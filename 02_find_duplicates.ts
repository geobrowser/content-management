import * as fs from 'fs';
import { gql } from './src/functions.js';
import { TYPES, DATA_TYPE_PROPERTY, DATA_TYPE_TO_SDK, SPACES } from './src/constants.js';

// ─── Configuration ──────────────────────────────────────────────────────────
// Finds duplicate entities (by name, case-insensitive) for the given types
// across the listed spaces. Also cross-checks against no_type_entities.csv
// to find typed entities with no-type twins.
// Run with: bun run 02_find_duplicates.ts

const spaceRank = new Map(SPACES.map((s, i) => [s.id, i]));
const spaceName = new Map(SPACES.map(s => [s.id, s.name]));

// ─── Load no-type CSV ───────────────────────────────────────────────────────

interface NoTypeEntry { id: string; name: string; spaceId: string; spaceName: string; }

function loadNoTypeCsv(path: string): Map<string, NoTypeEntry[]> {
  const byName = new Map<string, NoTypeEntry[]>();
  if (!fs.existsSync(path)) {
    console.log('⚠ no_type_entities.csv not found — skipping no-type cross-check\n');
    return byName;
  }
  const lines = fs.readFileSync(path, 'utf-8').split('\n').slice(1); // skip header
  for (const line of lines) {
    if (!line.trim()) continue;
    // Parse CSV (handles quoted fields with commas)
    const match = line.match(/^([^,]+),(".*?"|[^,]*),([^,]+),(.+)$/);
    if (!match) continue;
    const id = match[1];
    const name = match[2].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
    const spaceId = match[3];
    const sName = match[4];
    if (!name) continue;
    const key = name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push({ id, name, spaceId, spaceName: sName });
    byName.set(key, list);
  }
  return byName;
}

const noTypeByName = loadNoTypeCsv('./no_type_entities.csv');

// ─── Types ──────────────────────────────────────────────────────────────────

interface EntityHit {
  id: string;
  name: string;
  spaceId: string;
  dataType?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchEntitiesOfType(typeId: string, spaceId: string): Promise<EntityHit[]> {
  const hits: EntityHit[] = [];
  let cursor: string | null = null;

  while (true) {
    const afterClause = cursor ? `after: "${cursor}"` : '';
    const data = await gql(`{
      entitiesConnection(
        spaceId: "${spaceId}"
        typeId: "${typeId}"
        first: 100
        ${afterClause}
      ) {
        edges { node { id name } }
        pageInfo { hasNextPage endCursor }
      }
    }`);

    const conn = data.entitiesConnection;
    for (const edge of conn?.edges ?? []) {
      const name = (edge.node.name ?? '').trim();
      if (!name) continue;
      hits.push({ id: edge.node.id, name, spaceId });
    }

    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return hits;
}

async function getPropertyDataType(propertyId: string): Promise<string | null> {
  const data = await gql(`{
    relations(filter: {
      fromEntityId: { is: "${propertyId}" }
      typeId: { is: "${DATA_TYPE_PROPERTY}" }
    }) {
      toEntityId
      toEntity { name }
    }
  }`);
  const rels = data.relations ?? [];
  if (rels.length === 0) return null;
  const toEntityId = rels[0].toEntityId;
  const mapped = DATA_TYPE_TO_SDK[toEntityId];
  if (mapped) return mapped;
  const name = rels[0].toEntity?.name;
  return name ? name.toLowerCase() : null;
}

async function countBacklinks(entityId: string): Promise<number> {
  const data = await gql(`{
    relations(filter: {
      toEntityId: { is: "${entityId}" }
    }) {
      id
    }
  }`);
  return (data.relations ?? []).length;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const categories = [
    // Person type across all spaces
    { label: 'Person', typeId: '7ed45f2bc48b419e8e4664d5ff680b0d' },
  ];

  for (const { label, typeId } of categories) {
    console.log(`\nSearching for duplicate ${label} entities across ${SPACES.length} spaces...\n`);

    // Fetch all entities of this meta-type across all spaces
    const allHits: EntityHit[] = [];
    for (const space of SPACES) {
      const hits = await fetchEntitiesOfType(typeId, space.id);
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

    // Deduplicate: same entity ID across multiple spaces is not a true duplicate
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
    const duplicates = [...byName.entries()]
      .filter(([, hits]) => hits.length > 1)
      .sort(([a], [b]) => a.localeCompare(b));

    if (duplicates.length === 0) {
      console.log(`  No duplicate ${label} names found.\n`);
      continue;
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`${label} — ${duplicates.length} duplicate name(s)`);
    console.log(`${'='.repeat(80)}\n`);

    for (const [, hits] of duplicates) {
      // For properties, fetch data types for each entity
      if (typeId === TYPES.property) {
        await Promise.all(hits.map(async h => {
          h.dataType = await getPropertyDataType(h.id);
        }));
      }

      // Sort by space rank
      hits.sort((a, b) => (spaceRank.get(a.spaceId) ?? 999) - (spaceRank.get(b.spaceId) ?? 999));

      // Determine main entity
      const bestRank = spaceRank.get(hits[0].spaceId) ?? 999;
      const topTied = hits.filter(h => (spaceRank.get(h.spaceId) ?? 999) === bestRank);

      let mainEntity: EntityHit;

      if (topTied.length > 1) {
        const counts = await Promise.all(
          topTied.map(async h => ({ hit: h, backlinks: await countBacklinks(h.id) }))
        );
        counts.sort((a, b) => b.backlinks - a.backlinks);
        mainEntity = counts[0].hit;
        console.log(`  (Tiebreak in ${spaceName.get(mainEntity.spaceId)}: ${counts.map(c => `${c.hit.id}=${c.backlinks} backlinks`).join(', ')})`);
      } else {
        mainEntity = topTied[0];
      }

      const secondaries = hits.filter(h => h !== mainEntity);

      // Check for data type mismatch across property duplicates
      let mismatchWarning = '';
      if (typeId === TYPES.property) {
        const dataTypes = new Set(hits.map(h => h.dataType ?? 'relation'));
        if (dataTypes.size > 1) {
          mismatchWarning = '  ⚠ DATA TYPE MISMATCH\n';
        }
      }

      const dtLabel = (h: EntityHit) =>
        typeId === TYPES.property ? `  dataType=${h.dataType ?? 'relation'}` : '';

      console.log(`"${hits[0].name}"${mismatchWarning ? '\n' + mismatchWarning : ''}`);
      console.log(`  Main:       entityId=${mainEntity.id}  spaceId=${mainEntity.spaceId} (${spaceName.get(mainEntity.spaceId)})${dtLabel(mainEntity)}`);
      for (const sec of secondaries) {
        console.log(`  Secondary:  entityId=${sec.id}  spaceId=${sec.spaceId} (${spaceName.get(sec.spaceId)})${dtLabel(sec)}`);
      }
      console.log();
    }

    // ─── No-type cross-check ─────────────────────────────────────────────────
    // For each typed entity, check if a no-type entity with the same name exists
    const noTypeMatches: { typed: EntityHit; noType: NoTypeEntry[] }[] = [];
    const seenTypedNames = new Set<string>();
    for (const hit of allHits) {
      const key = hit.name.toLowerCase();
      if (seenTypedNames.has(key)) continue;
      seenTypedNames.add(key);
      const noTypes = noTypeByName.get(key);
      if (noTypes && noTypes.length > 0) {
        // Exclude if the no-type entity IS the same entity ID
        const different = noTypes.filter(nt => nt.id !== hit.id);
        if (different.length > 0) {
          noTypeMatches.push({ typed: hit, noType: different });
        }
      }
    }

    if (noTypeMatches.length > 0) {
      console.log(`\n── ${label}: ${noTypeMatches.length} typed ↔ no-type match(es) ──\n`);
      for (const m of noTypeMatches) {
        console.log(`"${m.typed.name}"  type=${label}`);
        console.log(`  Typed:    entityId=${m.typed.id}  spaceId=${m.typed.spaceId} (${spaceName.get(m.typed.spaceId)})`);
        for (const nt of m.noType) {
          console.log(`  No-type:  entityId=${nt.id}  spaceId=${nt.spaceId} (${nt.spaceName})`);
        }
        console.log();
      }
    } else {
      console.log(`  No typed ↔ no-type matches for ${label}.\n`);
    }
  }
}

main().catch(console.error);
