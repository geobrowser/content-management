---
name: geo-claim-grouping
description: Group Claim entities in Geo via the team's two-step process — step 1 links every adjudicated pair with Related claims (the initial grouping), step 2 assigns established groups to their corresponding brackets (Duplicate claims, Similar claims, Supporting/Opposing arguments) under the strict bracket definitions. Runs the bundled read-only discovery script to generate scored candidate claim pairs for a space, a page/tab of claims, or one seed claim — optionally pooling other spaces for cross-space matches — adjudicates every pair, dry-runs an ops script reading an editor-approved decisions file, and publishes held-for-review proposals only on an explicit publish. Triggers on "claim grouping", "group claims", "claim brackets", "related claims", "duplicate claims", "similar claims", "group related claims", "link similar claims", "assign similar claims", "claims like this one", "claim similarity pass", "claim relations pass", "which claims are similar to".
metadata:
  version: "0.7.1"
---

# Geo Knowledge Graph — Claim Grouping (Related / Duplicate / Similar / Arguments)

Editor-facing skill for grouping **Claim** entities (`96f859efa1ca4b229372c86ad58b694b`) via the Geo team's claim-relation taxonomy (Arturas review, 2026-08-12). Uses Bun + `@geoprotocol/geo-sdk` **v0.20.0+**. Additive-only: the ONLY op this skill ever emits is `createRelation` for approved claim-relation edges. Every run goes through candidate discovery → per-pair adjudication → Discovery + Gates + Plan template → dry-run → explicit `publish` confirmation.

**The claim-to-claim taxonomy (Root-space Claim schema — route, don't conflate):**

| Relationship between two claims | Correct home | Emitted in |
|---|---|---|
| Same broader issue, topic, event, or context — but **distinct assertions** | **`Related claims`** `504e5776788844f6a77dba3ee811d8f0` | **step 1** |
| Same claim created more than once — identical or **near-identical wording** | **`Duplicate claims`** `982866bf8ae94afe8cce8b805713e4af` | **step 2** (pass 2); merge decision stays with `geo-clean` |
| Distinct formulations of the **same core assertion** — wording/framing/emphasis/specificity may differ slightly, **no material difference in what is claimed** | **`Similar claims`** `e81750db3f09440cab9dd01808a43ccb` | **step 2** (pass 3) |
| One argues FOR the other | `Supporting arguments` `1dc6a843458848198e7a6e672268f811` | **step 2** (directional: the edge goes FROM the supported claim TO its supporting argument) |
| One argues AGAINST the other | `Opposing arguments` `4e6ec5d14292498a84e5f607ca1a08ce` | **step 2** (debate-position opposition is mutual → mirrored edges; one-sided rebuttals are directional) |
| LEGACY: Crypto-space `Related claims` `a8aa1b654afd4ac786a243481d806846` | superseded by the Root-space property | never emitted |

**The two-step process (order is mandatory):**

- **Step 1 — Related grouping (pass 1).** Related is the BROADEST layer (team feedback 2026-08-18: popular claims should carry ≥10 Related links). The entry bar is TOPIC-level, three signals in priority order: (1) **curated co-membership** — claims in the same debate-tab block/collection are Related with NO per-pair adjudication (the curation IS the judgment); (2) **adjacent topic family** (thematically merged blocks, e.g. AGI ↔ AI-and-consciousness) — used to top claims up toward the density target; (3) **cross-space same-topic attachments** (light topic-membership adjudication; the debate-side direction alone already counts toward its page density). Never demand a specific shared anchor at step 1 — that is step-2 thinking (the miscalibration that left 74/143 debate claims at zero Related). Copy-collapse (HARD RULE 8) applies at this layer too, with a NEGATION GUARD: near-identical wording collapses only when no not/never/no/cannot token separates the pair — opposing positions and modality variants are never collapsed. Related edges are terminal: they stay whatever bracket the pair lands in later.
- **Step 2 — bracket assignment (passes 2–3), only after step 1 is published/approved for the batch.** Each Related-grouped pair is **RE-adjudicated against the strict bracket definitions** and lands in exactly ONE bracket: `DUPLICATE` (pass 2 — identify duplicates first), then `SIMILAR` (pass 3), or `SUPPORTS` / `OPPOSES` (argument relations), or **`RELATED-ONLY`** (no additional edge — the pair stays just Related).

⚠️ **Step 2 never copies step-1 discovery verdicts.** A verdict of "similar" under the older broad recall bar (assertion-family + tightly-coupled claims) does NOT meet the strict `Similar claims` bracket — most tightly-coupled pairs (stage-of-process updates, complementary facets, same-debate-question positions) are RELATED-ONLY. This is the exact mistake the 2026-08-12 team review corrected: when in doubt between Similar and Related-only, choose RELATED-ONLY.

## When to apply

- "Populate / assign / link similar claims" or "group related claims" for a space.
- "Which claims are similar to {claim}?" — seed mode around one claim.
- A recurring claim-relations pass after new content lands (always three-pass order: Related → Duplicate → Similar).

**When NOT to apply:** actually merging duplicate claims (→ `geo-clean`; this skill only links them with `Duplicate claims`).

## Prerequisites — verify before first run

1. **`geo-skills` repo cloned** locally; the skill runs FROM the repo root and imports `src/functions.ts` helpers.
2. **Bun installed** (`bun --version` works) and **`bun install` already run** (`node_modules/` exists).
3. **Repo migrated to the 2026-07 Geo infrastructure**: `@geoprotocol/geo-sdk` ≥ 0.20.0 and endpoints derived from the SDK config — quick check: `grep -q 'GeoTestnetConfig' src/functions.ts && echo migrated`. If the check fails, STOP — migrating `src/` is repo work, never something to patch inside a generated script.
4. **`.env` filled in**: `PK_SW=` and `DEMO_SPACE_ID=` set (publish-time only; discovery + dry-run never touch the wallet). Never `cat .env` — verify with `test -f .env && grep -q '^PK_SW=' .env && echo ok`.
5. **Editor access to the target space** — checked live by Gate 0 via `getPublishableSpaceIds`. Non-editor spaces are still analyzable; their ops ship as a **fix package** (`scripts/fix-packages/<slug>/<date>/ops.json` + `report.txt`), never a forced publish. The Root (Geo) space is always fix-package territory for property-schema edits.

If any prerequisite is missing, STOP and ask the editor to fix it. Do not work around.

## HARD RULES (failure = bug)

1. **Template before ops script.** Before any `Write` to `scripts/` or any `bun run` of an ops script, emit the Discovery + Gates + Plan template (below) and wait for the editor to reply `go`. Exception: the bundled `scripts/discover_candidates.ts` is read-only and pre-written — running it needs no `go`; its output IS the Discovery input.
2. **Two-phase execution.** After `go`: write `scripts/<YYYY-MM-DD>-claim-grouping-<slug>.ts` with `const DRY_RUN = true`, run the dry-run yourself, surface counts + sample `[CREATE]` lines + artifact paths, then ask: *"Output looks right? Type **publish** to submit the held-for-review proposal, or **stop** to discard."* On `publish`: flip to `false` with an `// AUTHORIZED <date>: editor replied publish` comment and re-run. On `stop`: leave the script on disk, change nothing. **`go` never authorizes publish.**
3. **The pre-cluster score is never the decision.** Token/structural similarity only builds candidate pairs (recall). Every proposed edge must carry an adjudicated verdict + confidence + one-line reason in `decisions.json`, produced by reading both claims' full names, descriptions, and citation names/URLs. Read [`references/adjudication-rubric.md`](references/adjudication-rubric.md) before adjudicating any batch.
4. **Duplicates never get a Similar edge.** Verdict DUPLICATE → `Related claims` in pass 1, `Duplicate claims` in pass 2, and `duplicates-for-geo-clean.json` for the merge decision (linking is not merging). Creating a Similar-claims edge between exact-meaning claims is a bug (geo-orchestrate Gate-1 Claim rule: exact meaning = merge path).
5. **Decisions data goes in the file, not the script.** The ops script reads `decisions.json` at runtime (`fs.readFileSync`). Never transcribe pairs/IDs into the script as a `const list = [ … ]` (documented cause of a real publish outage).
6. **Deterministic, property-namespaced edge + relation-entity IDs.** Direction `both` (default — these relations are symmetric; each claim's page must list the other; editor decision 2026-08-04): per direction, edge id = `typeId.slice(0,8) + from.slice(0,12) + to.slice(0,12)` and relation-entity id = `typeId.slice(0,8) + to.slice(0,12) + from.slice(0,12)`. The 8-char property prefix keeps the three passes (Related/Duplicate/Similar) from colliding on the same pair — the pre-2026-08-12 scheme (`from16+to16`, no prefix) is retired for new edges but already occupies the ids of published Similar edges, so never reuse it. Pinning `entityId` is mandatory — the SDK otherwise randomizes it per run and dry-run reruns fail the byte-identical check. Direction `one` (editor opt-in): single edge, `from` = lexically smaller ID. Edge ids and entity ids live in separate namespaces (verified live 2026-08-04), so a reverse edge id equalling a forward relation-entity id is harmless. Reruns and reversed pairs cannot double-publish.
7. **Idempotency + collision pre-check at ops time.** Before emitting a create: (a) live query for an existing edge of the SAME property between the pair in the **SAME direction** → `[SKIP existing]` — never check either-direction for mirrored brackets: the mirror direction is intentional, and an either-direction check silently suppresses it on any rerun after the forward side is live (real incident 2026-08-13: rerun clobbered fix packages down to deltas); (b) `relation(id: "<deterministicId>")` lookup — resolves to a different tuple → `[ESCALATE collision]`, resolves to this tuple → `[SKIP already-published]`; (c) both endpoints still exist (`spaceIds`/`typeIds` non-empty — `entity(id:)` never returns null on this API) → else `[SKIP gone]`.
8. **Copy-cluster collapse — one edge per distinct assertion, at EVERY layer (Related included; editor rule 2026-08-17: 4 identical "backdoor" copies each got a step-1 Related row — the census belongs in decisions + the duplicates ledger, never in live edges).** When several candidate partners of the SAME target claim are duplicates or near-duplicates of one another (cross-space copies, restatements of the same actor's stance), emit ONE edge to a deterministic representative — prefer (a) the copy in the target claim's home space, then (b) the distinct formulation that has no copy-siblings, then (c) lowest id — and mark the rest `dedupSuppressed` (kept in decisions with a `representative` pointer, no edge) + route them to `duplicates-for-geo-clean.json`. Attaching N copies of one assertion as N Supporting/Opposing/Similar edges is spam, not evidence (editor rejection 2026-08-13: 5 near-identical "Mamdani calls Netanyahu a war criminal" supporters on one claim). **Duplicate-claims linking within a copy cluster is STAR topology** (editor decision 2026-08-13): mirrored edges canonical ↔ each copy only, never the full pairwise mesh; canonical = editor-space resident, else lowest id. Distinct-assertion guardrails: different statistics (12% teens vs 18% parents), different modality (can vs will), and different attributed actors are DISTINCT partners — collapse applies to copies and restatements of ONE assertion only.
9. **Ops bucket by the FROM claim's home space** (for cross-space pairs each direction publishes into its from-claim's space, so both pages render the link); one ops array per space, each published once via `publishOps(ops, editName, spaceId)` — held-for-review DAO proposals (auto-vote is disabled). A from-claim whose home is not an editor space → fix package, never a forced publish.
10. **Additive-only; voting data untouchable.** `createRelation` is the only op kind this skill emits — zero update/unset/delete ops, and never any Score / Rank Votes op (`EXCLUDED_VALUE_PROPERTY_IDS` / `EXCLUDED_RELATION_TYPE_IDS` in `src/constants.ts`).
11. **Logging + full IDs.** Every dry-run prints per-pair `[CREATE]` / `[SKIP]` / `[ESCALATE]` lines. All editor-facing output uses full 32-character entity IDs and `https://www.geobrowser.io/space/{spaceId}/{entityId}` links — never truncated.

12. **⛔ Podcasts-space claims are NEVER linked (editor directive 2026-08-21).** The Podcasts catch-all space `b5a31f8182b042437ede0f84ee02f104` holds episode-extracted claim copies; linking them into claim grouping is banned at every layer and for every property (Related, Duplicate, Similar, Supporting, Opposing). Enforcement is threefold: (a) discovery refuses `--space`/`--pool`/`--seed` values in the excluded set and drops excluded-resident claims from semantic recall and from the export (live residency check — corpus pulls only carry the pull space, so dual-resident copies are only catchable live); (b) adjudication never stages a pair whose member has ANY Podcasts residency — if one slips through, verdict it `EXCLUDED-SPACE` (no edge, no bracket) and flag it; (c) the ops script runs a batched endpoint-residency check and emits `[SKIP excluded-space]` for any edge touching a Podcasts resident — this is a hard guard, not a warning. Podcasts fix packages are retired: never generate ops bucketed to the Podcasts space. A dual-resident claim (Podcasts + an editor space) is also skipped — surface it in the report as an editor call instead of linking it. The 2026-08-21 unlink campaign removed the 195 previously-published Podcasts links; do not recreate them.

## The pipeline (4 stages)

### Stage A — Discovery (bundled script, read-only, no `go` needed)

```
bun run skills/actionable/geo-claim-grouping/scripts/discover_candidates.ts --space <spaceId> [--pool crypto,wa,health] [--scope-file <ids.json>] [--cap 80] [--out <dir>] [--resume]
bun run skills/actionable/geo-claim-grouping/scripts/discover_candidates.ts --seed <claimId>
```

Pulls the target space's Claim corpus + signal edges (citation Sources, Notable-claims story membership, Topics, existing Related/Similar edges), pre-clusters candidate pairs (text-first + structural recall), scores them, and writes `candidates.json` + `summary.json` + a log to `scripts/<date>-claim-grouping-<slug>/`. Everything adjudication needs is inline in `candidates.json` — no re-querying. Query shapes, scoring constants, and API quirks: [`references/queries-and-signals.md`](references/queries-and-signals.md).

**Cross-space matching (`--pool`)**: pool spaces' corpora + signals join the candidate pool; similar claims may live in other spaces and cross-space edges are valid — verdicts never depend on space. **Page/tab scope (`--scope-file`)**: a JSON `{ "ids": [...] }` of claim ids — only pairs touching the scope are exported, and each scope claim gets a semantic `search()` recall pass (claim-filtered, and resident in `--space` or a `--pool` space — never the wider graph) on top of the pre-cluster. To resolve a geobrowser page/tab URL to a scope file: `entity(id: <tabId>)` → its `Blocks` relations (`beaba5cba67741a8b35377030613fc70`) → each block's `Collection item` relations (`a99f9ce12ffa4dac8c61f6310d46064a`) for collection blocks, or the block's `Filter` value for query blocks.

### Stage B — Adjudication (in-conversation, rubric-bound)

Read [`references/adjudication-rubric.md`](references/adjudication-rubric.md), then judge EVERY exported pair: verdict `SIMILAR` / `DUPLICATE` / `SUPPORTS` / `OPPOSES` / `NOT-SIMILAR` + confidence (`high`/`medium`) + one-line reason. Write `decisions.json` (schema in [`references/ops-script-template.md`](references/ops-script-template.md)) plus the routing byproducts `duplicates-for-geo-clean.json` and `argument-flags.json`.

### Stage C — Template + `go`

Emit the Required output template (below). Wait for `go`.

### Stage D — Two-phase ops script

Copy the annotated template from [`references/ops-script-template.md`](references/ops-script-template.md) into `scripts/<date>-claim-grouping-<slug>.ts` (`DRY_RUN = true`), run it, report, then wait for `publish` / `stop` (HARD RULE 2).

## Required output template — post BEFORE writing any ops script

````
## Operation: Similar-claims linking — {space name | seed claim}

## Discovery
- Corpus: {N} Claims scanned in {space} ({spaceId}); campaign dir scripts/{date}-similar-claims-{slug}/
- Candidate pairs generated: {M} (pre-cluster, recall-only); adjudicated: {A} (cap {cap})
- Verdicts: SIMILAR {s} (high {h} / medium {m}) · DUPLICATE {d} · SUPPORTS {p} · OPPOSES {o} · NOT-SIMILAR {x}
- Existing Similar-claims edges: {e} (→ [SKIP] rows); dangling-edge cleanup notes: {c}

## Gates
- Gate 0 editor access: PASS | FIRE — {getPublishableSpaceIds result}
- Gate 1 duplicate routing: PASS (0 duplicates) | FIRE — {d} pairs → duplicates-for-geo-clean.json
- Gate 2 argument routing: PASS | FIRE — {p+o} pairs → argument-flags.json
- Gate 3 already linked: {e} pairs → [SKIP]
- Gate 4 parameters: direction={one|both}, bar=same-assertion-family, floor={high|medium} — confirmed | UNCONFIRMED
- Gate 5 volume: {A} ≤ cap ✓, planned ops {k} ≤ 200 ✓

If any gate is FIRE/UNCONFIRMED, STOP HERE. Run the gate dialog and wait.

## Plan (only if gates PASS or were waived)
- Ops: createRelation={k} (one per approved SIMILAR pair × direction) — no other op kinds; voting data untouched
- Target space: {spaceId} — ONE held-for-review proposal
- Script: scripts/{date}-similar-claims-{slug}.ts (written AFTER you reply go; reads decisions.json at runtime)
- Dry-run: bun run scripts/{date}-similar-claims-{slug}.ts  (I run this — you will NOT)

Reply **go** to authorize the dry-run. (Then **publish** — a separate reply — to submit.)
````

## Gate dialogs

**Gate 0 — Editor access (HARD STOP).**

> This wallet is not an editor of **{space}** ({spaceId}). Ops can only ship as a fix package (`scripts/fix-packages/similar-claims-{slug}/{date}/ops.json` + `report.txt`) for that space's editors: {names}. Continue as **fix package**, or pick another space?

**Gate 1 + 2 — Routing (informational STOP inside the plan).**

> {d} pairs are exact-meaning duplicates — they get NO Similar edge; besides their step-2 `Duplicate claims` bracket they are queued for a geo-clean merge pass (`duplicates-for-geo-clean.json`). {p+o} pairs are support/oppose relationships — bracketed as argument relations in step 2 (`argument-flags.json` records direction). Reply **go** to proceed.

**Gate 4 — Parameters (HARD STOP on first run in a space).**

> Pilot parameters — confirm: (1) **direction**: `both` (mirrored A→B and B→A — recommended default, editor decision 2026-08-04: each claim's page lists its similar claims; 2× ops) or `one` (single canonical edge, from = lexically smaller ID; halves the ops, reverse visible only via backlinks); (2) **similarity bar**: `assertion-family-broad` (recommended default, editor decision 2026-08-05) — same assertion family PLUS tightly-coupled claims on the same specific event/process/debate question; or `assertion-family-strict` (the narrower 08-04 bar — near-restatements only); (3) **confidence floor**: `high` (recommended — medium-confidence pairs stay in the report as editor calls). Reply with choices or `defaults`.

**Gate 5 — Volume.** Adjudication batches cap at 80 pairs (quality over throughput — remaining candidates persist in `candidates.json` for the next campaign). Planned ops > 200 in one proposal → ask before splitting. Never raise the cap to "finish faster".

## Adjudication rubric — summary

Full rubric with worked examples, confidence rules, and boundary guidance: [`references/adjudication-rubric.md`](references/adjudication-rubric.md) — **read it before adjudicating any batch.**

**Step-1 discovery verdicts** (broad recall — decide only whether a pair enters the Related grouping):

| Verdict | Definition | Step-1 action |
|---|---|---|
| **SIMILAR** | Same assertion family OR tightly coupled to the same specific event/process/metric/debate question | `Related claims` edge |
| **DUPLICATE** | Exact meaning (rephrasings count) | `Related claims` edge + `duplicates-for-geo-clean.json` |
| **SUPPORTS** / **OPPOSES** | One claim argues for / against the other | `Related claims` edge + `argument-flags.json` |
| **NOT-SIMILAR** | Shared-template/different-facts, or same subject *area* with no specific shared anchor | Dropped (caveat: same-topic pairs may still meet the broad Related bar — editor call, never auto-promote) |

**Step-2 bracket verdicts** (strict — RE-adjudicate every Related-grouped pair; exactly one bracket per pair):

| Bracket | Test (team definitions, 2026-08-12) | Step-2 action |
|---|---|---|
| **DUPLICATE** | Same claim created twice — identical or near-identical *wording* ("better than" vs "better compared with") | `Duplicate claims` edges (mirrored) + stays queued for `geo-clean` merge decision |
| **SIMILAR** | Distinct formulations, same core assertion, **no material difference in what is claimed** ("provide meaningful social interaction for older adults" ≈ "offer valuable social engagement to elderly people") | `Similar claims` edges (mirrored) |
| **SUPPORTS** | One claim is evidence/argument FOR the other | `Supporting arguments` edge FROM the supported claim TO the supporter (mirror only if mutual) |
| **OPPOSES** | The claims contradict / take opposite positions | `Opposing arguments` edges (mirrored for mutual debate positions; single edge for one-sided rebuttals) |
| **RELATED-ONLY** | Distinct assertions about the same broader issue/topic/event ("better than social isolation" vs "should become common in elderly care") — includes most old broad-bar similars: stage-of-process, complementary facets, same-debate-question | No additional edge — the Related edge from step 1 is the grouping |

The two most load-bearing calls:

- **Template-headline trap:** "Circle secures a MiCA license in France" vs "Kraken secures a MiCA license in Ireland" → **NOT-SIMILAR** (high). High token overlap on a shared template is anti-evidence, not evidence.
- **Same-story siblings:** claims co-extracted from ONE news story were deliberately published as distinct facts → bias to NOT-SIMILAR unless they independently meet the bar.

## Script generation rules (Stage D)

- File: `scripts/<YYYY-MM-DD>-claim-grouping-<slug>.ts`; artifacts into the campaign dir `scripts/<date>-claim-grouping-<slug>/`. One file, one campaign.
- Copy the annotated template from [`references/ops-script-template.md`](references/ops-script-template.md) — imports (`Graph` from the SDK; `gql`, `publishOps`, `printOps`, `getPublishableSpaceIds` from `src/functions.ts`), runtime read of `decisions.json`, the per-pair check sequence (liveness → existing-edge both directions → `relation(id:)` collision), `Graph.createRelation({ id, fromEntity, toEntity, type }).ops`, `printOps` + `decisions.dryrun.json`, `DRY_RUN` guard, publish tail with proposal URL.
- Reuse, don't reimplement: `src/functions.ts` (`gql` retries 5xx/429/transients up to 50×; `publishOps` resolves personal-vs-DAO routing and returns the proposalId).
- No other op kinds, ever (HARD RULE 10). Rerun of the dry-run must be byte-identical (zero drift) before `publish` is offered.

## Dry-run report — required sections

Post after every dry-run (full IDs + geobrowser links, HARD RULE 11): staged edges table (Claim A, Claim B, conf, reason, edge id) · medium-confidence editor calls (NOT staged) · skips with reasons · byproduct: duplicates routed to geo-clean · byproduct: SUPPORTS/OPPOSES flags · cleanup notes (any dangling Similar-claims edges found — hand off to geo-clean "Find stale relations", this skill never deletes) · artifact paths · the `publish` / `stop` ask.

## What this skill does NOT do

- Link claims resident in the Podcasts space `b5a31f8182b042437ede0f84ee02f104` — any property, any layer, any direction (HARD RULE 12; editor directive 2026-08-21). No Podcasts fix packages either.
- Merge duplicates (routes them to `geo-clean`), or emit anything on the LEGACY Crypto-space `Related claims` property `a8aa1b654afd4ac786a243481d806846` (superseded by Root-space `504e5776788844f6a77dba3ee811d8f0`).
- Run step 2 on a batch whose step-1 Related grouping is not yet published/approved, or copy step-1 discovery verdicts into step-2 brackets without re-adjudication.
- Delete or modify ANY existing relation — dangling Similar-claims edges are reported for `geo-clean`, not touched.
- Write to Root or any non-editor space directly — fix packages only.
- Publish on `go` (publish requires the separate `publish` reply), or auto-vote on proposals (held-for-review, voting is the editors').
- Use token/string similarity as the linking decision (candidates only — HARD RULE 3).
- Exceed the adjudication cap silently — uncovered candidates are declared in the report and `summary.json`.

## More / hand-offs

- Duplicate merges + stale-edge cleanup: [`../geo-clean/SKILL.md`](../geo-clean/SKILL.md)
- Argument-relation follow-ups + publish mechanics: [`../geo-publish/SKILL.md`](../geo-publish/SKILL.md)
- Editor-facing routing front door: [`../geo-orchestrate/SKILL.md`](../geo-orchestrate/SKILL.md)
- Query patterns + API performance: [`../../non-actionable/geo-query/SKILL.md`](../../non-actionable/geo-query/SKILL.md)
- Shared helpers: `../../../src/functions.ts`, `../../../src/constants.ts`; campaign pattern library: `../../../scripts/`
