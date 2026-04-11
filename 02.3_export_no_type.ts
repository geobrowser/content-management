import * as fs from 'fs';
import { gql } from './src/functions.js';
import { SPACES } from './src/constants.js';

// ─── Configuration ──────────────────────────────────────────────────────────
// Exports ALL no-type entities from all spaces into a single CSV file.
// Uses the same gql() as other scripts + retry wrapper + delays.
// Run once, then use the CSV to match against typed duplicates.
//   bun run 02.3_export_no_type.ts

const OUTPUT_FILE = './no_type_entities.csv';
const PAGE_SIZE = 25;
const DELAY_BETWEEN_PAGES = 2000;
const DELAY_BETWEEN_SPACES = 5000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface NoTypeEntity {
  id: string;
  name: string;
  spaceId: string;
  spaceName: string;
}

// ─── Fetch no-type entities for a space ─────────────────────────────────────

async function fetchNoTypeEntities(spaceId: string, sName: string): Promise<NoTypeEntity[]> {
  const results: NoTypeEntity[] = [];
  let lastId = '';
  let consecutiveErrors = 0;

  while (true) {
    // Keyset pagination: filter by id > lastId to avoid offset-based scanning.
    // The offset approach times out on NULL type filters at higher offsets.
    const idFilter = lastId ? `, id: { greaterThan: "${lastId}" }` : '';
    try {
      const data = await gql(`{
        entities(
          spaceId: "${spaceId}"
          filter: { typeIds: { isNull: true }${idFilter} }
          first: ${PAGE_SIZE}
        ) {
          id
          name
        }
      }`);

      const entities = data.entities ?? [];

      for (const e of entities) {
        const name = (e.name ?? '').trim();
        if (!name) continue;
        results.push({ id: e.id, name, spaceId, spaceName: sName });
      }

      consecutiveErrors = 0;

      if (entities.length < PAGE_SIZE) break;
      lastId = entities[entities.length - 1].id;

      await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));
    } catch (err: any) {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        console.log(`    ❌ Stopped after 3 consecutive page failures (got ${results.length} entities)`);
        break;
      }
      console.log(`    ⚠ Page failed, waiting 5s before next attempt...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  return results;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const allEntities: NoTypeEntity[] = [];

  console.log(`Exporting [NO TYPE] entities from ${SPACES.length} spaces...\n`);

  for (const space of SPACES) {
    console.log(`  ${space.name} (${space.id})...`);
    const entities = await fetchNoTypeEntities(space.id, space.name);
    console.log(`    → ${entities.length} no-type entities\n`);
    allEntities.push(...entities);
    await new Promise(r => setTimeout(r, DELAY_BETWEEN_SPACES));
  }

  // Write CSV
  const header = 'id,name,spaceId,spaceName';
  const rows = allEntities.map(e => {
    const escapeName = e.name.includes(',') || e.name.includes('"')
      ? `"${e.name.replace(/"/g, '""')}"`
      : e.name;
    return `${e.id},${escapeName},${e.spaceId},${e.spaceName}`;
  });

  const csv = [header, ...rows].join('\n');
  fs.writeFileSync(OUTPUT_FILE, csv, 'utf-8');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Exported ${allEntities.length} no-type entities to ${OUTPUT_FILE}`);
  console.log(`${'='.repeat(60)}`);

  const bySpace = new Map<string, number>();
  for (const e of allEntities) {
    bySpace.set(e.spaceName, (bySpace.get(e.spaceName) ?? 0) + 1);
  }
  for (const [name, count] of [...bySpace.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}`);
  }
}

main().catch(console.error);
