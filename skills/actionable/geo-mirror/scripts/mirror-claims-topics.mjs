#!/usr/bin/env node
// geo-mirror — Claims + Topics mirror (Geo → Notion). READ-ONLY on Geo.
// Mirrors a space's curated Debate-claims tab and Topics tab into TWO linked
// inline Notion databases under a parent page:
//   • "<Space> claims" — claims tagged Debate or Featured (Tags → multi-select)
//   • "<Space> topics" — tab topics + every topic those claims link to
// Conventions:
//   • every column mirrored from Geo is prefixed "Geo " (Geo Name, Geo Tags, …)
//   • "Proposed …" columns are for AI agents; the mirror creates them empty and
//     NEVER writes them on re-runs (upsert only touches Geo-prefixed columns)
//   • rows keyed by "Geo ID" → re-runs update in place, never duplicate
//
// Env:   NOTION_TOKEN
// Usage: node --env-file=.env scripts/mirror-claims-topics.mjs \
//          --space <SPACE_ID> --claims-tab <PAGE_ID> --topics-tab <PAGE_ID> \
//          --parent <NOTION_PAGE_ID> --added-since YYYY-MM-DD [--db-prefix "AI"] [--out extract.json] [--publish]
// DB titles: "<space name> claims" / "<space name> topics" (override prefix with --db-prefix)
// Scope (REQUIRED, never mirror a whole space):
//   --added-since   claims whose Collection-item relation (= when they were added to
//                   the tab) was created on/after this date. Topics tab is small and
//                   always mirrored whole.
//   --all-tab       explicit override: every claim on the tab
// Default is DRY RUN (extract + plan, no Notion writes). --publish writes.
import { writeFileSync } from 'node:fs';

const GEO = 'https://api-testnet.geobrowser.io/graphql';
const NOTION = 'https://api.notion.com/v1';
const BLOCKS_REL = 'beaba5cba67741a8b35377030613fc70';
const COLLECTION_ITEM = 'a99f9ce12ffa4dac8c61f6310d46064a';
const SCOPE_TAGS = ['Debate', 'Featured'];

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const spaceId = opt('--space');
const claimsTab = opt('--claims-tab');
const topicsTab = opt('--topics-tab');
const parentPage = opt('--parent')?.replace(/-/g, '');
const addedSince = opt('--added-since');
const allTab = args.includes('--all-tab');
const outFile = opt('--out');
const publish = args.includes('--publish');
// --skip-hierarchy: leave Geo Broader topics alone (for DBs that store the two Geo directions separately)
const skipHierarchy = args.includes('--skip-hierarchy');
const TOKEN = process.env.NOTION_TOKEN;

// SPACE mode (no tabs): every Claim in the space tagged Debate/Featured + every Topic in the space
const spaceMode = !claimsTab && !topicsTab;
if (!spaceId || !parentPage || (!spaceMode && (!claimsTab || !topicsTab))) {
  console.error('usage: mirror-claims-topics.mjs --space <ID> --parent <NOTION_PAGE_ID> [--claims-tab <ID> --topics-tab <ID> (--added-since YYYY-MM-DD | --all-tab)] [--out f.json] [--publish]');
  process.exit(1);
}
if (!spaceMode && !addedSince && !allTab) { console.error('REFUSING: pass --added-since YYYY-MM-DD (or --all-tab to deliberately mirror every claim on the tab).'); process.exit(2); }
if (publish && !TOKEN) { console.error('NOTION_TOKEN missing from env'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gql(query, variables = {}, attempt = 0) {
  let j;
  try {
    const r = await fetch(GEO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    j = await r.json();                          // gateway resets return non-JSON text
  } catch (err) {
    if (attempt >= 5) throw err;
    await sleep(1000 * 2 ** attempt);
    return gql(query, variables, attempt + 1);
  }
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}
const uniqBy = (arr, key) => { const s = new Set(); return arr.filter((x) => { const k = key(x); if (!k || s.has(k)) return false; s.add(k); return true; }); };
const geoUrl = (id, sp = spaceId) => `https://www.geobrowser.io/space/${sp}/${id}`;

// ── 1. tab membership: block → items (with when they were added) ────────────
// Collection blocks list items by hand (Collection item relations). Query blocks
// store a Filter JSON — {"spaceId":{"in":[…]},"filter":{"<relationTypeId>":{"is"|"in":…}}} —
// evaluated here with relations scoped to the filter's spaces (what the space tab shows).
async function queryBlockItems(filterJson) {
  const f = JSON.parse(filterJson);
  const spaces = f.spaceId?.in ?? [spaceId];
  const and = Object.entries(f.filter ?? {}).map(([typeId, c]) => ({
    relations: { some: { typeId: { is: typeId }, toEntityId: c.in ? { in: c.in } : { is: c.is }, spaceId: { in: spaces } } },
  }));
  const ids = []; let after = null;
  for (;;) {
    const d = await gql(`query($f: EntityFilter, $after: Cursor, $spaces: [UUID!]) { entitiesConnection(first: 200, after: $after, spaceIds: { in: $spaces }, filter: $f) {
      pageInfo { hasNextPage endCursor } nodes { id } } }`, { f: { and }, after, spaces });
    ids.push(...d.entitiesConnection.nodes.map((n) => n.id));
    if (!d.entitiesConnection.pageInfo.hasNextPage) break;
    after = d.entitiesConnection.pageInfo.endCursor;
  }
  return ids;
}
async function tabItems(tabId) {
  const d = await gql(`{ entity(id: "${tabId}") { name relations(first: 200, filter: { typeId: { is: "${BLOCKS_REL}" } }, orderBy: POSITION_ASC) { nodes {
    toEntity { id name values(first: 10) { nodes { property { name } text } }
      relations(first: 500, filter: { typeId: { is: "${COLLECTION_ITEM}" } }, orderBy: POSITION_ASC) { nodes { entity { createdAt } toEntity { id } } } } } } } }`);
  if (!d.entity) throw new Error(`tab ${tabId} not found`);
  const items = new Map();                       // id -> { blocks:[], addedAt }
  for (const { toEntity: b } of uniqBy(d.entity.relations.nodes, (n) => n.toEntity?.id)) {
    const filter = b.values.nodes.find((v) => v.property.name === 'Filter')?.text;
    const nodes = b.relations.nodes.length || !filter
      ? b.relations.nodes
      : (await queryBlockItems(filter)).map((id) => ({ toEntity: { id }, entity: null }));   // query block: no add date
    for (const r of nodes) {
      const id = r.toEntity?.id; if (!id) continue;
      const added = Number(r.entity?.createdAt ?? 0);
      const it = items.get(id) ?? { blocks: [], addedAt: added };
      if (!it.blocks.includes(b.name)) it.blocks.push(b.name);
      it.addedAt = Math.max(it.addedAt, added);
      items.set(id, it);
    }
  }
  return { name: d.entity.name, items };
}

// ── 2. entity detail (values + Tags/Topics/hierarchy relations) ──────────────
// claim relations mirrored as "Geo <name>" linked-name text columns (targets are
// mostly outside the mirrored set — arguments, articles, people — so no extra DBs)
const CLAIM_LINK_RELS = ['Supporting arguments', 'Opposing arguments', 'Related people', 'Related projects', 'Sources'];
const REL_KEEP = new Set(['Tags', 'Topics', 'Broader topics', 'Subtopics', ...CLAIM_LINK_RELS]);
async function fetchEntities(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const q = '{' + chunk.map((id, k) => `e${k}: entity(id: "${id}") { id name spaceIds types { name }
      values(first: 50) { nodes { spaceId property { name dataTypeName } text datetime float integer boolean } }
      relations(first: 300) { nodes { spaceId type { name } toEntity { id name } } } }`).join(' ') + '}';
    const d = await gql(q);
    chunk.forEach((id, k) => { if (d[`e${k}`]) out.set(id, d[`e${k}`]); });
    process.stderr.write(`\r  fetched ${Math.min(i + 25, ids.length)}/${ids.length}`);
  }
  process.stderr.write('\n');
  return out;
}
// per-space value wins; fall back to any space (sibling dataset spaces)
function scalars(e) {
  const out = {};
  const nodes = [...e.values.nodes].sort((a, b) => (b.spaceId === spaceId) - (a.spaceId === spaceId));
  for (const v of nodes) {
    const k = v.property.name; if (k in out) continue;
    const val = v.text ?? v.datetime ?? v.float ?? v.integer ?? v.boolean;
    if (val != null) out[k] = { value: val, dataType: v.property.dataTypeName };
  }
  return out;
}
function rels(e) {
  const out = {};
  for (const r of uniqBy(e.relations.nodes.filter((n) => REL_KEEP.has(n.type?.name)), (n) => `${n.type.name}:${n.toEntity?.id}`)) {
    (out[r.type.name] ??= []).push({ id: r.toEntity.id, name: r.toEntity.name, spaceId: r.spaceId });
  }
  return out;
}
// Names are stored per space. Use the Name value set IN the mirrored space; entity.name is
// Geo's denormalized display name and often comes from another space (e.g. WA "Strait of
// Hormuz blockade" vs entity.name "…blockage"). Fall back to it only when the space has no
// Name, and record that in "Geo Name source" so a fallback is never treated as this space's value.
const NAME_SOURCE = { own: 'This space', fallback: 'Other space (fallback)' };
function nameOf(e) {
  const own = e.values.nodes.find((v) => v.spaceId === spaceId && v.property?.name === 'Name')?.text;
  return own && own.trim() ? { name: own, nameSource: NAME_SOURCE.own } : { name: e.name, nameSource: NAME_SOURCE.fallback };
}
const pickSpace = (e) => (e.spaceIds?.includes(spaceId) ? spaceId : e.spaceIds?.[0] ?? spaceId);

process.stderr.write(spaceMode ? 'Sweeping space…\n' : 'Reading tabs…\n');
// space mode: filtered sweeps (Tags relation scoped to the space, so a tag set only in a
// sibling space doesn't pull the entity in) — returns ids of the given type
// (pass typeId to scope by type natively — a Types-relation filter 500s on large spaces)
async function spaceSweep(typeName, filter, typeId) {
  const ids = []; let after = null; let pageSize = 100;   // 200 → INTERNAL_SERVER_ERROR on World affairs topics
  for (;;) {
    let d;
    try {
      d = await gql(`query($f: EntityFilter, $after: Cursor) { entitiesConnection(first: ${pageSize}, after: $after, spaceId: "${spaceId}"${typeId ? `, typeId: "${typeId}"` : ''}, filter: $f) {
      pageInfo { hasNextPage endCursor } nodes { id types { name } } } }`, { f: filter, after });
    } catch (err) {
      if (pageSize <= 25) throw err;
      pageSize /= 2; continue;                               // retry the same cursor with a smaller page
    }
    ids.push(...d.entitiesConnection.nodes.filter((n) => n.types.some((t) => t.name === typeName)).map((n) => n.id));
    if (!d.entitiesConnection.pageInfo.hasNextPage) break;
    after = d.entitiesConnection.pageInfo.endCursor;
  }
  return [...new Set(ids)];
}
const TAGS_REL = '257090341ba5406f94e4d4af90042fba';
const TOPIC_TYPE = '5ef5a5860f274d8e8f6c59ae5b3e89e2';
const emptyTab = { name: '(none)', items: new Map() };
const cTab = spaceMode ? emptyTab : await tabItems(claimsTab);
const tTab = spaceMode ? emptyTab : await tabItems(topicsTab);
const cutoff = addedSince ? Date.parse(`${addedSince}T00:00:00Z`) / 1000 : 0;
const claimIds = spaceMode
  ? await spaceSweep('Claim', { relations: { some: { typeId: { is: TAGS_REL }, spaceId: { is: spaceId }, toEntity: { name: { in: SCOPE_TAGS } } } } })
  : [...cTab.items].filter(([, it]) => allTab || it.addedAt >= cutoff).map(([id]) => id);
process.stderr.write(spaceMode
  ? `Space mode: ${claimIds.length} claims tagged ${SCOPE_TAGS.join('/')}\n`
  : `Claims tab "${cTab.name}": ${cTab.items.size} items, ${claimIds.length} in scope\n`);
const spaceTopicIds = spaceMode
  ? await spaceSweep('Topic', null, TOPIC_TYPE)
  : [];

const claimEnts = await fetchEntities(claimIds);
const claims = [];
let droppedTag = 0;
for (const id of claimIds) {
  const e = claimEnts.get(id); if (!e) continue;
  const r = rels(e);
  const tags = [...new Set((r.Tags ?? []).map((t) => t.name).filter(Boolean))];
  if (!tags.some((t) => SCOPE_TAGS.includes(t))) { droppedTag++; continue; }
  const v = scalars(e);
  claims.push({ geoId: id, ...nameOf(e), url: geoUrl(id, pickSpace(e)), tags, topics: r.Topics ?? [],
    isFactual: v['Is factual']?.value ?? null, score: v.Score?.value ?? null, tabBlocks: cTab.items.get(id)?.blocks ?? [],
    links: Object.fromEntries(CLAIM_LINK_RELS.map((rel) => [rel, r[rel] ?? []])) });
}

const topicIds = [...new Set([...tTab.items.keys(), ...spaceTopicIds, ...claims.flatMap((c) => c.topics.map((t) => t.id))])];
process.stderr.write(spaceMode
  ? `Topics: ${spaceTopicIds.length} in space + claim-linked → ${topicIds.length} total\n`
  : `Topics: ${tTab.items.size} on tab "${tTab.name}" + claim-linked → ${topicIds.length} total\n`);
const topicEnts = await fetchEntities(topicIds);
const topics = [];
for (const id of topicIds) {
  const e = topicEnts.get(id); if (!e) continue;
  const r = rels(e); const v = scalars(e);
  topics.push({ geoId: id, ...nameOf(e), url: geoUrl(id, pickSpace(e)), inSpace: e.spaceIds?.includes(spaceId) ?? false,
    onTopicsTab: tTab.items.has(id), description: v.Description?.value ?? null, score: v.Score?.value ?? null,
    tags: [...new Set((r.Tags ?? []).map((t) => t.name).filter(Boolean))],
    broader: r['Broader topics'] ?? [], subtopics: r.Subtopics ?? [] });
}

const extract = { space: spaceId, claimsTab, topicsTab, scope: { mode: spaceMode ? 'space' : 'tabs', addedSince: addedSince ?? null, allTab }, extractedAt: new Date().toISOString(), claims, topics };
if (outFile) { writeFileSync(outFile, JSON.stringify(extract, null, 2)); process.stderr.write(`wrote ${outFile}\n`); }

// ── Notion schema ───────────────────────────────────────────────────────────
const spaceName = opt('--db-prefix') ?? (await gql(`{ space(id: "${spaceId}") { page { name } } }`)).space?.page?.name ?? 'Geo';
const dbTitle = { claims: `${spaceName} claims`, topics: `${spaceName} topics` };
const opts = (names) => ({ options: [...new Set(names)].filter(Boolean).sort().map((name) => ({ name: name.replace(/,/g, ' ').slice(0, 100) })) });
const claimProps = {
  'Geo Name': { title: {} }, 'Geo Name source': { select: { options: [{ name: NAME_SOURCE.own, color: 'green' }, { name: NAME_SOURCE.fallback, color: 'orange' }] } },
  'Geo ID': { rich_text: {} }, 'Geo URL': { url: {} },
  'Geo Tags': { multi_select: opts(claims.flatMap((c) => c.tags)) },
  'Geo Is factual': { checkbox: {} }, 'Geo Score': { number: {} },
  ...Object.fromEntries(CLAIM_LINK_RELS.map((rel) => [`Geo ${rel}`, { rich_text: {} }])),
  'Proposed rename': { rich_text: {} },
  'Proposed Tags': { multi_select: opts(claims.flatMap((c) => c.tags)) },
};
const topicProps = {
  'Geo Name': { title: {} }, 'Geo Name source': { select: { options: [{ name: NAME_SOURCE.own, color: 'green' }, { name: NAME_SOURCE.fallback, color: 'orange' }] } },
  'Geo ID': { rich_text: {} }, 'Geo URL': { url: {} },
  'Geo Description': { rich_text: {} }, 'Geo Tags': { multi_select: opts(topics.flatMap((t) => t.tags)) },
  'Geo Score': { number: {} }, 'Geo In space': { checkbox: {} }, ...(spaceMode ? {} : { 'Geo On Topics tab': { checkbox: {} } }),
  'Proposed rename': { rich_text: {} }, 'Proposed description': { rich_text: {} },
};
// relations added after both DBs exist (name → spec builder)
const relationPlan = [
  'claims.Geo Topics ⇄ topics.Geo Claims',
  'claims.Proposed Topics ⇄ topics.Proposed Claims',
  'topics.Geo Broader topics ⇄ topics.Geo Subtopics',
  'topics.Proposed Broader Topics ⇄ topics.Proposed Subtopics',
];

const hierarchyLinks = topics.reduce((n, t) => n + t.broader.length + t.subtopics.length, 0);
console.log(`\n${publish ? 'PUBLISH' : 'DRY RUN'} — Notion parent ${parentPage}`);
console.log(`  "${dbTitle.claims}": ${claims.length} rows (dropped ${droppedTag} without Debate/Featured tag)`);
console.log(`     tags: ${Object.entries(claims.flatMap((c) => c.tags).reduce((m, t) => (m[t] = (m[t] ?? 0) + 1, m), {})).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log(`     columns: ${Object.keys(claimProps).join(', ')}, Geo Topics, Proposed Topics`);
console.log(`  "${dbTitle.topics}": ${topics.length} rows (${topics.filter((t) => t.onTopicsTab).length} on Topics tab, ${topics.filter((t) => !t.inSpace).length} live outside the space)`);
console.log(`     columns: ${Object.keys(topicProps).join(', ')}, Geo Claims, Geo Broader topics, Geo Subtopics, Proposed Claims, Proposed Broader Topics, Proposed Subtopics`);
console.log(`  names: claims ${claims.filter((c) => c.nameSource === NAME_SOURCE.fallback).length} fallback · topics ${topics.filter((t) => t.nameSource === NAME_SOURCE.fallback).length} fallback`);
console.log(`  claim→topic links: ${claims.reduce((n, c) => n + c.topics.length, 0)} · topic hierarchy links: ${hierarchyLinks}`);
console.log(`  claim link columns: ${CLAIM_LINK_RELS.map((rel) => `Geo ${rel} ${claims.filter((c) => c.links[rel].length).length} claims/${claims.reduce((n, c) => n + c.links[rel].length, 0)} links`).join(' · ')}`);
console.log(`  relations: ${relationPlan.join(' | ')}`);
console.log(`  sample claims:\n${claims.slice(0, 5).map((c) => `     • ${c.name} [${c.tags.join(', ')}] → ${c.topics.map((t) => t.name).join(', ') || '(no topics)'}`).join('\n')}`);
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
  if ((r.status === 429 || r.status >= 500) && attempt < 6) {
    await sleep(Number(r.headers.get('retry-after')) * 1000 || Math.min(1000 * 2 ** attempt, 30000));
    return notion(path, method, body, attempt + 1);
  }
  throw new Error(`Notion ${method} ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
}

async function findOrCreateDb(title, properties) {
  const kids = [];
  let cur;
  do { const q = await notion(`/blocks/${parentPage}/children?page_size=100${cur ? `&start_cursor=${cur}` : ''}`); kids.push(...q.results); cur = q.has_more ? q.next_cursor : null; } while (cur);
  const hit = kids.find((b) => b.type === 'child_database' && b.child_database.title === title);
  if (hit) {
    const db = await notion(`/databases/${hit.id}`);
    // add any missing columns; never touch existing ones (keeps agent edits + views)
    const missing = Object.fromEntries(Object.entries(properties).filter(([k, v]) => !db.properties[k] && !v.title));
    if (Object.keys(missing).length) await notion(`/databases/${hit.id}`, 'PATCH', { properties: missing });
    return hit.id;
  }
  const created = await notion('/databases', 'POST', { parent: { type: 'page_id', page_id: parentPage }, is_inline: true, title: [{ text: { content: title } }], properties });
  return created.id;
}
// dual relation: create on A, then rename the auto-created synced column on B
async function ensureDual(dbA, nameA, dbB, nameB) {
  const a = await notion(`/databases/${dbA}`);
  if (a.properties[nameA]) return;
  const before = new Set(Object.keys((await notion(`/databases/${dbB}`)).properties));
  await notion(`/databases/${dbA}`, 'PATCH', { properties: { [nameA]: { relation: { database_id: dbB, type: 'dual_property', dual_property: {} } } } });
  const after = await notion(`/databases/${dbB}`);
  const synced = dbA === dbB
    ? Object.entries(after.properties).find(([k, p]) => k !== nameA && !before.has(k) && p.type === 'relation')?.[0]
    : Object.entries(after.properties).find(([k, p]) => !before.has(k) && p.type === 'relation')?.[0];
  if (synced && synced !== nameB) await notion(`/databases/${dbB}`, 'PATCH', { properties: { [synced]: { name: nameB } } });
}
// Geo ID -> page id, plus each page's current properties (for change detection)
const pageProps = new Map();
async function existingRows(dbId) {
  const m = new Map(); let cur;
  do {
    const q = await notion(`/databases/${dbId}/query`, 'POST', { page_size: 100, ...(cur ? { start_cursor: cur } : {}) });
    for (const p of q.results) { const g = p.properties['Geo ID']?.rich_text?.map((t) => t.plain_text).join(''); if (g) { m.set(g, p.id); pageProps.set(p.id, p.properties); } }
    cur = q.has_more ? q.next_cursor : null;
  } while (cur);
  return m;
}
// does the page already hold exactly these values? (only compares the properties we'd write)
const norm = (v) => {
  if (!v) return '';
  if (v.title || v.rich_text) return (v.title ?? v.rich_text).map((t) => `${t.plain_text ?? t.text?.content ?? ''}@${t.href ?? t.text?.link?.url ?? ''}`).join('');
  if ('url' in v) return v.url ?? '';
  if ('checkbox' in v) return String(Boolean(v.checkbox));
  if ('number' in v) return v.number == null ? '' : String(Number(v.number));
  if ('select' in v) return v.select?.name ?? '';
  if (v.multi_select) return v.multi_select.map((o) => o.name).sort().join('|');
  if (v.relation) return v.relation.map((r) => r.id.replace(/-/g, '')).sort().join('|');
  return JSON.stringify(v);
};
function unchanged(pageId, properties) {
  const cur = pageProps.get(pageId); if (!cur) return false;
  return Object.entries(properties).every(([k, want]) => {
    const have = cur[k]; if (!have) return false;
    // the query API truncates relations at 25 items: treat a full 25 that is a subset as equal
    if (want.relation && have.relation?.length === 25 && want.relation.length >= 25) {
      const w = new Set(want.relation.map((r) => r.id.replace(/-/g, '')));
      return have.relation.every((r) => w.has(r.id.replace(/-/g, '')));
    }
    const same = norm(have) === norm(want);
    if (!same && process.env.DEBUG_DIFF) process.stderr.write(`\n  diff ${k}: have=${JSON.stringify(norm(have)).slice(0, 160)} want=${JSON.stringify(norm(want)).slice(0, 160)}\n`);
    return same;
  });
}
const stats = { created: 0, updated: 0, unchanged: 0 };
const txt = (s) => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 1990) } }] : [] });
// one linked name per line; Notion caps a rich_text property at 100 segments (name + newline = 2)
function linkedNames(list) {
  const shown = list.slice(0, 48);
  const segs = shown.flatMap((x, i) => [
    { text: { content: (x.name ?? '(unnamed)').slice(0, 1990), link: { url: geoUrl(x.id, x.spaceId ?? spaceId) } } },
    ...(i < shown.length - 1 ? [{ text: { content: '\n' } }] : []),
  ]);
  if (list.length > shown.length) segs.push({ text: { content: `\n… +${list.length - shown.length} more` } });
  return { rich_text: segs };
}
const ms = (names) => ({ multi_select: names.map((name) => ({ name: name.replace(/,/g, ' ').slice(0, 100) })) });
async function upsert(dbId, rows, geoId, properties) {
  if (rows.has(geoId)) {
    if (unchanged(rows.get(geoId), properties)) { stats.unchanged++; return rows.get(geoId); }
    await notion(`/pages/${rows.get(geoId)}`, 'PATCH', { properties }); stats.updated++; return rows.get(geoId);
  }
  const p = await notion('/pages', 'POST', { parent: { database_id: dbId }, properties }); rows.set(geoId, p.id); stats.created++; return p.id;
}

process.stderr.write('Creating databases…\n');
const topicsDb = await findOrCreateDb(dbTitle.topics, topicProps);
const claimsDb = await findOrCreateDb(dbTitle.claims, claimProps);
await ensureDual(claimsDb, 'Geo Topics', topicsDb, 'Geo Claims');
await ensureDual(claimsDb, 'Proposed Topics', topicsDb, 'Proposed Claims');
await ensureDual(topicsDb, 'Geo Broader topics', topicsDb, 'Geo Subtopics');
await ensureDual(topicsDb, 'Proposed Broader Topics', topicsDb, 'Proposed Subtopics');

const topicRows = await existingRows(topicsDb);
let n = 0;
for (const t of topics) {
  await upsert(topicsDb, topicRows, t.geoId, {
    'Geo Name': { title: [{ text: { content: (t.name ?? '(unnamed)').slice(0, 1990) } }] }, 'Geo Name source': { select: { name: t.nameSource } }, 'Geo ID': txt(t.geoId), 'Geo URL': { url: t.url },
    'Geo Description': txt(t.description), 'Geo Tags': ms(t.tags), 'Geo Score': { number: t.score == null ? null : Number(t.score) },
    'Geo In space': { checkbox: t.inSpace }, ...(spaceMode ? {} : { 'Geo On Topics tab': { checkbox: t.onTopicsTab } }),
  });
  process.stderr.write(`\r  topics ${++n}/${topics.length}`);
}
process.stderr.write('\n');
// hierarchy: write Broader topics only (synced pair fills Subtopics); union both Geo directions
const broaderOf = new Map();
for (const t of topics) {
  for (const b of t.broader) if (topicRows.has(b.id)) (broaderOf.get(t.geoId) ?? broaderOf.set(t.geoId, new Set()).get(t.geoId)).add(b.id);
  for (const s of t.subtopics) if (topicRows.has(s.id)) (broaderOf.get(s.id) ?? broaderOf.set(s.id, new Set()).get(s.id)).add(t.geoId);
}
const topicStats = { ...stats }; Object.assign(stats, { created: 0, updated: 0, unchanged: 0 });
let hierarchyWrites = 0;
for (const [child, parents] of skipHierarchy ? [] : broaderOf) {
  if (!topicRows.has(child)) continue;
  const properties = { 'Geo Broader topics': { relation: [...parents].map((id) => ({ id: topicRows.get(id) })) } };
  if (unchanged(topicRows.get(child), properties)) continue;
  await notion(`/pages/${topicRows.get(child)}`, 'PATCH', { properties }); hierarchyWrites++;
}

const claimRows = await existingRows(claimsDb);
n = 0;
for (const c of claims) {
  await upsert(claimsDb, claimRows, c.geoId, {
    'Geo Name': { title: [{ text: { content: (c.name ?? '(unnamed)').slice(0, 1990) } }] }, 'Geo Name source': { select: { name: c.nameSource } }, 'Geo ID': txt(c.geoId), 'Geo URL': { url: c.url },
    'Geo Tags': ms(c.tags), 'Geo Is factual': { checkbox: Boolean(c.isFactual) }, 'Geo Score': { number: c.score == null ? null : Number(c.score) },
    'Geo Topics': { relation: c.topics.filter((t) => topicRows.has(t.id)).slice(0, 100).map((t) => ({ id: topicRows.get(t.id) })) },
    ...Object.fromEntries(CLAIM_LINK_RELS.map((rel) => [`Geo ${rel}`, linkedNames(c.links?.[rel] ?? [])])),
  });
  process.stderr.write(`\r  claims ${++n}/${claims.length}`);
}
process.stderr.write('\n');
console.log(`\n✅ Mirrored ${claims.length} claims + ${topics.length} topics`);
console.log(`   topics: ${topicStats.created} created, ${topicStats.updated} updated, ${topicStats.unchanged} unchanged · hierarchy rows written: ${skipHierarchy ? 'skipped' : hierarchyWrites}`);
console.log(`   claims: ${stats.created} created, ${stats.updated} updated, ${stats.unchanged} unchanged`);
const notInScope = { topics: [...topicRows.keys()].filter((g) => !topics.some((t) => t.geoId === g)).length, claims: [...claimRows.keys()].filter((g) => !claims.some((c) => c.geoId === g)).length };
console.log(`   rows in Notion no longer in Geo scope (left untouched): ${notInScope.claims} claims, ${notInScope.topics} topics`);
console.log(JSON.stringify({ claimsDb, topicsDb }, null, 2));
