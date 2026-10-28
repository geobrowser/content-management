#!/usr/bin/env node
// geo-claim-grouping-notion · step 1 — build the claim ROSTER from a Notion Claims mirror.
//
// Reads every row of the Claims database, keeps the ones with a valid Geo ID, and writes
// roster.json. Its `ids` array is exactly the shape geo-claim-grouping's discovery script
// accepts as `--scope-file`, and `rows` maps each Geo ID to its Notion page id so the
// sink can write relations without querying Notion per row.
//
// Schema-agnostic: needs one title column and one rich_text column holding the Geo ID
// (default name "Geo ID"). A url column (default "Geo URL") is used for links + space.
//
// READ-ONLY on Notion. Never touches Geo.
//
// Env:   NOTION_TOKEN=ntn_...   (loaded with --env-file, never printed)
// Usage:
//   node --env-file=.env skills/non-actionable/geo-claim-grouping-notion/scripts/roster-from-notion.mjs \
//     --db <DB_ID|URL> --out scripts/<campaign>/roster.json [--space <32hex>] \
//     [--geo-id-column "Geo ID"] [--url-column "Geo URL"] [--rate 3]
//
// Exit codes: 0 ok · 1 Notion/API error · 2 usage or contract error (missing columns etc.)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const USAGE = `usage: node --env-file=.env skills/non-actionable/geo-claim-grouping-notion/scripts/roster-from-notion.mjs \\
  --db <DB_ID|URL> --out <campaign>/roster.json [--space <32hex>] [--geo-id-column "Geo ID"] [--url-column "Geo URL"] [--rate 3]

  --db             the Claims mirror database (id or Notion URL); must be shared with the integration
  --out            where to write roster.json (directories are created)
  --space          Geo space id (32 hex) — optional when every Geo URL points at one space
  --geo-id-column  rich_text column holding the 32-hex Geo entity id   (default "Geo ID")
  --url-column     url column holding the geobrowser link              (default "Geo URL")
  --rate           Notion requests per second                          (default 3)
  --type           expected Geo entity type id (32 hex)                (default Claim)
  --skip-type-check  do not verify roster ids against Geo (offline use)
  --endpoint       Geo GraphQL endpoint (for the type check)`;

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const TOKEN = process.env.NOTION_TOKEN;
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const idOf = (s) => (s || '').trim().replace(/^.*\/(?=[0-9a-f]{32}\b)/i, '').replace(/[?#].*$/, '').replace(/-/g, '').toLowerCase();

const dbId = idOf(opt('--db'));
const outFile = opt('--out');
const spaceArg = (opt('--space') || '').replace(/-/g, '').toLowerCase();
const GEO_ID_COL = opt('--geo-id-column', 'Geo ID');
const URL_COL = opt('--url-column', 'Geo URL');
const RATE = parseFloat(opt('--rate', '3'));
// Entity-type assertion (see the type-check block below). Defaults to Claim.
const CLAIM_TYPE = '96f859efa1ca4b229372c86ad58b694b';
const EXPECT_TYPE = (opt('--type', CLAIM_TYPE) || '').replace(/-/g, '').toLowerCase();
const SKIP_TYPE_CHECK = args.includes('--skip-type-check');
const GEO_ENDPOINT = opt('--endpoint', 'https://api-testnet.geobrowser.io/graphql');
const TYPE_BATCH = 50;
const HEX32 = /^[0-9a-f]{32}$/;

if (!dbId || !HEX32.test(dbId) || !outFile) { console.error(USAGE); process.exit(2); }
if (spaceArg && !HEX32.test(spaceArg)) { console.error(`--space must be a 32-hex space id (got: ${spaceArg})`); process.exit(2); }
if (!TOKEN) { console.error('NOTION_TOKEN missing from env — run with: node --env-file=.env …'); process.exit(2); }

// ── paced + retrying Notion client (same shape as geo-mirror/scripts/bulk-set-property.mjs) ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
async function pace() { const gap = 1000 / RATE; const now = Date.now(); const start = Math.max(now, nextSlot); nextSlot = start + gap; if (start > now) await sleep(start - now); }
async function notion(path, method = 'GET', body, attempt = 0) {
  await pace();
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
const plain = (p) => {
  if (!p) return null;
  if (p.type === 'title') return p.title.map((t) => t.plain_text).join('');
  if (p.type === 'rich_text') return p.rich_text.map((t) => t.plain_text).join('');
  if (p.type === 'url') return p.url ?? null;
  return null;
};
const SPACE_RE = /geobrowser\.io\/space\/([0-9a-f]{32})/i;

try {
  // ── schema: find the title column, verify the Geo ID column ────────────────
  const db = await notion(`/databases/${dbId}`);
  const dbTitle = (db.title || []).map((t) => t.plain_text).join('') || '(untitled)';
  const props = db.properties || {};
  const titleProperty = Object.keys(props).find((k) => props[k].type === 'title');
  if (!titleProperty) { console.error(`no title column found on "${dbTitle}"`); process.exit(2); }
  if (!props[GEO_ID_COL] || props[GEO_ID_COL].type !== 'rich_text') {
    console.error(`column "${GEO_ID_COL}" (rich_text) not found on "${dbTitle}". Columns: ${Object.keys(props).sort().join(', ')}\nPass --geo-id-column "<name>" if it is called something else.`);
    process.exit(2);
  }
  const hasUrl = !!props[URL_COL] && (props[URL_COL].type === 'url' || props[URL_COL].type === 'rich_text');

  // ── rows ────────────────────────────────────────────────────────────────────
  const rowsRaw = []; let cursor;
  do {
    const res = await notion(`/databases/${dbId}/query`, 'POST', cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
    rowsRaw.push(...res.results); cursor = res.has_more ? res.next_cursor : null;
    process.stderr.write(`\r  read ${rowsRaw.length} rows`);
  } while (cursor);
  process.stderr.write('\n');

  const seen = new Map();            // geoId -> [pageId, ...]
  const rows = {};                   // geoId -> { pageId, name, url }
  const rowsWithoutGeoId = [];
  const spacesSeen = {};
  for (const r of rowsRaw) {
    const pageId = r.id.replace(/-/g, '');
    const raw = (plain(r.properties[GEO_ID_COL]) || '').replace(/-/g, '').trim().toLowerCase();
    if (!HEX32.test(raw)) { rowsWithoutGeoId.push(pageId); continue; }
    const name = plain(r.properties[titleProperty]) || '';
    const url = hasUrl ? plain(r.properties[URL_COL]) : null;
    const m = url && SPACE_RE.exec(url);
    if (m) spacesSeen[m[1].toLowerCase()] = (spacesSeen[m[1].toLowerCase()] || 0) + 1;
    if (!seen.has(raw)) seen.set(raw, []);
    seen.get(raw).push(pageId);
    rows[raw] = { pageId, name, url: url || null };
  }
  const duplicates = [...seen].filter(([, ps]) => ps.length > 1).map(([geoId, pageIds]) => ({ geoId, pageIds, name: rows[geoId]?.name || '' }));
  for (const d of duplicates) delete rows[d.geoId];   // ambiguous rows are never written by the sink
  const ids = Object.keys(rows).sort();

  // ── space resolution ────────────────────────────────────────────────────────
  const spaceKeys = Object.keys(spacesSeen);
  let space = spaceArg || (spaceKeys.length === 1 ? spaceKeys[0] : null);
  if (!space) {
    console.error(`cannot resolve the Geo space: ${spaceKeys.length ? `Geo URLs point at ${spaceKeys.length} spaces (${spaceKeys.join(', ')})` : `no "${URL_COL}" links found`} — pass --space <32hex>.`);
    process.exit(2);
  }
  for (const id of ids) if (!rows[id].url) rows[id].url = `https://www.geobrowser.io/space/${space}/${id}`;

  // ── entity-type assertion (read-only Geo GraphQL — no wallet, no env) ───────
  // This script is schema-agnostic by design: any database with a title column and a
  // Geo ID column is accepted. That makes a WRONG-TYPE mirror silently valid — a Topics
  // database once produced a clean 70-id "claims" roster that every later step trusted,
  // and only an external check caught it. Nothing else in the pipeline verifies type.
  let typeCheck = { checked: false, reason: 'skipped (--skip-type-check)' };
  if (!SKIP_TYPE_CHECK && ids.length) {
    const geoGql = async (query, retries = 2) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fetch(GEO_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
          const j = await r.json();
          if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
          return j.data;
        } catch (err) {
          if (attempt >= retries) throw err;
          await sleep(500 * 2 ** attempt);
        }
      }
    };
    const typesSeen = {}; const wrong = []; let unresolved = 0;
    for (let i = 0; i < ids.length; i += TYPE_BATCH) {
      const chunk = ids.slice(i, i + TYPE_BATCH);
      const data = await geoGql('{' + chunk.map((id, k) => `e${k}: entity(id:"${id}"){ id name typeIds types { name } }`).join(' ') + '}');
      chunk.forEach((id, k) => {
        const e = data[`e${k}`];
        const typeIds = e?.typeIds ?? [];
        const names = (e?.types ?? []).map((t) => t?.name).filter(Boolean);
        if (!typeIds.length) { unresolved++; wrong.push({ id, name: e?.name || '', types: [] }); return; }
        for (const n of new Set(names.length ? names : ['(unnamed type)'])) typesSeen[n] = (typesSeen[n] || 0) + 1;
        if (!typeIds.includes(EXPECT_TYPE)) wrong.push({ id, name: e?.name || '', types: names });
      });
      process.stderr.write(`\rtype-checking ${Math.min(i + TYPE_BATCH, ids.length)}/${ids.length} against Geo`);
    }
    process.stderr.write('\n');
    typeCheck = { checked: true, expectedTypeId: EXPECT_TYPE, endpoint: GEO_ENDPOINT, total: ids.length,
      matched: ids.length - wrong.length, wrong: wrong.length, unresolved, typesSeen };
    if (wrong.length) {
      console.error(`✗ roster type check FAILED — ${ids.length - wrong.length}/${ids.length} rows are type ${EXPECT_TYPE}.`);
      console.error(`  types seen : ${Object.entries(typesSeen).map(([n, c]) => `${n} ${c}`).join(' · ') || '(none)'}`);
      if (unresolved) console.error(`  unresolved : ${unresolved} id(s) returned no types at all (deleted, or not in this space)`);
      for (const w of wrong.slice(0, 5)) console.error(`  - ${w.id} "${w.name}" → ${w.types.join(', ') || '(no types)'}`);
      if (wrong.length > 5) console.error(`  … and ${wrong.length - 5} more`);
      console.error(`  This database is not a mirror of type ${EXPECT_TYPE}. Point --db at the right database,`);
      console.error(`  pass --type <32hex> to roster a different type, or --skip-type-check to bypass deliberately.`);
      process.exit(2);
    }
  }

  const roster = {
    db: dbId, dbTitle, titleProperty, geoIdProperty: GEO_ID_COL, urlProperty: hasUrl ? URL_COL : null,
    space, fetchedAt: new Date().toISOString(), rowCount: rowsRaw.length, typeCheck,
    ids, rows, duplicates, rowsWithoutGeoId: rowsWithoutGeoId.length, rowsWithoutGeoIdPageIds: rowsWithoutGeoId.slice(0, 20), spacesSeen,
  };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(roster, null, 2) + '\n');

  console.log(`roster — "${dbTitle}" (${dbId})`);
  console.log(`  rows read         : ${rowsRaw.length}`);
  console.log(`  ids in roster     : ${ids.length}`);
  console.log(`  space             : ${space}${spaceArg ? ' (from --space)' : ''}`);
  console.log(`  type check        : ${typeCheck.checked ? `${typeCheck.matched}/${typeCheck.total} are type ${typeCheck.expectedTypeId} ✓` : `SKIPPED — ${typeCheck.reason}`}`);
  console.log(`  title column      : "${titleProperty}"   geo id column: "${GEO_ID_COL}"   url column: ${hasUrl ? `"${URL_COL}"` : '(none — links built from space + id)'}`);
  if (duplicates.length) console.log(`  ⚠ duplicate Geo IDs (excluded): ${duplicates.length} → ${duplicates.slice(0, 5).map((d) => d.geoId).join(' | ')}${duplicates.length > 5 ? ' …' : ''}`);
  if (rowsWithoutGeoId.length) console.log(`  ⚠ rows without a valid Geo ID : ${rowsWithoutGeoId.length}`);
  if (spaceKeys.length > 1) console.log(`  ⚠ Geo URLs span ${spaceKeys.length} spaces: ${spaceKeys.map((s) => `${s} (${spacesSeen[s]})`).join(', ')}`);
  console.log(`  wrote ${outFile}`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
