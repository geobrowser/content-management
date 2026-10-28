/**
 * geo-claim-grouping · discover_candidates.ts — READ-ONLY candidate generator
 * ---------------------------------------------------------------------------
 * Pulls a space's Claim corpus + signal edges, pre-clusters candidate claim
 * pairs (text-first + structural recall), scores them, and exports the top-cap
 * pairs to candidates.json for in-conversation adjudication (Stage B).
 *
 * READ-ONLY: gql() pulls only — no wallet, no ops, no writes to Geo.
 * Runs from the REPO ROOT (both the tracked skill copy and the deployed
 * .claude/skills copy sit 4 levels below root, so the ../../../../ import
 * resolves from either):
 *   bun run skills/actionable/geo-claim-grouping/scripts/discover_candidates.ts --space <32hex> [--cap 80]
 *
 * Scoring constants are documented in ../references/queries-and-signals.md —
 * ported from the adjudication-validated P7 pass (2026-07-09 crypto sweep),
 * plus structural terms for the verified high-coverage signals.
 */
import { gql } from "../../../../src/functions.ts";
import * as fs from "fs";
import * as path from "path";

// ─── Well-known IDs (verified live 2026-08-04, see references/queries-and-signals.md) ───
const CLAIM_TYPE = "96f859efa1ca4b229372c86ad58b694b";
const SIMILAR_CLAIMS = "e81750db3f09440cab9dd01808a43ccb";   // step-2 pass-3 bracket
const RELATED_GROUPING = "504e5776788844f6a77dba3ee811d8f0"; // step-1 Related claims (Root schema) — the grouping baseline
const DUPLICATE_CLAIMS = "982866bf8ae94afe8cce8b805713e4af"; // step-2 pass-2 bracket
const RELATED_CLAIMS = "a8aa1b654afd4ac786a243481d806846";   // LEGACY Crypto-space property — annotation only, never emitted
const SOURCES = "49c5d5e1679a4dbdbfd33f618f227c94";          // Claim -> citation entity (per-claim; NAME = article headline)
const NOTABLE_CLAIMS = "e1371bcda7044396adb7ea7ecc8fe3d4";   // News story -> Claim (claim is toEntityId)
const TOPICS_A = "806d52bc27e94c9193c057978b093351";         // two Topics property ids coexist on Claim schemas —
const TOPICS_B = "3b7759e55a714a8084d489258fd4bdd5";         // pull both, report per-id counts

const EDITOR_SPACES: Record<string, string> = {
  crypto: "c9f267dcb0d270718c2a3c45a64afd32",
  wa: "89bd89bf28ff8a0963faf92a8c905e20",
  ai: "41e851610e13a19441c4d980f2f2ce6b",
  health: "52c7ae149838b6d47ce0f3b2a5974546",
};
const SLUG_BY_SPACE = Object.fromEntries(Object.entries(EDITOR_SPACES).map(([k, v]) => [v, k]));

// ⛔ Excluded spaces (editor directive 2026-08-21): the Podcasts catch-all space holds
// episode-extracted claim copies that must NEVER be linked by this skill — any property,
// any layer (HARD RULE 12 in SKILL.md). Claims with ANY excluded-space residency are
// refused as --space/--pool/--seed and dropped from every admission path (semantic
// recall + a live residency gate on the export); drops are counted in the summary.
const EXCLUDED_SPACE_IDS: Record<string, string> = { b5a31f8182b042437ede0f84ee02f104: "podcasts" };

// ─── Pre-cluster constants (see references/queries-and-signals.md for justification) ───
const DF_SKIP = 20;          // salient tokens this common separate nothing
const POSTING_SKIP = 12;     // quadratic-pair guard on hub tokens
const RARE_DF = 4;           // shared rare token = near-decisive for recall
const DEFAULT_MIN_JACCARD = 0.42;
const RARE_MIN_JACCARD = 0.3;
const MIN_SHARED_SALIENT = 3;
const DEFAULT_RECENT_DAYS = 14;
const W_SALIENT = 0.08, W_RECENT = 0.15, W_SOURCE = 0.25, W_STORY = 0.10, W_TOPIC = 0.10;
const CITATION_POSTING_SKIP = 25;  // shared-citation hub guard (one article cited by >25 claims)
const STORY_POSTING_SKIP = 50;     // a story's Notable-claims list is normally ~17
const TOPIC_POSTING_SKIP = 60;     // topics are sparse (4–14% coverage) but can hub
const STRUCT_MIN_SHARED_CITATIONS = 2;  // structural admission without text support
const DEFAULT_CAP = 80;      // the proven single-batch adjudication size
const PAGE_CAP = 400;        // runaway guard; logs "scan INCOMPLETE" when hit
const DESC_SLICE = 300;      // description prefix used for tokenization
const STOP = new Set(("the a an of in on for to and or as at by with from into over under after before amid its his her " +
  "their is are was were be been has have had will would can could may might says said say up out down off vs via " +
  "about more less than it that this these those not no now how what when why who which while during against between").split(" "));

// ─── CLI ─────────────────────────────────────────────────────────────────────
const USAGE = `discover_candidates.ts — read-only Similar-claims candidate generator (geo-claim-grouping skill)

USAGE (from the repo root):
  bun run skills/actionable/geo-claim-grouping/scripts/discover_candidates.ts --space <32hex> [options]
  bun run skills/actionable/geo-claim-grouping/scripts/discover_candidates.ts --seed <claimId32hex> [options]
  bun run skills/actionable/geo-claim-grouping/scripts/discover_candidates.ts --all-spaces [options]

MODES (exactly one required):
  --space <id>      scan one space's Claim corpus for candidate pairs
  --seed <id>       candidates around one claim (semantic search + pre-cluster vs its home space)
  --all-spaces      run --space for each editor space (crypto, wa, ai, health), one campaign dir each

OPTIONS:
  --pool <csv>      extra spaces (slugs crypto|wa|ai|health or 32hex ids) whose Claim corpora + signals
                    join the candidate pool — enables CROSS-SPACE matches
  --scope-file <p>  JSON { "ids": ["<32hex>", ...] } — only pairs touching these claims are exported
                    (page/tab campaigns); each scope claim also gets a semantic search() recall
                    pass, restricted to --space plus any --pool spaces
  --no-semantic     skip the per-scope-claim semantic search() pass (~6s per claim)
  --cap <n>         max pairs exported for adjudication, top-by-score (default ${DEFAULT_CAP})
  --out <dir>       campaign dir (default scripts/<YYYY-MM-DD>-similar-claims-<slug>)
  --resume          reuse claims-/signals- checkpoints in the campaign dir instead of re-pulling
  --min-jaccard <x> text-admission jaccard threshold (default ${DEFAULT_MIN_JACCARD})
  --recent-days <n> recency-bonus window in days (default ${DEFAULT_RECENT_DAYS})
  --help            this text

EXAMPLES:
  bun run skills/actionable/geo-claim-grouping/scripts/discover_candidates.ts --space c9f267dcb0d270718c2a3c45a64afd32 --cap 80
  bun run skills/actionable/geo-claim-grouping/scripts/discover_candidates.ts --seed 0002373da9bc4f3c8b6c9fbd13f6f52f

Artifacts: candidates.json (adjudication input — everything inline), summary.json,
claims-<spaceId>.json + signals-<spaceId>.json (checkpoints), discovery-run.log.`;

interface Args { space?: string; seed?: string; allSpaces: boolean; pool: string[]; scopeFile?: string; semantic: boolean; cap: number; out?: string; resume: boolean; minJaccard: number; recentDays: number; }
function parseArgs(argv: string[]): Args {
  const a: Args = { allSpaces: false, pool: [], semantic: true, cap: DEFAULT_CAP, resume: false, minJaccard: DEFAULT_MIN_JACCARD, recentDays: DEFAULT_RECENT_DAYS };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { i++; if (i >= argv.length) { console.error(`missing value for ${k}\n\n${USAGE}`); process.exit(2); } return argv[i]; };
    if (k === "--help" || k === "-h") { console.log(USAGE); process.exit(0); }
    else if (k === "--space") a.space = next();
    else if (k === "--seed") a.seed = next();
    else if (k === "--all-spaces") a.allSpaces = true;
    else if (k === "--pool") a.pool = next().split(",").map((s) => EDITOR_SPACES[s.trim()] ?? s.trim()).filter(Boolean);
    else if (k === "--scope-file") a.scopeFile = next();
    else if (k === "--no-semantic") a.semantic = false;
    else if (k === "--cap") a.cap = Number(next());
    else if (k === "--out") a.out = next();
    else if (k === "--resume") a.resume = true;
    else if (k === "--min-jaccard") a.minJaccard = Number(next());
    else if (k === "--recent-days") a.recentDays = Number(next());
    else { console.error(`unknown arg: ${k}\n\n${USAGE}`); process.exit(2); }
  }
  const hex = /^[0-9a-f]{32}$/i;
  for (const p of a.pool) if (!hex.test(p)) { console.error(`--pool entries must be known slugs or 32-hex ids (got: ${p})\n\n${USAGE}`); process.exit(2); }
  const modes = [a.space, a.seed, a.allSpaces ? "y" : undefined].filter(Boolean).length;
  if (modes !== 1) { console.error(`exactly one of --space / --seed / --all-spaces is required\n\n${USAGE}`); process.exit(2); }
  const hex32 = /^[0-9a-f]{32}$/i;
  if (a.space && !hex32.test(a.space)) { console.error(`--space must be a 32-hex space id\n\n${USAGE}`); process.exit(2); }
  if (a.seed && !hex32.test(a.seed)) { console.error(`--seed must be a 32-hex claim id\n\n${USAGE}`); process.exit(2); }
  if (!Number.isFinite(a.cap) || a.cap < 1) { console.error(`--cap must be a positive number\n\n${USAGE}`); process.exit(2); }
  for (const p of a.pool) if (EXCLUDED_SPACE_IDS[p]) { console.error(`--pool must not include the excluded ${EXCLUDED_SPACE_IDS[p]} space (${p}) — its claims are never linked (editor directive 2026-08-21, HARD RULE 12)`); process.exit(2); }
  if (a.space && EXCLUDED_SPACE_IDS[a.space]) { console.error(`--space must not be the excluded ${EXCLUDED_SPACE_IDS[a.space]} space — its claims are never linked (editor directive 2026-08-21, HARD RULE 12)`); process.exit(2); }
  return a;
}

// ─── Logging (console + campaign-dir log file) ───────────────────────────────
let LOG_PATH = "";
const log = (m: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  if (LOG_PATH) fs.appendFileSync(LOG_PATH, line + "\n");
};

// ─── Shared pull helpers ─────────────────────────────────────────────────────
interface Claim { id: string; name: string; description: string; createdAt: string; spaces: string[]; }

async function pullClaims(spaceId: string): Promise<{ claims: Claim[]; pages: number; incomplete: boolean }> {
  // The v2 index runs type+space FILTER-form entity scans on a slow path that errors
  // outright at first:1000 (verified 2026-08-04 on Crypto: filter@1000 = deterministic
  // "Unexpected error", filter@500 = ~20s, ARG form @1000 = ~5s — the old API's
  // arg-vs-filter split survived the migration). Probe the shape ladder once with a
  // tiny retry budget, then paginate with the winner at the full budget.
  const FIELDS = "nodes { id name description createdAt } pageInfo { hasNextPage endCursor }";
  const shapes = [
    { label: "arg@1000", q: (after: string) => `{ entitiesConnection(typeId: "${CLAIM_TYPE}", spaceId: "${spaceId}", first: 1000${after}) { ${FIELDS} } }` },
    { label: "arg@500", q: (after: string) => `{ entitiesConnection(typeId: "${CLAIM_TYPE}", spaceId: "${spaceId}", first: 500${after}) { ${FIELDS} } }` },
    { label: "filter@500", q: (after: string) => `{ entitiesConnection(filter: { typeIds: { anyEqualTo: "${CLAIM_TYPE}" }, spaceIds: { anyEqualTo: "${spaceId}" } }, first: 500${after}) { ${FIELDS} } }` },
    { label: "filter@250", q: (after: string) => `{ entitiesConnection(filter: { typeIds: { anyEqualTo: "${CLAIM_TYPE}" }, spaceIds: { anyEqualTo: "${spaceId}" } }, first: 250${after}) { ${FIELDS} } }` },
  ];
  let shape: (typeof shapes)[number] | undefined;
  let conn: any;
  for (const s of shapes) {
    try { conn = (await gql(s.q(""), undefined, 2)).entitiesConnection; shape = s; log(`   S1 shape: ${s.label}`); break; }
    catch (e: any) { log(`   S1 shape ${s.label} failed (${String(e.message).slice(0, 60)}) — trying next`); }
  }
  if (!shape) throw new Error("S1: no working entitiesConnection shape — API down?");
  const claims: Claim[] = [];
  const ingest = (c: any) => { for (const n of c?.nodes ?? []) claims.push({ id: n.id, name: n.name ?? "", description: n.description ?? "", createdAt: n.createdAt ?? "0", spaces: [spaceId] }); };
  ingest(conn);
  let pages = 1, incomplete = false;
  for (let page = 2; page <= PAGE_CAP && conn?.pageInfo?.hasNextPage; page++) {
    conn = (await gql(shape.q(`, after: ${JSON.stringify(conn.pageInfo.endCursor)}`))).entitiesConnection;
    ingest(conn);
    pages = page;
    if (page % 25 === 0) log(`   claims page ${page}: ${claims.length} so far`);
    if (page === PAGE_CAP && conn?.pageInfo?.hasNextPage) { incomplete = true; log(`   WARNING: hit ${PAGE_CAP}-page cap — claim scan INCOMPLETE`); }
  }
  return { claims, pages, incomplete };
}

interface Edge { id: string; fromEntityId: string; toEntityId: string; toName: string | null; }
async function pullEdges(spaceId: string, typeId: string, label: string): Promise<Edge[]> {
  const edges: Edge[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= PAGE_CAP; page++) {
    const after = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
    const d = await gql(`{
      relationsConnection(filter: { spaceId: { is: "${spaceId}" }, typeId: { is: "${typeId}" } }, first: 1000${after}) {
        nodes { id fromEntityId toEntityId toEntity { id name } }
        pageInfo { hasNextPage endCursor }
      } }`);
    const conn = d.relationsConnection;
    for (const n of conn?.nodes ?? []) edges.push({ id: n.id, fromEntityId: n.fromEntityId, toEntityId: n.toEntityId, toName: n.toEntity?.name ?? null });
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (page === PAGE_CAP) log(`   WARNING: ${label} sweep hit ${PAGE_CAP}-page cap — INCOMPLETE`);
  }
  log(`   ${label}: ${edges.length} edges`);
  return edges;
}

async function pullGlobalEdges(typeId: string) {
  const rows: any[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= PAGE_CAP; page++) {
    const after = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
    const d = await gql(`{
      relationsConnection(filter: { typeId: { is: "${typeId}" } }, first: 1000${after}) {
        nodes { id fromEntityId toEntityId spaceId toEntity { spaceIds typeIds } }
        pageInfo { hasNextPage endCursor }
      } }`);
    const conn = d.relationsConnection;
    for (const n of conn?.nodes ?? [])
      rows.push({ edgeId: n.id, fromId: n.fromEntityId, toId: n.toEntityId, spaceId: n.spaceId,
        danglingTarget: (n.toEntity?.spaceIds ?? []).length === 0 && (n.toEntity?.typeIds ?? []).length === 0 });
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return rows;
}

// ─── Tokenization / scoring primitives ───────────────────────────────────────
const normName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
function tokenize(c: Claim) {
  const raw = `${c.name} ${c.description.slice(0, DESC_SLICE)}`.split(/[^A-Za-z0-9$#]+/).filter((x) => x.length >= 2);
  const all = new Set(raw.map((x) => x.toLowerCase()).filter((x) => !STOP.has(x)));
  const salient = new Set(raw.filter((x) => (/[A-Z]/.test(x) || /\d/.test(x)) && !STOP.has(x.toLowerCase())).map((x) => x.toLowerCase()));
  return { all, salient };
}
const pairKeyOf = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ─── Core: candidate generation over a claim corpus ──────────────────────────
function buildCandidates(opts: {
  claims: Claim[];
  citations: Map<string, { id: string; name: string }[]>;   // claimId -> citation entities
  stories: Map<string, Set<string>>;                        // claimId -> story ids
  topics: Map<string, Set<string>>;                         // claimId -> topic ids
  relatedPairs: Set<string>;                                // canonical pairKeys with a LEGACY Related-claims edge (annotation)
  groupedPairs?: Set<string>;                               // canonical pairKeys already in the step-1 Related grouping (504e5776…) — EXCLUDED pre-cap
  similarPairs: Set<string>;                                // canonical pairKeys with a Similar-claims edge
  minJaccard: number; recentDays: number;
  anchorSet?: Set<string>;                                  // scope/seed mode: only pairs touching these claims
  forcedPairs?: Set<string>;                                // canonical id-pairKeys admitted regardless of gates (semantic recall)
  primarySpace: (c: Claim) => string;                       // home space for display + op bucketing
}) {
  const { claims } = opts;
  const idx = new Map(claims.map((c, i) => [c.id, i]));
  const toks = claims.map(tokenize);

  // text index over salient tokens
  const df = new Map<string, number>();
  for (const t of toks) for (const s of t.salient) df.set(s, (df.get(s) ?? 0) + 1);
  const pairSharedRare = new Map<string, number>();
  const rarePair = new Set<string>();
  {
    const index = new Map<string, number[]>();
    toks.forEach((t, i) => { for (const s of t.salient) { if ((df.get(s) ?? 0) > DF_SKIP) continue; (index.get(s) ?? index.set(s, []).get(s)!).push(i); } });
    for (const [tok, arr] of index) {
      if (arr.length > POSTING_SKIP) continue;
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}|${arr[j]}`;
        pairSharedRare.set(key, (pairSharedRare.get(key) ?? 0) + 1);
        if ((df.get(tok) ?? 99) <= RARE_DF) rarePair.add(key);
      }
    }
  }

  // structural indexes → per-pair shared feature lists
  const collectShared = (map: Map<string, Set<string> | { id: string; name: string }[]>, skip: number, keyFn: (v: any) => string) => {
    const posting = new Map<string, number[]>();
    for (const [claimId, vals] of map) {
      const i = idx.get(claimId); if (i === undefined) continue;
      const arr = vals instanceof Set ? [...vals] : vals.map(keyFn);
      for (const v of new Set(arr)) (posting.get(v) ?? posting.set(v, []).get(v)!).push(i);
    }
    const shared = new Map<string, string[]>();
    for (const [v, arr] of posting) {
      if (arr.length < 2 || arr.length > skip) continue;
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const key = arr[i] < arr[j] ? `${arr[i]}|${arr[j]}` : `${arr[j]}|${arr[i]}`;
        (shared.get(key) ?? shared.set(key, []).get(key)!).push(v);
      }
    }
    return shared;
  };
  const citationsByName = new Map<string, Set<string>>();
  for (const [cid, arr] of opts.citations) citationsByName.set(cid, new Set(arr.map((x) => normName(x.name || x.id))));
  const sharedCitations = collectShared(citationsByName as any, CITATION_POSTING_SKIP, (v) => v);
  const sharedStories = collectShared(opts.stories as any, STORY_POSTING_SKIP, (v) => v);
  const sharedTopics = collectShared(opts.topics as any, TOPIC_POSTING_SKIP, (v) => v);

  // candidate keys = text-admitted ∪ structurally-admitted ∪ forced (semantic recall)
  const keys = new Set<string>();
  for (const [key, n] of pairSharedRare) if (n >= 2 || rarePair.has(key)) keys.add(key);
  for (const [key, cits] of sharedCitations) if (cits.length >= STRUCT_MIN_SHARED_CITATIONS) keys.add(key);
  for (const key of sharedStories.keys()) if (sharedTopics.has(key)) keys.add(key);
  const forcedIdx = new Set<string>();
  for (const pk of opts.forcedPairs ?? []) {
    const [x, y] = pk.split("|");
    const i = idx.get(x), j = idx.get(y);
    if (i === undefined || j === undefined) continue;
    const key = i < j ? `${i}|${j}` : `${j}|${i}`;
    keys.add(key); forcedIdx.add(key);
  }

  const out: any[] = [];
  for (const key of keys) {
    const [i, j] = key.split("|").map(Number);
    const A = claims[i], B = claims[j];
    if (opts.anchorSet && !opts.anchorSet.has(A.id) && !opts.anchorSet.has(B.id)) continue;
    // Equal-name pairs are Pass-1 merge material, not adjudicable similarity — a single
    // 9-copy claim otherwise floods the cap with C(9,2)=36 rows (seen on the Crypto pilot).
    // They surface once per cluster via exactNameClusters instead.
    if (normName(A.name) === normName(B.name) && A.name.trim()) continue;
    const TA = toks[i], TB = toks[j];
    const inter = [...TA.all].filter((x) => TB.all.has(x)).length;
    const union = new Set([...TA.all, ...TB.all]).size;
    const jac = union ? inter / union : 0;
    const sharedSalient = [...TA.salient].filter((x) => TB.salient.has(x)).sort();
    const cits = (sharedCitations.get(key) ?? []).sort();
    const stor = (sharedStories.get(key) ?? []).sort();
    const tops = (sharedTopics.get(key) ?? []).sort();
    const textAdmit = (pairSharedRare.get(key) ?? 0) >= 2 || rarePair.has(key);
    const textPass = textAdmit && (jac >= opts.minJaccard || sharedSalient.length >= MIN_SHARED_SALIENT || (rarePair.has(key) && jac >= RARE_MIN_JACCARD));
    const structPass = cits.length >= STRUCT_MIN_SHARED_CITATIONS || (stor.length >= 1 && tops.length >= 1);
    const forced = forcedIdx.has(key);
    if (!textPass && !structPass && !forced) continue;
    const dDays = Math.abs(Number(A.createdAt) - Number(B.createdAt)) / 86400;
    const pk = pairKeyOf(A.id, B.id);
    if (opts.groupedPairs?.has(pk)) continue; // already Related-grouped (step 1 done) — don't burn cap slots re-proposing
    const score = jac + W_SALIENT * sharedSalient.length + (dDays <= opts.recentDays ? W_RECENT : 0) +
      (cits.length >= 1 ? W_SOURCE : 0) + (stor.length >= 1 ? W_STORY : 0) + (tops.length >= 1 ? W_TOPIC : 0);
    out.push({
      pairKey: pk,
      score: Math.round((score + (forced && !textPass && !structPass ? 0.5 : 0)) * 100) / 100,
      jaccard: Math.round(jac * 100) / 100,
      sharedSalient,
      via: [textPass ? "text" : null, structPass ? "struct" : null, forced ? "semantic" : null].filter(Boolean),
      signals: {
        sharedCitationNames: cits, sharedStories: stor, sameStorySiblings: stor.length >= 1,
        sharedTopics: tops, daysApart: Math.round(dDays),
        alreadyRelatedClaims: opts.relatedPairs.has(pk), alreadySimilar: opts.similarPairs.has(pk),
      },
      a: { id: A.id, name: A.name, description: A.description, created: A.createdAt, space: opts.primarySpace(A), spaces: A.spaces },
      b: { id: B.id, name: B.name, description: B.description, created: B.createdAt, space: opts.primarySpace(B), spaces: B.spaces },
    });
  }
  out.sort((x, y) => y.score - x.score || x.pairKey.localeCompare(y.pairKey));
  return out;
}

// ─── URL enrichment for exported pairs (best-effort; Value fields are typed) ─
async function enrichUrls(pairs: any[], citations: Map<string, { id: string; name: string }[]>) {
  const wanted = new Set<string>();
  for (const p of pairs) for (const side of [p.a, p.b])
    for (const c of (citations.get(side.id) ?? []).slice(0, 4)) wanted.add(c.id);
  const urlByCitation = new Map<string, string>();
  const ids = [...wanted];
  for (let i = 0; i < ids.length; i += 40) {
    try {
      const d = await gql(`query($ids: [UUID!]) { entities(filter: { id: { in: $ids } }, first: 100) { id valuesList { propertyId text } } }`,
        { ids: ids.slice(i, i + 40) });
      for (const e of d.entities ?? []) {
        const url = (e.valuesList ?? []).map((v: any) => v.text).find((t: any) => typeof t === "string" && t.startsWith("http"));
        if (url) urlByCitation.set(e.id, url);
      }
    } catch (e: any) { log(`   URL enrichment degraded (${e.message.slice(0, 80)}) — citation names still attached`); break; }
  }
  for (const p of pairs) for (const side of [p.a, p.b]) {
    const cits = (citations.get(side.id) ?? []).slice(0, 4);
    side.citationNames = cits.map((c) => c.name);
    side.sourceUrls = cits.map((c) => urlByCitation.get(c.id)).filter(Boolean);
  }
}

// ─── Per-space bundle (S1 corpus + S2 signals, both checkpointed) ────────────
interface RawSignals { sources: Edge[]; notable: Edge[]; topicsA: Edge[]; topicsB: Edge[]; related: Edge[]; }
async function pullBundle(spaceId: string, outDir: string, resume: boolean): Promise<{ corpus: { claims: Claim[]; pages: number; incomplete: boolean }; raw: RawSignals }> {
  const ckClaims = path.join(outDir, `claims-${spaceId}.json`);
  let corpus: { claims: Claim[]; pages: number; incomplete: boolean };
  if (resume && fs.existsSync(ckClaims)) {
    corpus = JSON.parse(fs.readFileSync(ckClaims, "utf8"));
    for (const c of corpus.claims) c.spaces = c.spaces ?? [spaceId]; // pre-pool checkpoints lack the field
    log(`S1 resume [${SLUG_BY_SPACE[spaceId] ?? spaceId.slice(0, 8)}]: ${corpus.claims.length} claims from checkpoint`);
  } else {
    corpus = await pullClaims(spaceId);
    fs.writeFileSync(ckClaims, JSON.stringify(corpus, null, 1));
    log(`S1 [${SLUG_BY_SPACE[spaceId] ?? spaceId.slice(0, 8)}]: ${corpus.claims.length} claims (${corpus.pages} pages)`);
  }
  const ckSignals = path.join(outDir, `signals-${spaceId}.json`);
  let raw: RawSignals;
  if (resume && fs.existsSync(ckSignals)) { raw = JSON.parse(fs.readFileSync(ckSignals, "utf8")); log(`S2 resume [${SLUG_BY_SPACE[spaceId] ?? spaceId.slice(0, 8)}]: signal edges from checkpoint`); }
  else {
    log(`S2 [${SLUG_BY_SPACE[spaceId] ?? spaceId.slice(0, 8)}]: signal sweeps...`);
    raw = {
      sources: await pullEdges(spaceId, SOURCES, "Sources"),
      notable: await pullEdges(spaceId, NOTABLE_CLAIMS, "Notable claims"),
      topicsA: await pullEdges(spaceId, TOPICS_A, "Topics(A)"),
      topicsB: await pullEdges(spaceId, TOPICS_B, "Topics(B)"),
      related: await pullEdges(spaceId, RELATED_CLAIMS, "Related claims"),
    };
    fs.writeFileSync(ckSignals, JSON.stringify(raw, null, 1));
  }
  return { corpus, raw };
}

// ─── Space pipeline (target space + optional cross-space pool + optional scope) ─
async function runSpace(spaceId: string, args: Args, seedId?: string) {
  const slug = seedId ? `seed-${seedId.slice(0, 8)}` : (SLUG_BY_SPACE[spaceId] ?? spaceId.slice(0, 8));
  const outDir = args.out ?? path.join("scripts", `${new Date().toISOString().slice(0, 10)}-similar-claims-${slug}`);
  fs.mkdirSync(outDir, { recursive: true });
  LOG_PATH = path.join(outDir, "discovery-run.log");
  const t0 = Date.now();
  const poolIds = args.pool.filter((p) => p !== spaceId);
  log(`== geo-claim-grouping discovery — space ${spaceId}${seedId ? ` (seed ${seedId})` : ""}${poolIds.length ? ` + pool [${poolIds.map((p) => SLUG_BY_SPACE[p] ?? p.slice(0, 8)).join(",")}]` : ""} -> ${outDir}`);

  // S1+S2 — target space first, then pool spaces
  const bundles: Array<{ sid: string; corpus: { claims: Claim[]; pages: number; incomplete: boolean }; raw: RawSignals }> = [];
  for (const sid of [spaceId, ...poolIds]) bundles.push({ sid, ...(await pullBundle(sid, outDir, args.resume)) });

  // merge corpora by claim id (a claim can be resident in several pool spaces)
  const byId = new Map<string, Claim>();
  let scanIncomplete = false;
  for (const b of bundles) {
    scanIncomplete = scanIncomplete || b.corpus.incomplete;
    for (const c of b.corpus.claims) {
      const ex = byId.get(c.id);
      if (ex) { for (const s of c.spaces) if (!ex.spaces.includes(s)) ex.spaces.push(s); }
      else byId.set(c.id, c);
    }
  }
  const claims = [...byId.values()];
  const claimIds = new Set(byId.keys());
  log(`Pool corpus: ${claims.length} distinct claims across ${bundles.length} space(s)`);

  // merge signals across spaces
  const citations = new Map<string, { id: string; name: string }[]>();
  const stories = new Map<string, Set<string>>();
  const topics = new Map<string, Set<string>>();
  const relatedPairs = new Set<string>();
  let sourcesEdges = 0, topicsAEdges = 0, topicsBEdges = 0, relatedEdges = 0;
  for (const b of bundles) {
    sourcesEdges += b.raw.sources.length; topicsAEdges += b.raw.topicsA.length; topicsBEdges += b.raw.topicsB.length; relatedEdges += b.raw.related.length;
    for (const e of b.raw.sources) if (claimIds.has(e.fromEntityId))
      (citations.get(e.fromEntityId) ?? citations.set(e.fromEntityId, []).get(e.fromEntityId)!).push({ id: e.toEntityId, name: e.toName ?? "" });
    for (const e of b.raw.notable) if (claimIds.has(e.toEntityId))
      (stories.get(e.toEntityId) ?? stories.set(e.toEntityId, new Set()).get(e.toEntityId)!).add(e.fromEntityId);
    for (const e of [...b.raw.topicsA, ...b.raw.topicsB]) if (claimIds.has(e.fromEntityId))
      (topics.get(e.fromEntityId) ?? topics.set(e.fromEntityId, new Set()).get(e.fromEntityId)!).add(e.toEntityId);
    for (const e of b.raw.related) if (claimIds.has(e.fromEntityId) && claimIds.has(e.toEntityId)) relatedPairs.add(pairKeyOf(e.fromEntityId, e.toEntityId));
  }

  // S3 — global existing edges: Similar (pass-3) + the step-1 Related grouping baseline
  // (already-grouped pairs are not fresh step-1 candidates — taxonomy 2026-08-12)
  const existing = await pullGlobalEdges(SIMILAR_CLAIMS);
  const similarPairs = new Set<string>(existing.map((r) => pairKeyOf(r.fromId, r.toId)));
  const grouped = await pullGlobalEdges(RELATED_GROUPING);
  const groupedPairs = new Set<string>(grouped.map((r) => pairKeyOf(r.fromId, r.toId)));
  log(`S3: ${existing.length} Similar edge(s), ${grouped.length} Related-grouping edge(s) graph-wide (grouped pairs are EXCLUDED from export); ${existing.filter((r) => r.danglingTarget).length} dangling Similar`);

  const primarySpace = (c: Claim) =>
    c.spaces.includes(spaceId) ? spaceId : (c.spaces.find((s) => SLUG_BY_SPACE[s]) ?? c.spaces[0] ?? spaceId);

  // S3b — exact-name duplicate clusters over the merged pool (Pass-1 merge material; excluded from pairs).
  // Cross-space clusters are DISTINCT entities sharing a name — cross-space merge candidates for geo-clean.
  const byName = new Map<string, Claim[]>();
  for (const c of claims) {
    const k = normName(c.name);
    if (!k) continue;
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(c);
  }
  const exactNameClusters = [...byName.values()]
    .filter((cs) => cs.length >= 2)
    .map((cs) => ({ name: cs[0].name, size: cs.length, crossSpace: new Set(cs.map((c) => primarySpace(c))).size > 1,
      ids: cs.map((c) => c.id).sort(), spaces: [...new Set(cs.map((c) => primarySpace(c)))].sort() }))
    .sort((x, y) => y.size - x.size || x.name.localeCompare(y.name));
  log(`S3b: ${exactNameClusters.length} exact-name duplicate cluster(s) (${exactNameClusters.reduce((s, g) => s + g.size, 0)} claims, ${exactNameClusters.filter((g) => g.crossSpace).length} cross-space) — routed to geo-clean, excluded from pairs`);

  // Scope (page/tab campaigns) + seed
  let anchorSet: Set<string> | undefined;
  let scopeMissing: string[] = [];
  if (seedId) anchorSet = new Set([seedId]);
  else if (args.scopeFile) {
    const sf = JSON.parse(fs.readFileSync(args.scopeFile, "utf8"));
    const ids: string[] = Array.isArray(sf) ? sf : sf.ids;
    anchorSet = new Set(ids);
    scopeMissing = ids.filter((id) => !claimIds.has(id));
    if (scopeMissing.length) log(`WARNING: ${scopeMissing.length} scope claim(s) not found in the pooled corpora: ${scopeMissing.slice(0, 5).join(", ")}${scopeMissing.length > 5 ? "…" : ""}`);
    log(`Scope: ${anchorSet.size} claims from ${args.scopeFile}`);
  }

  // S3c — semantic recall per scope claim (cross-space, claim-filtered). Bonus recall path:
  // normative/debate claims share few salient tokens, so the text gate under-recalls them.
  const forcedPairs = new Set<string>();
  let semanticExcludedDrops = 0;
  let semanticOutOfScopeDrops = 0;
  // Semantic hits are restricted to the spaces this run actually works: the target space
  // plus anything explicitly passed to --pool. search() itself takes no space argument, so
  // without this filter S3c reaches the whole graph and silently reintroduces the
  // cross-space matching that --pool exists to opt into (S1/S2 already honour that bound).
  const semanticSpaces = new Set<string>([spaceId, ...poolIds]);
  if (args.semantic && anchorSet) {
    log(`S3c: semantic recall for ${anchorSet.size} scope claim(s) (~6s each)...`);
    let hits = 0, added = 0, done = 0;
    for (const aid of anchorSet) {
      const A = byId.get(aid);
      if (!A || !A.name.trim()) continue;
      try {
        const d = await gql(`query($q: String!) { search(query: $q, first: 12, filter: { typeIds: { anyEqualTo: "${CLAIM_TYPE}" } }) { id name description createdAt spaceIds } }`, { q: A.name });
        for (const h of d.search ?? []) {
          if (h.id === aid) continue;
          // HARD RULE 12: excluded-space residents never enter the pool
          if ((h.spaceIds ?? []).some((s: string) => EXCLUDED_SPACE_IDS[s])) { semanticExcludedDrops++; continue; }
          // in-scope residency: target space, or a space explicitly named in --pool
          if (!(h.spaceIds ?? []).some((s: string) => semanticSpaces.has(s))) { semanticOutOfScopeDrops++; continue; }
          hits++;
          if (!byId.has(h.id)) {
            const nc: Claim = { id: h.id, name: h.name ?? "", description: h.description ?? "", createdAt: h.createdAt ?? "0", spaces: h.spaceIds ?? [] };
            byId.set(h.id, nc); claims.push(nc); claimIds.add(h.id); added++;
          }
          forcedPairs.add(pairKeyOf(aid, h.id));
        }
      } catch (e: any) { log(`   semantic search degraded (${String(e.message).slice(0, 70)}) — continuing with pre-cluster only`); break; }
      done++;
      if (done % 20 === 0) log(`   semantic: ${done}/${anchorSet.size} scope claims searched`);
    }
    log(`S3c: ${forcedPairs.size} forced pair(s) from ${hits} in-scope hits (${added} out-of-pool claims added; ${semanticExcludedDrops} dropped on excluded-space residency; ${semanticOutOfScopeDrops} dropped as out-of-scope, scope = ${semanticSpaces.size} space(s))`);
  }

  // S4 — pre-cluster + score
  const all = buildCandidates({
    claims, citations, stories, topics, relatedPairs, groupedPairs, similarPairs,
    minJaccard: args.minJaccard, recentDays: args.recentDays, anchorSet, forcedPairs, primarySpace,
  });
  // S4b — excluded-space residency gate on the export (HARD RULE 12). Corpus pulls only
  // carry the pull space, so a dual-resident copy (e.g. AI + podcasts) is only catchable
  // by a live residency check. Verify export-window members in batches and refill from
  // the remainder so the cap stays honest.
  const residency = new Map<string, string[]>();
  const verifyResidency = async (ids: string[]) => {
    const need = ids.filter((i) => !residency.has(i));
    for (let i = 0; i < need.length; i += 40) {
      const r = await gql(`query($ids: [UUID!]) { entities(filter: { id: { in: $ids } }, first: 100) { id spaceIds } }`, { ids: need.slice(i, i + 40) });
      for (const e of r.entities ?? []) residency.set(e.id, e.spaceIds ?? []);
    }
  };
  const isExcludedResident = (id: string) => (residency.get(id) ?? []).some((s) => EXCLUDED_SPACE_IDS[s]);
  const exported: typeof all = [];
  let exportExcludedDrops = 0;
  for (let i = 0; i < all.length && exported.length < args.cap; i += args.cap) {
    const window = all.slice(i, i + args.cap);
    await verifyResidency([...new Set(window.flatMap((p: any) => [p.a.id, p.b.id]))]);
    for (const p of window) {
      if (exported.length >= args.cap) break;
      if (isExcludedResident((p as any).a.id) || isExcludedResident((p as any).b.id)) { exportExcludedDrops++; continue; }
      exported.push(p);
    }
  }
  log(`S4: ${all.length} candidate pairs -> exporting top ${exported.length}${all.length > exported.length ? " (CAPPED by score)" : ""}; ${exportExcludedDrops} pair(s) dropped on excluded-space residency (HARD RULE 12)`);

  // S5 — enrich + write artifacts
  await enrichUrls(exported, citations);
  const candidates = {
    generatedAt: new Date().toISOString(), mode: seedId ? "seed" : (args.scopeFile ? "scope" : "space"),
    space: { id: spaceId, name: SLUG_BY_SPACE[spaceId] ?? spaceId },
    pool: poolIds.map((p) => ({ id: p, name: SLUG_BY_SPACE[p] ?? p })),
    scope: anchorSet ? { file: args.scopeFile ?? null, size: anchorSet.size, missing: scopeMissing } : null,
    params: { cap: args.cap, minJaccard: args.minJaccard, recentDays: args.recentDays, semantic: args.semantic,
      weights: { sharedSource: W_SOURCE, sharedStory: W_STORY, sharedTopic: W_TOPIC, recency: W_RECENT, salient: W_SALIENT } },
    claimsScanned: claims.length, pairsConsidered: all.length, pairsExported: exported.length, capped: all.length > exported.length,
    topicsPropertyCounts: { [TOPICS_A]: topicsAEdges, [TOPICS_B]: topicsBEdges },
    existingSimilarEdges: existing,
    exactNameClusters,
    pairs: exported,
  };
  fs.writeFileSync(path.join(outDir, "candidates.json"), JSON.stringify(candidates, null, 1));
  const summary = {
    spaceId, slug, pool: poolIds, scope: anchorSet ? anchorSet.size : null, scanIncomplete,
    claims: claims.length,
    coverage: {
      withCitations: citations.size, citationEdges: sourcesEdges,
      inStories: stories.size, withTopics: topics.size, relatedClaimEdges: relatedEdges,
    },
    pairsConsidered: all.length, pairsExported: exported.length, semanticForcedPairs: forcedPairs.size,
    excludedSpaceDrops: { semantic: semanticExcludedDrops, export: exportExcludedDrops },
    semanticScopeSpaces: [...semanticSpaces], semanticOutOfScopeDrops,
    exactNameClusters: exactNameClusters.length, exactNameDuplicateClaims: exactNameClusters.reduce((s, g) => s + g.size, 0),
    existingSimilarEdges: existing.length, danglingSimilarEdges: existing.filter((r) => r.danglingTarget).length,
    runtimeMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  log(`DONE in ${Math.round((Date.now() - t0) / 1000)}s — candidates.json + summary.json in ${outDir}`);
  return { outDir, summary };
}

// ─── Seed mode ───────────────────────────────────────────────────────────────
async function runSeed(seedId: string, args: Args) {
  const d = await gql(`{ entity(id: "${seedId}") { id name spaceIds typeIds } }`);
  const e = d.entity;
  const alive = (e?.spaceIds ?? []).length > 0 || (e?.typeIds ?? []).length > 0;  // entity(id:) never returns null on this API
  if (!alive) { console.error(`seed ${seedId} does not exist (empty spaceIds+typeIds)`); process.exit(2); }
  if (!(e.typeIds ?? []).includes(CLAIM_TYPE)) { console.error(`seed ${seedId} ("${e.name}") is not a Claim (typeIds: ${JSON.stringify(e.typeIds)})`); process.exit(2); }
  const excludedRes = (e.spaceIds as string[]).filter((s) => EXCLUDED_SPACE_IDS[s]);
  if (excludedRes.length) { console.error(`seed ${seedId} ("${e.name}") is resident in the excluded ${excludedRes.map((s) => EXCLUDED_SPACE_IDS[s]).join(",")} space — its claims are never linked (editor directive 2026-08-21, HARD RULE 12)`); process.exit(2); }
  const home = (e.spaceIds as string[]).find((s) => SLUG_BY_SPACE[s]) ?? e.spaceIds[0];
  log(`seed "${e.name}" — home space ${home}`);
  // Semantic recall runs inside runSpace (S3c) for the seed anchor.
  return runSpace(home, args, seedId);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.seed) await runSeed(args.seed, args);
  else if (args.space) await runSpace(args.space, args);
  else for (const [slug, id] of Object.entries(EDITOR_SPACES)) { log(`\n===== ${slug} =====`); await runSpace(id, { ...args, out: undefined }); }
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
