// geo-mirror Part 2 — SYNC (plan → Geo). Publishes reviewed Notion edits back to
// Geo as updateEntity ops, through the repo's canonical publishOps (personal-vs-DAO
// routing + circuit-breaker). DRY_RUN by default — flip to publish only after the
// editor reviews the diff (the geo-publish two-phase gate: dry-run → confirm).
//
// Run (Node, NOT Bun — Bun's fetch hits a bug on the geo API host):
//   node --env-file=.env scripts/sync-to-geo.mjs <plan.json>              # dry-run
//   node --env-file=.env scripts/sync-to-geo.mjs <plan.json> --publish    # write
import { readFileSync } from 'node:fs';
import { Graph } from '@geoprotocol/geo-sdk';
import { publishOps } from '../../../../src/functions.ts';

const args = process.argv.slice(2);
const planFile = args[0];
const DRY_RUN = !args.includes('--publish');
if (!planFile || planFile.startsWith('--')) { console.error('usage: node --env-file=.env sync-to-geo.mjs <plan.json> [--publish]'); process.exit(1); }

const { space, plan, previewOnly } = JSON.parse(readFileSync(planFile, 'utf8'));
if (!plan?.length) { console.log('Plan is empty — nothing to sync.'); process.exit(0); }
if (previewOnly && !DRY_RUN) {
  console.error('This plan was built with --preview-all (unapproved proposals). Approve rows and build a real plan before publishing.');
  process.exit(2);
}

// GRC-20 value type for a Geo dataTypeName (v1 handles text-ish fields + URLs)
function valueType(dataType) {
  switch ((dataType || 'Text').toLowerCase()) {
    case 'text': return 'text';
    case 'url': return 'text';        // Web URL is stored as Text on Geo
    case 'checkbox': case 'boolean': return 'checkbox';
    case 'number': return 'number';
    case 'time': case 'datetime': case 'date': return 'time';
    default: return 'text';
  }
}

// build one updateEntity op per changed entity (all its changed values in one op)
const bySpace = new Map();
let opCount = 0;
for (const p of plan) {
  const values = p.changes
    .filter((c) => c.propertyId)
    .map((c) => ({ property: c.propertyId, type: valueType(c.dataType), value: c.new }));
  if (!values.length) continue;
  const { ops } = Graph.updateEntity({ id: p.geoId, values });
  if (!bySpace.has(p.spaceId)) bySpace.set(p.spaceId, []);
  bySpace.get(p.spaceId).push(...ops);
  opCount += ops.length;
}

console.log(`\n${DRY_RUN ? 'DRY RUN' : 'PUBLISH'} — sync ${plan.length} entities (${opCount} ops) back to Geo`);
for (const p of plan.slice(0, 20)) {
  console.log(`  [${p.db}] ${p.geoId}`);
  for (const c of p.changes) console.log(`    ${c.property}: → "${String(c.new).slice(0, 60)}"`);
}
if (plan.length > 20) console.log(`  … ${plan.length - 20} more`);

if (DRY_RUN) {
  console.log('\n(DRY RUN — nothing written. Re-run with --publish after review.)');
  process.exit(0);
}

for (const [spaceId, ops] of bySpace) {
  console.log(`\nPublishing ${ops.length} ops to space ${spaceId}…`);
  const result = await publishOps(ops, `Notion sync — ${space?.name ?? spaceId}`, spaceId);
  console.log(result ? `  ✅ ${result}` : '  ⚠ skipped (space not yours / not an editor)');
}
console.log(`\nView: https://www.geobrowser.io/space/${space?.id ?? [...bySpace.keys()][0]}`);
