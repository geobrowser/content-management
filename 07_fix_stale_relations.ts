import { Graph, type Op } from '@geoprotocol/geo-sdk';
import { gql, publishOps } from './src/functions.js';
import { SPACES, TYPES, PROPERTIES } from './src/constants.js';
import * as fs from 'fs';

// ─── Configuration ──────────────────────────────────────────────────────────
// Finds and fixes stale relations caused by the wrong-space publishing bug
// in mergeEntities/changeEntityId.
//
// The bug: cross-space backlink ops were published to mainSpaceId instead of
// the relation's own spaceId. This caused:
//   1. Stale relations in their original space (still pointing to deleted secondaries)
//   2. Wrong-space duplicates in mainSpaceId (new relations created there)
//
// This script:
//   Phase 1: Detect stale relations (toEntity has no name AND no typeIds = deleted)
//   Phase 2: Find the correct target by matching (fromEntityId, typeId) across spaces
//   Phase 3: Delete stale + wrong-space duplicate, create correct relation in proper space
//
// Run with: bun run 07_fix_stale_relations.ts

const DRY_RUN = true;

const spaceName = new Map(SPACES.map(s => [s.id, s.name]));

// ─── Types ──────────────────────────────────────────────────────────────────

interface StaleRelation {
  id: string;
  entityId: string;
  spaceId: string;
  fromEntityId: string;
  fromEntityName: string;
  toEntityId: string;
  typeId: string;
  typeName: string;
  toSpaceId: string | null;
  fromSpaceId: string | null;
  toVersionId: string | null;
  fromVersionId: string | null;
  position: string | null;
}

interface FixCase {
  stale: StaleRelation;
  correctTargetId: string;
  correctTargetName: string;
  wrongSpaceRelId: string | null;
  wrongSpaceId: string | null;
  /** True if a correct relation already exists in the stale relation's space */
  correctAlreadyExists: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function optionalRelationFields(r: StaleRelation) {
  return {
    ...(r.toSpaceId ? { toSpace: r.toSpaceId } : {}),
    ...(r.fromSpaceId ? { fromSpace: r.fromSpaceId } : {}),
    ...(r.toVersionId ? { toVersion: r.toVersionId } : {}),
    ...(r.fromVersionId ? { fromVersion: r.fromVersionId } : {}),
    ...(r.position ? { position: r.position } : {}),
  };
}

// ─── Phase 1: Detect ────────────────────────────────────────────────────────

async function findStaleRelationsInSpace(spaceId: string): Promise<StaleRelation[]> {
  const stale: StaleRelation[] = [];
  let offset = 0;
  const PAGE = 100;
  //-- fromEntity: {typeIds: {anyEqualTo: "${TYPES.topic}"}}
  while (true) {
    const data = await gql(`{
      relations(
        filter: { 
          spaceId: { is: "${spaceId}" }        
        }
        first: ${PAGE}
        offset: ${offset}
      ) {
        id
        entityId
        fromEntityId
        fromEntity { name }
        toEntityId
        toEntity { name typeIds }
        typeId
        typeEntity { name }
        toSpaceId
        fromSpaceId
        toVersionId
        fromVersionId
        position
      }
    }`);

    const rels = data.relations ?? [];
    for (const r of rels) {
      const toName = (r.toEntity?.name ?? '').trim();
      const toTypeIds: string[] = r.toEntity?.typeIds ?? [];

      // A deleted entity has no name AND no type assignments
      if (!toName && toTypeIds.length === 0) {
        stale.push({
          id: r.id,
          entityId: r.entityId,
          spaceId,
          fromEntityId: r.fromEntityId,
          fromEntityName: r.fromEntity?.name ?? '(unnamed)',
          toEntityId: r.toEntityId,
          typeId: r.typeId,
          typeName: r.typeEntity?.name ?? r.typeId,
          toSpaceId: r.toSpaceId ?? null,
          fromSpaceId: r.fromSpaceId ?? null,
          toVersionId: r.toVersionId ?? null,
          fromVersionId: r.fromVersionId ?? null,
          position: r.position ?? null,
        });
      }
    }

    if (rels.length < PAGE) break;
    offset += PAGE;
  }

  return stale;
}

// ─── Phase 2: Resolve ───────────────────────────────────────────────────────

async function findCorrectTarget(stale: StaleRelation): Promise<FixCase | null> {
  // Find all relations from the same fromEntity with the same typeId (across all spaces)
  const data = await gql(`{
    relations(filter: {
      fromEntityId: { is: "${stale.fromEntityId}" }
      typeId: { is: "${stale.typeId}" }
    }) {
      id
      entityId
      spaceId
      toEntityId
      toEntity { name }
      toSpaceId
      fromSpaceId
      toVersionId
      fromVersionId
      position
    }
  }`);

  const rels = data.relations ?? [];

  // Check if a correct relation already exists in the stale relation's space
  const sameSpaceValid = rels.find((r: any) => {
    const name = (r.toEntity?.name ?? '').trim();
    return name && r.spaceId === stale.spaceId && r.id !== stale.id;
  });

  // First try: match by entityId (the bug reuses bl.entityId for the wrong-space duplicate)
  const exactMatch = rels.find((r: any) => {
    const name = (r.toEntity?.name ?? '').trim();
    return name && r.entityId === stale.entityId && r.spaceId !== stale.spaceId;
  });

  if (exactMatch) {
    return {
      stale,
      correctTargetId: exactMatch.toEntityId,
      correctTargetName: exactMatch.toEntity?.name ?? '',
      wrongSpaceRelId: exactMatch.id,
      wrongSpaceId: exactMatch.spaceId,
      correctAlreadyExists: !!sameSpaceValid,
    };
  }

  // Fallback: match by (fromEntityId, typeId) — same from entity + same relation type,
  // different space, pointing to a valid (named) entity
  const fallback = rels.find((r: any) => {
    const name = (r.toEntity?.name ?? '').trim();
    return name && r.spaceId !== stale.spaceId && r.toEntityId !== stale.toEntityId;
  });

  if (fallback) {
    return {
      stale,
      correctTargetId: fallback.toEntityId,
      correctTargetName: fallback.toEntity?.name ?? '',
      wrongSpaceRelId: fallback.id,
      wrongSpaceId: fallback.spaceId,
      correctAlreadyExists: !!sameSpaceValid,
    };
  }

  if (sameSpaceValid) {
    // A correct relation already exists in this space — just need to delete the stale one
    return {
      stale,
      correctTargetId: sameSpaceValid.toEntityId,
      correctTargetName: sameSpaceValid.toEntity?.name ?? '',
      wrongSpaceRelId: null,
      wrongSpaceId: null,
      correctAlreadyExists: true,
    };
  }

  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '*** DRY RUN ***\n' : '*** LIVE RUN ***\n');

  const lines: string[] = [];
  const log = (msg: string = '') => { console.log(msg); lines.push(msg); };

  // ═══ Phase 1: Detect stale relations ═══
  log('═'.repeat(80));
  log('Phase 1: Scanning for stale relations (pointing to deleted entities)');
  log('═'.repeat(80));

  const allStale: StaleRelation[] = [];
  for (const space of SPACES) {
    const stale = await findStaleRelationsInSpace(space.id);
    log(`  ${space.name}: ${stale.length} stale relation(s)`);
    allStale.push(...stale);
  }

  log(`\n  Total: ${allStale.length} stale relation(s)\n`);

  if (allStale.length === 0) {
    log('No stale relations found. Nothing to fix.');
    writeReport(lines);
    return;
  }

  // ═══ Phase 2: Find correct targets ═══
  log('═'.repeat(80));
  log('Phase 2: Resolving correct targets for each stale relation');
  log('═'.repeat(80));

  const fixCases: FixCase[] = [];
  const unfixable: StaleRelation[] = [];

  // Deduplicate lookups: group stale relations by (fromEntityId, typeId)
  const grouped = new Map<string, StaleRelation[]>();
  for (const s of allStale) {
    const key = `${s.fromEntityId}:${s.typeId}`;
    const list = grouped.get(key) ?? [];
    list.push(s);
    grouped.set(key, list);
  }

  for (const [, staleGroup] of grouped) {
    // Resolve one, apply to all in the group
    const fix = await findCorrectTarget(staleGroup[0]);

    for (const stale of staleGroup) {
      if (fix) {
        fixCases.push({
          stale,
          correctTargetId: fix.correctTargetId,
          correctTargetName: fix.correctTargetName,
          // Only the first in the group should delete the wrong-space dup
          wrongSpaceRelId: stale === staleGroup[0] ? fix.wrongSpaceRelId : null,
          wrongSpaceId: stale === staleGroup[0] ? fix.wrongSpaceId : null,
          correctAlreadyExists: fix.correctAlreadyExists,
        });
      } else if (stale.typeId === PROPERTIES.types && stale.toEntityId === '8e7ed5cde92d4903962f773bd80d96e4') {
        // Deleted Topic duplicate → remap to the correct Topic type
        fixCases.push({
          stale,
          correctTargetId: TYPES.topic,
          correctTargetName: 'Topic',
          wrongSpaceRelId: null,
          wrongSpaceId: null,
          correctAlreadyExists: false,
        });
      } else if (stale.typeId === PROPERTIES.types && stale.toEntityId === '4d0076ff1e824585b03066f6bf6420ce') {
        // Deleted Project duplicate → remap to the correct Project type
        fixCases.push({
          stale,
          correctTargetId: '484a18c5030a499cb0f2ef588ff16d50',
          correctTargetName: 'Project',
          wrongSpaceRelId: null,
          wrongSpaceId: null,
          correctAlreadyExists: false,
        });
      } else if (stale.typeId === PROPERTIES.types && stale.toEntityId === '4faff0b210cb49958e20109409b8699c') {
        // Deleted Person duplicate → remap to the correct Person type
        fixCases.push({
          stale,
          correctTargetId: '7ed45f2bc48b419e8e4664d5ff680b0d',
          correctTargetName: 'Person',
          wrongSpaceRelId: null,
          wrongSpaceId: null,
          correctAlreadyExists: false,
        });
      } else if (stale.typeId === PROPERTIES.types && stale.toEntityId === 'af47cf1c2f57403393668d900ccc1a0f') {
        // Deleted Claim duplicate → remap to the correct Claim type
        fixCases.push({
          stale,
          correctTargetId: '96f859efa1ca4b229372c86ad58b694b',
          correctTargetName: 'Claim',
          wrongSpaceRelId: null,
          wrongSpaceId: null,
          correctAlreadyExists: false,
        });
      } else if (stale.typeId === PROPERTIES.types && stale.toEntityId === 'e9cd276d2e554b58b2d47ab03f5ddeb6') {
        // Deleted Episode duplicate → remap to the correct Episode type
        fixCases.push({
          stale,
          correctTargetId: '972d201ad78045689e01543f67b26bee',
          correctTargetName: 'Episode',
          wrongSpaceRelId: null,
          wrongSpaceId: null,
          correctAlreadyExists: false,
        });
      } else if (stale.typeId === PROPERTIES.types && stale.toEntityId === 'f29fc15e849941cf912aead23beadd77') {
        // Deleted Role duplicate → remap to the correct Role type
        fixCases.push({
          stale,
          correctTargetId: 'e4e366e9d5554b6892bf7358e824afd2',
          correctTargetName: 'Role',
          wrongSpaceRelId: null,
          wrongSpaceId: null,
          correctAlreadyExists: false,
        });
      } else if (stale.typeId === PROPERTIES.types && stale.toEntityId === 'af31eefce19745199fcbc0062cf2173b') {
        // Deleted Podcast duplicate → remap to the correct Podcast type
        fixCases.push({
          stale,
          correctTargetId: '4c81561d1f9541319cdddd20ab831ba2',
          correctTargetName: 'Podcast',
          wrongSpaceRelId: null,
          wrongSpaceId: null,
          correctAlreadyExists: false,
        });
      } else if (stale.typeId === '1155befffad549b7a2e0da4777b8792c') {
        // Stale Avatar relation → just delete, no replacement needed
        fixCases.push({
          stale,
          correctTargetId: '',
          correctTargetName: '(delete only)',
          wrongSpaceRelId: null,
          wrongSpaceId: null,
          correctAlreadyExists: true, // skip create
        });
      } else {
        unfixable.push(stale);
      }
    }
  }

  log(`\n  Fixable: ${fixCases.length}`);
  log(`  Unfixable (no matching relation found): ${unfixable.length}\n`);

  // Log fixable cases
  for (const fix of fixCases) {
    log(`  FIX: "${fix.stale.fromEntityName}" --[${fix.stale.typeName}]--> DELETED(${fix.stale.toEntityId})`);
    log(`    Stale in: ${spaceName.get(fix.stale.spaceId) ?? fix.stale.spaceId}  relation: ${fix.stale.id}`);
    log(`    Correct target: "${fix.correctTargetName}" (${fix.correctTargetId})`);
    if (fix.wrongSpaceRelId) {
      log(`    Wrong-space duplicate in: ${spaceName.get(fix.wrongSpaceId!) ?? fix.wrongSpaceId}  relation: ${fix.wrongSpaceRelId}`);
    }
    log();
  }

  // Log unfixable cases
  for (const s of unfixable) {
    log(`  UNFIXABLE: "${s.fromEntityName}" --[${s.typeName}]--> DELETED(${s.toEntityId})`);
    log(`    In: ${spaceName.get(s.spaceId) ?? s.spaceId}  relation: ${s.id}`);
    log();
  }

  // ═══ Phase 3: Fix ═══
  log('═'.repeat(80));
  log('Phase 3: Generating fix ops');
  log('═'.repeat(80));

  const opsBySpace = new Map<string, Op[]>();
  const addOps = (spaceId: string, ops: Op[]) => {
    const existing = opsBySpace.get(spaceId) ?? [];
    existing.push(...ops);
    opsBySpace.set(spaceId, existing);
  };

  // Track relations we've already decided to create in this batch
  // Key: "spaceId:fromEntityId:typeId:toEntityId"
  const createdInBatch = new Set<string>();
  let skippedDuplicates = 0;

  for (const fix of fixCases) {
    // 1. Delete the stale relation in its space
    const delStale = Graph.deleteRelation({ id: fix.stale.id });
    addOps(fix.stale.spaceId, delStale.ops);

    // 2. Create the corrected relation — but only if it doesn't already exist
    //    in the space (from the API) or from a prior fix in this batch
    const createKey = `${fix.stale.spaceId}:${fix.stale.fromEntityId}:${fix.stale.typeId}:${fix.correctTargetId}`;
    if (fix.correctAlreadyExists || createdInBatch.has(createKey)) {
      log(`  SKIP CREATE (already exists): "${fix.stale.fromEntityName}" --[${fix.stale.typeName}]--> "${fix.correctTargetName}" in ${spaceName.get(fix.stale.spaceId) ?? fix.stale.spaceId}`);
      skippedDuplicates++;
    } else {
      const createCorrect = Graph.createRelation({
        fromEntity: fix.stale.fromEntityId,
        toEntity: fix.correctTargetId,
        type: fix.stale.typeId,
        entityId: fix.stale.entityId,
        ...optionalRelationFields(fix.stale),
      });
      addOps(fix.stale.spaceId, createCorrect.ops);
      createdInBatch.add(createKey);
    }

    // 3. Delete the wrong-space duplicate (if found)
    if (fix.wrongSpaceRelId && fix.wrongSpaceId) {
      const delWrong = Graph.deleteRelation({ id: fix.wrongSpaceRelId });
      addOps(fix.wrongSpaceId, delWrong.ops);
    }
  }

  if (skippedDuplicates > 0) {
    log(`\n  Skipped ${skippedDuplicates} duplicate create(s)`);
  }

  // Publish per space
  for (const [spaceId, ops] of opsBySpace) {
    if (ops.length === 0) continue;
    log(`  ${spaceName.get(spaceId) ?? spaceId}: ${ops.length} ops`);
    if (!DRY_RUN) {
      await publishOps(ops, `Fix stale relations from wrong-space bug`, spaceId);
      log(`    Published.`);
    }
  }

  // ═══ Summary ═══
  log(`\n${'═'.repeat(80)}`);
  log('SUMMARY');
  log('═'.repeat(80));
  log(`  Stale relations found: ${allStale.length}`);
  log(`  Fixed: ${fixCases.length}`);
  log(`  Unfixable: ${unfixable.length}`);
  log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  let totalOps = 0;
  for (const [spaceId, ops] of opsBySpace) {
    totalOps += ops.length;
    log(`    ${spaceName.get(spaceId) ?? spaceId}: ${ops.length} ops`);
  }
  log(`  Total ops: ${totalOps}`);

  // ═══ Most frequent stale toEntityIds ═══
  log(`\n${'═'.repeat(80)}`);
  log('Most frequent stale toEntityIds');
  log('═'.repeat(80));

  const toEntityCounts = new Map<string, number>();
  for (const s of allStale) {
    toEntityCounts.set(s.toEntityId, (toEntityCounts.get(s.toEntityId) ?? 0) + 1);
  }
  const sortedToEntities = [...toEntityCounts.entries()]
    .sort((a, b) => b[1] - a[1]);

  for (const [toEntityId, count] of sortedToEntities) {
    log(`  ${count}x  ${toEntityId}`);
  }

  writeReport(lines);
}

function writeReport(lines: string[]) {
  const outPath = 'output/07_fix_stale_relations.txt';
  fs.mkdirSync('output', { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`\nReport written to ${outPath}`);
}

main().catch(console.error);
