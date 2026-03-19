//Note: we are having issues where some stuff is getting published to the wrong spaces...
//Need to query all spaces and find all types that have properties relations pointing to blank entities
//Need to output those

//If I am deleting a relation, I also need to delete the relation entity
//Orphaned entity should have no relation pointing to it as an entity or to entity

import { gql, publishOps } from './src/functions.js';
import { TYPES, DATA_TYPE_PROPERTY, DATA_TYPE_TO_SDK, SPACES } from './src/constants.js';
import { mergeEntities, type OpsBatch, type EntityData, type BacklinkRecord, ENTITY_INLINE_FIELDS, parseInlineEntity } from './src/entity_ops.js';
import * as fs from 'fs';

// ─── Configuration ──────────────────────────────────────────────────────────
// Finds duplicate Type and Property entities and merges them automatically.
// Property duplicates with data type mismatches are SKIPPED (logged as warnings).
// Run with: bun run 03_merge_duplicates.ts

const DRY_RUN = false; // Set to false to actually publish merges

const spaceRank = new Map(SPACES.map((s, i) => [s.id, i]));
const spaceName = new Map(SPACES.map(s => [s.id, s.name]));

// ─── Types ──────────────────────────────────────────────────────────────────

interface EntityHit {
  id: string;
  name: string;
  spaceId: string;
  dataType?: string | null;
}

interface DuplicateGroup {
  name: string;
  main: EntityHit;
  secondaries: EntityHit[];
  hasDataTypeMismatch: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchEntitiesOfType(typeId: string, spaceId: string): Promise<EntityHit[]> {
  const hits: EntityHit[] = [];
  let offset = 0;
  const PAGE = 500;

  while (true) {
    const data = await gql(`{
      entities(
        spaceId: "${spaceId}"
        typeId: "${typeId}"
        first: ${PAGE}
        offset: ${offset}
      ) {
        id
        name
      }
    }`);

    const entities = data.entities ?? [];
    for (const e of entities) {
      const name = (e.name ?? '').trim();
      if (!name) continue;
      hits.push({ id: e.id, name, spaceId });
    }

    if (entities.length < PAGE) break;
    offset += PAGE;
  }

  return hits;
}

const knownSpaceIds = new Set(SPACES.map(s => s.id));

async function countBacklinks(entityId: string): Promise<{ total: number; external: number }> {
  const data = await gql(`{
    relations(filter: {
      toEntityId: { is: "${entityId}" }
    }) {
      id
      fromEntity {
        spaceIds
      }
    }
  }`);
  const rels = data.relations ?? [];
  let external = 0;
  for (const rel of rels) {
    const spaceIds: string[] = rel.fromEntity?.spaceIds ?? [];
    // If the entity only exists in spaces we don't control, it's external
    const allExternal = spaceIds.length > 0 && spaceIds.every((s: string) => !knownSpaceIds.has(s));
    if (allExternal) external++;
  }
  return { total: rels.length, external };
}

async function countExternalPropertyUsages(propertyId: string): Promise<{ total: number; external: number }> {
  const data = await gql(`{
    values(filter: { propertyId: { is: "${propertyId}" } }) {
      spaceId
    }
    relations(filter: { typeId: { is: "${propertyId}" } }) {
      fromEntity {
        spaceIds
      }
    }
  }`);

  const spaceHits = new Set<string>();
  const externalSpaceHits = new Set<string>();

  // Count value usages by space
  for (const v of data.values ?? []) {
    if (v.spaceId) {
      spaceHits.add(v.spaceId);
      if (!knownSpaceIds.has(v.spaceId)) externalSpaceHits.add(v.spaceId);
    }
  }

  // Count relation usages by the fromEntity's spaces
  for (const rel of data.relations ?? []) {
    for (const sid of rel.fromEntity?.spaceIds ?? []) {
      spaceHits.add(sid);
      if (!knownSpaceIds.has(sid)) externalSpaceHits.add(sid);
    }
  }

  const totalUsages = (data.values ?? []).length + (data.relations ?? []).length;
  let externalUsages = 0;
  for (const v of data.values ?? []) {
    if (v.spaceId && !knownSpaceIds.has(v.spaceId)) externalUsages++;
  }
  for (const rel of data.relations ?? []) {
    const sids: string[] = rel.fromEntity?.spaceIds ?? [];
    if (sids.length > 0 && sids.every((s: string) => !knownSpaceIds.has(s))) externalUsages++;
  }

  return { total: totalUsages, external: externalUsages };
}

async function findDuplicates(label: string, typeId: string): Promise<DuplicateGroup[]> {
  console.log(`\nSearching for duplicate ${label} entities across ${SPACES.length} spaces...\n`);

  const allHits: EntityHit[] = [];
  const spaceResults = await Promise.all(
    SPACES.map(async space => {
      const hits = await fetchEntitiesOfType(typeId, space.id);
      return { space, hits };
    })
  );
  for (const { space, hits } of spaceResults) {
    console.log(`  ${space.name}: ${hits.length} ${label} entities`);
    allHits.push(...hits);
  }

  console.log(`  Total: ${allHits.length}`);

  // Group by lowercase name
  const byName = new Map<string, EntityHit[]>();
  for (const hit of allHits) {
    const key = hit.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(hit);
    byName.set(key, list);
  }

  // Deduplicate: same entity ID across multiple spaces
  for (const [key, hits] of byName) {
    const uniqueById = new Map<string, EntityHit>();
    for (const hit of hits) {
      const existing = uniqueById.get(hit.id);
      if (!existing || (spaceRank.get(hit.spaceId) ?? 999) < (spaceRank.get(existing.spaceId) ?? 999)) {
        uniqueById.set(hit.id, hit);
      }
    }
    byName.set(key, [...uniqueById.values()]);
  }

  // Filter to groups with 2+ distinct entity IDs
  const duplicateEntries = [...byName.entries()]
    .filter(([, hits]) => hits.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));

  // Collect all duplicate entity IDs for bulk querying
  const allDuplicateIds = duplicateEntries.flatMap(([, hits]) => hits.map(h => h.id));
  const uniqueDuplicateIds = [...new Set(allDuplicateIds)];

  console.log(`  ${duplicateEntries.length} duplicate groups, ${uniqueDuplicateIds.length} unique entities to analyze`);

  // ── Bulk fetch: backlinks and property data types in as few queries as possible ──

  // Bulk fetch all backlinks pointing to any duplicate entity (paginated)
  const backlinkCounts = new Map<string, { total: number; external: number }>();
  // Initialize all to zero
  for (const id of uniqueDuplicateIds) backlinkCounts.set(id, { total: 0, external: 0 });

  const BULK_PAGE = 500;
  for (let i = 0; i < uniqueDuplicateIds.length; i += BULK_PAGE) {
    const idBatch = uniqueDuplicateIds.slice(i, i + BULK_PAGE);
    const filterIds = idBatch.map(id => `"${id}"`).join(', ');

    if (typeId === TYPES.property) {
      // For properties: count values and relations using this property ID
      let offset = 0;
      while (true) {
        const data = await gql(`{
          values(filter: { propertyId: { in: [${filterIds}] } }, first: ${BULK_PAGE}, offset: ${offset}) {
            propertyId
            spaceId
          }
          relations(filter: { typeId: { in: [${filterIds}] } }, first: ${BULK_PAGE}, offset: ${offset}) {
            typeId
            fromEntity { spaceIds }
          }
        }`);

        const values = data.values ?? [];
        const relations = data.relations ?? [];

        for (const v of values) {
          const counts = backlinkCounts.get(v.propertyId)!;
          counts.total++;
          if (v.spaceId && !knownSpaceIds.has(v.spaceId)) counts.external++;
        }
        for (const rel of relations) {
          const counts = backlinkCounts.get(rel.typeId)!;
          counts.total++;
          const sids: string[] = rel.fromEntity?.spaceIds ?? [];
          if (sids.length > 0 && sids.every((s: string) => !knownSpaceIds.has(s))) counts.external++;
        }

        if (values.length < BULK_PAGE && relations.length < BULK_PAGE) break;
        offset += BULK_PAGE;
      }
    } else {
      // For non-property types: count backlinks (relations pointing TO each entity)
      let offset = 0;
      while (true) {
        const data = await gql(`{
          relations(filter: { toEntityId: { in: [${filterIds}] } }, first: ${BULK_PAGE}, offset: ${offset}) {
            toEntityId
            fromEntity { spaceIds }
          }
        }`);

        const rels = data.relations ?? [];
        for (const rel of rels) {
          const counts = backlinkCounts.get(rel.toEntityId);
          if (!counts) continue;
          counts.total++;
          const sids: string[] = rel.fromEntity?.spaceIds ?? [];
          if (sids.length > 0 && sids.every((s: string) => !knownSpaceIds.has(s))) counts.external++;
        }

        if (rels.length < BULK_PAGE) break;
        offset += BULK_PAGE;
      }
    }
  }

  console.log(`  Bulk backlink/usage fetch complete.`);

  // Bulk fetch data types for property entities
  const dataTypeMap = new Map<string, string | null>();
  if (typeId === TYPES.property) {
    for (let i = 0; i < uniqueDuplicateIds.length; i += BULK_PAGE) {
      const idBatch = uniqueDuplicateIds.slice(i, i + BULK_PAGE);
      const filterIds = idBatch.map(id => `"${id}"`).join(', ');
      const data = await gql(`{
        relations(filter: {
          fromEntityId: { in: [${filterIds}] }
          typeId: { is: "${DATA_TYPE_PROPERTY}" }
        }) {
          fromEntityId
          toEntityId
          toEntity { name }
        }
      }`);
      for (const rel of data.relations ?? []) {
        const mapped = DATA_TYPE_TO_SDK[rel.toEntityId];
        if (mapped) {
          dataTypeMap.set(rel.fromEntityId, mapped);
        } else {
          const name = rel.toEntity?.name;
          dataTypeMap.set(rel.fromEntityId, name ? name.toLowerCase() : null);
        }
      }
    }
    // Entities with no Data Type relation are relation-only
    for (const id of uniqueDuplicateIds) {
      if (!dataTypeMap.has(id)) dataTypeMap.set(id, null);
    }
    console.log(`  Bulk data type fetch complete.`);
  }

  // ── Build groups using the pre-fetched data (no more per-entity queries) ──

  const groups: DuplicateGroup[] = [];

  for (const [, hits] of duplicateEntries) {
    // Attach data types from bulk lookup
    if (typeId === TYPES.property) {
      for (const h of hits) h.dataType = dataTypeMap.get(h.id) ?? null;
    }

    // Determine main entity using pre-fetched counts
    const counts = hits.map(h => ({
      hit: h,
      ...(backlinkCounts.get(h.id) ?? { total: 0, external: 0 }),
    }));
    counts.sort((a, b) =>
      b.external - a.external
      || (spaceRank.get(a.hit.spaceId) ?? 999) - (spaceRank.get(b.hit.spaceId) ?? 999)
      || b.total - a.total
    );

    const mainEntity = counts[0].hit;
    const usageLabel = typeId === TYPES.property ? 'ext usages' : 'ext backlinks';
    console.log(`  Main selection: ${counts.map(c => `${c.hit.id}=${c.external} ${usageLabel}/${c.total} total (${spaceName.get(c.hit.spaceId)})`).join(', ')}`);

    const secondaries = hits.filter(h => h !== mainEntity);

    let hasDataTypeMismatch = false;
    if (typeId === TYPES.property) {
      const dataTypes = new Set(hits.map(h => h.dataType ?? 'relation'));
      hasDataTypeMismatch = dataTypes.size > 1;
    }

    groups.push({ name: hits[0].name, main: mainEntity, secondaries, hasDataTypeMismatch });
  }

  return groups;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '*** DRY RUN — no changes will be published ***\n' : '*** LIVE RUN — merges will be published ***\n');

  const categories = [
    //{ label: 'Type', typeId: TYPES.type },
    //{ label: 'Property', typeId: TYPES.property },
    //{ label: 'Role', typeId: TYPES.role },
    //{ label: 'Skill', typeId: TYPES.skill },
    //{ label: 'Topic', typeId: TYPES.topic },
    //{ label: 'Claim', typeId: TYPES.claim },
    //{ label: 'Person', typeId: TYPES.person },
    //{ label: 'Podcast', typeId: TYPES.podcast },
    { label: 'Episode', typeId: TYPES.episode },
  ];

  let mergedCount = 0;
  let skippedCount = 0;
  const opsBatch: OpsBatch = new Map();

  // Report tracking
  const reportMerged: Array<{ name: string; label: string; main: EntityHit; secondaries: EntityHit[] }> = [];
  const reportSkipped: Array<{ name: string; label: string; main: { hit: EntityHit; usages: number }; secondaries: Array<{ hit: EntityHit; usages: number }>; reason: string }> = [];
  const reportErrors: Array<{ name: string; label: string; main: EntityHit; secondaries: EntityHit[]; error: string }> = [];

  for (const { label, typeId } of categories) {
    const groups = await findDuplicates(label, typeId);

    if (groups.length === 0) {
      console.log(`  No duplicate ${label} names found.\n`);
      continue;
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`${label} — ${groups.length} duplicate name(s)`);
    console.log(`${'='.repeat(80)}\n`);

    // ── Bulk prefetch all entity data for merge candidates ──
    const allEntityIds = new Set<string>();
    for (const group of groups) {
      allEntityIds.add(group.main.id);
      for (const sec of group.secondaries) allEntityIds.add(sec.id);
    }

    const entityDataCache = new Map<string, EntityData>();
    const backlinksCache = new Map<string, BacklinkRecord[]>();
    const BULK = 500;
    const entityIdList = [...allEntityIds];

    console.log(`Bulk-prefetching ${entityIdList.length} entities for ${groups.length} merge groups...`);
    for (let i = 0; i < entityIdList.length; i += BULK) {
      const batch = entityIdList.slice(i, i + BULK);
      const filterIds = batch.map(id => `"${id}"`).join(', ');
      const data = await gql(`{
        entities(filter: { id: { in: [${filterIds}] } }) {
          ${ENTITY_INLINE_FIELDS}
        }
      }`);

      for (const e of (data.entities ?? [])) {
        const { relations, backlinks, values } = parseInlineEntity(e);
        entityDataCache.set(e.id, { values, relations });
        backlinksCache.set(e.id, backlinks);
      }
    }

    // Also prefetch relation targets (entities referenced by the candidates)
    const relationTargetIds = new Set<string>();
    for (const [, ed] of entityDataCache) {
      for (const r of ed.relations) {
        if (!entityDataCache.has(r.toEntityId)) relationTargetIds.add(r.toEntityId);
      }
    }

    if (relationTargetIds.size > 0) {
      const targetIdList = [...relationTargetIds];
      console.log(`Bulk-prefetching ${targetIdList.length} relation targets...`);
      for (let i = 0; i < targetIdList.length; i += BULK) {
        const batch = targetIdList.slice(i, i + BULK);
        const filterIds = batch.map(id => `"${id}"`).join(', ');
        const data = await gql(`{
          entities(filter: { id: { in: [${filterIds}] } }) {
            ${ENTITY_INLINE_FIELDS}
          }
        }`);

        for (const e of (data.entities ?? [])) {
          const { relations, backlinks, values } = parseInlineEntity(e);
          if (!entityDataCache.has(e.id)) entityDataCache.set(e.id, { values, relations });
          if (!backlinksCache.has(e.id)) backlinksCache.set(e.id, backlinks);
        }
      }
    }

    console.log(`Prefetch complete: ${entityDataCache.size} entities, ${backlinksCache.size} backlink entries\n`);

    for (const group of groups) {
      const dtLabel = (h: EntityHit) =>
        typeId === TYPES.property ? `  dataType=${h.dataType ?? 'relation'}` : '';

      // Skip property duplicates with data type mismatch — but only if
      // at least one secondary actually has usages (values/relations).
      // If no secondary has usages, the mismatch doesn't matter.
      if (group.hasDataTypeMismatch) {
        const secondaryUsages = await Promise.all(
          group.secondaries.map(async sec => ({
            sec,
            usages: (await countExternalPropertyUsages(sec.id)).total + (await countBacklinks(sec.id)).total,
          }))
        );
        const mainUsages = (await countExternalPropertyUsages(group.main.id)).total + (await countBacklinks(group.main.id)).total;
        const anySecondaryHasUsages = secondaryUsages.some(s => s.usages > 0);

        if (anySecondaryHasUsages && mainUsages > 0) {
          // Both sides have usages — can't safely merge
          console.log(`SKIPPED "${group.name}" — DATA TYPE MISMATCH`);
          console.log(`  Main:       entityId=${group.main.id}  spaceId=${group.main.spaceId} (${spaceName.get(group.main.spaceId)})${dtLabel(group.main)}  usages=${mainUsages}`);
          for (const su of secondaryUsages) {
            console.log(`  Secondary:  entityId=${su.sec.id}  spaceId=${su.sec.spaceId} (${spaceName.get(su.sec.spaceId)})${dtLabel(su.sec)}  usages=${su.usages}`);
          }
          console.log();
          reportSkipped.push({
            name: group.name,
            label,
            main: { hit: group.main, usages: mainUsages },
            secondaries: secondaryUsages.map(su => ({ hit: su.sec, usages: su.usages })),
            reason: 'Data type mismatch',
          });
          skippedCount++;
          continue;
        }

        if (anySecondaryHasUsages && mainUsages === 0) {
          // Main has no usages — swap to the most-used secondary
          secondaryUsages.sort((a, b) => b.usages - a.usages);
          const newMain = secondaryUsages[0].sec;
          const newSecondaries = [group.main, ...secondaryUsages.slice(1).map(su => su.sec)];
          console.log(`  Data type mismatch but main has 0 usages — swapping main to ${newMain.id} (${spaceName.get(newMain.spaceId)}) with ${secondaryUsages[0].usages} usages`);
          group.main = newMain;
          group.secondaries = newSecondaries;
        } else {
          console.log(`  Data type mismatch but no secondary has usages — proceeding with merge.`);
        }
      }

      console.log(`MERGING "${group.name}"`);
      console.log(`  Main:       entityId=${group.main.id}  spaceId=${group.main.spaceId} (${spaceName.get(group.main.spaceId)})${dtLabel(group.main)}`);
      for (const sec of group.secondaries) {
        console.log(`  Secondary:  entityId=${sec.id}  spaceId=${sec.spaceId} (${spaceName.get(sec.spaceId)})${dtLabel(sec)}`);
      }

      try {
        await mergeEntities({
          mainEntityId: group.main.id,
          mainSpaceId: group.main.spaceId,
          secondaries: group.secondaries.map(s => ({ entityId: s.id, spaceId: s.spaceId })),
          dryRun: DRY_RUN,
          opsBatch,
          entityDataCache,
          backlinksCache,
          ...(group.hasDataTypeMismatch ? { addPropertiesToMain: false } : {}),
        });
        reportMerged.push({ name: group.name, label, main: group.main, secondaries: group.secondaries });
        mergedCount++;
        console.log(`  Done.\n`);
      } catch (err: any) {
        console.error(`  ERROR merging "${group.name}": ${err.message}\n`);
        reportErrors.push({ name: group.name, label, main: group.main, secondaries: group.secondaries, error: err.message });
        skippedCount++;
      }
    }
  }

  // Publish all accumulated ops, once per space
  if (!DRY_RUN) {
    let totalOps = 0;
    for (const [spaceId, ops] of opsBatch) {
      if (ops.length === 0) continue;
      totalOps += ops.length;
      console.log(`\nPublishing ${ops.length} ops to space ${spaceId} (${spaceName.get(spaceId) ?? 'unknown'})...`);
      await publishOps(ops, `Batch merge duplicates`, spaceId);
    }
    console.log(`\nPublished ${totalOps} total ops across ${opsBatch.size} space(s).`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Write ops dump (grouped by space)
  // ═══════════════════════════════════════════════════════════════════════════
  const opsLines: string[] = [];
  let totalOpsCount = 0;
  for (const [spaceId, ops] of opsBatch) {
    if (ops.length === 0) continue;
    totalOpsCount += ops.length;
    opsLines.push(`${'='.repeat(80)}`);
    opsLines.push(`Space: ${spaceName.get(spaceId) ?? 'unknown'} (${spaceId})`);
    opsLines.push(`Ops count: ${ops.length}`);
    opsLines.push(`${'='.repeat(80)}`);
    opsLines.push(JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2));
    opsLines.push('');
  }
  if (totalOpsCount > 0) {
    opsLines.unshift(`Total ops: ${totalOpsCount} across ${opsBatch.size} space(s)\n`);
    fs.writeFileSync('merge_duplicates_ops.txt', opsLines.join('\n'));
    console.log(`\nOps written to merge_duplicates_ops.txt (${totalOpsCount} ops across ${opsBatch.size} space(s))`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Write report
  // ═══════════════════════════════════════════════════════════════════════════
  const lines: string[] = [];
  const entityLine = (h: EntityHit) =>
    `    entityId=${h.id}  spaceId=${h.spaceId} (${spaceName.get(h.spaceId)})${h.dataType ? `  dataType=${h.dataType}` : ''}`;

  lines.push('SUCCESSFULLY MERGED');
  lines.push('='.repeat(80));
  if (reportMerged.length === 0) {
    lines.push('  (none)');
  } else {
    for (const m of reportMerged) {
      lines.push(`  "${m.name}" [${m.label}]`);
      lines.push(`    Main:      ${entityLine(m.main).trim()}`);
      for (const sec of m.secondaries) {
        lines.push(`    Secondary: ${entityLine(sec).trim()}`);
      }
    }
  }

  lines.push('');
  lines.push('SKIPPED (data type mismatch)');
  lines.push('='.repeat(80));
  if (reportSkipped.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of reportSkipped) {
      lines.push(`  "${s.name}" [${s.label}]  — ${s.reason}`);
      lines.push(`    Main:      ${entityLine(s.main.hit).trim()}  usages=${s.main.usages}`);
      for (const sec of s.secondaries) {
        lines.push(`    Secondary: ${entityLine(sec.hit).trim()}  usages=${sec.usages}`);
      }
    }
  }

  lines.push('');
  lines.push('ERRORS');
  lines.push('='.repeat(80));
  if (reportErrors.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of reportErrors) {
      lines.push(`  "${e.name}" [${e.label}]  — ${e.error}`);
      lines.push(`    Main:      ${entityLine(e.main).trim()}`);
      for (const sec of e.secondaries) {
        lines.push(`    Secondary: ${entityLine(sec).trim()}`);
      }
    }
  }

  lines.push('');
  lines.push('SUMMARY');
  lines.push('='.repeat(80));
  lines.push(`  Merged:  ${reportMerged.length}`);
  lines.push(`  Skipped: ${reportSkipped.length}`);
  lines.push(`  Errors:  ${reportErrors.length}`);
  lines.push(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const reportText = lines.join('\n');
  fs.writeFileSync('merge_duplicates_report.txt', reportText);
  console.log(`\nReport written to merge_duplicates_report.txt`);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Summary: ${mergedCount} merged, ${skippedCount} skipped${DRY_RUN ? ' (dry run)' : ''}`);
  console.log(`${'='.repeat(80)}`);
}

main().catch(console.error);
