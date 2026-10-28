#!/usr/bin/env node
// geo-mirror — Notion write half. TYPE-GENERIC: mirrors the generic extract JSON
// into ONE linked Notion database PER entity type (primary type first, then each
// related type — Claim, Person, Article, Topic, …). Every row keyed by Geo ID so
// re-runs UPDATE IN PLACE and Part 2 can diff. Needs a Notion integration token +
// a parent page the integration is shared into.
//
// Env:  NOTION_TOKEN=secret_...
// Usage: node scripts/mirror-to-notion.mjs <extract.json> --parent <PAGE_ID> [--dry-run]
import { readFileSync } from 'node:fs';

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const TOKEN = process.env.NOTION_TOKEN;
const args = process.argv.slice(2);
const jsonFile = args[0];
const parentPage = (() => { const i = args.indexOf('--parent'); return i >= 0 ? args[i + 1] : process.env.NOTION_PARENT_PAGE; })();
const dryRun = args.includes('--dry-run');
if (!jsonFile || jsonFile.startsWith('--')) { console.error('usage: mirror-to-notion.mjs <extract.json> --parent <PAGE_ID> [--dry-run]'); process.exit(1); }
if (!dryRun && !TOKEN) { console.error('NOTION_TOKEN missing from env'); process.exit(1); }
if (!dryRun && !parentPage) { console.error('--parent <PAGE_ID> required'); process.exit(1); }

const data = JSON.parse(readFileSync(jsonFile, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notion(path, method = 'GET', body, attempt = 0) {
  let r, j;
  try {
    r = await fetch(`${NOTION}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    j = await r.json();
  } catch (err) { if (attempt >= 6) throw err; await sleep(Math.min(1000 * 2 ** attempt, 30000)); return notion(path, method, body, attempt + 1); }
  if (r.ok) return j;
  if ((r.status === 429 || r.status >= 500) && attempt < 6) {
    const wait = Number(r.headers.get('retry-after')) * 1000 || Math.min(1000 * 2 ** attempt, 30000);
    process.stderr.write(`\n  ⟳ Notion ${r.status} — retry ${attempt + 1}/6 in ${Math.round(wait / 1000)}s\n`); await sleep(wait); return notion(path, method, body, attempt + 1);
  }
  throw new Error(`Notion ${method} ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
}

// ── Geo dataType → Notion column type + value formatter ─────────────────────
const isUrl = (v) => typeof v === 'string' && /^https?:\/\//.test(v);
function colType(dataType, sampleVal) {
  switch ((dataType || '').toLowerCase()) {
    case 'datetime': case 'date': case 'time': return 'date';
    case 'float': case 'integer': case 'number': return 'number';
    case 'checkbox': case 'boolean': return 'checkbox';
    case 'url': return 'url';
    case 'text': return 'rich_text';
    default: return isUrl(sampleVal) ? 'url' : 'rich_text';   // e.g. "Audio URL" (null dataType)
  }
}
const clip = (s) => String(s ?? '').slice(0, 1900);
function fmt(type, v) {
  if (v == null || v === '') return type === 'checkbox' ? { checkbox: false } : { [type]: type === 'rich_text' ? [] : null };
  switch (type) {
    case 'title': return { title: [{ text: { content: clip(v) } }] };
    case 'rich_text': return { rich_text: [{ text: { content: clip(v) } }] };
    case 'date': return { date: { start: v } };
    case 'number': return { number: Number(v) };
    case 'checkbox': return { checkbox: Boolean(v) };
    case 'multi_select': return { multi_select: (Array.isArray(v) ? v : [v]).filter(Boolean).map((n) => ({ name: String(n).slice(0, 100).replace(/,/g, ' ') })) };
    case 'url': return { url: String(v) };
    default: return { rich_text: [{ text: { content: clip(v) } }] };
  }
}

// ── gather entities by type: primary + each related type ────────────────────
const primaryType = data.type.name;
const byType = new Map();               // typeName -> [ {geoId, name, values} ]
byType.set(primaryType, data.entities.map((e) => ({ geoId: e.geoId, name: e.name, values: e.values, _primary: true, _src: e })));
for (const [id, r] of Object.entries(data.related || {})) {
  const t = r.typeName || '(entity)';
  if (!byType.has(t)) byType.set(t, []);
  byType.get(t).push({ geoId: id, name: r.name, values: r.values });
}
// column set per type = union of scalar value prop names (Name handled as title)
function columnsFor(entities) {
  const cols = new Map();               // propName -> { type }
  for (const e of entities) for (const [k, v] of Object.entries(e.values || {})) {
    if (k === 'Name') continue;
    if (!cols.has(k)) cols.set(k, { type: colType(v.dataType, v.value) });
  }
  return cols;
}
// which related type does each primary relation name point at? (for link columns)
// ONLY relations whose targets were enriched into their own DB (core-linked) get
// a relation column — otherwise you'd get an always-empty column (e.g. Related
// stories when related stories aren't mirrored as rows).
const relTargetType = new Map();        // relationName -> targetTypeName
for (const e of data.entities) for (const [rname, list] of Object.entries(e.relations || {})) {
  const linked = list.find((x) => data.related?.[x.geoId]);
  if (linked) relTargetType.set(rname, data.related[linked.geoId].typeName);
}

const REVIEW = { select: { options: [{ name: 'To review', color: 'yellow' }, { name: 'Reviewed', color: 'green' }, { name: 'Edited in Notion', color: 'orange' }] } };

// ── dry-run: print the plan ─────────────────────────────────────────────────
if (dryRun) {
  console.log(`DRY RUN — mirror into Notion under ${parentPage ?? '(unset)'}:`);
  console.log(`  Space: ${data.space.name} · primary type: ${primaryType}`);
  console.log(`  Databases (one per type, primary first):`);
  const order = [primaryType, ...[...byType.keys()].filter((t) => t !== primaryType)];
  for (const t of order) {
    const ents = byType.get(t); const cols = [...columnsFor(ents).keys()];
    console.log(`    • Geo ${t} — ${data.space.name}: ${ents.length} rows | cols: ${['Name', ...cols].join(', ')}`);
  }
  console.log(`  Primary relation links: ${[...relTargetType.entries()].map(([r, t]) => `${r}→${t}`).join(', ') || '(none)'}`);
  console.log('  Nothing written (dry run).');
  process.exit(0);
}

// ── find-or-create an inline DB by title ────────────────────────────────────
async function findOrCreateDb(dbTitle, properties) {
  const found = await notion('/search', 'POST', { query: dbTitle, filter: { property: 'object', value: 'database' } });
  const hit = found.results.find((d) => d.title?.[0]?.plain_text === dbTitle && d.parent?.page_id?.replace(/-/g, '') === parentPage.replace(/-/g, ''));
  if (hit) { if (hit.is_inline === false) await notion(`/databases/${hit.id}`, 'PATCH', { is_inline: true }); return hit.id; }
  const created = await notion('/databases', 'POST', { parent: { type: 'page_id', page_id: parentPage }, is_inline: true, title: [{ text: { content: dbTitle } }], properties });
  return created.id;
}
async function upsert(dbId, geoId, properties, extra = {}) {
  const q = await notion(`/databases/${dbId}/query`, 'POST', { filter: { property: 'Geo ID', rich_text: { equals: geoId } }, page_size: 1 });
  const body = { properties, ...extra };
  if (q.results[0]) { await notion(`/pages/${q.results[0].id}`, 'PATCH', body); return q.results[0].id; }
  const p = await notion('/pages', 'POST', { parent: { database_id: dbId }, ...body }); return p.id;
}
const imageCover = (u) => u ? { cover: { type: 'external', external: { url: u } }, icon: { type: 'external', external: { url: u } } } : {};

// body blocks for a primary entity: description/summary → grouped page Blocks → relations
const rt = (t, link) => t ? [{ type: 'text', text: { content: clip(t), link: link ? { url: link } : null } }] : [];
const h2 = (t) => ({ object: 'block', type: 'heading_2', heading_2: { rich_text: rt(t) } });
const para = (t) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(t) } });
const bullet = (t, link) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(t, link) } });
function bodyBlocks(e) {
  const b = [];
  const desc = e.values?.Description?.value, sum = e.values?.Summary?.value;
  if (desc) b.push(para(desc));
  if (sum) { b.push(h2('Summary')); b.push(para(sum)); }
  if (e.blocks?.length) for (const sec of e.blocks) { if (sec.heading) b.push(h2(sec.heading)); if (sec.description) b.push(para(sec.description)); for (const it of (sec.items || [])) b.push(bullet(it.name)); }
  // relations not already shown as page-block sections
  for (const [rname, list] of Object.entries(e.relations || {})) {
    if (['Types', 'Cover', 'Avatar', 'Blocks', 'Notable claims'].includes(rname)) continue;
    if (!list.length) continue;
    b.push(h2(rname));
    for (const t of list) b.push(bullet(t.name));
  }
  return b;
}
async function replaceChildren(pageId, children) {
  const ex = await notion(`/blocks/${pageId}/children?page_size=100`);
  for (const blk of ex.results) await notion(`/blocks/${blk.id}`, 'DELETE');
  for (let i = 0; i < children.length; i += 100) await notion(`/blocks/${pageId}/children`, 'PATCH', { children: children.slice(i, i + 100) });
}

// A mixed-type collection (--any-type) lands in ONE database, so the Geo types stop
// being the database name and have to survive as a column instead.
const TYPES_COL = 'Geo types';
const FOREIGN_COL = 'Other space';   // resident elsewhere: read-only, never rename or sync back
const anyForeign = data.entities.some((e) => e.foreignSpace);
const mixedTypes = new Set(data.entities.flatMap((e) => e.typeNames ?? []));
const keepTypesCol = (data.type?.anyType === true) && mixedTypes.size > 0;

// ── create DBs: primary first, then related types; relations patched after ──
process.stderr.write('Creating databases…\n');
const sfx = ` — ${data.space.name}`;
const order = [primaryType, ...[...byType.keys()].filter((t) => t !== primaryType)];
const dbIds = new Map(); const dbCols = new Map();
for (const t of order) {
  const cols = columnsFor(byType.get(t)); dbCols.set(t, cols);
  const props = { Name: { title: {} }, 'Geo ID': { rich_text: {} }, 'Geo URL': { url: {} }, 'Review status': REVIEW };
  for (const [name, { type }] of cols) props[name] = { [type]: {} };
  if (t === primaryType) props.Cover = { url: {} };
  if (t === primaryType && keepTypesCol) props[TYPES_COL] = { multi_select: {} };
  if (t === primaryType && anyForeign) props[FOREIGN_COL] = { checkbox: {} };
  const title = (t === primaryType && data.type?.label) ? `${t}${sfx}` : `Geo ${t}${sfx}`;
  dbIds.set(t, await findOrCreateDb(title, props));
  process.stderr.write(`  ${title}: ${dbIds.get(t)}\n`);
}
// add relation columns on the primary DB now that target DBs exist
const relProps = {};
for (const [rname, ttype] of relTargetType) if (dbIds.get(ttype)) relProps[rname] = { relation: { database_id: dbIds.get(ttype), single_property: {} } };
if (Object.keys(relProps).length) await notion(`/databases/${dbIds.get(primaryType)}`, 'PATCH', { properties: relProps });

// ── upsert related types first (so primary can link them), then primary ─────
const pageIdByGeo = new Map();
for (const t of order.filter((x) => x !== primaryType)) {
  const cols = dbCols.get(t); const ents = byType.get(t);
  process.stderr.write(`${t} (${ents.length})…\n`);
  for (const e of ents) {
    const props = { Name: fmt('title', e.name), 'Geo ID': fmt('rich_text', e.geoId), 'Geo URL': fmt('url', `https://www.geobrowser.io/space/${data.space.id}/${e.geoId}`), 'Review status': { select: { name: 'To review' } } };
    for (const [name, { type }] of cols) props[name] = fmt(type, e.values?.[name]?.value);
    pageIdByGeo.set(e.geoId, await upsert(dbIds.get(t), e.geoId, props));
  }
}
const primaryRows = byType.get(primaryType);
process.stderr.write(`${primaryType} (${primaryRows.length})…\n`);
const cols = dbCols.get(primaryType);
let n = 0;
for (const row of primaryRows) {
  const e = row._src ?? row;            // _src = full primary entity; else a same-type related stub
  const props = { Name: fmt('title', e.name), 'Geo ID': fmt('rich_text', e.geoId), 'Geo URL': fmt('url', `https://www.geobrowser.io/space/${data.space.id}/${e.geoId}`), 'Review status': { select: { name: 'To review' } }, Cover: fmt('url', e.coverUrl) };
  for (const [name, { type }] of cols) props[name] = fmt(type, e.values?.[name]?.value);
  if (keepTypesCol) props[TYPES_COL] = fmt('multi_select', e.typeNames ?? []);
  if (anyForeign) props[FOREIGN_COL] = { checkbox: Boolean(e.foreignSpace) };
  if (row._src) for (const [rname] of relTargetType) {   // relation links only exist on full primaries
    if (!relProps[rname]) continue;
    const ids = (e.relations?.[rname] || []).map((x) => pageIdByGeo.get(x.geoId)).filter(Boolean);
    props[rname] = { relation: ids.map((id) => ({ id })) };
  }
  const pageId = await upsert(dbIds.get(primaryType), e.geoId, props, imageCover(e.coverUrl));
  if (row._src) await replaceChildren(pageId, bodyBlocks(e));   // rich body only for full primaries
  pageIdByGeo.set(e.geoId, pageId);
  process.stderr.write(`\r  ${primaryType} ${++n}/${primaryRows.length}`);
}
process.stderr.write('\n');
process.stderr.write(`\n✅ Mirrored ${data.space.name}: ${order.map((t) => `${byType.get(t).length} ${t}`).join(', ')}\n`);
console.log(JSON.stringify(Object.fromEntries([...dbIds.entries()].map(([t, id]) => [t, id])), null, 2));
