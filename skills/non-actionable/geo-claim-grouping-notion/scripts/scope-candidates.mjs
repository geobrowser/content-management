#!/usr/bin/env node
// geo-claim-grouping-notion · step 3 — restrict discovery output to the roster.
//
// geo-claim-grouping's discovery keeps every pair that touches ANY scope claim
// (discover_candidates.ts: `!anchorSet.has(A.id) && !anchorSet.has(B.id)` → skip), so
// the counterpart can be any claim of the space or, with semantic recall, any space.
// This skill writes self-relations on the Claims mirror, so BOTH sides must be roster
// rows. This script drops every other pair, filters the exact-name clusters and the
// existing Similar edges to roster members, re-caps to an adjudication batch, and
// writes candidates.scoped.json — the file the editor adjudicates.
//
// Pure file transform: no network, no env, no writes anywhere but --out.
//
// Usage:
//   node skills/non-actionable/geo-claim-grouping-notion/scripts/scope-candidates.mjs \
//     --candidates scripts/<campaign>/candidates.json --roster scripts/<campaign>/roster.json \
//     [--top 80] [--out scripts/<campaign>/candidates.scoped.json]
//
// Exit codes: 0 ok · 2 usage/contract error
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const USAGE = `usage: node skills/non-actionable/geo-claim-grouping-notion/scripts/scope-candidates.mjs \\
  --candidates <campaign>/candidates.json --roster <campaign>/roster.json [--top 80] [--out <campaign>/candidates.scoped.json]

  --candidates  discovery output from geo-claim-grouping/scripts/discover_candidates.ts
  --roster      roster.json from roster-from-notion.mjs
  --top         adjudication batch size after filtering, top-by-score (default 80 — the parent skill's proven batch)
  --out         output file (default: candidates.scoped.json next to --candidates)`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const candFile = opt('--candidates');
const rosterFile = opt('--roster');
const top = Number(opt('--top', '80'));
if (!candFile || !rosterFile) { console.error(USAGE); process.exit(2); }
if (!Number.isFinite(top) || top < 1) { console.error('--top must be a positive number'); process.exit(2); }
const outFile = opt('--out', join(dirname(candFile), 'candidates.scoped.json'));

const cand = JSON.parse(readFileSync(candFile, 'utf8'));
const roster = JSON.parse(readFileSync(rosterFile, 'utf8'));
if (!Array.isArray(cand.pairs)) { console.error(`${candFile}: no "pairs" array — is this a discovery candidates.json?`); process.exit(2); }
if (!Array.isArray(roster.ids) || !roster.space) { console.error(`${rosterFile}: expected { ids: [...], space: "<32hex>" } from roster-from-notion.mjs`); process.exit(2); }

const inRoster = new Set(roster.ids.map((s) => String(s).toLowerCase()));
const rosterSpace = String(roster.space).toLowerCase();
const sideSpace = (side) => (side?.space || (Array.isArray(side?.spaces) && side.spaces.includes(rosterSpace) ? rosterSpace : side?.spaces?.[0]) || '').toLowerCase();

// ── pairs: keep only both-in-roster; classify what was dropped ──────────────
const kept = []; const dropped = { bothOff: 0, oneOff: { sameSpaceNotInMirror: 0, otherSpace: 0 } };
for (const p of cand.pairs) {
  const aIn = inRoster.has(String(p.a?.id).toLowerCase()), bIn = inRoster.has(String(p.b?.id).toLowerCase());
  if (aIn && bIn) { kept.push(p); continue; }
  if (!aIn && !bIn) { dropped.bothOff++; continue; }
  const off = aIn ? p.b : p.a;
  if (sideSpace(off) === rosterSpace) dropped.oneOff.sameSpaceNotInMirror++; else dropped.oneOff.otherSpace++;
}
// discovery order is already score-desc (stable) — do not re-sort, just re-cap
const exported = kept.slice(0, top);
const capped = kept.length > exported.length;

// ── exact-name clusters: intersect with the roster, keep clusters of ≥ 2 ────
const clustersIn = (cand.exactNameClusters || []).length;
const exactNameClusters = (cand.exactNameClusters || [])
  .map((c) => ({ ...c, ids: (c.ids || []).map((s) => String(s).toLowerCase()).filter((id) => inRoster.has(id)).sort() }))
  .filter((c) => c.ids.length >= 2)
  .map((c) => ({ ...c, size: c.ids.length, spaces: [rosterSpace], crossSpace: false }));

// ── existing Similar edges: both endpoints in roster ────────────────────────
const existingIn = (cand.existingSimilarEdges || []).length;
const existingSimilarEdges = (cand.existingSimilarEdges || []).filter((e) => inRoster.has(String(e.fromId).toLowerCase()) && inRoster.has(String(e.toId).toLowerCase()));

const scopeMissing = cand.scope?.missing || [];
const out = {
  ...cand,
  pairs: exported,
  pairsExported: exported.length,
  capped: Boolean(cand.capped) || capped,
  exactNameClusters,
  existingSimilarEdges,
  scoped: {
    scopedAt: new Date().toISOString(),
    roster: { file: rosterFile, db: roster.db, size: inRoster.size, space: rosterSpace, fetchedAt: roster.fetchedAt },
    top, inputPairs: cand.pairs.length, keptBeforeCap: kept.length, exported: exported.length, capped,
    dropped, clustersIn, clustersOut: exactNameClusters.length, existingSimilarIn: existingIn, existingSimilarOut: existingSimilarEdges.length,
    scopeMissing: scopeMissing.length,
  },
};
writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');

console.log(`scope-candidates — roster ${inRoster.size} ids (space ${rosterSpace})`);
console.log(`  pairs in            : ${cand.pairs.length}${cand.capped ? '  (discovery was CAPPED — re-run it with a higher --cap or --resume --cap N)' : ''}`);
console.log(`  both in roster      : ${kept.length}`);
console.log(`  dropped             : ${dropped.bothOff} both off · ${dropped.oneOff.sameSpaceNotInMirror} one side same-space-not-in-mirror · ${dropped.oneOff.otherSpace} one side other space`);
console.log(`  exported (top ${top})  : ${exported.length}${capped ? `  (CAPPED — ${kept.length - exported.length} kept pairs wait for the next batch)` : ''}`);
console.log(`  exact-name clusters : ${clustersIn} → ${exactNameClusters.length} (roster members only)`);
console.log(`  existing Similar    : ${existingIn} → ${existingSimilarEdges.length} (both in roster)`);
if (scopeMissing.length) console.log(`  ⚠ scope.missing     : ${scopeMissing.length} roster ids not in the Geo corpus → ${scopeMissing.slice(0, 5).join(' | ')}${scopeMissing.length > 5 ? ' …' : ''}`);
console.log(`  wrote ${outFile}`);
