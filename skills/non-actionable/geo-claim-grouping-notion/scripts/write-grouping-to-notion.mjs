#!/usr/bin/env node
// geo-claim-grouping-notion · step 6 — write adjudicated claim groups into the Notion Claims
// mirror as REVIEW COLUMNS (the sink). This replaces geo-claim-grouping's Geo publish step.
//
// Reads the campaign's decisions.json (step 1) + brackets.json (step 2) [+ clusters.json /
// candidates.scoped.json for exact-name clusters] and computes, per Claims row, the desired
// members of five self-relation columns + one notes column:
//   Proposed related claims        ← step-1 verdicts (every non-NOT-SIMILAR, approved)   → Geo "Related claims"
//   Proposed exact duplicates      ← bracket DUPLICATE + exact-name clusters (star)      → Geo "Duplicate claims"
//   Proposed semantic duplicates   ← bracket SIMILAR                                     → Geo "Similar claims"
//   Proposed supporting arguments  ← bracket SUPPORTS, on the SUPPORTED row               → Geo "Supporting arguments"
//   Proposed opposing arguments    ← bracket OPPOSES (mutual → both rows; else rebutted)  → Geo "Opposing arguments"
//   Proposed grouping notes        ← one line per counterpart: [Tag · conf] <name→Geo URL> — reason
// Direction semantics copy geo-claim-grouping/references/ops-script-template.md (step-2 expansion).
//
// Guarantees: never writes Geo · only ever sends the six columns above · creates missing
// columns, never re-types existing ones · never proposes an edge that already exists on Geo
// in that direction (existing-edges.json) · diff-first (unchanged rows are not written) ·
// dry-run by default, --publish to write, then a read-back that must report 0 remaining.
//
// Env:   NOTION_TOKEN=ntn_...   (loaded with --env-file, never printed)
// Usage:
//   node --env-file=.env skills/non-actionable/geo-claim-grouping-notion/scripts/write-grouping-to-notion.mjs \
//     --db <DB_ID|URL> --campaign scripts/<campaign> --roster scripts/<campaign>/roster.json \
//     [--existing scripts/<campaign>/existing-edges.json] [--floor high|medium] [--prune] \
//     [--rate 3] [--concurrency 4] [--allow-no-geo-check] [--publish]
//
// Exit codes: 0 ok · 1 Notion/API error · 2 usage or contract error (schema conflict, bad input file)
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const USAGE = `usage: node --env-file=.env skills/non-actionable/geo-claim-grouping-notion/scripts/write-grouping-to-notion.mjs \\
  --db <DB_ID|URL> --campaign <dir> --roster <dir>/roster.json [--existing <dir>/existing-edges.json] \\
  [--floor high|medium] [--prune] [--rate 3] [--concurrency 4] [--allow-no-geo-check] [--publish]

  --db                  the Claims mirror database (id or Notion URL)
  --campaign            geo-claim-grouping campaign dir holding decisions.json / brackets.json / clusters.json / candidates.scoped.json
  --roster              roster.json from roster-from-notion.mjs (page ids, names, Geo URLs)
  --existing            existing-edges.json from existing-edges-from-geo.mjs (default: <campaign>/existing-edges.json)
  --floor               minimum confidence that reaches the relation columns: high (default) | medium
                        (lower-confidence pairs still get a notes line tagged "editor call")
  --prune               make each row's columns equal THIS campaign only (drops earlier proposals, hand edits, and
                        proposals since published to Geo — every removal is reported). Default is additive.
  --rate / --concurrency  Notion pacing: requests per second (default 3) and worker pool (default 4)
  --allow-no-geo-check  run without existing-edges.json (loudly) — only for offline fixtures
  --publish             actually write (creates missing columns, patches rows, then reads back). Default: dry-run.`;

// ── contract ────────────────────────────────────────────────────────────────
const COLS = {
  related: 'Proposed related claims',
  duplicate: 'Proposed exact duplicates',
  similar: 'Proposed semantic duplicates',
  supporting: 'Proposed supporting arguments',
  opposing: 'Proposed opposing arguments',
};
const NOTES_COL = 'Proposed grouping notes';
const GEO_PROPS = {                                   // ids from geo-claim-grouping/SKILL.md — reported, never written
  related: '504e5776788844f6a77dba3ee811d8f0', duplicate: '982866bf8ae94afe8cce8b805713e4af', similar: 'e81750db3f09440cab9dd01808a43ccb',
  supporting: '1dc6a843458848198e7a6e672268f811', opposing: '4e6ec5d14292498a84e5f607ca1a08ce',
};
const LABEL = { related: 'Related', duplicate: 'Exact duplicate', similar: 'Semantic duplicate', supporting: 'Supporting', opposing: 'Opposing' };
const BRACKET_PROP = { DUPLICATE: 'duplicate', SIMILAR: 'similar', SUPPORTS: 'supporting', OPPOSES: 'opposing' };
const TAG_RANK = { 'Exact duplicate · same name': 0, 'Exact duplicate': 1, 'Semantic duplicate': 2, 'Supported by': 3, Opposes: 4, 'Opposed by': 5, Related: 6 };
const MAX_TEXT = 1900;        // Notion allows 2000 chars per text object; keep the same headroom as geo-mirror's clip()
const MAX_OBJECTS = 100;      // Notion caps a rich_text property value at 100 objects
const OBJECTS_PER_LINE = 3;   // prefix · hyperlinked name · suffix
const MAX_LINES = Math.floor((MAX_OBJECTS - 1) / OBJECTS_PER_LINE);   // 33 lines + one overflow object
const STALE_EDGES_HOURS = 24; // existing-edges.json older than this is flagged (Geo changes daily)
const HEX32 = /^[0-9a-f]{32}$/;
const GEO_URL_RE = /geobrowser\.io\/space\/[0-9a-f]{32}\/([0-9a-f]{32})/i;

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const idOf = (s) => (s || '').trim().replace(/^.*\/(?=[0-9a-f]{32}\b)/i, '').replace(/[?#].*$/, '').replace(/-/g, '').toLowerCase();
const norm = (s) => String(s ?? '').replace(/-/g, '').trim().toLowerCase();

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const TOKEN = process.env.NOTION_TOKEN;
const dbId = idOf(opt('--db'));
const campaign = opt('--campaign');
const rosterFile = opt('--roster');
const existingFile = opt('--existing', campaign ? join(campaign, 'existing-edges.json') : undefined);
const floor = opt('--floor', 'high');
const PRUNE = args.includes('--prune');
const RATE = parseFloat(opt('--rate', '3'));
const CONC = parseInt(opt('--concurrency', '4'));
const ALLOW_NO_GEO = args.includes('--allow-no-geo-check');
const DRY = !args.includes('--publish');

if (!dbId || !HEX32.test(dbId) || !campaign || !rosterFile) { console.error(USAGE); process.exit(2); }
if (!['high', 'medium'].includes(floor)) { console.error('--floor must be high or medium'); process.exit(2); }
if (!existsSync(campaign) || !statSync(campaign).isDirectory()) { console.error(`--campaign ${campaign} is not a directory`); process.exit(2); }
if (!existsSync(rosterFile)) { console.error(`--roster ${rosterFile} not found`); process.exit(2); }
if (!TOKEN) { console.error('NOTION_TOKEN missing from env — run with: node --env-file=.env …'); process.exit(2); }

// ── inputs ──────────────────────────────────────────────────────────────────
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const roster = readJson(rosterFile);
if (!Array.isArray(roster.ids) || !roster.rows || !roster.space) { console.error(`${rosterFile}: expected { ids, rows, space } from roster-from-notion.mjs`); process.exit(2); }
const rosterRows = {}; for (const [id, r] of Object.entries(roster.rows)) rosterRows[norm(id)] = r;
const inRoster = (id) => Object.prototype.hasOwnProperty.call(rosterRows, id);
const space = norm(roster.space);
const GEO_ID_COL = roster.geoIdProperty || 'Geo ID';

const decisionsFile = join(campaign, 'decisions.json'), bracketsFile = join(campaign, 'brackets.json');
const clustersFile = join(campaign, 'clusters.json'), scopedFile = join(campaign, 'candidates.scoped.json');
const decisionsDoc = existsSync(decisionsFile) ? readJson(decisionsFile) : null;
const bracketsDoc = existsSync(bracketsFile) ? readJson(bracketsFile) : null;
const decisions = decisionsDoc?.decisions ?? [];
const brackets = bracketsDoc?.rows ?? [];
if (decisionsDoc && !Array.isArray(decisionsDoc.decisions)) { console.error(`${decisionsFile}: expected { decisions: [...] } (geo-claim-grouping step-1 schema)`); process.exit(2); }
if (bracketsDoc && !Array.isArray(bracketsDoc.rows)) { console.error(`${bracketsFile}: expected { rows: [...] } (geo-claim-grouping step-2 schema)`); process.exit(2); }
let clusters = [], clustersSource = null;
if (existsSync(clustersFile)) {
  const c = readJson(clustersFile); const list = Array.isArray(c) ? c : c?.clusters;
  if (!Array.isArray(list) || list.some((x) => !Array.isArray(x?.ids))) { console.error(`${clustersFile}: expected [ { "ids": [...], "canonical"?: "<id>", "name"?: "…" } ] or { "clusters": [ … ] } — geo-claim-grouping defines no schema for this file, so this skill accepts only that shape`); process.exit(2); }
  clusters = list; clustersSource = 'clusters.json';
} else if (existsSync(scopedFile)) {
  const s = readJson(scopedFile); clusters = Array.isArray(s.exactNameClusters) ? s.exactNameClusters : []; clustersSource = 'candidates.scoped.json#exactNameClusters';
}
if (!decisions.length && !brackets.length && !clusters.length) { console.error(`nothing to write: no decisions.json / brackets.json / clusters in ${campaign}`); process.exit(2); }

let existing = null; const edgeSet = new Set();
if (existsSync(existingFile)) {
  existing = readJson(existingFile);
  for (const [prop, list] of Object.entries(existing.edges || {})) for (const e of list) edgeSet.add(`${prop}|${norm(e.from)}|${norm(e.to)}`);
} else if (!ALLOW_NO_GEO) {
  console.error(`existing-edges.json not found at ${existingFile} — run existing-edges-from-geo.mjs first (or pass --allow-no-geo-check for offline fixtures). Without it the sink cannot avoid proposing relations that are already live on Geo.`);
  process.exit(2);
}
const hasEdge = (prop, from, to) => edgeSet.has(`${prop}|${from}|${to}`);
const pk = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ── desired state ───────────────────────────────────────────────────────────
const desired = new Map();   // geoId → { rel: {prop: Set<geoId>}, notes: [], touched: Set<geoId> }
const ensure = (id) => { if (!desired.has(id)) desired.set(id, { rel: Object.fromEntries(Object.keys(COLS).map((k) => [k, new Set()])), notes: [], touched: new Set() }); return desired.get(id); };
const floorOk = (conf) => floor === 'medium' || (conf || 'high') === 'high';
const skipped = { notApproved: 0, notSimilar: 0, dedupSuppressed: 0, relatedOnly: 0, unknownBracket: 0, offRoster: 0, belowFloor: 0, alreadyOnGeo: Object.fromEntries(Object.keys(COLS).map((k) => [k, 0])), clustersTooSmall: 0 };
const pairsIn = Object.fromEntries(Object.keys(COLS).map((k) => [k, 0]));
const rowEntries = Object.fromEntries(Object.keys(COLS).map((k) => [k, 0]));
const needsEyes = { bracketWithoutRelated: [], pairIdsNotInRoster: [], scopeMissing: [], rosterRowsMissing: [], unknownPageIds: [], duplicateGeoIds: [], preExistingColumns: [], staleExistingEdges: null, notesOverflow: [], unknownBrackets: [], cappedScope: null };

const addNote = (from, tag, conf, to, reason) => { const d = ensure(from); d.notes.push({ tag, conf: conf || 'high', to, reason: String(reason || '').replace(/\s+/g, ' ').trim() }); d.touched.add(to); };
function propose(prop, from, to, tag, conf, reason) {
  if (hasEdge(prop, from, to)) { skipped.alreadyOnGeo[prop]++; addNote(from, `already on Geo · ${LABEL[prop]}`, conf, to, reason); return; }
  ensure(from).rel[prop].add(to); rowEntries[prop]++; addNote(from, tag, conf, to, reason);
}

// step 1 — Related grouping (every non-NOT-SIMILAR verdict → Related, both rows)
const decisionKeys = new Set();
for (const d of decisions) {
  const a = norm(d.a?.id), b = norm(d.b?.id); decisionKeys.add(pk(a, b));
  if (d.approved === false) { skipped.notApproved++; continue; }
  if (d.verdict === 'NOT-SIMILAR' || d.verdict === 'EXCLUDED-SPACE') { skipped.notSimilar++; continue; }
  if (d.dedupSuppressed) { skipped.dedupSuppressed++; continue; }
  if (!inRoster(a) || !inRoster(b)) { skipped.offRoster++; needsEyes.pairIdsNotInRoster.push(`${d.pairKey || pk(a, b)} (step 1)`); continue; }
  pairsIn.related++;
  const conf = d.confidence || 'high';
  if (!floorOk(conf)) { skipped.belowFloor++; addNote(a, `Related · ${conf} — editor call`, conf, b, d.reason); addNote(b, `Related · ${conf} — editor call`, conf, a, d.reason); continue; }
  propose('related', a, b, 'Related', conf, d.reason); propose('related', b, a, 'Related', conf, d.reason);
}
// step 2 — brackets (direction expansion = ops-script-template.md step-2 script)
for (const r of brackets) {
  const a = norm(r.a?.id), b = norm(r.b?.id);
  if (r.dedupSuppressed) { skipped.dedupSuppressed++; continue; }
  if (r.bracket === 'RELATED-ONLY') { skipped.relatedOnly++; continue; }
  const prop = BRACKET_PROP[r.bracket];
  if (!prop) { skipped.unknownBracket++; needsEyes.unknownBrackets.push(`${r.pairKey || pk(a, b)}: "${r.bracket}"`); continue; }
  if (!inRoster(a) || !inRoster(b)) { skipped.offRoster++; needsEyes.pairIdsNotInRoster.push(`${r.pairKey || pk(a, b)} (step 2 ${r.bracket})`); continue; }
  pairsIn[prop]++;
  const conf = r.confidence || 'high';
  let edges, tag;
  if (r.bracket === 'DUPLICATE' || r.bracket === 'SIMILAR') { edges = [[a, b], [b, a]]; tag = LABEL[prop]; }
  else if (r.bracket === 'SUPPORTS') { const s = r.supported === 'b' ? b : a, o = r.supported === 'b' ? a : b; edges = [[s, o]]; tag = 'Supported by'; }   // edge FROM supported TO supporter
  else if (r.mutual) { edges = [[a, b], [b, a]]; tag = 'Opposes'; }
  else { const reb = r.rebutted === 'b' ? b : a, other = r.rebutted === 'b' ? a : b; edges = [[reb, other]]; tag = 'Opposed by'; }   // FROM rebutted TO rebutter
  if (!floorOk(conf)) { skipped.belowFloor++; for (const [f, t] of edges) addNote(f, `${tag} · ${conf} — editor call`, conf, t, r.reason); continue; }
  for (const [f, t] of edges) propose(prop, f, t, tag, conf, r.reason);
  if (!decisionKeys.has(pk(a, b)) && !hasEdge('related', a, b) && !hasEdge('related', b, a)) needsEyes.bracketWithoutRelated.push(`${r.pairKey || pk(a, b)} (${r.bracket})`);
}
// step 2b — exact-name clusters → Duplicate STAR (canonical ↔ each copy; HARD RULE 8 of the parent skill)
let clustersUsed = 0;
for (const c of clusters) {
  const members = [...new Set((c.ids || []).map(norm))].filter(inRoster).sort();
  if (members.length < 2) { skipped.clustersTooSmall++; continue; }
  const canon = c.canonical && members.includes(norm(c.canonical)) ? norm(c.canonical) : members[0];   // lowest id — all members are same-space
  const reason = `identical normalized name: "${c.name || rosterRows[canon]?.name || ''}"`;
  clustersUsed++; pairsIn.duplicate += members.length - 1;
  for (const copy of members) if (copy !== canon) { propose('duplicate', canon, copy, 'Exact duplicate · same name', 'high', reason); propose('duplicate', copy, canon, 'Exact duplicate · same name', 'high', reason); }
}
for (const id of desired.keys()) if (!inRoster(id)) needsEyes.pairIdsNotInRoster.push(id);
if (existing) {
  const ageH = (Date.now() - Date.parse(existing.generatedAt || 0)) / 36e5;
  if (!(ageH < STALE_EDGES_HOURS)) needsEyes.staleExistingEdges = `existing-edges.json is ${Math.round(ageH)}h old (generated ${existing.generatedAt}) — Geo changes daily; re-run existing-edges-from-geo.mjs`;
}
if (existsSync(scopedFile)) {
  const s = readJson(scopedFile);
  needsEyes.scopeMissing = s.scope?.missing || [];
  // A capped scope means the adjudication is a SAMPLE, not a pass over every kept pair.
  // scope-candidates.mjs already records this; without surfacing it here, section 6 prints
  // "nothing" over a partial adjudication and the columns read as complete.
  const sc = s.scoped || {};
  if (s.capped || sc.capped) {
    const waiting = Number.isFinite(sc.keptBeforeCap) && Number.isFinite(sc.exported) ? sc.keptBeforeCap - sc.exported : null;
    needsEyes.cappedScope = `adjudication is a SAMPLE — candidates.scoped.json is capped${sc.top ? ` at --top ${sc.top}` : ''}${waiting != null ? `, ${waiting} kept pair(s) were never adjudicated` : ''}. Re-run scope-candidates.mjs with a higher --top and adjudicate the remainder before treating these columns as a complete pass.`;
  }
}

// ── notes rendering ─────────────────────────────────────────────────────────
const clip = (s) => String(s ?? '').slice(0, MAX_TEXT);
const txt = (content, url) => ({ type: 'text', text: { content: clip(content), link: url ? { url } : null } });
const urlOf = (id) => rosterRows[id]?.url || `https://www.geobrowser.io/space/${space}/${id}`;
const nameOf = (id) => rosterRows[id]?.name || id;
const rank = (n) => TAG_RANK[n.tag] ?? (n.tag.startsWith('already on Geo') ? 8 : 7);
function renderNotes(notes) {
  const sorted = [...notes].sort((x, y) => rank(x) - rank(y) || nameOf(x.to).localeCompare(nameOf(y.to)) || x.to.localeCompare(y.to));
  const lines = sorted.slice(0, MAX_LINES).flatMap((n) => [txt(`[${n.tag} · ${n.conf}] `), txt(nameOf(n.to), urlOf(n.to)), txt(`${n.reason ? ` — ${n.reason}` : ''}\n`)]);
  if (sorted.length > MAX_LINES) lines.push(txt(`… +${sorted.length - MAX_LINES} more (see the relation columns)\n`));
  return lines;
}
// split a current rich_text value into lines; each line's counterpart = first geobrowser link in it
function splitLines(objs) {
  const lines = []; let cur = [];
  for (const o of objs) { cur.push(o); if ((o.plain_text ?? o.text?.content ?? '').endsWith('\n')) { lines.push(cur); cur = []; } }
  if (cur.length) lines.push(cur);
  return lines.map((objsOfLine) => ({ objs: objsOfLine, to: objsOfLine.map((o) => GEO_URL_RE.exec(o.href || o.text?.link?.url || '')?.[1]?.toLowerCase()).find(Boolean) || null }));
}
const strip = (o) => ({ type: 'text', text: { content: o.plain_text ?? o.text?.content ?? '', link: (o.href || o.text?.link?.url) ? { url: o.href || o.text.link.url } : null }, ...(o.annotations && Object.values(o.annotations).some((v) => v === true || (typeof v === 'string' && v !== 'default')) ? { annotations: o.annotations } : {}) });
const notesSig = (objs) => JSON.stringify(objs.map((o) => [o.text?.content ?? o.plain_text ?? '', o.text?.link?.url || o.href || null]));
const relSig = (ids) => [...new Set(ids.map(norm))].sort().join(',');

// ── Notion client (paced + retrying; same shape as geo-mirror/scripts/bulk-set-property.mjs) ──
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
async function allRows(database) {
  const rows = []; let cursor;
  do { const res = await notion(`/databases/${database}/query`, 'POST', cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }); rows.push(...res.results); cursor = res.has_more ? res.next_cursor : null; process.stderr.write(`\r  read ${rows.length} rows`); } while (cursor);
  process.stderr.write('\n'); return rows;
}
async function fullRelation(pageId, propId) {          // relation values > 25 come back truncated (has_more) — page the property endpoint
  const ids = []; let cursor;
  do { const res = await notion(`/pages/${pageId}/properties/${propId}?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`); for (const x of res.results || []) if (x.relation?.id) ids.push(x.relation.id); cursor = res.has_more ? res.next_cursor : null; } while (cursor);
  return ids;
}
const plain = (p) => !p ? null : p.type === 'title' ? p.title.map((t) => t.plain_text).join('') : p.type === 'rich_text' ? p.rich_text.map((t) => t.plain_text).join('') : null;

try {
  // ── schema ──────────────────────────────────────────────────────────────────
  let db = await notion(`/databases/${dbId}`);
  const dbTitle = (db.title || []).map((t) => t.plain_text).join('') || '(untitled)';
  const titleProperty = Object.keys(db.properties).find((k) => db.properties[k].type === 'title');
  if (!db.properties[GEO_ID_COL] || db.properties[GEO_ID_COL].type !== 'rich_text') { console.error(`column "${GEO_ID_COL}" (rich_text) not found on "${dbTitle}"`); process.exit(2); }
  const toCreate = {}, conflicts = [], present = [];
  for (const [key, name] of Object.entries(COLS)) {
    const p = db.properties[name];
    if (!p) toCreate[name] = { relation: { database_id: db.id, single_property: {} } };
    else if (p.type !== 'relation') conflicts.push(`"${name}" exists as ${p.type} (expected relation)`);
    else if (norm(p.relation?.database_id) !== dbId) conflicts.push(`"${name}" is a relation to another database (${p.relation?.database_id})`);
    else present.push(name);
  }
  if (!db.properties[NOTES_COL]) toCreate[NOTES_COL] = { rich_text: {} };
  else if (db.properties[NOTES_COL].type !== 'rich_text') conflicts.push(`"${NOTES_COL}" exists as ${db.properties[NOTES_COL].type} (expected rich_text)`);
  else present.push(NOTES_COL);
  if (conflicts.length) { console.error(`schema conflict on "${dbTitle}" — this skill never re-types a column:\n  ${conflicts.join('\n  ')}`); process.exit(2); }
  needsEyes.preExistingColumns = present;

  // ── current rows ────────────────────────────────────────────────────────────
  const rows = await allRows(dbId);
  const byGeo = new Map(); const dupGeo = new Set();
  for (const r of rows) { const g = norm(plain(r.properties[GEO_ID_COL])); if (!HEX32.test(g)) continue; if (byGeo.has(g)) dupGeo.add(g); else byGeo.set(g, r); }
  for (const g of dupGeo) { byGeo.delete(g); needsEyes.duplicateGeoIds.push(g); }
  const geoByPage = new Map([...byGeo].map(([g, r]) => [norm(r.id), g]));
  const pageOf = (g) => byGeo.get(g) ? norm(byGeo.get(g).id) : null;

  // ── per-row plan ────────────────────────────────────────────────────────────
  const targets = PRUNE ? new Set([...byGeo.keys()]) : new Set([...desired.keys()].filter((g) => byGeo.has(g)));
  for (const g of desired.keys()) if (!byGeo.has(g) && inRoster(g)) needsEyes.rosterRowsMissing.push(g);
  const plan = []; let unchanged = 0;
  for (const g of targets) {
    const row = byGeo.get(g); const want = desired.get(g) || ensure(g);
    const changes = {}; const body = {}; let touchedAny = false;
    for (const [key, name] of Object.entries(COLS)) {
      const p = row.properties[name];
      let curIds = p ? p.relation.map((x) => norm(x.id)) : [];
      if (p?.has_more) curIds = (await fullRelation(row.id, db.properties[name].id)).map(norm);
      const wantIds = [...want.rel[key]].map(pageOf).filter(Boolean);
      const unknown = curIds.filter((id) => !geoByPage.has(id));
      if (unknown.length && !PRUNE) needsEyes.unknownPageIds.push(...unknown.map((id) => `${g}/${name}: ${id}`));
      const finalIds = PRUNE ? wantIds : [...new Set([...curIds, ...wantIds])];
      if (relSig(curIds) !== relSig(finalIds)) {
        const cur = new Set(curIds), fin = new Set(finalIds);
        changes[key] = { add: finalIds.filter((id) => !cur.has(id)).map((id) => geoByPage.get(id) || id), remove: curIds.filter((id) => !fin.has(id)).map((id) => geoByPage.get(id) || id) };
        body[name] = { relation: finalIds.map((id) => ({ id })) }; touchedAny = true;
      }
    }
    const curNotes = row.properties[NOTES_COL]?.rich_text || [];
    const keptLines = PRUNE ? [] : splitLines(curNotes).filter((l) => !(l.to && want.touched.has(l.to))).flatMap((l) => l.objs.map(strip));
    let finalNotes = [...keptLines, ...renderNotes(want.notes)];
    if (finalNotes.length > MAX_OBJECTS) { needsEyes.notesOverflow.push(g); finalNotes = finalNotes.slice(0, MAX_OBJECTS - 1).concat([txt('… (notes truncated — 100-object limit)\n')]); }
    if (notesSig(curNotes.map(strip)) !== notesSig(finalNotes)) { body[NOTES_COL] = { rich_text: finalNotes }; changes.notes = { lines: want.notes.length, kept: PRUNE ? 0 : keptLines.length }; touchedAny = true; }
    if (!touchedAny) { unchanged++; continue; }
    plan.push({ geoId: g, pageId: norm(row.id), name: nameOf(g), url: urlOf(g), changes, body });
  }

  // ── report ──────────────────────────────────────────────────────────────────
  const link = (g) => `${nameOf(g)} <${urlOf(g)}>`;
  const cnt = (o) => Object.entries(o).map(([k, v]) => `${LABEL[k] || k} ${v}`).join(' · ');
  const L = [];
  L.push(`${DRY ? 'DRY RUN' : 'PUBLISH'} — geo-claim-grouping-notion → "${dbTitle}" (${dbId})`);
  L.push(`1 Inputs      roster ${roster.ids.length} ids (space ${space}, fetched ${roster.fetchedAt}) · decisions.json ${decisionsDoc ? `${decisions.length} rows (adjudicated ${decisionsDoc.adjudicatedAt || '?'})` : 'absent'} · brackets.json ${bracketsDoc ? `${brackets.length} rows (adjudicated ${bracketsDoc.adjudicatedAt || '?'})` : 'absent'} · clusters ${clustersSource ? `${clusters.length} from ${clustersSource} (${clustersUsed} used)` : 'absent'} · existing-edges ${existing ? `${existing.generatedAt} [${cnt(Object.fromEntries(Object.entries(existing.counts || {}).map(([k, v]) => [k, v.kept])))}]` : '⚠ NONE (--allow-no-geo-check)'} · floor=${floor} · mode=${PRUNE ? 'prune' : 'additive'}`);
  L.push(`2 Schema      title column "${titleProperty}" · "${GEO_ID_COL}" ok · columns present [${present.join(', ') || '—'}] · TO CREATE [${Object.keys(toCreate).join(', ') || '—'}]`);
  L.push(`3 Proposals   pairs in → row entries planned: ${Object.keys(COLS).map((k) => `${LABEL[k]} ${pairsIn[k]}→${rowEntries[k]}`).join(' · ')}`);
  L.push(`              skipped: off-roster ${skipped.offRoster} · not approved ${skipped.notApproved} · NOT-SIMILAR/EXCLUDED ${skipped.notSimilar} · RELATED-ONLY ${skipped.relatedOnly} · dedupSuppressed ${skipped.dedupSuppressed} · below floor ${skipped.belowFloor} · unknown bracket ${skipped.unknownBracket} · clusters <2 in roster ${skipped.clustersTooSmall}`);
  L.push(`              already on Geo (per direction): ${cnt(skipped.alreadyOnGeo)}`);
  L.push(`4 Rows        ${plan.length} row${plan.length === 1 ? '' : 's'} change · ${unchanged} already correct · ${rows.length} rows in the database`);
  const unusual = (p) => Object.values(p.changes).some((c) => c.remove?.length) || needsEyes.notesOverflow.includes(p.geoId);
  const shown = [...plan.slice(0, 10), ...plan.slice(10).filter(unusual)];
  for (const p of shown) {
    L.push(`   • ${link(p.geoId)}`);
    for (const [key, c] of Object.entries(p.changes)) {
      if (key === 'notes') { L.push(`       ${NOTES_COL}: ${c.lines} line${c.lines === 1 ? '' : 's'} from this campaign${c.kept ? ` + ${c.kept} kept objects` : ''}`); continue; }
      if (c.add.length) L.push(`       ${COLS[key]}: +${c.add.length}  ${c.add.map(link).join(' | ')}`);
      if (c.remove.length) L.push(`       ${COLS[key]}: −${c.remove.length}  ${c.remove.map(link).join(' | ')}   ⚠ REMOVAL (--prune)`);
    }
  }
  if (plan.length > shown.length) L.push(`   … ${plan.length - shown.length} more rows (all in the run record)`);
  const reqs = plan.length + (Object.keys(toCreate).length ? 1 : 0); const eta = Math.ceil(reqs / RATE);
  L.push(`5 Write plan  ${Object.keys(toCreate).length ? `1 schema PATCH (${Object.keys(toCreate).length} column${Object.keys(toCreate).length === 1 ? '' : 's'}) + ` : ''}${plan.length} row PATCH${plan.length === 1 ? '' : 'es'} · estimated ~${Math.floor(eta / 60)}m ${eta % 60}s at ${RATE} req/s`);
  for (const p of plan.slice(0, 5)) L.push(`     ${p.name.slice(0, 70)}  →  ${Object.entries(p.changes).map(([k, c]) => k === 'notes' ? 'notes' : `${LABEL[k]} +${c.add.length}${c.remove.length ? `/−${c.remove.length}` : ''}`).join(', ')}`);
  const eyes = [];
  if (needsEyes.cappedScope) eyes.push(needsEyes.cappedScope);
  if (needsEyes.scopeMissing.length) eyes.push(`${needsEyes.scopeMissing.length} roster id(s) were not in the Geo corpus at discovery (scope.missing): ${needsEyes.scopeMissing.slice(0, 5).join(', ')}${needsEyes.scopeMissing.length > 5 ? ' …' : ''}`);
  if (needsEyes.bracketWithoutRelated.length) eyes.push(`${needsEyes.bracketWithoutRelated.length} bracket pair(s) have no step-1 decision and no live Related edge: ${needsEyes.bracketWithoutRelated.slice(0, 5).join(' | ')}${needsEyes.bracketWithoutRelated.length > 5 ? ' …' : ''}`);
  if (needsEyes.pairIdsNotInRoster.length) eyes.push(`${needsEyes.pairIdsNotInRoster.length} pair(s) reference claims outside the roster (dropped): ${needsEyes.pairIdsNotInRoster.slice(0, 5).join(' | ')}${needsEyes.pairIdsNotInRoster.length > 5 ? ' …' : ''}`);
  if (needsEyes.unknownBrackets.length) eyes.push(`unknown bracket values: ${needsEyes.unknownBrackets.join(' | ')}`);
  if (needsEyes.staleExistingEdges) eyes.push(needsEyes.staleExistingEdges);
  if (!existing) eyes.push('NO existing-edges.json — relations already live on Geo may be re-proposed');
  if (needsEyes.duplicateGeoIds.length) eyes.push(`duplicate Geo IDs in the database (rows skipped): ${needsEyes.duplicateGeoIds.join(', ')}`);
  if (needsEyes.rosterRowsMissing.length) eyes.push(`${needsEyes.rosterRowsMissing.length} roster claim(s) no longer have a row (re-run roster-from-notion.mjs): ${needsEyes.rosterRowsMissing.slice(0, 5).join(', ')}`);
  if (needsEyes.unknownPageIds.length) eyes.push(`${needsEyes.unknownPageIds.length} existing relation value(s) point at pages outside the roster (kept): ${needsEyes.unknownPageIds.slice(0, 3).join(' | ')}${needsEyes.unknownPageIds.length > 3 ? ' …' : ''}`);
  if (present.length) eyes.push(`columns that pre-existed (not created by this run): ${present.join(', ')}`);
  if (needsEyes.notesOverflow.length) eyes.push(`notes truncated at the 100-object limit on: ${needsEyes.notesOverflow.slice(0, 5).join(', ')}`);
  if (PRUNE) eyes.push(`--prune: every relation/notes value not produced by THIS campaign is removed (see ⚠ REMOVAL lines) — including hand edits and proposals since published to Geo`);
  L.push(`6 ⚠ Needs your eyes${eyes.length ? '' : '  nothing'}`); for (const e of eyes) L.push(`   - ${e}`);
  console.log('\n' + L.join('\n'));

  const record = { runAt: new Date().toISOString(), mode: DRY ? 'dry-run' : 'publish', db: { id: dbId, title: dbTitle }, campaign, floor, prune: PRUNE,
    inputs: { roster: { file: rosterFile, size: roster.ids.length, space, fetchedAt: roster.fetchedAt }, decisions: decisionsDoc ? { file: decisionsFile, adjudicatedAt: decisionsDoc.adjudicatedAt || null, count: decisions.length } : null, brackets: bracketsDoc ? { file: bracketsFile, adjudicatedAt: bracketsDoc.adjudicatedAt || null, count: brackets.length } : null, clusters: clustersSource ? { source: clustersSource, count: clusters.length, used: clustersUsed } : null, existing: existing ? { file: existingFile, generatedAt: existing.generatedAt, counts: existing.counts } : null },
    schema: { titleProperty, geoIdProperty: GEO_ID_COL, present, toCreate: Object.keys(toCreate), geoProperties: GEO_PROPS },
    proposals: { pairsIn, rowEntries, skipped }, counts: { rowsInDb: rows.length, rowsUnchanged: unchanged, rowsToWrite: plan.length },
    rows: plan.map(({ body, ...p }) => p), needsEyes };
  const recordFile = join(campaign, `grouping-notion.${DRY ? 'dryrun' : 'publish'}.json`);

  if (DRY) { writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n'); console.log(`\n(DRY RUN — nothing written. Run record: ${recordFile}. Re-run with --publish after the editor replies "publish".)`); process.exit(0); }

  // ── publish ─────────────────────────────────────────────────────────────────
  if (Object.keys(toCreate).length) { await notion(`/databases/${dbId}`, 'PATCH', { properties: toCreate }); db = await notion(`/databases/${dbId}`); console.log(`\n  created columns: ${Object.keys(toCreate).join(', ')}`); }
  if (!plan.length) { record.readBack = { remaining: 0, checked: 0 }; writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n'); console.log('\nNothing to write.'); process.exit(0); }
  const t0 = Date.now(); let done = 0, failed = 0; const failures = []; const queue = plan.slice();
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const w = queue.shift(); if (!w) return;
      try { await notion(`/pages/${w.pageId}`, 'PATCH', { properties: w.body }); }
      catch (e) { failed++; failures.push({ geoId: w.geoId, error: e.message.slice(0, 200) }); process.stderr.write(`\n  ✗ ${w.name.slice(0, 60)}: ${e.message.slice(0, 120)}\n`); }
      done++; if (done % 10 === 0 || done === plan.length) process.stderr.write(`\r  wrote ${done}/${plan.length}  (${(done / ((Date.now() - t0) / 1000)).toFixed(1)}/s)`);
    }
  }));
  process.stderr.write('\n');
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✅ wrote ${done - failed}/${plan.length} rows in ${Math.floor(secs / 60)}m ${secs % 60}s${failed ? ` (${failed} FAILED)` : ''}`);

  // ── read-back: every planned row must now equal its planned value ───────────
  const after = new Map(); for (const r of await allRows(dbId)) after.set(norm(r.id), r);
  let remaining = 0; const mismatches = [];
  for (const w of plan) {
    const r = after.get(w.pageId); if (!r) { remaining++; mismatches.push(`${w.geoId}: row missing`); continue; }
    for (const [name, val] of Object.entries(w.body)) {
      if (val.relation) { const p = r.properties[name]; let cur = p ? p.relation.map((x) => norm(x.id)) : []; if (p?.has_more) cur = (await fullRelation(r.id, db.properties[name].id)).map(norm); if (relSig(cur) !== relSig(val.relation.map((x) => x.id))) { remaining++; mismatches.push(`${w.geoId}/${name}`); } }
      else if (notesSig((r.properties[name]?.rich_text || []).map(strip)) !== notesSig(val.rich_text)) { remaining++; mismatches.push(`${w.geoId}/${name}`); }
    }
  }
  record.readBack = { checked: plan.length, remaining, mismatches: mismatches.slice(0, 50), failures };
  writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n');
  console.log(`read-back: ${plan.length} rows checked, ${remaining} remaining difference${remaining === 1 ? '' : 's'}${remaining ? ` — ${mismatches.slice(0, 5).join(' | ')}` : ' ✓'}`);
  console.log(`run record: ${recordFile}`);
  process.exit(remaining || failed ? 1 : 0);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
