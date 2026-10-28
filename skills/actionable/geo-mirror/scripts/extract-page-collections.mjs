#!/usr/bin/env node
// geo-mirror — the front door for "mirror THIS Geo page into Notion".
//
// A Geo page is composed of Blocks; a Data block holds "Collection item" relations.
// Each of those blocks is what an editor sees as a named collection on the page
// ("Accepted sources", "Source materials", "Recent news"). This script reads the
// page and writes ONE ids file per collection, so each collection becomes one
// Notion database via extract-space.mjs --ids-file.
//
// Collections routinely mix entity types — 49 "Accepted sources" spanning Publisher,
// Organization, Project, Court… — so pass --any-type downstream and keep the types
// as a column. Without it extract-space keeps only the one type you named and
// silently reports the rest as off-type.
//
// READ-ONLY. Touches neither Geo nor Notion.
//
// Usage:
//   node scripts/extract-page-collections.mjs <PAGE_ID> --space <SPACE_ID> [--out-dir <dir>]
//   node scripts/extract-page-collections.mjs <PAGE_ID> --space <SPACE_ID> --only "Accepted sources"

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api-testnet.geobrowser.io/graphql';
const BLOCKS_REL = 'beaba5cba67741a8b35377030613fc70';
const COLLECTION_ITEM = 'a99f9ce12ffa4dac8c61f6310d46064a';

const args = process.argv.slice(2);
const pageId = args[0]?.replace(/-/g, '').toLowerCase();
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const spaceId = opt('--space')?.replace(/-/g, '').toLowerCase();
const outDir = opt('--out-dir', '.');
const only = opt('--only');

if (!pageId || !/^[0-9a-f]{32}$/.test(pageId)) {
  console.error('usage: extract-page-collections.mjs <PAGE_ID> --space <SPACE_ID> [--out-dir <dir>] [--only "<collection>"]\n' +
    'Both ids are the 32-hex halves of a geobrowser URL: /space/<SPACE_ID>/<PAGE_ID>');
  process.exit(1);
}
if (!spaceId) { console.error('--space <SPACE_ID> required — it is the first 32-hex id in the geobrowser URL'); process.exit(1); }

async function gql(query) {
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// A sibling "… datasets" space doubles every relation edge, so the same item comes
// back twice. Dedupe on the target id or every count is inflated.
const uniqTargets = (nodes) => {
  const seen = new Set();
  return (nodes ?? []).filter((r) => { const id = r.toEntity?.id; if (!id || seen.has(id)) return false; seen.add(id); return true; });
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'collection';

const data = await gql(`{ entity(id: "${pageId}") { name
  relations(first: 100, filter: { typeId: { is: "${BLOCKS_REL}" } }, orderBy: POSITION_ASC) {
    nodes { toEntity {
      id name
      values(first: 10) { nodes { property { name } text } }
      relations(first: 500, filter: { typeId: { is: "${COLLECTION_ITEM}" } }, orderBy: POSITION_ASC) {
        nodes { toEntity { id name types { name } spaceIds } }
      }
    } }
  } } }`);

if (!data.entity) { console.error(`entity ${pageId} not found`); process.exit(2); }
const pageName = data.entity.name ?? '(page)';
const blocks = uniqTargets(data.entity.relations.nodes)
  .map((r) => {
    const b = r.toEntity;
    const v = b.values.nodes;
    return {
      heading: v.find((x) => x.property.name === 'Name')?.text ?? b.name ?? '(untitled block)',
      items: uniqTargets(b.relations.nodes).map((ci) => ({
        geoId: ci.toEntity.id,
        name: ci.toEntity.name,
        types: (ci.toEntity.types ?? []).map((t) => t.name),
        foreign: !(ci.toEntity.spaceIds ?? []).includes(spaceId),
      })),
    };
  })
  .filter((b) => b.items.length);          // text-only blocks hold no collection

if (!blocks.length) {
  console.error(`"${pageName}" has no collections — no block on it holds Collection item relations.\n` +
    'Mirror it by type instead (extract-space.mjs --type … with a scope), or check you passed the page id, not the space id.');
  process.exit(2);
}

const wanted = only ? blocks.filter((b) => b.heading.toLowerCase() === only.toLowerCase()) : blocks;
if (only && !wanted.length) {
  console.error(`--only "${only}" matched no collection. Found: ${blocks.map((b) => `"${b.heading}"`).join(', ')}`);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
console.log(`Page: ${pageName}`);
console.log(`Space: ${spaceId}\n`);

const written = [];
for (const b of wanted) {
  const typeCount = {};
  for (const i of b.items) for (const t of i.types) typeCount[t] = (typeCount[t] ?? 0) + 1;
  const types = Object.entries(typeCount).sort((a, c) => c[1] - a[1]);
  const file = join(outDir, `${slug(b.heading)}.ids.json`);
  writeFileSync(file, JSON.stringify({ collection: b.heading, page: pageId, space: spaceId, count: b.items.length, ids: b.items.map((i) => i.geoId) }, null, 2));
  const foreign = b.items.filter((i) => i.foreign).length;
  written.push({ heading: b.heading, file, count: b.items.length, mixed: types.length > 1, foreign });
  console.log(`"${b.heading}" — ${b.items.length} items, ${types.length} type(s)`);
  console.log(`  types: ${types.map(([t, n]) => `${t} ${n}`).join(' · ')}`);
  if (foreign) console.log(`  ⚠ ${foreign} of ${b.items.length} live in ANOTHER space — pass --any-space or they are dropped`);
  console.log(`  first: ${b.items.slice(0, 3).map((i) => i.name).join(' | ')}`);
  console.log(`  → ${file}\n`);
}

console.log('Next — one database per collection. Show the editor these counts first:\n');
for (const w of written) {
  const label = w.heading.replace(/"/g, '');
  const flags = `${w.mixed ? '--any-type ' : ''}${w.foreign ? '--any-space ' : ''}`;
  console.log(`# ${label} (${w.count} items${w.mixed ? ', mixed types' : ''}${w.foreign ? `, ${w.foreign} from other spaces` : ''})`);
  console.log(`node scripts/extract-space.mjs ${spaceId} --ids-file ${w.file} ${flags}--label "${label}" --out ${w.file.replace(/\.ids\.json$/, '')}.extract.json`);
  console.log(`node --env-file=.env scripts/mirror-to-notion.mjs ${w.file.replace(/\.ids\.json$/, '')}.extract.json --parent <NOTION_PAGE_ID> --dry-run`);
  console.log('');
}
console.log('Every populated Geo property becomes a Notion COLUMN. The page body is extra, never\n' +
  'the only home for a value — if you find yourself writing properties into the body, stop.');
