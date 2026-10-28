#!/usr/bin/env node
// geo-claim-grouping-notion · step 5 — which claim relations ALREADY exist on Geo?
//
// The sink must never propose a relation that is already live on Geo in that direction
// (geo-claim-grouping HARD RULE 7: same-direction existing check). Discovery only knows
// Similar (global pull) and the LEGACY Crypto "Related claims" property — not Root
// Related, Duplicate, Supporting or Opposing. This script pulls all five Root-space
// claim-relation properties (one paged relationsConnection sweep per property, the S3
// shape from geo-claim-grouping/references/queries-and-signals.md) and keeps every edge
// whose BOTH endpoints are roster claims.
//
// READ-ONLY on Geo (public GraphQL, no wallet, no env needed).
//
// Usage:
//   node skills/non-actionable/geo-claim-grouping-notion/scripts/existing-edges-from-geo.mjs \
//     --roster scripts/<campaign>/roster.json [--out scripts/<campaign>/existing-edges.json] \
//     [--endpoint https://api-testnet.geobrowser.io/graphql]
//
// Exit codes: 0 ok · 1 API error · 2 usage error
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const USAGE = `usage: node skills/non-actionable/geo-claim-grouping-notion/scripts/existing-edges-from-geo.mjs \\
  --roster <campaign>/roster.json [--out <campaign>/existing-edges.json] [--endpoint <graphql url>]

  --roster    roster.json from roster-from-notion.mjs (only its ids are used)
  --out       output file (default: existing-edges.json next to --roster)
  --endpoint  Geo GraphQL endpoint (default https://api-testnet.geobrowser.io/graphql)`;

// Root-space Claim relation properties — ids from geo-claim-grouping/SKILL.md (verdict table)
const PROPS = {
  related: '504e5776788844f6a77dba3ee811d8f0',     // Related claims     (step 1)
  duplicate: '982866bf8ae94afe8cce8b805713e4af',   // Duplicate claims   (step 2, mirrored)
  similar: 'e81750db3f09440cab9dd01808a43ccb',     // Similar claims     (step 2, mirrored)
  supporting: '1dc6a843458848198e7a6e672268f811',  // Supporting arguments (directional: supported → supporter)
  opposing: '4e6ec5d14292498a84e5f607ca1a08ce',    // Opposing arguments   (mutual → mirrored; one-sided: rebutted → rebutter)
};
const PAGE_SIZE = 1000;   // matches the parent skill's S3 pulls
const PAGE_GUARD = 400;   // runaway guard, same as discover_candidates.ts PAGE_CAP

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rosterFile = opt('--roster');
if (!rosterFile) { console.error(USAGE); process.exit(2); }
const outFile = opt('--out', join(dirname(rosterFile), 'existing-edges.json'));
const ENDPOINT = opt('--endpoint', 'https://api-testnet.geobrowser.io/graphql');

const roster = JSON.parse(readFileSync(rosterFile, 'utf8'));
if (!Array.isArray(roster.ids)) { console.error(`${rosterFile}: expected { ids: [...] } from roster-from-notion.mjs`); process.exit(2); }
const inRoster = new Set(roster.ids.map((s) => String(s).toLowerCase()));

// ── GraphQL client: lib/gql.mjs semantics (2 retries on 5xx/429/network/transient) ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gql(query, variables, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    let res;
    try { res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }); }
    catch (err) { lastErr = new Error(`gql: network error (attempt ${attempt + 1}/${retries + 1}): ${err.message}`); continue; }
    if (res.status >= 500 || res.status === 429) { lastErr = new Error(`gql: HTTP ${res.status} (attempt ${attempt + 1}/${retries + 1})`); continue; }
    const body = await res.text();
    let json; try { json = JSON.parse(body); } catch { throw new Error(`gql: non-JSON response (HTTP ${res.status}): ${body.slice(0, 300)}`); }
    if (json.errors?.length) {
      const msg = json.errors.map((e) => e.message).join(' | ');
      if (/Unexpected error|Internal/i.test(msg) && attempt < retries) { lastErr = new Error(`gql: transient GraphQL error: ${msg}`); continue; }
      throw new Error(`gql: GraphQL error(s): ${msg}`);
    }
    if (!res.ok) throw new Error(`gql: HTTP ${res.status}: ${body.slice(0, 300)}`);
    return json.data;
  }
  throw lastErr;
}

const QUERY = `query($typeId: UUID!, $after: Cursor) {
  relationsConnection(filter: { typeId: { is: $typeId } }, first: ${PAGE_SIZE}, after: $after) {
    nodes { id fromEntityId toEntityId spaceId }
    pageInfo { hasNextPage endCursor } } }`;

try {
  const edges = {}; const counts = {};
  for (const [key, typeId] of Object.entries(PROPS)) {
    const kept = []; let scanned = 0, pages = 0, after = null, truncated = false;
    for (;;) {
      if (pages >= PAGE_GUARD) { truncated = true; break; }
      const d = await gql(QUERY, { typeId, after });
      const conn = d.relationsConnection; pages++;
      for (const n of conn.nodes) {
        scanned++;
        const from = String(n.fromEntityId).toLowerCase(), to = String(n.toEntityId).toLowerCase();
        if (inRoster.has(from) && inRoster.has(to)) kept.push({ edgeId: n.id, from, to, spaceId: n.spaceId });
      }
      process.stderr.write(`\r  ${key.padEnd(10)} page ${pages}: ${scanned} scanned, ${kept.length} in roster`);
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    process.stderr.write('\n');
    edges[key] = kept; counts[key] = { typeId, scanned, kept: kept.length, pages, truncated };
    if (truncated) console.error(`  ⚠ ${key}: stopped at the ${PAGE_GUARD}-page guard — result is INCOMPLETE`);
  }
  const out = { generatedAt: new Date().toISOString(), endpoint: ENDPOINT, roster: { file: rosterFile, size: inRoster.size, space: roster.space || null }, counts, edges };
  writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
  console.log(`existing-edges — roster ${inRoster.size} ids`);
  for (const [k, c] of Object.entries(counts)) console.log(`  ${k.padEnd(10)} ${String(c.kept).padStart(5)} edges between roster claims  (${c.scanned} scanned graph-wide, ${c.pages} page${c.pages === 1 ? '' : 's'})${c.truncated ? '  ⚠ INCOMPLETE' : ''}`);
  console.log(`  wrote ${outFile}`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
