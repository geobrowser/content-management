---
name: geo-discovery
description: >
  Run an independent gap-discovery pass over a Geo space's daily content stream and
  publish the gaps as Gap finding entities. Surfaces coverage, depth, freshness,
  structural, and trending gaps at both entity and theme altitude. Triggers on
  "run discovery", "discover gaps", "what's missing in {space}", "discovery pass".
version: "0.1.0"
authors: CptMoh
tools: Claude Code
---

# geo-discovery

Self-contained discovery engine for the Geo knowledge graph. Mines the daily content
stream a space already ingests (News stories + topic-matched podcast episodes + their
Claims), finds the five gap types, ranks them, and produces Gap finding entities for review.

**Self-configuring per space.** Identity types, on-domain podcasts, and the publish
target are AUTO-DERIVED from the target space at run time (`scripts/space_profile.py`),
so the same skill runs on AI / crypto / health / any space with no per-space tuning. The
only hand-maintained knob is the global content/taxonomy denylist in `space_profile.py`.

**Stateless by design.** Every run is independent — it must NOT read prior-run
findings or drafted waves. Assume no previous run exists. (This is how the process
is perfected: clean-room runs you can compare.)

## When to use
The operator wants to run a discovery cycle on a space (AI, crypto, health, …) and
get a ranked list of gaps worth acting on.

## Inputs
- `space_id` (required) — the Geo space to run against (e.g. AI `41e851610e13a19441c4d980f2f2ce6b`).
- `days` (default 2) — recency window for the harvest.
- `strategic_anchors` — **OPTIONAL** bias only. Default runs need none: relevance is data-driven
  (trending + theme-fit). Pass `--anchors a,b,c` to Stage-4 routing only if you want to tilt a cycle.
- `action_capacity` (default 5 per track).

## Dependencies
- `python3` (standard library only — no pip install needed).
- Read access to the Geo GraphQL endpoint (baked into the scripts; no auth).
- For Stage 6 only: the `geo-publish` skill + the operator's signing key (write access).
- The `Gap finding` / `Gap type` / `Gap status` types must exist on Geo to publish.

## Configuration — auto-derived, not hand-tuned
Run `python3 scripts/space_profile.py <space_id>` to see what the run will use:
- **Identity types** = the space's own types minus a global content/taxonomy denylist minus
  orphan types. (AI → Model/Provider/Lab/Agent…; crypto → Project/Protocol/Token/Network/DEX…)
- **On-domain podcasts** = per-episode gates (precedence: deny > allow > topic-overlap): a global
  `SHOW_DENYLIST` + an optional per-space `PODCAST_ALLOWLIST`, else keep iff the episode shares
  ≥ `MIN_TOPIC_OVERLAP` **distinctive** topics with the space (`harvest.py` / `space_profile.py`).
- **Publish target** = the space's datasets space from `space_profile.DATASETS_SPACE` (add one
  line per space; reuses the shared Gap-finding ontology by ID).
New space → no config edits; only add its datasets-space mapping before Stage 6.

## Guardrails (non-negotiable)
- **Resolve exact-name first, then a normalized + type-scoped fuzzy fallback.** `gap_diagnostic`
  matches by `isInsensitive`, then normalizes (folds unicode dash-confusables like the U+2011 in
  `GPT‑5.5`) and runs a TYPE-SCOPED substring over identity types only (catches `Mythos` inside
  `Claude Mythos Preview`). NEVER a bare all-types substring — that buries popular entities
  (`OpenAI` = 1596 all-types hits) and produces false "missing" verdicts. A norm-equal hit = same
  entity (format variant, not a gap); a token/cross-type hit = related entity → keep the gap but
  set `Gap finding subject` and flag enrich-vs-create.
- **Existence ≠ no gap.** Run all five checks; an entity that exists can still be thin,
  stale, or duplicated.
- **Enrich, don't duplicate.** Before any "create", confirm the entity doesn't exist.
- **Relations over free text. Type discipline. Every fact cites Sources.**
- **Read-only except Stage 6.** Nothing writes to the graph before the review gate.
- **Never auto-publish.** Stage 6 is human-in-loop.

## Procedure (6 stages)

### Stage 1 — Harvest  ·  Automated
```
python3 scripts/run.py harvest --space <space_id> --days 2 --with-episodes --out harvest.json
```
(prints the auto-derived profile banner, then harvests). → `harvest.json`: recent News stories
(space-scoped) + on-domain podcast episodes, with their `claims[]` and `topics[]`.
**News is space-scoped** (only the target space's stories). **Episode relevance** is decided
per-episode with three gates (precedence: deny > allow > topic-overlap):
- `SHOW_DENYLIST` (harvest.py) — pure politics/general-news shows are dropped outright.
- `PODCAST_ALLOWLIST` (space_profile.py, per space) — known on-domain shows are always kept,
  so a single off-topic week can't drop e.g. *What Bitcoin Did*.
- otherwise: keep iff the episode shares ≥ `MIN_TOPIC_OVERLAP` (default 2) **distinctive**
  topics with the space (broad/generic topics in `BROAD_TOPICS` don't count — a shared
  "U.S. politics" is not evidence of on-domain).

### Stage 2 — Extract candidates (NER)  ·  Automated (LLM)
Read `harvest.json`. Following `references/ner_prompt.md`, extract the distinct named
entities (orgs, labs, models, products, programs, people) referenced in the claim text
and story titles. → `candidates[]` (list of names).

### Stage 3 — Diagnose  ·  Automated
Write the Stage-2 output to `candidates.json` (`[{"name","velocity"}, …]`) and run the driver —
it diagnoses every candidate with live PROGRESS (no polling a background job) and writes
`profiles.json` with the resolved IDs already filled in:
```
python3 scripts/run.py diagnose --space <space_id> --candidates candidates.json --out profiles.json
```
Identity resolution is **auto-derived per space** (no hardcoded type list). Each profile carries
`gaps[]`, `canonical_id`, and — for structural dedup — `dup_ids[]` (the exact entities to merge),
so Stage 6 writes the merge/create action without re-resolving entities. (Importable too:
`from gap_diagnostic import diagnose`.)

### Stage 4 — Score + route  ·  Automated (no input required)
```
python3 scripts/run.py route --profiles profiles.json --harvest harvest.json
```
Ranking is **data-driven** — there is NO manual `relevance` or `strategic_anchors` to enter.
Score ≈ `trending(velocity) + gap_value + theme_fit`, where the hot themes are derived from the
harvest itself (Stage-5 cross-source signal) and `theme_fit` boosts candidates that belong to a
hot theme. (Strategic anchors presupposed what discovery is meant to surface; they're now an
OPTIONAL `--anchors a,b,c` bias, not a required input.)
→ two ranked tracks: **Integrity** (structural dedup, batch into one merge wave) and
**Growth** (coverage/depth/freshness, theme-bundled). The Stage-6 review gate is where the
operator de-selects anything off-domain — no per-candidate scoring needed.

### Stage 5 — Theme heat + theme-gap diagnosis  ·  Automated
```
python3 scripts/theme_heat.py  --in harvest.json
python3 scripts/theme_gaps.py  --in harvest.json --space <space_id>
```
`theme_heat` classifies themes CROSS-SOURCE (DEEP-eligible) / podcast-only (STANDARD) /
news-only (provisional) — cross-source agreement is the sustained-heat signal that sets
depth tier. `theme_gaps` then resolves each hot theme against the target space's Topic
taxonomy (exact-name + Topic-type filtered) and emits a **theme-level gap**:
- **Coverage(theme):** no Topic exists → create it.
- **Structural(theme):** Topic exists but not in this space (e.g. only in podcasts) → attach + develop here.
- **Depth(theme):** Topic exists in-space but thin/disconnected → develop the page.

Themes are first-class discovery output, not just a heat map: each theme gap becomes a
`Gap finding` (structuring work — build/attach/develop a topic page; feeds `page-developer`).

**Bounded by upstream tags.** `theme_heat`/`theme_gaps` cluster Topics ALREADY ATTACHED to
the harvested stories, so they can only re-surface themes the taxonomy already knows. They are
blind to genuinely-new themes that recur in the claim TEXT but have no Topic yet. Stage 5c fixes that.

### Stage 5c — Emergent-theme discovery  ·  LLM + Automated (wider/periodic runs)
The model-driven complement to 5a/5b. **Run on the wider/periodic runs** (e.g. 30-day), not every
daily cycle — it costs a full read of the claim corpus.
1. **(LLM — you)** read the harvested claims and PROPOSE candidate emergent theme names — patterns
   that recur across stories but may have NO Topic yet (e.g. "physical attacks on crypto holders",
   "Bitcoin ATM regulation"). Write them to a JSON file: `[{"name":"…","synonyms":["…"]}]`.
2. **(script)** run the existence ladder + **variant reconciliation** deterministically:
```
python3 scripts/theme_emergent.py --space <space_id> --themes emergent.json
```
   Verdicts: `IN-SPACE` (already covered) · `VARIANT` (a name variant already in-space → do NOT
   create, would duplicate) · `ELSEWHERE` (exact Topic in another canonical space → bring it in) ·
   `CREATE` (genuinely emergent → file a `Coverage(theme)` finding, tagged `Theme`). The `VARIANT`
   guard is what prevents duplicate topics ("Real-world asset tokenization" vs existing
   "Real World Assets", "Restaking" vs "Liquid restaking"). Only `CREATE` (and chosen `ELSEWHERE`)
   become Gap findings.

### Stage 6 — Publish discoveries  ·  Human-in-loop (review gate)
Draft a `Gap finding` per accepted gap — entity-level AND theme-level — following
`references/drafting-conventions.md` (human-first name/description/action) and
`references/discovery-schema.md`. Always set **Publish date**; add the `Trending` gap tag
when velocity ≥ TREND_TAG_FLOOR. Operator reviews; on approval, publish via `geo-publish`.
**Enrich-vs-create lives here** — a "coverage" gap that's a sub-thing of an existing entity
(a program inside a lab, a model from a lab) becomes an enrich/link action, not a new entity.

**Publish with the generalized publisher — don't hand-author the glue.** Write the accepted
findings to `drafts.json` (`{target_space, publish_date, discoverer, findings:[{name, description,
recommended_action, gap_types:[…], subject?, suggested_type?, sources:[…], topics?, tags?}]}`),
get your personal-space id from geo-publish's `whoami.mjs`, then:
```
NODE_PATH=<geo-publish-skill>/node_modules bun --env-file=.env.geo-publish run \
  scripts/publish_gaps.mjs --findings drafts.json --author <your-personal-space> [--dry-run]
```
It works on ANY space: the target datasets space's DAO address + type are resolved at runtime
(DAO → propose+vote; personal → publishEdit), and the Gap-finding ontology IDs are shared
constants. `--dry-run` builds + prints ops without submitting; drop it to publish. Mechanics +
gotchas (FAST needs a separate YES vote; real `voteProposal` sig; `url`→`text`; dates in
`datetime`) are baked in and documented in `references/stage6-publish.md`.

**Dashboard — build once per space, then reuse.** The findings display is a Topic with live-query
tables; because they're live, every operator's findings show up automatically. Build it once:
```
bun … run scripts/build_dashboard.mjs --space <host> --datasets <datasets-space> --author <you>
```
It's **idempotent** — if a dashboard already exists it prints that URL and exits (publish into the
shared datasets space and your findings appear there); pass `--force` only to build your own.

## Output
A ranked Gap finding set (two tracks) + a theme map with depth tiers, and — on approval —
`Gap finding` entities published to the space (status `Proposed`).

## Files
- `scripts/space_profile.py` — auto-derives identity types + datasets target per space (global type denylist + per-space `PODCAST_ALLOWLIST` live here)
- `scripts/run.py` — driver: `profile` / `harvest` / `diagnose` subcommands (progress + structured output; run this instead of authoring glue)
- `scripts/harvest.py` — Stage 1 (episode filter: deny > allow > distinctive-topic-overlap; `BROAD_TOPICS`/`SHOW_DENYLIST` here)
- `scripts/theme_emergent.py` — Stage 5c (emergent-theme existence ladder + variant reconciliation)
- `scripts/gap_diagnostic.py` — Stage 3 (5-gap diagnostic; exact-name + normalized type-scoped fuzzy fallback)
- `scripts/prioritize.py` — Stage 4 (gate + two-track rank)
- `scripts/theme_heat.py` — Stage 5 (theme clustering + cross-source classification)
- `scripts/theme_gaps.py` — Stage 5b (theme-level gap diagnosis → theme Gap findings)
- `scripts/publish_gaps.mjs` — Stage 6 publisher (any space: runtime DAO resolution + shared ontology constants)
- `scripts/build_dashboard.mjs` — Stage 6 dashboard (build once per space, idempotent reuse; live-query tables)
- `references/ner_prompt.md` — Stage 2 extraction prompt
- `references/discovery-schema.md` — the Gap finding entity schema for Stage 6
- `references/drafting-conventions.md` — human-first naming/description/action + required props (Stage 6)
- `references/stage6-publish.md` — Stage 6 DAO publish mechanics + gotchas (propose+vote, voteProposal signature, url→text, dates)
