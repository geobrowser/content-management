#!/usr/bin/env node
// geo-mirror Part 2 — plan Notion → Geo changes for ANY mirrored table.
// READ-ONLY on Geo. Writes a plan file that sync-to-geo.mjs dry-runs and publishes.
//
// A mirrored table is any Notion database with a "Geo ID" column — the table and
// page names don't matter. Two table styles, decided per table:
//   • proposal table — has "Proposed …" columns (e.g. the "- new" pages). The
//     "Geo …" columns are the mirrored baseline; the change to publish is an
//     APPROVED proposal ("Publish status" = Approved). Needs --setup once.
//   • direct table   — no "Proposed …" columns (e.g. tables made by
//     mirror-to-notion.mjs). The change is an edited mirrored column. If the table
//     has a "Publish status" column, only Approved rows are used.
//
// Env: NOTION_TOKEN
// Usage:
//   node --env-file=.env plan-notion-changes.mjs --page <PAGE> [--db <DB> …] [--recursive] --setup
//   node --env-file=.env plan-notion-changes.mjs --page <PAGE> --out plan.json [--space <ID>] [--limit N] [--include-qa-flagged]
//   node --env-file=.env plan-notion-changes.mjs --page <PAGE> --preview-all --out preview.json   # review only, never publishable
//   node --env-file=.env sync-to-geo.mjs plan.json [--publish]
//   node --env-file=.env plan-notion-changes.mjs --mark-sent plan.json
//
// Before planning a change it checks the LIVE value in the table's space and skips:
// rows not in that space · QA-flagged rows (any "QA flag…" column set) · names marked
// "Other space (fallback)" · stale proposals (Geo changed since the mirror) · rows
// already sent · properties it can't resolve to exactly one Geo text property.
// Non-text proposals (relations, tags, hierarchy) are counted and left to geo-publish.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  STATUS, STATUS_OPTIONS, norm, idOf, notionClient, gql, findMirroredTables, allRows,
  cellText, classifyTable, liveValues, resolvePropertyIds, spaceFromUrls,
} from './notion-geo-tables.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const many = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const has = (n) => args.includes(n);
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error('NOTION_TOKEN missing from env'); process.exit(1); }
const notion = notionClient(TOKEN);

// ── mark rows of a published plan ────────────────────────────────────────────
if (opt('--mark-sent')) {
  const { plan } = JSON.parse(readFileSync(opt('--mark-sent'), 'utf8'));
  let n = 0;
  for (const p of plan) {
    if (!p.hasPublishStatus) continue;
    await notion(`/pages/${p.notionPageId}`, 'PATCH', { properties: { 'Publish status': { select: { name: STATUS.sent } } } }); n++;
  }
  console.log(`Marked ${n} rows "${STATUS.sent}".${n < plan.length ? ` ${plan.length - n} rows are in tables without a Publish status column.` : ''}`);
  process.exit(0);
}

const page = idOf(opt('--page'));
const dbs = many('--db').map(idOf).filter(Boolean);
if (!page && !dbs.length) { console.error('usage: plan-notion-changes.mjs --page <PAGE> | --db <DB> … (see header)'); process.exit(1); }

const tables = await findMirroredTables(notion, { page, dbs, recursive: has('--recursive') });
if (!tables.length) { console.error('No tables with a "Geo ID" column found. Check the page/database is connected to the integration, or pass --recursive for sub-pages.'); process.exit(1); }

// ── --setup: add the approval column ─────────────────────────────────────────
if (has('--setup')) {
  for (const t of tables) {
    const cur = t.schema['Publish status'];
    if (cur?.type === 'select') { console.log(`"${t.title}": Publish status already exists.`); continue; }
    if (cur) { console.error(`"${t.title}": a "Publish status" column of type ${cur.type} exists; not changing it.`); continue; }
    await notion(`/databases/${t.id}`, 'PATCH', { properties: { 'Publish status': { select: { options: STATUS_OPTIONS } } } });
    console.log(`"${t.title}": added Publish status (${STATUS_OPTIONS.map((o) => o.name).join(' / ')}).`);
  }
  process.exit(0);
}

const previewAll = has('--preview-all');
const includeQa = has('--include-qa-flagged');
const limit = parseInt(opt('--limit') ?? '0') || 0;
const outFile = opt('--out') ?? 'plan.json';
const forcedSpace = opt('--space');

const plan = []; const report = []; const skipped = {}; const unhandled = {}; const blocked = [];
const note = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
const spaceNames = new Map();

for (const t of tables) {
  const cls = classifyTable(t.schema);
  const fields = cls.style === 'proposal' ? cls.proposals : cls.mirrored;
  for (const c of cls.other) unhandled[`${t.title} · ${c}`] = 0;
  if (!fields.size) { report.push({ t, cls, candidates: 0, approved: 0, planned: 0, note: 'no text columns to publish' }); continue; }
  if (cls.style === 'proposal' && !cls.publishStatus && !previewAll) { blocked.push(t.title); continue; }

  const rows = await allRows(notion, t.id);
  for (const c of cls.other) unhandled[`${t.title} · ${c}`] = rows.filter((r) => { const p = r.properties[c]; return (p?.relation?.length ?? p?.multi_select?.length ?? (p?.select ? 1 : 0)) > 0; }).length;

  const ranked = spaceFromUrls(rows.map((r) => r.properties['Geo URL']?.url));
  const spaceId = forcedSpace ?? ranked[0]?.[0];
  if (!spaceId) { report.push({ t, cls, candidates: 0, approved: 0, planned: 0, note: 'no Geo URLs — pass --space' }); continue; }
  if (!spaceNames.has(spaceId)) spaceNames.set(spaceId, (await gql(`{ space(id: "${spaceId}") { page { name } } }`)).space?.page?.name ?? '(space)');

  const statusOf = (r) => (cls.publishStatus ? r.properties[cls.publishStatus]?.select?.name ?? null : null);
  const valueOf = (r, col) => norm(cellText(r.properties[col]));
  const candidates = rows.filter((r) => {
    if (!norm(cellText(r.properties['Geo ID']))) return false;
    if (cls.style === 'proposal') return [...fields.values()].some((f) => valueOf(r, f.column));
    return true;
  });
  const gated = candidates.filter((r) => {
    if (previewAll || !cls.publishStatus) return true;
    return [STATUS.approved, STATUS.sent].includes(statusOf(r));
  });

  const live = await liveValues([...new Set(gated.map((r) => norm(cellText(r.properties['Geo ID']))))], spaceId);
  const props = await resolvePropertyIds([...fields.values()], live);

  let planned = 0; const nowLive = [];
  for (const r of gated) {
    const geoId = norm(cellText(r.properties['Geo ID']));
    const L = live.get(geoId);
    if (!L?.inSpace) { note(`not in ${spaceNames.get(spaceId)} on Geo`); continue; }
    const flags = cls.qaFlags.flatMap((c) => { const p = r.properties[c]; return p?.multi_select?.map((o) => o.name) ?? (p?.select ? [p.select.name] : []); });
    if (flags.length && !includeQa) { note('QA-flagged'); continue; }
    const status = statusOf(r);
    const fallback = cls.nameSource && r.properties[cls.nameSource]?.select?.name === 'Other space (fallback)';
    const changes = []; let fieldsSeen = 0; let fieldsLive = 0;
    for (const [key, f] of fields) {
      const proposal = valueOf(r, f.column);
      if (!proposal) continue;                                  // empty cell: nothing proposed / never blank Geo
      const prop = props.get(key);
      if (!prop) { note(`"${f.column}" isn't a mirrored Geo property (or its name matches several)`); continue; }
      if (prop.dataType !== 'Text') { note(`"${f.geoName}" is a ${prop.dataType} property — use geo-publish`); continue; }
      if (key === 'name' && fallback) { note('name is a fallback from another space'); continue; }
      fieldsSeen++;
      const current = L.values.get(key)?.text ?? '';
      if (current === proposal) { fieldsLive++; continue; }
      if (cls.style === 'proposal') {
        const baseCol = cls.mirrored.get(key)?.column;
        if (baseCol) { if (current !== valueOf(r, baseCol)) { note('stale — Geo changed since the mirror; refresh first'); continue; } }
        else note(`no "Geo ${f.geoName}" column — can't detect a conflicting Geo change (planned anyway)`);
      }
      if (status === STATUS.sent) { note('already sent — waiting for the vote'); continue; }
      changes.push({ property: f.geoName, propertyId: prop.id, dataType: 'Text', old: current, new: proposal });
    }
    if (changes.length) {
      plan.push({ geoId, spaceId, db: t.title, notionPageId: r.id, hasPublishStatus: Boolean(cls.publishStatus), changes });
      planned++;
    } else if (!previewAll && cls.publishStatus && fieldsSeen && fieldsSeen === fieldsLive && [STATUS.approved, STATUS.sent].includes(status)) {
      nowLive.push(r.id);
    }
  }
  for (const id of nowLive) await notion(`/pages/${id}`, 'PATCH', { properties: { [cls.publishStatus]: { select: { name: STATUS.live } } } });
  report.push({
    t, cls, spaceId, candidates: candidates.length,
    approved: cls.publishStatus ? candidates.filter((r) => statusOf(r) === STATUS.approved).length : null,
    planned, markedLive: nowLive.length,
    otherSpaces: ranked.length > 1 && !forcedSpace ? ranked.slice(1).reduce((n, [, c]) => n + c, 0) : 0,
  });
}

const planned = limit ? plan.slice(0, limit) : plan;
const firstSpace = planned[0]?.spaceId ?? report.find((x) => x.spaceId)?.spaceId;
writeFileSync(outFile, JSON.stringify({
  space: firstSpace ? { id: firstSpace, name: spaceNames.get(firstSpace) } : null,
  previewOnly: previewAll, generatedAt: new Date().toISOString(),
  counts: { entities: planned.length, changes: planned.reduce((n, p) => n + p.changes.length, 0) },
  plan: planned,
}, null, 2));

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\n${previewAll ? 'PREVIEW — every filled value, approval ignored (not publishable)' : 'PLAN'}\n`);
console.log('| Table | Style | Space | Rows to check | Approved | In plan |');
console.log('|---|---|---|---|---|---|');
for (const x of report) {
  console.log(`| ${x.t.title} | ${x.cls.style} | ${x.spaceId ? spaceNames.get(x.spaceId) : '—'} | ${x.candidates} | ${x.approved ?? 'no approval column'} | ${x.planned}${x.note ? ` (${x.note})` : ''} |`);
}
for (const b of blocked) console.log(`| ${b} | proposal | — | — | — | blocked: run --setup to add "Publish status" |`);
const changes = planned.flatMap((p) => p.changes);
const byProp = {}; for (const c of changes) byProp[c.property] = (byProp[c.property] ?? 0) + 1;
console.log(`\nChanges: ${changes.length}${changes.length ? ` (${Object.entries(byProp).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}${limit && plan.length > limit ? ` — limited to ${limit} of ${plan.length} rows` : ''}`);
const live = report.reduce((n, x) => n + (x.markedLive ?? 0), 0);
if (live) console.log(`Marked ${live} rows "${STATUS.live}" (the Geo value already matches).`);
const other = report.reduce((n, x) => n + (x.otherSpaces ?? 0), 0);
if (other) console.log(`${other} rows point to another space; they are skipped. Use --space to override.`);
if (Object.keys(skipped).length) { console.log('\nSkipped:'); for (const [k, n] of Object.entries(skipped)) console.log(`  ${n} × ${k}`); }
const un = Object.entries(unhandled).filter(([, n]) => n);
if (un.length) { console.log('\nNot handled here (publish through geo-publish):'); for (const [k, n] of un) console.log(`  ${n} rows × ${k}`); }
if (planned.length) { console.log('\nSample:'); for (const p of planned.slice(0, 5)) for (const c of p.changes) console.log(`  [${p.db}] ${c.property}: "${c.old.slice(0, 50)}" → "${c.new.slice(0, 50)}"`); }
console.log(`\nWrote ${outFile}.${previewAll ? ' Preview only — sync-to-geo refuses to publish it.' : planned.length ? ` Next: node --env-file=.env sync-to-geo.mjs ${outFile}` : ''}`);
if (blocked.length && !planned.length) process.exit(2);
