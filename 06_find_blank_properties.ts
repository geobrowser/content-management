import { gql } from './src/functions.js';
import { SPACES } from './src/constants.js';
import * as fs from 'fs';

// ─── Configuration ──────────────────────────────────────────────────────────
// Finds Type entities that have at least one "Properties" relation pointing
// to an entity with a blank (empty/whitespace-only) name.
//
// Type (entity type):     e7d737c536764c609fa16aa64a8c90ad
// Properties (property):  01412f8381894ab1836565c7fd358cc1
//
// Run with: bun run 06_find_blank_properties.ts

const TYPE_TYPE_ID = 'e7d737c536764c609fa16aa64a8c90ad';
const PROPERTIES_PROPERTY_ID = '01412f8381894ab1836565c7fd358cc1';

interface BlankPropertyHit {
  typeEntityId: string;
  typeEntityName: string;
  blankPropertyEntityId: string;
}

async function fetchTypeEntities(spaceId: string): Promise<Array<{ id: string; name: string }>> {
  const all: Array<{ id: string; name: string }> = [];
  let offset = 0;
  const PAGE = 100;

  while (true) {
    const data = await gql(`{
      entities(
        spaceId: "${spaceId}"
        typeId: "${TYPE_TYPE_ID}"
        first: ${PAGE}
        offset: ${offset}
      ) {
        id
        name
      }
    }`);

    const entities = data.entities ?? [];
    all.push(...entities);
    if (entities.length < PAGE) break;
    offset += PAGE;
  }

  return all;
}

async function getBlankPropertyTargets(typeEntityId: string, spaceId: string): Promise<string[]> {
  const blankIds: string[] = [];
  let offset = 0;
  const PAGE = 100;

  while (true) {
    const data = await gql(`{
      relations(
        filter: {
          fromEntityId: { is: "${typeEntityId}" }
          typeId: { is: "${PROPERTIES_PROPERTY_ID}" }
          spaceId: { is: "${spaceId}" }
        }
        first: ${PAGE}
        offset: ${offset}
      ) {
        toEntityId
        toEntity { name }
      }
    }`);

    const rels = data.relations ?? [];
    for (const rel of rels) {
      //const targetSpaces: string[] = rel.toEntity?.spaceIds ?? [];
      //if (!targetSpaces.includes(spaceId)) continue;

      const name = (rel.toEntity?.name ?? '').trim();
      if (!name) {
        blankIds.push(rel.toEntityId);
      }
    }

    if (rels.length < PAGE) break;
    offset += PAGE;
  }

  return blankIds;
}

async function main() {
  let grandTotal = 0;
  const lines: string[] = [];

  const log = (msg: string = '') => {
    console.log(msg);
    lines.push(msg);
  };

  for (const space of SPACES) {
    log(`\n${'='.repeat(70)}`);
    log(`Space: ${space.name} (${space.id})`);
    log(`${'='.repeat(70)}`);

    const typeEntities = await fetchTypeEntities(space.id);
    log(`  Found ${typeEntities.length} Type entities`);

    const hits: BlankPropertyHit[] = [];

    for (const te of typeEntities) {
      const blankIds = await getBlankPropertyTargets(te.id, space.id);
      for (const blankId of blankIds) {
        hits.push({
          typeEntityId: te.id,
          typeEntityName: te.name ?? '(unnamed)',
          blankPropertyEntityId: blankId,
        });
      }
    }

    if (hits.length === 0) {
      log(`  No Type entities with blank-name Properties relations.\n`);
      continue;
    }

    log(`  ${hits.length} blank-name Properties relation(s):\n`);
    grandTotal += hits.length;

    for (const hit of hits) {
      log(`  Type: "${hit.typeEntityName}"  (${hit.typeEntityId})`);
      log(`    -> blank Property entity: ${hit.blankPropertyEntityId}`);
    }
    log();
  }

  log(`\nTotal across all spaces: ${grandTotal} blank-name Properties relation(s)`);

  const outPath = 'output/06_blank_properties.txt';
  fs.mkdirSync('output', { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`\nResults written to ${outPath}`);
}

main().catch(console.error);
