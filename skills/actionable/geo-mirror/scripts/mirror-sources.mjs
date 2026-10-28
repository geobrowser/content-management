#!/usr/bin/env node
// geo-mirror — Accepted sources mirror (Geo → Notion). READ-ONLY on Geo.
// "Source" is not a Geo type: it is any entity (Publisher, Project, Person, Think tank…)
// that a space has tagged "Source accepted by the space". This mirrors every such
// entity across the given spaces into ONE inline Notion database, one row per entity.
// Conventions (same as mirror-claims-topics.mjs):
//   • every column mirrored from Geo is prefixed "Geo "; tags are multi-selects, not a DB
//   • acceptance + tags are per space: "Geo URL — <space>", "Geo Tags — <space>", "Geo Accepted in"
//   • "Proposed …" columns are for AI agents; created empty and NEVER written by re-runs
//   • rows keyed by "Geo ID" → re-runs update in place, never duplicate
//
// Env:   NOTION_TOKEN
// Usage: node --env-file=.env scripts/mirror-sources.mjs --parent <NOTION_PAGE_ID> \
//          [--spaces "AI=41e8…,World affairs=89bd…"] [--db-title "Accepted sources"] [--out f.json] [--publish]
// Default spaces: AI, World affairs, Relationships, US Politics. Default is DRY RUN.
import { writeFileSync } from 'node:fs';

const GEO = 'https://api-testnet.geobrowser.io/graphql';
const NOTION = 'https://api.notion.com/v1';
const TAGS_REL = '257090341ba5406f94e4d4af90042fba';
const ACCEPTED_TAG = '044f2dc2ce504281a69afda8b5285853';   // "Source accepted by the space"
const DEFAULT_SPACES = 'AI=41e851610e13a19441c4d980f2f2ce6b,World affairs=89bd89bf28ff8a0963faf92a8c905e20,Relationships=224406e0de3c48d78ef12774111b8b2f,US Politics=4582fbbee28a16589154f7e36f1ee3c5';
// value properties mirrored as columns (present on most sources); everything else is left out
const VALUE_COLS = ['Description', 'Website', 'Wikipedia', 'X', 'LinkedIn', 'Year founded', 'RSS Feed URL', 'Editorial board URL'];
// relations mirrored as select / linked-name text columns
const SELECT_RELS = ['Credibility score', 'Relevance score'];
const LINK_RELS = ['Owners', 'Founders'];

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const parentPage = opt('--parent')?.replace(/-/g, '');
const spaces = (opt('--spaces') ?? DEFAULT_SPACES).split(',').map((s) => s.split('=').map((x) => x.trim())).map(([name, id]) => ({ name, id }));
const dbTitle = opt('--db-title') ?? 'Accepted sources';
const outFile = opt('--out');
const publish = args.includes('--publish');
const TOKEN = process.env.NOTION_TOKEN;
if (!parentPage) { console.error('usage: mirror-sources.mjs --parent <NOTION_PAGE_ID> [--spaces "Name=id,…"] [--out f.json] [--publish]'); process.exit(1); }
if (publish && !TOKEN) { console.error('NOTION_TOKEN missing from env'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gql(query, variables = {}, attempt = 0) {
  let j;
  try {
    const r = await fetch(GEO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    j = await r.json();
  } catch (err) { if (attempt >= 5) throw err; await sleep(1000 * 2 ** attempt); return gql(query, variables, attempt + 1); }
  if (j.errors) { if (attempt >= 3) throw new Error(JSON.stringify(j.errors).slice(0, 400)); await sleep(1000 * 2 ** attempt); return gql(query, variables, attempt + 1); }
  return j.data;
}
const geoUrl = (id, sp) => `https://www.geobrowser.io/space/${sp}/${id}`;
const spaceName = new Map(spaces.map((s) => [s.id, s.name]));

// ── 1. acceptance per space (the tag must be asserted IN that space) ─────────
const members = new Map();                        // entityId -> [spaceName]
for (const s of spaces) {
  let after = null; let n = 0;
  for (;;) {
    const d = await gql(`query($f: EntityFilter, $after: Cursor) { entitiesConnection(first: 100, after: $after, spaceId: "${s.id}", filter: $f) {
      pageInfo { hasNextPage endCursor } nodes { id } } }`,
    { f: { relations: { some: { typeId: { is: TAGS_REL }, toEntityId: { is: ACCEPTED_TAG }, spaceId: { is: s.id } } } }, after });
    for (const { id } of d.entitiesConnection.nodes) { const m = members.get(id) ?? []; if (!m.includes(s.name)) { m.push(s.name); n++; } members.set(id, m); }
    if (!d.entitiesConnection.pageInfo.hasNextPage) break;
    after = d.entitiesConnection.pageInfo.endCursor;
  }
  process.stderr.write(`${s.name}: ${n} accepted sources\n`);
}

// ── 2. entity detail ────────────────────────────────────────────────────────
const ids = [...members.keys()];
const sources = [];
for (let i = 0; i < ids.length; i += 20) {
  const chunk = ids.slice(i, i + 20);
  const d = await gql('{' + chunk.map((id, k) => `e${k}: entity(id: "${id}") { id name types { name }
    values(first: 80) { nodes { spaceId property { name } text datetime float integer boolean } }
    relations(first: 300) { nodes { spaceId type { name } toEntity { id name } } } }`).join(' ') + '}');
  for (const e of Object.values(d)) {
    if (!e) continue;
    const accepted = members.get(e.id);
    const acceptedIds = spaces.filter((s) => accepted.includes(s.name)).map((s) => s.id);
    // prefer values/relations asserted in an accepting space, then any space
    const rank = (sp) => (acceptedIds.includes(sp) ? 0 : 1);
    const values = {};
    for (const v of [...e.values.nodes].sort((a, b) => rank(a.spaceId) - rank(b.spaceId))) {
      const k = v.property?.name; const val = v.text ?? v.datetime ?? v.float ?? v.integer ?? v.boolean;
      if (k && val != null && !(k in values)) values[k] = String(val);
    }
    const relsOf = (type) => {
      const seen = new Set();
      return [...e.relations.nodes].filter((r) => r.type?.name === type && r.toEntity?.id)
        .sort((a, b) => rank(a.spaceId) - rank(b.spaceId))
        .filter((r) => !seen.has(r.toEntity.id) && seen.add(r.toEntity.id))
        .map((r) => ({ id: r.toEntity.id, name: r.toEntity.name, spaceId: r.spaceId }));
    };
    const tagsBySpace = {};
    for (const s of spaces) {
      tagsBySpace[s.name] = [...new Set(e.relations.nodes.filter((r) => r.type?.name === 'Tags' && r.spaceId === s.id).map((r) => r.toEntity?.name).filter(Boolean))];
    }
    sources.push({
      geoId: e.id, name: e.name, types: [...new Set(e.types.map((t) => t.name).filter(Boolean))], acceptedIn: accepted,
      urls: Object.fromEntries(spaces.filter((s) => accepted.includes(s.name)).map((s) => [s.name, geoUrl(e.id, s.id)])),
      tagsBySpace, values,
      selects: Object.fromEntries(SELECT_RELS.map((r) => [r, relsOf(r)[0]?.name ?? null])),
      links: Object.fromEntries(LINK_RELS.map((r) => [r, relsOf(r)])),
    });
  }
  process.stderr.write(`\r  fetched ${Math.min(i + 20, ids.length)}/${ids.length}`);
}
process.stderr.write('\n');
sources.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
if (outFile) { writeFileSync(outFile, JSON.stringify({ spaces, extractedAt: new Date().toISOString(), sources }, null, 2)); process.stderr.write(`wrote ${outFile}\n`); }

// ── Notion schema ───────────────────────────────────────────────────────────
const clean = (s) => String(s).replace(/,/g, ' ').slice(0, 100);
const opts = (names) => ({ options: [...new Set(names.filter(Boolean).map(clean))].sort().map((name) => ({ name })) });
const allTags = sources.flatMap((s) => Object.values(s.tagsBySpace).flat());
const allTypes = sources.flatMap((s) => s.types);
const props = {
  'Geo Name': { title: {} }, 'Geo ID': { rich_text: {} },
  'Geo Types': { multi_select: opts(allTypes) },
  'Geo Accepted in': { multi_select: opts(spaces.map((s) => s.name)) },
  ...Object.fromEntries(spaces.flatMap((s) => [[`Geo URL — ${s.name}`, { url: {} }], [`Geo Tags — ${s.name}`, { multi_select: opts(allTags) }]])),
  ...Object.fromEntries(VALUE_COLS.map((c) => [`Geo ${c}`, { rich_text: {} }])),
  ...Object.fromEntries(SELECT_RELS.map((r) => [`Geo ${r}`, { select: opts(sources.map((s) => s.selects[r])) }])),
  ...Object.fromEntries(LINK_RELS.map((r) => [`Geo ${r}`, { rich_text: {} }])),
  'Proposed rename': { rich_text: {} }, 'Proposed description': { rich_text: {} },
  'Proposed Types': { multi_select: opts(allTypes) }, 'Proposed Tags': { multi_select: opts(allTags) },
};

const count = (f) => sources.filter(f).length;
console.log(`\n${publish ? 'PUBLISH' : 'DRY RUN'} — Notion parent ${parentPage}`);
console.log(`  "${dbTitle}": ${sources.length} rows (one per Geo entity)`);
console.log(`     accepted in: ${spaces.map((s) => `${s.name} ${count((x) => x.acceptedIn.includes(s.name))}`).join(', ')}`);
console.log(`     types: ${Object.entries(allTypes.reduce((m, t) => (m[t] = (m[t] ?? 0) + 1, m), {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log(`     columns: ${Object.keys(props).join(', ')}`);
console.log(`     filled: ${[...VALUE_COLS.map((c) => `${c} ${count((s) => s.values[c])}`), ...SELECT_RELS.map((r) => `${r} ${count((s) => s.selects[r])}`), ...LINK_RELS.map((r) => `${r} ${count((s) => s.links[r].length)}`)].join(' · ')}`);
console.log(`  sample:\n${sources.slice(0, 4).map((s) => `     • ${s.name} [${s.types.join(', ')}] accepted in ${s.acceptedIn.join(', ')} — tags ${Object.entries(s.tagsBySpace).filter(([, t]) => t.length).map(([sp, t]) => `${sp}: ${t.join('; ')}`).join(' | ')}`).join('\n')}`);
if (!publish) { console.log('  Nothing written. Re-run with --publish to write.'); process.exit(0); }

// ── Notion write ────────────────────────────────────────────────────────────
let lastCall = 0;
async function notion(path, method = 'GET', body, attempt = 0) {
  const wait = 350 - (Date.now() - lastCall); if (wait > 0) await sleep(wait); lastCall = Date.now();
  let r, j;
  try {
    r = await fetch(`${NOTION}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    j = await r.json();
  } catch (err) { if (attempt >= 6) throw err; await sleep(Math.min(1000 * 2 ** attempt, 30000)); return notion(path, method, body, attempt + 1); }
  if (r.ok) return j;
  if ((r.status === 429 || r.status >= 500) && attempt < 6) { await sleep(Number(r.headers.get('retry-after')) * 1000 || Math.min(1000 * 2 ** attempt, 30000)); return notion(path, method, body, attempt + 1); }
  throw new Error(`Notion ${method} ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
}
async function findOrCreateDb() {
  const kids = []; let cur;
  do { const q = await notion(`/blocks/${parentPage}/children?page_size=100${cur ? `&start_cursor=${cur}` : ''}`); kids.push(...q.results); cur = q.has_more ? q.next_cursor : null; } while (cur);
  const hit = kids.find((b) => b.type === 'child_database' && b.child_database.title === dbTitle);
  if (hit) {
    const db = await notion(`/databases/${hit.id}`);
    const missing = Object.fromEntries(Object.entries(props).filter(([k, v]) => !db.properties[k] && !v.title));
    if (Object.keys(missing).length) await notion(`/databases/${hit.id}`, 'PATCH', { properties: missing });
    return hit.id;
  }
  return (await notion('/databases', 'POST', { parent: { type: 'page_id', page_id: parentPage }, is_inline: true, title: [{ text: { content: dbTitle } }], properties: props })).id;
}
const txt = (s) => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 1990) } }] : [] });
const ms = (names) => ({ multi_select: [...new Set(names.filter(Boolean).map(clean))].map((name) => ({ name })) });
function linkedNames(list) {
  const shown = list.slice(0, 48);
  const segs = shown.flatMap((x, i) => [
    { text: { content: (x.name ?? '(unnamed)').slice(0, 1990), link: { url: geoUrl(x.id, x.spaceId) } } },
    ...(i < shown.length - 1 ? [{ text: { content: '\n' } }] : []),
  ]);
  if (list.length > shown.length) segs.push({ text: { content: `\n… +${list.length - shown.length} more` } });
  return { rich_text: segs };
}

const dbId = await findOrCreateDb();
const rows = new Map(); const pageProps = new Map(); let cur;
do {
  const q = await notion(`/databases/${dbId}/query`, 'POST', { page_size: 100, ...(cur ? { start_cursor: cur } : {}) });
  for (const p of q.results) { const g = p.properties['Geo ID']?.rich_text?.map((t) => t.plain_text).join(''); if (g) { rows.set(g, p.id); pageProps.set(p.id, p.properties); } }
  cur = q.has_more ? q.next_cursor : null;
} while (cur);
// only write rows whose Geo values differ from what Notion already holds
const norm = (v) => {
  if (!v) return '';
  if (v.title || v.rich_text) return (v.title ?? v.rich_text).map((t) => `${t.plain_text ?? t.text?.content ?? ''}@${t.href ?? t.text?.link?.url ?? ''}`).join('');
  if ('url' in v) return v.url ?? '';
  if ('select' in v) return v.select?.name ?? '';
  if (v.multi_select) return v.multi_select.map((o) => o.name).sort().join('|');
  return JSON.stringify(v);
};
const unchanged = (pageId, properties) => { const cur = pageProps.get(pageId); return !!cur && Object.entries(properties).every(([k, w]) => cur[k] && norm(cur[k]) === norm(w)); };
const stats = { created: 0, updated: 0, unchanged: 0 };
let n = 0;
for (const s of sources) {
  const properties = {
    'Geo Name': { title: [{ text: { content: (s.name ?? '(unnamed)').slice(0, 1990) } }] }, 'Geo ID': txt(s.geoId),
    'Geo Types': ms(s.types), 'Geo Accepted in': ms(s.acceptedIn),
    ...Object.fromEntries(spaces.flatMap((sp) => [[`Geo URL — ${sp.name}`, { url: s.urls[sp.name] ?? null }], [`Geo Tags — ${sp.name}`, ms(s.tagsBySpace[sp.name])]])),
    ...Object.fromEntries(VALUE_COLS.map((c) => [`Geo ${c}`, txt(s.values[c])])),
    ...Object.fromEntries(SELECT_RELS.map((r) => [`Geo ${r}`, { select: s.selects[r] ? { name: clean(s.selects[r]) } : null }])),
    ...Object.fromEntries(LINK_RELS.map((r) => [`Geo ${r}`, linkedNames(s.links[r])])),
  };
  if (rows.has(s.geoId)) {
    if (unchanged(rows.get(s.geoId), properties)) stats.unchanged++;
    else { await notion(`/pages/${rows.get(s.geoId)}`, 'PATCH', { properties }); stats.updated++; }
  } else { rows.set(s.geoId, (await notion('/pages', 'POST', { parent: { database_id: dbId }, properties })).id); stats.created++; }
  process.stderr.write(`\r  sources ${++n}/${sources.length}`);
}
process.stderr.write('\n');
console.log(`\n✅ Mirrored ${sources.length} accepted sources`);
console.log(`   ${stats.created} created, ${stats.updated} updated, ${stats.unchanged} unchanged · rows no longer accepted (left untouched): ${[...rows.keys()].filter((g) => !sources.some((s) => s.geoId === g)).length}`);
console.log(JSON.stringify({ dbId }, null, 2));
