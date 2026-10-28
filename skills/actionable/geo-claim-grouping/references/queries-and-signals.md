# Queries, signals, and scoring — verified shapes (2026-08-04, v2 API)

Everything here was verified live against the post-2026-07-migration index. The endpoint is always `${NETWORK.apiOrigin}/graphql` via `src/functions.ts` `gql()` (config-derived — never hardcode a host).

## Contents
- Well-known IDs
- API quirks that bind this skill
- The verified queries (S1–S3)
- Signal reality: what claims actually have
- Pre-cluster + scoring constants (justified)
- Runtime budget + checkpointing
- candidates.json schema

## Well-known IDs

| Thing | ID |
|---|---|
| Claim type | `96f859efa1ca4b229372c86ad58b694b` |
| **Related claims** (Root-space Claim schema; step-1 grouping) | `504e5776788844f6a77dba3ee811d8f0` |
| **Duplicate claims** (step-2 pass 2) | `982866bf8ae94afe8cce8b805713e4af` |
| **Similar claims** (step-2 pass 3) | `e81750db3f09440cab9dd01808a43ccb` |
| **Supporting arguments** (step 2; FROM supported claim TO supporter — convention verified against 1,483 pre-existing edges 2026-08-13) / **Opposing arguments** (mirrored if mutual, else FROM rebutted TO rebutter) | `1dc6a843458848198e7a6e672268f811` / `4e6ec5d14292498a84e5f607ca1a08ce` |
| LEGACY Crypto-space Related claims (superseded — NEVER emitted) | `a8aa1b654afd4ac786a243481d806846` |
| Sources (Claim → citation entity) | `49c5d5e1679a4dbdbfd33f618f227c94` |
| Notable claims (News story → Claim; claim is `toEntityId`) | `e1371bcda7044396adb7ea7ecc8fe3d4` |
| Topics (two property IDs coexist on Claim schemas — pull both, report counts) | `806d52bc27e94c9193c057978b093351`, `3b7759e55a714a8084d489258fd4bdd5` |
| Editor spaces (wallet verified 2026-08-03) | Crypto `c9f267dcb0d270718c2a3c45a64afd32`, World Affairs `89bd89bf28ff8a0963faf92a8c905e20`, AI `41e851610e13a19441c4d980f2f2ce6b`, Health `52c7ae149838b6d47ce0f3b2a5974546` |

## API quirks that bind this skill

1. **`totalCount` errors on every form tried** (`first: 0` AND `first: 1`) — "Unexpected error". Never count via totalCount; **the pull IS the count.**
2. `first`/`offset` hard-cap at 1000; past row 1000 only cursor `after` works. Use `first: 1000` + `pageInfo { hasNextPage endCursor }`, with a 400-page runaway guard that logs "scan INCOMPLETE" when hit.
3. `entity(id:)` **never returns null** — any ID returns a stub. Existence check = `spaceIds` or `typeIds` non-empty. A relation target with both empty is a **dangling edge** (deleted target).
4. **Entity type+space scans: the arg-vs-filter split survived the migration.** The top-level-arg form `entitiesConnection(typeId:, spaceId:, first: 1000)` returns in ~5s; the filter form (`filter: { typeIds: { anyEqualTo }, spaceIds: { anyEqualTo } }`) is the slow path — ~20s at `first: 500` and a **deterministic "Unexpected error" at `first: 1000`** (verified on Crypto 2026-08-04; small pages like `first: 3` mask the problem). The discovery script probes a shape ladder (arg@1000 → arg@500 → filter@500 → filter@250) with a 2-retry budget and locks in the first that works. `relationsConnection` filter-form sweeps at `first: 1000` are unaffected (proven at 672k-edge scale by the 2026-08-03 campaign).
5. `entities(filter: { id: { in: $ids } }, first: 100)` for batched lookups — chunk input to 40 IDs.
6. `createdAt` is a **Unix-seconds numeric string** (e.g. `"1785350351"`), not ISO. `daysApart = |Number(a) − Number(b)| / 86400`.
7. The `Value` type has **typed fields** (`text`, `date`, …), no generic `value` field — URL enrichment reads `valuesList { propertyId text }` and degrades gracefully if the shape shifts again.
8. `gql()` already retries 5xx/429/transient GraphQL errors up to 50× with backoff — do not add client timeouts or outer retry loops.
9. `relationsConnection(filter: { id: { in: [...] } })` works for **batched relation-id lookups** (chunk to 200; verified 2026-08-13) — replaces per-id `relation(id:)` loops in collision checks.
10. `ProposalVersion` has **no `executedAt`** field — check execution by whether the proposal's edges exist live; `yesCount`/`noCount` are available.
11. `Position.generateBetween` **jitters per run** (fractional-indexing randomness) — pin generated positions into the data file or dry-run reruns fail the byte-identical check.

## The verified queries

**S1 — Claim corpus (cursor-paginate to completion; ARG form — see quirk 4):**

```graphql
{ entitiesConnection(
    typeId: "96f859efa1ca4b229372c86ad58b694b", spaceId: "<SPACE>",
    first: 1000, after: "<endCursor>") {
    nodes { id name description createdAt }
    pageInfo { hasNextPage endCursor } } }
```

The script's shape ladder falls back to arg@500 → filter@500 → filter@250 if the arg form ever regresses.

**S2 — one sweep per signal relation type (Sources, Notable claims, Topics ×2, Related claims):**

```graphql
{ relationsConnection(
    filter: { spaceId: { is: "<SPACE>" }, typeId: { is: "<SIGNAL_TYPE_ID>" } },
    first: 1000, after: "<endCursor>") {
    nodes { id fromEntityId toEntityId toEntity { id name } }
    pageInfo { hasNextPage endCursor } } }
```

**S3 — global existing claim-relation edges, one paged pull PER property (Related `504e5776…`, Similar `e81750db…`, Duplicate `982866bf…`, Supporting `1dc6a843…`, Opposing `4e6ec5d1…`):**

```graphql
{ relationsConnection(
    filter: { typeId: { is: "<PROPERTY_ID>" } },
    first: 1000, after: "<endCursor>") {
    nodes { id fromEntityId toEntityId spaceId toEntity { spaceIds typeIds } }
    pageInfo { hasNextPage endCursor } } }
```

The Related pull is the step-1 idempotency baseline (already-grouped pairs are not candidates again); the bracket pulls feed step-2's same-direction existing check. Note the argument properties are heavily used graph-wide by other editorial work (~1,500/~1,250 edges) — an existing hand-built edge on your pair means SKIP, not collision.

Edges whose `toEntity.spaceIds` AND `typeIds` are both empty are dangling → cleanup notes for geo-clean (never deleted here).

## Signal reality: what claims actually have

Measured on 100-claim samples per space (2026-08-04):

| Signal | World Affairs | Crypto | Verdict for matching |
|---|---|---|---|
| Sources (citation edges) | **99%** | **79%** | strongest structural signal |
| Notable-claims story membership | ~1 backlink/claim | ~1/claim | event-family grouping |
| Topics | 4% | 14% | bonus only |
| Tags / Related entities / people / projects | ~1–4% | ~1–4% | too sparse — ignore |

**Citation entities are per-claim** (verified: 30 Sources edges → 30 distinct targets) but their **names are article headlines** — two claims citing the same article carry same-named citation entities. Therefore the shared-source key is the **normalized citation name** (lowercase, trimmed, whitespace-collapsed), NOT the target entity ID. Claim names themselves are rich self-contained 1–2-sentence assertions (ontology mandate) — text is the primary recall surface.

## Pre-cluster + scoring constants (justified)

Ported from the proven P7 pass (`scripts/2026-07-09-crypto-sweep-discovery-p2.ts`), which produced the adjudicated crypto-sweep B2 table; structural terms added for this skill. Tokenization runs over `name + " " + description.slice(0,300)`.

| Constant | Value | Why |
|---|---|---|
| Salient token | has uppercase or digit, length ≥2, not stopword | proper nouns / tickers / bill names carry the signal |
| df skip | > 20 | tokens this common in the corpus separate nothing |
| Posting-list skip | > 12 | quadratic-pair guard on hub tokens |
| Rare token | df ≤ 4 | a shared rare token is near-decisive for recall |
| Pair admission (text) | (sharedRare ≥ 2 OR rare-pair) AND (jaccard ≥ 0.42 OR sharedSalient ≥ 3 OR (rare-pair AND jaccard ≥ 0.3)) | P7 thresholds, validated by the 07-09 adjudication round |
| Pair admission (structural) | ≥ 2 shared citation names, OR (shared story AND shared topic) | catches same-assertion pairs phrased too differently for the text gate — the reason this pipeline is text-FIRST, not text-ONLY |
| Score | `jaccard + 0.08·sharedSalient + 0.15·[≤14 days apart] + 0.25·[≥1 shared citation name] + 0.10·[shared story] + 0.10·[shared topic]` | citation overlap outweighs recency because it is the highest-coverage structural signal (99%/79%); story/topic are weak corroboration at their coverage levels |
| Equal-normalized-name pairs | EXCLUDED from `pairs`; surfaced once per cluster in `exactNameClusters` | Pass-1 merge material, not adjudicable similarity — on the Crypto pilot a single 9-copy claim otherwise flooded the cap with C(9,2)=36 rows (52% of the batch burned on 2 clusters) |
| Export cap | top 80 by score (`--cap`) | the proven single-batch adjudication size; uncovered candidates persist in the artifact for the next campaign |
| Semantic recall (scope/seed modes) | `search(query: <claim name>, first: 12, filter: { typeIds: { anyEqualTo: <Claim> } })` per scope claim (~6s each; verified live 2026-08-05, flat entity list) | normative/debate claims share few salient tokens — the text gate under-recalls them; forced pairs bypass the gates and get a **+0.5 admission bonus** so recall hits survive the cap |
| Cross-space pool (`--pool`) | pool spaces' corpora + signals merge; claims dedupe by id; per-side `space` = target space if resident, else first editor space | similar claims live across spaces (editor directive 2026-08-05); citation-NAME overlap works cross-space, story overlap is space-local |

Score orders the export queue only — it never appears in a verdict (HARD RULE 3).

## Runtime budget + checkpointing

A 2–5k-claim space ≈ 2–5 corpus pages + 5 signal sweeps of similar page counts + 1 global page ≈ **15–40 gql pages ≈ 2–6 min** foreground. Stage checkpoints (`claims-<spaceId>.json` after S1, per-signal maps after S2) + `--resume` make a killed run cheap. Progress logs every 25 pages; the script tees its own `discovery-run.log`.

Seed mode (`--seed <claimId>`): semantic `search(query:)` costs ~5–11 s — acceptable for one seed, never loop it over a corpus. If the search field errors on the current schema, seed mode falls back to pre-cluster-only against the seed's home space and says so.

## candidates.json schema

```json
{
  "generatedAt": "…", "mode": "space|seed",
  "space": { "id": "…", "name": "…" },
  "params": { "cap": 80, "minJaccard": 0.42, "weights": { "sharedSource": 0.25, "sharedStory": 0.10, "sharedTopic": 0.10, "recency": 0.15 } },
  "claimsScanned": 0, "pairsConsidered": 0, "pairsExported": 0, "capped": false,
  "topicsPropertyCounts": { "806d52bc…": 0, "3b7759e5…": 0 },
  "existingSimilarEdges": [ { "edgeId": "…", "fromId": "…", "toId": "…", "spaceId": "…", "danglingTarget": false } ],
  "exactNameClusters": [ { "name": "…", "size": 2, "ids": ["…"] } ],
  "pairs": [ {
    "pairKey": "<sortedIdA>|<sortedIdB>",
    "score": 0.0, "jaccard": 0.0, "sharedSalient": ["…"],
    "signals": { "sharedCitationNames": ["…"], "sharedStories": ["…"], "sameStorySiblings": false,
                 "sharedTopics": ["…"], "daysApart": 0, "alreadyRelatedClaims": false, "alreadySimilar": false },
    "a": { "id": "<32hex>", "name": "…", "description": "…", "created": "<ISO>", "citationNames": ["…"], "sourceUrls": ["…"] },
    "b": { "id": "<32hex>", "name": "…", "description": "…", "created": "<ISO>", "citationNames": ["…"], "sourceUrls": ["…"] }
  } ]
}
```

Everything adjudication needs is inline — Stage B never re-queries.
