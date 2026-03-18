import { gql } from './src/functions.js';
import { TYPES, DATA_TYPE_PROPERTY, DATA_TYPE_TO_SDK, SPACES } from './src/constants.js';

// ─── Configuration ──────────────────────────────────────────────────────────
// Finds duplicate Type and Property entities (by name, case-insensitive)
// across the listed spaces. For Properties, shows data type and flags mismatches.
// Run with: bun run 02_find_duplicates.ts

const spaceRank = new Map(SPACES.map((s, i) => [s.id, i]));
const spaceName = new Map(SPACES.map(s => [s.id, s.name]));

// ─── Types ──────────────────────────────────────────────────────────────────

interface EntityHit {
  id: string;
  name: string;
  spaceId: string;
  dataType?: string | null; // SDK type name for properties, null = relation-only
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchEntitiesOfType(typeId: string, spaceId: string): Promise<EntityHit[]> {
  const hits: EntityHit[] = [];
  let offset = 0;
  const PAGE = 100;

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
  // Try hardcoded map first, fall back to entity name (lowercased)
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
    //{ label: 'Type', typeId: TYPES.type },
    //{ label: 'Property', typeId: TYPES.property },
    { label: 'Role', typeId: "e4e366e9d5554b6892bf7358e824afd2" },
    { label: 'Skill', typeId: "9ca6ab1f3a114e49bbaf72e0c9a985cf" },
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
  }
}

main().catch(console.error);
