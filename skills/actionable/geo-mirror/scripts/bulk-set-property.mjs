#!/usr/bin/env node
// Bulk-fill a Notion property across many rows — the fast path.
//
// WHY THIS EXISTS: setting a property row-by-row through an agent costs one
// tool-call round trip per row (~5-7s), so ~480 rows ≈ 50 minutes. This script
// does the same writes as paced REST calls at Notion's allowed ~3 req/s, so the
// same job takes ~3 minutes. Same pattern as mirror-to-notion.mjs.
//
// It also only writes rows that actually CHANGE, so a re-run costs seconds.
//
// Env:  NOTION_TOKEN=ntn_...
// Usage:
//   node --env-file=.env scripts/bulk-set-property.mjs \
//     --db <DATABASE_ID_OR_URL> --plan plan.json --property "New broader topics"
//   ... add --publish to actually write (dry-run is the default)
//
// Plan file — either shape works:
//   [{ "name": "Attention Mechanism", "parent": "Attention" }, ...]        // single relation
//   [{ "key":  "Attention Mechanism", "values": ["Attention", "NLP"] }]    // multi-value
// A parent of "ROOT" (or null/"") means "no parent" → skipped, unless --clear-root.
//
// Rows are matched by the --match column (default "Name"). For a relation
// property the values are resolved to page IDs in --target-db (default: the same
// database, i.e. a self-referencing hierarchy).
import { readFileSync } from 'node:fs';

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const TOKEN = process.env.NOTION_TOKEN;

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const idOf = (s) => (s || '').trim().replace(/^.*\/(?=[0-9a-f]{32}\b)/i, '').replace(/[?#].*$/, '').replace(/-/g, '');

const dbId = idOf(opt('--db'));
const targetDbId = idOf(opt('--target-db')) || dbId;
const planFile = opt('--plan');
const property = opt('--property');
const matchCol = opt('--match', 'Name');
const RATE = parseFloat(opt('--rate', '3'));        // requests/sec (Notion's documented average)
const CONC = parseInt(opt('--concurrency', '4'));
const clearRoot = args.includes('--clear-root');
const DRY = !args.includes('--publish');

if (!TOKEN) { console.error('NOTION_TOKEN missing from env'); process.exit(1); }
if (!dbId || !planFile || !property) {
  console.error('usage: bulk-set-property.mjs --db <DB_ID|URL> --plan <plan.json> --property "<Property>" [--match Name] [--target-db <DB>] [--rate 3] [--publish]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── paced + retrying Notion client ──────────────────────────────────────────
// Notion's documented limit is an average of ~3 requests/sec per integration.
// We serialise request STARTS at that rate while allowing several in flight,
// which sustains the full allowance without tripping 429s.
let nextSlot = 0;
async function pace() {
  const gap = 1000 / RATE;
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + gap;
  if (start > now) await sleep(start - now);
}
async function notion(path, method = 'GET', body, attempt = 0) {
  await pace();
  let r, j;
  try {
    r = await fetch(`${NOTION}${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    j = await r.json();
  } catch (err) {
    if (attempt >= 6) throw err;
    await sleep(Math.min(1000 * 2 ** attempt, 30000));
    return notion(path, method, body, attempt + 1);
  }
  if (r.ok) return j;
  if ((r.status === 429 || r.status >= 500) && attempt < 6) {
    const wait = Number(r.headers.get('retry-after')) * 1000 || Math.min(1000 * 2 ** attempt, 30000);
    process.stderr.write(`\n  ⟳ ${r.status} — retry ${attempt + 1}/6 in ${Math.round(wait / 1000)}s\n`);
    await sleep(wait);
    return notion(path, method, body, attempt + 1);
  }
  throw new Error(`Notion ${method} ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
}

// ── read every row of a database (paginated) ────────────────────────────────
async function allRows(database) {
  const rows = []; let cursor;
  do {
    const res = await notion(`/databases/${database}/query`, 'POST', cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
    rows.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
    process.stderr.write(`\r  read ${rows.length} rows`);
  } while (cursor);
  process.stderr.write('\n');
  return rows;
}
const plain = (p) => {
  if (!p) return null;
  if (p.type === 'title') return p.title.map((t) => t.plain_text).join('');
  if (p.type === 'rich_text') return p.rich_text.map((t) => t.plain_text).join('');
  if (p.type === 'select') return p.select?.name ?? null;
  if (p.type === 'url') return p.url ?? null;
  return null;
};
const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

// ── load plan ───────────────────────────────────────────────────────────────
const rawPlan = JSON.parse(readFileSync(planFile, 'utf8'));
const plan = (Array.isArray(rawPlan) ? rawPlan : rawPlan.assignments ?? []).map((e) => ({
  key: norm(e.key ?? e.name),
  values: (e.values ?? (e.parent != null ? [e.parent] : []))
    .map(norm)
    .filter((v) => v && v.toUpperCase() !== 'ROOT'),
}));
if (!plan.length) { console.error('plan is empty'); process.exit(1); }

// ── read source rows (+ target rows if a different DB) ──────────────────────
process.stderr.write(`Reading target database…\n`);
const rows = await allRows(dbId);
const targetRows = targetDbId === dbId ? rows : (process.stderr.write('Reading value database…\n'), await allRows(targetDbId));

// index by match column; track duplicate names (ambiguous → reported, not guessed)
const byKey = new Map(); const dupes = new Set();
for (const row of rows) {
  const k = norm(plain(row.properties[matchCol]));
  if (!k) continue;
  if (byKey.has(k)) dupes.add(k); else byKey.set(k, row);
}
const targetByKey = new Map(); const targetDupes = new Set();
for (const row of targetRows) {
  const k = norm(plain(row.properties[matchCol]));
  if (!k) continue;
  if (targetByKey.has(k)) targetDupes.add(k); else targetByKey.set(k, row);
}

// what type is the property we're setting?
const sample = rows.find((r) => r.properties[property]);
if (!sample) { console.error(`property "${property}" not found on this database`); process.exit(1); }
const propType = sample.properties[property].type;

// ── build the write set, skipping rows already correct ──────────────────────
const writes = []; const missingKeys = []; const missingValues = new Set(); const unchanged = [];
for (const entry of plan) {
  const row = byKey.get(entry.key);
  if (!row) { missingKeys.push(entry.key); continue; }

  let value, currentSig, nextSig;
  if (propType === 'relation') {
    const ids = [];
    for (const v of entry.values) {
      const t = targetByKey.get(v);
      if (!t) { missingValues.add(v); continue; }
      ids.push(t.id);
    }
    value = { relation: ids.map((id) => ({ id })) };
    currentSig = (row.properties[property].relation ?? []).map((x) => x.id.replace(/-/g, '')).sort().join(',');
    nextSig = ids.map((x) => x.replace(/-/g, '')).sort().join(',');
  } else {
    const v = entry.values[0] ?? '';
    value = propType === 'select' ? { select: v ? { name: v } : null }
      : propType === 'url' ? { url: v || null }
      : { rich_text: v ? [{ text: { content: v.slice(0, 1900) } }] : [] };
    currentSig = norm(plain(row.properties[property]));
    nextSig = norm(v);
  }

  if (!nextSig && !clearRoot) { continue; }            // ROOT / empty → leave alone
  if (currentSig === nextSig) { unchanged.push(entry.key); continue; }   // already correct → skip
  writes.push({ pageId: row.id, key: entry.key, value, from: currentSig, to: nextSig });
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\n${DRY ? 'DRY RUN' : 'PUBLISH'} — property "${property}" (${propType}) on ${rows.length} rows`);
console.log(`  plan entries      : ${plan.length}`);
console.log(`  already correct   : ${unchanged.length}  (skipped — this is why re-runs are cheap)`);
console.log(`  TO WRITE          : ${writes.length}`);
if (missingKeys.length) console.log(`  ⚠ no row matched  : ${missingKeys.length} → ${missingKeys.slice(0, 5).join(' | ')}${missingKeys.length > 5 ? ' …' : ''}`);
if (missingValues.size) console.log(`  ⚠ value not found : ${missingValues.size} → ${[...missingValues].slice(0, 5).join(' | ')}${missingValues.size > 5 ? ' …' : ''}`);
if (dupes.size) console.log(`  ⚠ duplicate "${matchCol}" (first row used, verify!): ${[...dupes].slice(0, 8).join(' | ')}`);
if (targetDupes.size && targetDbId !== dbId) console.log(`  ⚠ duplicate value names: ${[...targetDupes].slice(0, 8).join(' | ')}`);

const eta = Math.ceil(writes.length / RATE);
console.log(`  estimated time    : ~${Math.floor(eta / 60)}m ${eta % 60}s at ${RATE} req/s`);
for (const w of writes.slice(0, 5)) console.log(`    ${w.key}  →  ${w.to || '(cleared)'}`);
if (writes.length > 5) console.log(`    … ${writes.length - 5} more`);

if (DRY) { console.log('\n(DRY RUN — nothing written. Re-run with --publish.)'); process.exit(0); }
if (!writes.length) { console.log('\nNothing to write.'); process.exit(0); }

// ── write with a small worker pool (each worker paces itself) ───────────────
const t0 = Date.now();
let done = 0, failed = 0;
const queue = writes.slice();
await Promise.all(Array.from({ length: CONC }, async () => {
  for (;;) {
    const w = queue.shift();
    if (!w) return;
    try {
      await notion(`/pages/${w.pageId}`, 'PATCH', { properties: { [property]: w.value } });
    } catch (e) {
      failed++; process.stderr.write(`\n  ✗ ${w.key}: ${e.message.slice(0, 120)}\n`);
    }
    done++;
    if (done % 10 === 0 || done === writes.length) {
      const rate = done / ((Date.now() - t0) / 1000);
      process.stderr.write(`\r  wrote ${done}/${writes.length}  (${rate.toFixed(1)}/s)`);
    }
  }
}));
const secs = ((Date.now() - t0) / 1000).toFixed(0);
process.stderr.write('\n');
console.log(`\n✅ wrote ${done - failed}/${writes.length} rows in ${Math.floor(secs / 60)}m ${secs % 60}s${failed ? ` (${failed} failed)` : ''}`);
