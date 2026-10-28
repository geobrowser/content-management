// Shared helpers for publishing Notion edits back to Geo (geo-mirror Part 2).
//
// The one convention: a Notion database with a "Geo ID" column holds content
// mirrored from Geo, whatever the database or page is called. Columns map to Geo
// properties by name:
//   • the title column               → Name
//   • "Geo <X>"                      → X   (mirrored value)
//   • "<X>" (only in tables that use no "Geo …" columns — the older geo-mirror style) → X
//   • "Proposed rename"              → Name (a proposal)
//   • "Proposed <X>"                 → X    (a proposal)
// Property IDs are resolved from Geo, never from a hand-written list.
import { SystemIds } from '@geoprotocol/geo-sdk';

export const GEO = 'https://api-testnet.geobrowser.io/graphql';
export const STATUS = { approved: 'Approved', hold: 'Hold', sent: 'Sent to Geo', live: 'Live on Geo' };
export const STATUS_OPTIONS = [
  { name: STATUS.approved, color: 'green' }, { name: STATUS.hold, color: 'gray' },
  { name: STATUS.sent, color: 'yellow' }, { name: STATUS.live, color: 'blue' },
];
// our own bookkeeping columns — never treated as Geo properties
const META = new Set(['geo id', 'geo url', 'geo name source', 'publish status', 'review status', 'cover']);
const SYSTEM_PROPERTY_IDS = new Set(Object.entries(SystemIds).filter(([k]) => k.endsWith('_PROPERTY')).map(([, v]) => v));
const TEXT_TYPES = new Set(['title', 'rich_text', 'url']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const norm = (v) => (v ?? '').replace(/\s+/g, ' ').trim();
export const idOf = (s) => (s || '').replace(/[?#].*$/, '').replace(/-/g, '').match(/[0-9a-f]{32}(?!.*[0-9a-f]{32})/i)?.[0];

// ── clients ─────────────────────────────────────────────────────────────────
export function notionClient(token) {
  let nextSlot = 0;                       // ~3 req/s, shared by everything using this client
  return async function notion(path, method = 'GET', body, attempt = 0) {
    const now = Date.now(); const start = Math.max(now, nextSlot); nextSlot = start + 340;
    if (start > now) await sleep(start - now);
    const r = await fetch(`https://api.notion.com/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (r.ok) return j;
    if ((r.status === 429 || r.status >= 500) && attempt < 6) { await sleep(Number(r.headers.get('retry-after')) * 1000 || Math.min(1000 * 2 ** attempt, 30000)); return notion(path, method, body, attempt + 1); }
    throw new Error(`Notion ${method} ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  };
}
export async function gql(query, attempt = 0) {
  try {
    const r = await fetch(GEO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
    return j.data;
  } catch (e) { if (attempt >= 4) throw e; await sleep(1000 * 2 ** attempt); return gql(query, attempt + 1); }
}

// ── find mirrored tables ────────────────────────────────────────────────────
// Every database with a "Geo ID" column, either given directly (--db) or found on
// a page: its own blocks, including tables inside toggles and column layouts.
// Sub-pages are searched only with `recursive`.
export async function findMirroredTables(notion, { page, dbs = [], recursive = false }) {
  const found = new Map();
  const consider = async (id) => {
    if (found.has(id)) return;
    let db; try { db = await notion(`/databases/${id}`); } catch { return; }
    const hasGeoId = Object.keys(db.properties).some((k) => k.trim().toLowerCase() === 'geo id');
    if (hasGeoId) found.set(id, { id, title: db.title.map((t) => t.plain_text).join('') || '(untitled)', schema: db.properties });
  };
  for (const d of dbs) await consider(d);
  const walk = async (blockId, depth) => {
    if (depth > 6) return;
    let cursor;
    do {
      const r = await notion(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
      for (const b of r.results) {
        if (b.type === 'child_database') await consider(b.id);
        else if (b.type === 'child_page') { if (recursive) await walk(b.id, depth + 1); }
        else if (b.has_children) await walk(b.id, depth + 1);
      }
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
  };
  if (page) {
    // the "page" may itself be a database
    await consider(page);
    if (!found.has(page)) await walk(page, 0);
  }
  return [...found.values()];
}

export async function allRows(notion, dbId) {
  const rows = []; let cursor;
  do {
    const q = await notion(`/databases/${dbId}/query`, 'POST', cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
    rows.push(...q.results); cursor = q.has_more ? q.next_cursor : null;
  } while (cursor);
  return rows;
}

export function cellText(p) {
  if (!p) return undefined;
  if (p.type === 'title') return p.title.map((t) => t.plain_text).join('');
  if (p.type === 'rich_text') return p.rich_text.map((t) => t.plain_text).join('');
  if (p.type === 'url') return p.url ?? '';
  return undefined;
}

// ── classify a table's columns ──────────────────────────────────────────────
// Returns { style: 'proposal' | 'direct', mirrored: Map(geoName → column),
//           proposals: Map(geoName → column), other: [unsupported proposal columns],
//           nameSource, publishStatus, qaFlags: [columns] }
export function classifyTable(schema) {
  const cols = Object.entries(schema);
  const lower = (s) => s.trim().toLowerCase();
  const prefixed = cols.some(([k]) => /^geo\s+/i.test(k) && !META.has(lower(k)));
  const mirrored = new Map(); const proposals = new Map(); const other = [];
  for (const [name, p] of cols) {
    const l = lower(name);
    if (META.has(l)) continue;
    // explicit = the column name itself says "this is a Geo property"; an unprefixed
    // column in an old-style table is only a guess and needs stronger evidence
    if (/^proposed\s+/i.test(name)) {
      const target = /^proposed\s+rename$/i.test(name) ? 'Name' : name.replace(/^proposed\s+/i, '').trim();
      if (TEXT_TYPES.has(p.type)) proposals.set(target.toLowerCase(), { column: name, geoName: target, explicit: true });
      else other.push(name);
      continue;
    }
    if (p.type === 'title') { mirrored.set('name', { column: name, geoName: 'Name', explicit: true }); continue; }
    if (!TEXT_TYPES.has(p.type)) continue;
    if (prefixed) {
      if (/^geo\s+/i.test(name)) { const g = name.replace(/^geo\s+/i, '').trim(); mirrored.set(g.toLowerCase(), { column: name, geoName: g, explicit: true }); }
    } else {
      mirrored.set(l, { column: name, geoName: name.trim(), explicit: false });
    }
  }
  const find = (re) => cols.find(([k]) => re.test(k))?.[0] ?? null;
  return {
    style: proposals.size || other.length ? 'proposal' : 'direct',
    mirrored, proposals, other,
    nameSource: find(/^geo name source$/i),
    publishStatus: schema['Publish status']?.type === 'select' ? 'Publish status' : null,
    qaFlags: cols.filter(([k, p]) => /^qa flag/i.test(k) && ['select', 'multi_select'].includes(p.type)).map(([k]) => k),
  };
}

// ── live values + property ids ──────────────────────────────────────────────
// For each entity: is it in the space, and its per-space values keyed by
// lower-cased property name → { id, name, dataType, text }.
export async function liveValues(ids, spaceId) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const q = '{' + chunk.map((id, k) => `e${k}: entity(id:"${id}"){ spaceIds valuesList(filter:{ spaceId:{ is:"${spaceId}" } }){ text property{ id name dataTypeName } } }`).join(' ') + '}';
    const d = await gql(q);
    chunk.forEach((id, k) => {
      const e = d[`e${k}`];
      const values = new Map();
      for (const v of e?.valuesList ?? []) {
        if (!v.property) continue;
        values.set(v.property.name.toLowerCase(), { id: v.property.id, name: v.property.name, dataType: v.property.dataTypeName, text: norm(v.text) });
      }
      out.set(id, { inSpace: (e?.spaceIds ?? []).includes(spaceId), values });
    });
  }
  return out;
}

// Resolve each field ({ geoName, explicit }) to ONE Geo property id:
//   1. the property the table's entities already use under that name
//   2. otherwise a lookup by name — for explicit columns ("Geo …", "Proposed …", title):
//      the only match, or the system one (SDK SystemIds) when several share the name;
//      for unprefixed columns: a system property only. An editor's "Notes" column
//      must never be published just because Geo has some property called "Notes".
// Ambiguous or unknown names return null (the change is skipped, never guessed).
export async function resolvePropertyIds(fields, live) {
  const out = new Map();
  for (const { geoName, explicit } of fields) {
    const key = geoName.toLowerCase();
    if (out.has(key)) continue;
    const counts = new Map();
    for (const e of live.values()) { const v = e.values.get(key); if (v) counts.set(v.id, { n: (counts.get(v.id)?.n ?? 0) + 1, dataType: v.dataType }); }
    if (counts.size === 1) { const [[id, c]] = [...counts]; out.set(key, { id, dataType: c.dataType }); continue; }
    const d = await gql(`{ properties(filter:{ name:{ is:${JSON.stringify(geoName)} } }, first: 20){ id dataTypeName } }`);
    let cands = d.properties ?? [];
    if (counts.size > 1) cands = cands.filter((c) => counts.has(c.id));
    if (!explicit || cands.length > 1) cands = cands.filter((c) => SYSTEM_PROPERTY_IDS.has(c.id));
    out.set(key, cands.length === 1 ? { id: cands[0].id, dataType: cands[0].dataTypeName } : null);
  }
  return out;
}

// the space a table was mirrored from: the most common space in its rows' Geo URLs
export function spaceFromUrls(urls) {
  const n = {};
  for (const u of urls) { const s = (u || '').match(/\/space\/([0-9a-f]{32})\//)?.[1]; if (s) n[s] = (n[s] ?? 0) + 1; }
  return Object.entries(n).sort((a, b) => b[1] - a[1]);
}
