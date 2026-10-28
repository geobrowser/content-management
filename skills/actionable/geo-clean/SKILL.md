---
name: geo-clean
description: Clean the Geo knowledge graph — find and merge duplicates, find entities without types, delete orphans, move/copy entities between spaces, fix data types, find blank properties, fix stale relations, delete space data. Runs safeguards (deterministic canonical selection, both-scored escalation, untouchable-space protection, voting-data exclusion, system-entity exclusion (governance proposals / space bookkeeping / rankings), ranked-entity review escalation, anchored-entity (page/avatar/cover) protection, dry-run expiry, orphan check, dry-run, explicit publish confirmation) before any destructive op. Triggers on "find duplicates", "merge", "deduplicate", "delete orphan", "delete entity", "move entity", "copy entity", "delete space data", "fix data type", "find blank properties", "fix stale relations", "clean", "cleanup".
metadata:
  version: "0.5.1"
---

# Geo Knowledge Graph — Cleaning

Editor-facing skill for cleaning Geo: finding bad data, merging duplicates, deleting orphans, moving entities, fixing types. Uses Bun + `@geoprotocol/geo-sdk` **v0.20.0+** locally on the editor's machine (older SDKs target the decommissioned pre-2026-07 infrastructure — see prerequisite 4). Every destructive op runs through a Discovery + Gates + Plan template, a dry-run, and an explicit `publish` confirmation.

This skill complements the publishing skill (which creates new entities). Both share the same local setup. Works on any host (Claude Code, other desktop agents) that can read files, run bash, and reach the network.

## Prerequisites — verify before first run

1. **`geo-skills` repo cloned** locally. The skill runs FROM this directory and imports helpers from `src/` (`mergeEntities`, `selectCanonicalTopic`, `OpsBatch`, etc.).
2. **Bun installed** (`bun --version` works).
3. **`bun install` already run** (`node_modules/` exists).
4. **Repo migrated to the 2026-07 Geo infrastructure**: `@geoprotocol/geo-sdk` pinned **≥ 0.20.0** (beta pins like `^0.20.0-beta.8` count) in `package.json`, with all endpoints derived from the SDK's network config — quick check: `grep -q 'GeoTestnetConfig' src/functions.ts && echo migrated`. The old infrastructure (SDK ≤ 0.19.x, hardcoded `testnet-api.geobrowser.io` / old Conduit RPC URLs) is decommissioned: during the short post-migration grace window the old endpoints still respond — everything LOOKS fine — but edits published there are not carried over, and then the endpoints go offline for good. If the check fails, STOP — migrating `src/` and the SDK pin is repo work, never something to patch around inside a generated script.
5. **`.env` filled in**: `GEO_PRIVATE_KEY=` (or legacy `PK_SW=`) and `DEMO_SPACE_ID=` set. Never `cat .env` or grep the key's value — to verify presence use `test -f .env && grep -qE '^(GEO_PRIVATE_KEY|PK_SW)=' .env && echo ok`.
6. **Network allowlist** (if the host sandboxes outbound traffic): the hosts come from the SDK's `GeoTestnetConfig` (apiOrigin, chain.rpcUrl, sponsorship.rpcUrl) — currently `testnet-api-v2.geobrowser.io` (GraphQL; the announced `api-testnet.geobrowser.io` alias serves the same data), `rpc-geo-testnet-irdc0cgb0w.t.conduit.xyz` (RPC, chain id 55516) and `rpc.zerodev.app` (gas sponsorship, publish-time), plus the IPFS gateway. Hosts surface on first failed publish — add as they appear, and re-check the config after SDK bumps (final vanity URLs like `rpc-testnet.geobrowser.io` may land in a later release).

If any prerequisite is missing, STOP and ask the editor to fix it. Do not work around.

## HARD RULES (failure = bug)

1. Before any `Write` to `scripts/` or any `bun run`, you MUST emit the operation-specific Discovery + Gates + Plan template (below) and wait for the editor to reply `go`.
2. **Two-phase execution**:
   - After `go`: write the script with `DRY_RUN = true`, run the dry-run yourself, surface the summary to the editor.
   - Ask: *"Output looks right? Type **publish** to apply the cleanup, or **stop** to discard."*
   - On `publish`: flip `DRY_RUN = false`, run again, report the per-space proposal URLs (or tx hash for a personal space) + space verify URL.
   - On `stop`: do nothing; leave the script for review.
3. **Never auto-execute a destructive op without `publish`.** `go` only authorizes the dry-run.
4. **Logging is mandatory.** Every dry-run prints per-entity decisions: `[MERGE] X (id) ← Y (id), Z (id)` / `[DELETE] X (id, 0 backlinks)` / `[SKIP] X (id, reason)` / `[ESCALATE] X (both-scored)`. No silent ops.
5. **Always use deterministic IDs for relation entities** created during merges: `from.slice(0,16) + to.slice(0,16)`. Reruns must be idempotent.
6. **Additive-only when in doubt.** If a "fix" could be done either by adding new data or by deleting old, prefer adding. Only delete when the user explicitly authorized.
7. **Data goes in the file, not in the script.** When a cleanup runs over a large list (the `scripts/<date>-*.json` exports this skill writes, or a candidate-ID/CSV list), the script **reads and parses that file at runtime** — it must NOT have the IDs/rows transcribed into it as a `const list = [ … ]` array. Baking the list in blows the token budget and times out on big sets, and risks the model corrupting IDs as it copies. The script holds only logic + helper imports; the list stays in the file. Full pattern: `geo-publish` → "Bulk / dataset publishing".
8. **Voting/ranking data is untouchable.** Geo's ranking data — the **Score** value property (`85a4668a42fa4f488969c0a9de0c294b`, "net upvotes minus downvotes", system-maintained), **Ranking Vote** relations (`19a4cfff45f24150abf2af0f43eb2eec` — live name "Ranking Vote", kept as `RANK_VOTES_RELATION_TYPE_ID` in `src/constants.ts`; cast by **Ranking** entities, type `5c74731dfabb4dc8b5c53346521c639a`, usually from the voter's personal space) and the vote ordinal/weighted value properties (`49ee1b8918204e75a1ae38a2dcaad4a5`, `103701ddcabe4a8e835b10345327b647`) — belongs to the voters and the system, not to the entity being cleaned. **No generated op may set, copy, unset, redirect, or delete any of it, in ANY operation.** Redirecting a Ranking Vote backlink fabricates a vote; deleting one destroys a voter's data. The `src/` helpers exclude these at op-generation time (`EXCLUDED_VALUE_PROPERTY_IDS` / `EXCLUDED_RELATION_TYPE_IDS` in `src/constants.ts`); scripts that assemble ops by hand must apply the same exclusion and run a scrub pass over the final batch (see [`reference.md`](reference.md)). Accepted consequence: a merged-away duplicate keeps its votes and Score. An entity RECEIVING Ranking Votes is *ranked* — see "Ranked entities" below for what that means for cleanup decisions.
9. **Anchored (identity) entities are excluded from deletion by default.** A space's identity — its **`page`/home entity**, its **Avatar** (profile photo) and **Cover** images — is anchored. A space wipe or bulk delete must **skip** these unless the editor explicitly overrides (Gate — Anchored-entity, below). Resolve them with `getAnchoredEntityIds(spaceId)` from `src/functions.ts` (returns `{page + avatar + cover}` entity IDs) and filter every delete/unset op against that set, logging `[SKIP] <id> (anchored)`. The dry-run summary MUST state `Anchored entities excluded: N`. Why this rule exists: a bulk personal-space delete once wiped the profile photo and space description because the script processed the page entity + identity images as ordinary rows (Aug-2026 incident).
10. **Dry-run authorizations expire.** `publish` acts on the dry-run's snapshot; if the space changed in between, the op is stale. If more than **~30 minutes** elapsed between the dry-run and `publish` (or the session was interrupted/resumed), **do NOT publish the old script** — re-run discovery + the dry-run, show the fresh counts (highlight any delta), and ask for `publish` again. A 10-hour gap between `go` and `publish` was a contributing factor in the Aug-2026 wipe.
11. **Never hand-write a raw-SDK delete loop.** All destructive ops go through the `src/` helpers and `publishOps` — never a bespoke `geo.entities.delete()` / `deleteEntity` loop that bypasses the exclusions above. `publishOps` refuses any batch removing data from >50 relations/values unless `CONFIRM_DESTRUCTIVE=1` is set. For a legitimate mass delete (space wipe, big merge), set that flag **only on the confirmed `publish` run** (`CONFIRM_DESTRUCTIVE=1 bun run scripts/<file>.ts`), **after** the editor's explicit `publish` and after anchored/voting exclusions are applied — never on the dry-run, never to route around a block. See [`reference.md`](reference.md).
12. **System entities are invisible to cleanup.** Three classes of protocol-minted entities must never appear in a candidate list, never be counted as "junk", and never be targeted by any op:
    - **Governance proposal entities** — named `Proposal <uuid>`, one per governance proposal (current infra stamps them with a "System entity for proposal …" description). They are governance bookkeeping, not broken-publish leakage, and the protocol keeps minting them — deleting them is at best churn, at worst breaks governance views.
    - **Space bookkeeping entities** — named `Space <uuid>` (including the space's own id as an entity), carrying `Payout` / `Allocated` edges. Payout & allocation accounting.
    - **Ranking entities** — type `Ranking` (`5c74731dfabb4dc8b5c53346521c639a`); they hold users' Ranking Votes and usually live in personal spaces.
    Discovery reports them as one aggregate line (`System entities excluded: N — proposals {p}, space bookkeeping {b}, rankings {r}`), logs `[SKIP] <id> (system entity)` if one reaches an op pipeline, and moves on. Detection recipes in [`reference.md`](reference.md).

## Ranked entities — surface them in every discovery output

Geo's ranking feature: a user's **Ranking** entity (e.g. "Books everyone should read", type `5c74731d…`, usually in their personal space) casts **Ranking Vote** relations (`19a4cfff…`) at the entities being ranked; ranking *blocks* on pages ("Submitted to Ranking Block", `09c219c103d14d2aa5c78edbf2d0182a`) render them, and the system-maintained **Score** value aggregates votes. An entity is **ranked** when it has ≥1 inbound Ranking Vote (verified example: Animal Farm `6278a4a649eb485f86c0bb1c036b5e14`, 30 inbound Ranking Votes from 30 users' Rankings).

Ranked = a user chose to put this entity on a list. That is a community-value signal cleanup must respect:

- **Every discovery output includes ranking status** — a `Ranked` column with the inbound Ranking Vote count (`relationsConnection(filter: { toEntityId: { is: X }, typeId: { is: "19a4cfff…" } }, first: 0) { totalCount }`) and the Score value where present. Every Discovery block also prints the counters `System entities excluded: N` and `Ranked candidates flagged: M`.
- **A ranked entity is never an easy delete.** Ranking Votes do not *block* deletion the way references do, but deleting a ranked entity strands real users' votes — so any delete candidate with ≥1 Ranking Vote is escalated to editor review with its vote count shown, never batched into a "delete all" bucket.
- **Merges already respect ranking** via the Score cascade rule and HARD RULE 8 (votes never migrate; a merged-away twin keeps its votes). Surface each member's vote count in the member table so the editor sees where the community's votes sit before approving.

## The operations

Each operation has a dedicated section below with its own Discovery, Gates, and Plan template.

| Operation | Destructive? | Key gate |
|---|---|---|
| Find duplicates | No | — |
| Find entities without types | No | — |
| Find blank properties | No | — |
| Find stale relations | No | — |
| Find duplicate-type relations | No | — |
| Merge duplicates | Yes | Deterministic canonical cascade + Both-Scored escalation + untouchable spaces |
| Delete orphan | Yes | Must have 0 incoming relations (vote edges listed separately) |
| Move / copy entity | Yes | Representative-topic guard; explicit `from_space` on multi-space sources |
| Fix data type | Yes | Old value preserved as comment until publish |
| Fix duplicate-type relations | Yes | Keep exactly one edge per (entity, type) |
| Delete space data | Yes (mass) | Editor types space name to confirm |

---

## Operation: Find duplicates (read-only)

Used standalone OR as the discovery step before a merge. **Two passes** — run Pass 1 always; run Pass 2 when the type is text-heavy (News story, Article, Claim, Event) where exact-name collisions are near-impossible.

### Pass 1 — Exact-name grouping (cheap, deterministic)
Pattern B from `geo-query` (list entities of a type): list entities of the target type (paginate every page, not just the first 50). Group by `name.toLowerCase().trim()`. Surface groups with 2+ members.

Pass 1 works well for **People / Orgs / Projects / Topics** (canonical names recur verbatim — "ethereum" published four times). It is **structurally blind to news/article near-duplicates**: two stories about the same event almost never share a byte-identical headline, so Pass 1 returns 0 groups even when genuine same-event dupes exist. Verified: exact-name grouping over 1,087 Crypto News stories → **0 groups**, while ~4 genuine same-event near-dupes were present.

**Inventory mode (optional, for big sweeps):** when the editor wants a space-wide or multi-space dedup campaign, write the Pass-1 groups to `scripts/<date>-merge-inventory.json` (HARD RULE 7 format: one row per group — name, ids, optional forced `canonical_id`, optional `preferred_name`) and keep a **deferred-twins ledger** (`scripts/<date>-deferred-twins.json`) for out-of-scope twins found along the way (wrong type, multi-space assignments pending placement, both-scored groups). Deferred ≠ ignored: the ledger is the queue for a later pass.

### Pass 2 — Semantic near-duplicate detection (LLM judgment, NOT string similarity)
Run this for text-heavy types. The goal is **same real-world event told twice**, e.g.:
- "Senate advances GENIUS Act in new cloture vote" ↔ "GENIUS Act advances toward final Senate vote"
- "Trump Media and Crypto.com formalize their partnership…" ↔ "Trump Media is partnering with Crypto.com to launch ETPs…"
- "Priority Blockspace for Humans has launched on World Chain" ↔ "World launches Priority Blockspace for Humans"

**Do NOT use token/string-similarity (Jaccard, Levenshtein, cosine-on-bag-of-words) as the decision.** It over-flags template headlines that are *different stories*:
- "X raises $Y Series Z" vs "P raises $Q Series R" — high token overlap, **different companies, NOT dupes**
- "X secures MiCA license" vs "P secures MiCA license" — same template, **different firms, NOT dupes**

Method: (1) **pre-cluster cheaply for recall** — bucket by shared salient tokens (names, tickers, bill names) or a same-week `createdAt` window; this builds candidate pairs, it is *not* the decision. (2) **LLM-adjudicate each pair** — read both names (+ `description`/source URL) and decide *same event → near-dup; same template, different actors → keep separate*, with a confidence + one-line reason. (3) **Recommendations only** — never auto-merge a Pass-2 group; the editor confirms each. Pass 2 trades determinism for recall (can miss, can over-suggest), so Pass 1 groups are safe to "merge all" but Pass 2 groups are not.

### Output template
```
## Duplicate groups — type {type name}
Total entities scanned: {N}

### Pass 1 — exact name ({G1} groups)
| Group | Members | Spaces | Backlinks (each) | Ranked votes (each) |
|---|---|---|---|---|
| "ethereum" | 4 | Crypto, Crypto datasets, AI, PERSONAL | 142, 8, 2, 0 | 5, 0, 0, 0 |
| ... |

### Pass 2 — semantic near-dupes ({G2} candidate groups, ADVISORY — confirm each)
| Members (headlines) | Same event? | Confidence | Reason |
|---|---|---|---|
| "Senate advances GENIUS Act in new cloture vote" / "GENIUS Act advances toward final Senate vote" | yes | high | same Senate vote, same bill |
| "Circle secures MiCA license" / "Kraken secures MiCA license" | no | high | template match, different firms — KEEP SEPARATE |

Reply with the group(s) to merge (Pass 1: or "all"; Pass 2: name them explicitly — no "all"). The canonical is picked by the deterministic cascade (see Merge).
```

No write happens here. Output is the input for the Merge operation.

---

## Operation: Merge duplicates (destructive)

The most-requested op. Losing members merge INTO the canonical (Main) and are removed — **except** copies living in untouchable spaces, which survive there (see the Untouchable-Spaces rule). The canonical is picked by a **deterministic cascade**, not by eyeball.

### Canonical selection — deterministic cascade

Selection runs during Discovery, BEFORE any script is written. Same data in, same pick out. Implemented by `src/select_canonical.ts` (`fetchCandidateMeta` → `buildScoringContext` → `selectCanonicalTopic`) — generated scripts call the helper, never re-implement the rules.

**Step 0 — hard exclusions.** A candidate resident in a **personal space** or a **dataset space** (`DATASET_SPACE_IDS` in `src/constants.ts`) can never be canonical — never reference a personal- or dataset-space copy, whatever its backlink count. **Root exception:** a candidate resident in Root (Geo) (`a19c345ab9866679b001d7d2138d88a1`) is ALWAYS eligible regardless of its other residencies — the Root copy IS the graph's canonical entity.

**Step 1 — Both-Scored check.** If ≥2 eligible candidates carry a Score value → do NOT merge; fire the Both-Scored gate (below).

**Step 2 — priority cascade.** First rule that separates the candidates wins:

| # | Rule | The candidate that wins… |
|---|---|---|
| 1 | Canonical space | IS a canonical space's representative topic (`space(id){topicId}` resolves to it). E.g. reference Crypto `0fcd62b5798f4078b84fa535ac95fcf3` (the Crypto space's topic), not Crypto `c6d666eb7ffa40d29db1f713eb1943f3`. |
| 2 | Canonical topic | lives in Root (Geo) space |
| 3 | Properly placed | is NOT resident *only* in a catch-all space (currently: Podcasts `b5a31f8182b042437ede0f84ee02f104`). A demotion, not an exclusion — the catch-all-only copy still merges in as a secondary. |
| 4 | Featured | has a `Tags → Featured topic` relation (`b69b8b1659df4e6d99d79956a30e8932`) — these render as Featured Timelines in the News App |
| 5 | Scored | carries a Score value (the single scored candidate is strongly preferred) |
| 6 | Curated | has a `Tags → Curated topic` relation (`7f796eb5bfc5449c98649bf7d996a2ca`) |
| 7 | More backlinks | higher TRUE backlink count (`relationsConnection.totalCount`, all spaces — never a first-page count) |
| 8 | More data | more values + relations |
| 9 | Older | smaller `createdAt` |
| 10 | Lowest id | `id.localeCompare` — stable final tiebreak |

Rules 1–6 are topic-flavored: for types that carry no tags/scores/representative status they simply never fire, and the cascade falls through to 7–10 — so it is safe for **any entity type** (People, Projects, Shows, …). (Score deliberately sits below Featured, following the implemented selection rules; the guidance doc's prose reads it higher.)

**Editor override.** An explicit editor-designated Main (reply with the id, or the `canonical_id` column in an inventory file) bypasses the cascade AND the Both-Scored escalation — a human has decided. Log it as `[forced]`.

### Untouchable spaces — vacate semantics (automatic policy)

Members partition three ways; the Plan must name each member's bucket:

- **eligible** — no personal/dataset residency (or Root-resident): may be canonical; losers are fully merged + deleted.
- **vacatable** — canonical-ineligible (personal/dataset residency) but ALSO resident in managed DAO spaces: **vacated from the managed spaces only**; the copy **survives untouched in its personal/dataset spaces**, and backlinks living in surviving spaces keep pointing at the surviving copy.
- **excluded** — resident ONLY in personal/dataset spaces: left entirely untouched (not merged, not deleted — not our data). A group where every member is excluded is skipped (`no-eligible-candidate` escalation).

Two standing guards:
- **Representative-topic guard:** never vacate a space's representative topic (`space.topicId === entity`) from its own space — it is part of the space's identity. It survives there like a personal-space copy does.
- **Editor's own personal space:** the exclusions protect OTHER people's spaces. If the editor explicitly asked to clean their own personal space, personal copies there are fair game — say so in the plan.

### Cross-space semantics — merge consolidates, never relocates

For a secondary resident in a foreign (non-anchor) space, the merge is **references-only**: backlinks in that space are redirected to the canonical (they resolve cross-space by global id); the twin's space-local values and outgoing relations are dropped with the residency. **A merge never grants the canonical new residencies** — a space that loses its twin gets the topic back only via a deliberate Move (see the Move/copy operation). The Plan's END STATE must warn about every such space.

### Discovery (mandatory before Plan)

For every group the editor selected:

1. **List every member** (id, name, spaces, types).
2. **Fetch selection metadata per member** (one gql call each — query shapes in [`reference.md`](reference.md)): `spaceIds`, `representsSpaces` (spaces whose `topicId` is this entity), Score values, Featured/Curated tags, TRUE backlink `totalCount`, values+relations counts, `createdAt`.
3. **Resolve the scoring context once per run**: each canonical space's representative-topic id, and which candidate spaces are `PERSONAL` (`space(id){ type }`).
4. **Partition** members into eligible / vacatable / excluded; run the cascade → canonical + anchor space (a space shared by canonical and secondaries; topical canonical space preferred over Root).
5. **Count backlinks per member, paginated to completion** (cursor-paginate `first: 500` until `hasNextPage` is false; record page count). The totalCount from step 2 ranks; the pagination proves completeness for migration.
6. **Bucket the resulting ops by target space.** Each backlink op writes to the backlink's source space, not Main's space. A merge that touches Podcasts, Crypto, and a personal space becomes separate per-space transactions / governance proposals.

### Gate — Both-Scored (HARD STOP)

Fires if **two or more eligible members carry a Score value**. Scored topics are treated as canonical-grade; fusing two of them is a human call.

STOP and tell the editor:

> Group **"{name}"** has {n} scored members — not merging (needs human review, escalate to the space's lead editor):
> | Member | ID | Score | Spaces |
> |---|---|---|---|
> | … | … | +12 | Crypto, Root |
> | … | … | +3 | Podcasts |
>
> Options: **skip** (default — the group is written to the escalation report), or reply with the id to keep as Main (**forced override** — you accept merging scored topics).

Escalated groups are appended to `scripts/<date>-escalations.txt` (name, ids, scores, spaces, reason `both-scored` / `no-eligible-candidate`) so the review queue survives the session.

### Gate — Canonical-Delete (explicit authorization)

Consolidation legitimately removes DAO-resident twins — but never silently. Two layers:

1. **Plan layer:** the END STATE block (below) must name every canonical-space copy that gets removed and every space that LOSES the topic. The editor's `go` authorizes exactly that list.
2. **Helper layer:** `mergeEntities` refuses any non-PERSONAL loser unless the script passes `allowCanonicalDelete: true`. The skill sets that flag ONLY in scripts generated after a `go` on a plan whose END STATE showed the removals. Never pass it preemptively.

**Root invariant (⛔ absolute):** the Root (Geo) space must never lose a topic. If the planned END STATE removes a topic from Root, the plan is invalid — force the Root-resident twin as canonical or drop the group. Do not offer an override for this one.

### Gate — Big-Merge (HARD STOP)

Fires if **any single member has > 100 incoming backlinks** OR **the total planned ops > 200**.

Big merges have historically lost rows (AI/Tech merge incident, 2026-05-29: 216 deletes vs 107 creates because backlinks weren't paginated to completion). Even with the pagination fix in place, large merges produce huge cross-space governance proposals and are hard to roll back.

STOP and tell the editor:

> Group **"{name}"** is too big for the auto-merge helper:
> - canonical has **{N}** incoming backlinks (cap is 100)
> - duplicate(s) have **{M}** combined
> - estimated total ops: **{ops}** (cap is 200)
>
> This needs the manual merge procedure in [`big-merge.md`](big-merge.md) — the helper has historically under-migrated rows on this scale and produced large cross-space proposals. Reply **skip** to leave this group, or **force big-merge** to override (you accept the under-migration risk and will manually verify backlink counts post-merge).

### Gate — Cross-Space-Impact

Fires if the merge writes into **more than one space**.

STOP and tell the editor:

> This merge writes into **{S} spaces**:
> | Space | createRelation | updateEntity | deleteRelation | deleteEntity | Can publish? |
> |---|---|---|---|---|---|
> | Crypto | 12 | 1 | 0 | 0 | yes (editor) |
> | Podcasts | 94 | 0 | 94 | 0 | yes (editor) |
> | World affairs | 3 | 0 | 3 | 0 | NO — fix package |
>
> Each non-personal space becomes its own DAO governance proposal. The Podcasts proposal in particular will churn the podcast app's topic links for **{N}** episodes.
>
> Ops for spaces where this wallet lacks editor access are NOT dropped and NOT force-published: they are exported as a **fix package** (`scripts/fix-packages/<space>/<date>/ops.json` + `report.txt` listing that space's editors) for the right editor to apply.
>
> Reply **go** to proceed across all spaces, or name spaces to exclude (e.g. `exclude Podcasts` — those backlinks stay pointing at the duplicate).

### Gate — Backlink-Pagination-Confirmation

Discovery must surface, per member:

```
Backlinks paginated to completion: YES (253 rows fetched across 6 pages, totalCount 253 ✓)
```

If the paginated row count disagrees with `relationsConnection.totalCount`, or the helper returns a count without a page breakdown, the gate fires:

> Backlink pagination for **{name}** ({id}) could not be confirmed as complete. Refusing to proceed — under-migration risk. Investigate before merging.

### Gate — Selection ambiguity (residual)

The cascade is deterministic, so ties no longer stop the merge. This gate fires only when selection **cannot run**: metadata fetch failed for a member (entity not found / API errors), or the editor asked to override but named an id outside the group. Surface the metadata table and ask for an explicit Main or **skip**.

### Gate — Data-type mismatch

If members have different data-type assignments for the same property name (e.g. one stores "Birth date" as `text`, another as `date`), STOP and ask which type wins. Don't silently coerce.

### Plan template

```
## Merge plan — type {type name}
Groups: {G}   Escalated: {E} (written to scripts/<date>-escalations.txt)
Pagination: all members confirmed paginated to completion ✓
Voting data: excluded from all ops (Score / Rank Votes stay put) ✓

Per-space ops:
| Space | createRelation | updateEntity | deleteRelation | deleteEntity | Publish route |
|---|---|---|---|---|---|
| Crypto | 12 | 1 | 0 | 1 | proposal |
| Podcasts | 94 | 0 | 94 | 0 | proposal |
| World affairs | 3 | 0 | 3 | 0 | FIX PACKAGE (no editor access) |

Per-group decisions:
[MERGE] "ethereum"  CANONICAL: 4cd3dcb0… (Crypto, rule 1 — canonical-space topic)
        ← 8bd19463… (Crypto datasets)  EXCLUDED — dataset space, left untouched
        ← 61bc9cb3… (AI, 2 backlinks)  eligible loser → merged + deleted
        ← a54bc45b… (PERSONAL + AI)    vacatable → vacated from AI, survives in PERSONAL
[ESCALATE] "defi"   both-scored (+12 / +3) → skipped, in escalation report
[SKIP]  "ai"        Big-Merge gate (253 backlinks > 100)

END STATE (what the graph looks like after publish):
  canonical 4cd3dcb0… → [Crypto, Root] (residencies unchanged — merge never adds any)
  twin 61bc9cb3… → fully removed
  twin a54bc45b… → survives only in [PERSONAL] (+ its votes/Score stay wherever set)
  ⚠ topic LEAVES: [AI] — twin removed there, canonical not resident (returns only via a later move)
  ⛔ Root check: no topic leaves Root ✓   (if one would: DO NOT PUBLISH — force the Root twin as canonical)

Reply **go** to write + dry-run the script. (Then **publish** to actually merge.)
```

### Execution

Use `mergeEntities` from `src/entity_ops.ts` (battle-tested) with the selection results — full contract + code template in [`reference.md`](reference.md). Non-negotiables:

- `disableAutoSelect: true` and the cascade's pick as `mainEntityId` — otherwise the helper re-picks the Main itself and the approved plan is a lie.
- `secondaries` entries carry `residentSpaceIds` + `keptSpaceIds` from selection; pass `untouchableSpaceIds` (dataset + personal spaces) so surviving copies are skipped.
- `allowCanonicalDelete: true` ONLY after `go` on a plan whose END STATE named the canonical-space removals.
- Accumulate everything into one `OpsBatch` (`opsBatch: Map<string, Op[]>`); the script publishes per space at the end only when `DRY_RUN = false`. Spaces without editor access → fix package, never a forced publish.
- **Snapshot before publish:** during the dry-run, save each secondary's pre-merge state — `bun run validate_migration.ts <secondaryId> <canonicalId> --save-snapshot scripts/<date>-snap-<secondaryId>.json`.

After publish:
1. Report per-space **proposal URLs** (`publishOps` returns the proposalId for DAO spaces): `https://www.geobrowser.io/space/{spaceId}/governance?proposalId={id-without-0x}`.
2. **Validate the migration** per secondary: `bun run validate_migration.ts <secondaryId> <canonicalId> --snapshot scripts/<date>-snap-<secondaryId>.json` — all three rules (values, outgoing relations, backlinks) must PASS. A FAIL is a red flag for under-migration — investigate before approving the next merge.
3. Quick sanity: canonical's new backlink total ≈ pre-merge sum (canonical + migrated duplicates').

---

## Operation: Move / copy entity between spaces (destructive)

Relocate (or replicate) an entity, keeping its global id. This is also the sanctioned repair when a merge's END STATE warned `topic LEAVES [space]` and the editor wants it back there.

- **move** — recreate the entity's values + outgoing relations in `to_space`, remove them from `from_space`. **References to the entity are left untouched**: because the id is unchanged, they keep resolving to it cross-space. (Deliberately diverges from Geo's UI "Move to", which deletes source-space references.)
- **copy** — like move but the source is kept, so the entity becomes multi-space (like Geo's "Copy to"). Copied relations get **fresh ids** so the two per-space copies stay independent.

Only the entity's own data moves — not the entities it points to (those relations become cross-space) nor block children (not cascaded). Voting data stays put (HARD RULE 8).

### Discovery
1. Pattern C on the entity: name, types, values, outgoing relations, `spaceIds`.
2. Resolve `from_space`: explicit if the editor gave one; inferred when the entity lives in exactly one space.
3. Check `spaces(filter: { topicId: { is: "<id>" } })` — representative-topic guard.

### Gates
- **Multi-space source:** if the entity lives in several spaces and the editor didn't name `from_space`, STOP and ask (list the residencies).
- **Representative-topic guard:** never MOVE a space's representative topic out of its own space (copy is fine). STOP: this topic is part of the space's identity.
- **Already there:** `from_space === to_space` or already resident in `to_space` (for copy) → skip, tell the editor.

### Plan template
```
## Move/copy plan
[MOVE] "Ken Burns" (000ab247…)  Podcasts → World affairs   (references untouched, resolve cross-space)
[COPY] "Nuclear weapons" (c2bc56fd…)  Podcasts → World affairs   (source kept; fresh relation ids)

Ops: create {n} (to_space) + delete {m} (from_space, move only). Voting data untouched.
Reply **go** to write + dry-run.
```

Uses `moveEntity` from `src/entity_ops.ts` (`mode: 'move' | 'copy'`).

---

## Operation: Delete orphan entity (destructive)

Delete an entity that no longer belongs (typo, test entity, abandoned record). **Only safe when nothing points at it.**

### Discovery
For each candidate ID:
1. **System-entity check first** (HARD RULE 12): governance Proposal entities, Space bookkeeping entities, Ranking entities → refuse the candidate outright, log `[SKIP] <id> (system entity)`.
2. Pattern C (its types, values, outgoing relations).
3. Pattern D incoming — count backlinks. Paginate fully.
4. Split incoming edges: **references** (block deletion) vs **Ranking Vote edges** (`19a4cfff…` — do not block, are never deleted/migrated, and remain after deletion by design). **≥1 Ranking Vote ⇒ the entity is RANKED**: it drops out of any bulk/easy-delete bucket and needs an explicit per-entity editor confirmation with the vote count shown (deleting it strands the voters' votes).

### Gate — Backlink check (HARD)
If the candidate has ANY incoming non-vote relations, STOP. Do not generate a delete op. Tell the editor:

> Entity **{name}** (`{id}`) has **{N}** incoming relations (+ {V} Ranking Vote edges, non-blocking, never touched):
> | From | Type |
> |---|---|
> | ... | ... |
>
> Delete would orphan these referrers. Options:
> - **Re-point** these relations to another entity first (specify target), then delete.
> - **Merge** this entity into another (use the merge operation instead of delete).
> - **Force delete** (acknowledged: referrers will be orphaned) — type `force delete {id}` exactly to confirm.

### Gate — Ranked entity (review, not bulk)
Fires when a delete candidate has **≥1 inbound Ranking Vote** (and passed the backlink gate — votes alone don't block). STOP and tell the editor:

> Entity **{name}** (`{id}`) is **ranked** — {V} Ranking Vote(s) from users' Rankings{score, if a Score value exists}. Deleting it strands those votes. Confirm this specific delete with `delete ranked {id}`, or **skip**.

Never fold ranked candidates into a "delete all" approval.

### Plan template
```
## Delete plan
System entities excluded: {S}   Ranked candidates flagged: {M}
[DELETE] {name} ({id}) — 0 blocking backlinks, 0 ranking votes, in space {space}
[DELETE] {name} ({id}) — 0 blocking backlinks; RANKED (2 votes) — editor confirmed `delete ranked` ✓
[SKIP]   {name} ({id}) — has 4 backlinks (gate fired; see above)
[SKIP]   Proposal 00064d73-… ({id}) — system entity (HARD RULE 12)

Will produce: deleteEntity={n}, deleteRelation={m} (outgoing relations cleaned up; Score values and Ranking Vote edges excluded).

Reply **go** to write + dry-run.
```

Uses `Graph.deleteEntity({ id })`. Also emit `deleteRelation` ops for the entity's outgoing relations (use the edge `id`, not `toEntity.id`) — except vote relations (HARD RULE 8). Score values are never unset, even on deletion.

---

## Operation: Find entities without types (read-only)

Untyped entities are leakage from broken publishes. Surface them so the editor can re-type or delete.

### Discovery — there is NO server-side "untyped" filter that works. Paginate + check client-side.

Three "obvious" approaches all fail (details in [`reference.md`](reference.md) gotcha 8): there is **no `types` filter field** (it's `typeIds`); **`typeIds: { isNull: true }` and `entitiesConnection.totalCount` both 504-timeout**; and **`relationsByTypeIdConnection: { none }`** is fast but a **false-positive trap** (returns rows that actually have types). Don't use any of them.

**The only reliable method: paginate the space and check `typeIds.length === 0` client-side** (`8f151ba4de204e3c9cb499ddf96f48f1` is the Types property; an entity with no Types relation has an empty `typeIds`):
```graphql
{ entities(
    first: 500,
    filter: { spaceIds: { anyEqualTo: "<spaceId>" } }
  ) { id name typeIds createdAt } }
```
Page with `after`/cursor (or `offset`) until exhausted; keep only rows where `typeIds` is `[]`. This is read-only and slow on big spaces — log progress per page and write the full list to `scripts/<date>-no-type-export.json`.

Bucket the untyped rows; label each in the output:
- **System entities** (HARD RULE 12) — `Proposal <uuid>` governance entities, `Space <uuid>` bookkeeping entities (Payout/Allocated edges), Ranking entities. **EXCLUDED from the candidate list** — reported as one aggregate count only, never listed row-by-row, never offered for deletion. (Pre-0.5.0 versions of this skill called proposal entities "husks" with default action delete — that guidance is retired; they are protocol data.)
- **Relation entities** — property-bags of live relations (an edge's `entityId`). Structural, untyped by design — excluded from the candidate list.
- **Stubs / unnamed** — named-but-empty or nameless leftovers. Candidates for review/delete once live-verified (0 global backlinks, no ranking votes).
- **Real entities** that just lost their type (e.g. "Kaito AI"). Default action **assign type**.

Reference baseline (crypto-datasets space, paginate-and-check): **193 untyped / 1,827 (~11%)**, mostly system proposal entities plus a few real ones.

### Output template
```
## Entities without types — space {space name}
Scanned (paginated): {N} entities across {pages} pages
Untyped: {U} ({pct}%)  — real: {r}, stubs/unnamed: {s}
System entities excluded: {S} — proposals {p}, space bookkeeping {b}, rankings {rk}
Relation entities excluded (structural): {re}
Ranked candidates flagged: {M}
Full list: scripts/<date>-no-type-export.json

| Name | ID | Space | Class | Ranked (votes) | createdAt |
|---|---|---|---|---|---|
| Kaito AI | … | crypto-datasets | real | 0 | … |
| Old draft topic | … | crypto-datasets | stub | 3 ⚠ review | … |

Decide per-entity: **assign type** (specify type id) / **delete** (use delete-orphan op) / **leave**.
(Ranked rows — votes ≥1 — always land in review, never in a bulk delete.)
```

Read-only — no script written. Hand off to merge / delete / publish as the editor decides.

---

## Operation: Find blank properties (read-only)

Find entities of type T where property P is empty. Useful for backlog work ("every Person needs a Web URL").

### Discovery
List entities of type T (paginate). For each, check `values[].property.id === P` exists with a non-empty value. Report misses.

### Output template
```
## Blank "{property name}" on type "{type name}"
Total entities of type: {N}
Entities missing the property: {M} ({pct}%)

Sample:
| Name | ID | Space |
|---|---|---|
| ... |

Full list written to scripts/<date>-blank-{prop}.json.
```

Read-only. Hand off to a bulk publish op once the editor has source URLs.

---

## Operation: Fix data type (destructive)

A property stored under the wrong SDK type (e.g. "Birth date" published as `text` when it should be `date`). Re-publish under correct type, unset the old.

**Never applies to system value properties** — Score and the vote value properties (`EXCLUDED_VALUE_PROPERTY_IDS`) are system-maintained and off-limits (HARD RULE 8).

### Discovery
1. Identify the property's correct data type (from the type's schema entry — Pattern C on a known-good instance).
2. List entities of type T where the property exists.
3. For each, capture the current (wrong-typed) value as a string, then validate it parses under the target type (e.g. `"1815-12-10"` parses as `date`; `"about 1815"` does NOT).

### Gate — Unparseable values
If any entity's current value can't be cleanly parsed under the target type, STOP and surface a list. Options:
- **Hand-correct each** before retrying.
- **Skip unparseable** and fix only the clean ones.
- **Drop unparseable** (unset, no replacement).

### Plan template
```
## Fix data type — "{property name}": text → date
Affected entities: {N}
Clean (will be re-typed): {M}
Unparseable (gate fired): {U}

Per-entity:
[FIX]  {name} ({id})  "1815-12-10" → date
[SKIP] {name} ({id})  "about 1815" (unparseable)

Reply **go** to write + dry-run.
```

Each entity gets a `Graph.updateEntity({ values: [...], unset: [...] })` op. Batch.

---

## Operation: Find stale relations (read-only)

A relation is stale if its `toEntity.id` no longer exists (target deleted). Surface for cleanup.

### Discovery
For each entity of type T (or across a space), read its relations. For each relation's `toEntity.id`, run a quick existence check (`entity(id: "<id>") { id }`). Collect nulls.

### Output template
```
## Stale relations
Scanned: {N} entities, {R} outgoing relations.
Stale: {S} (target no longer exists).

| From | Relation type | Dangling target id | Edge id |
|---|---|---|---|
| ... |

Reply **go** to write + dry-run a cleanup that deletes the stale edges.
```

Cleanup ops use `Graph.deleteRelation({ id })` with the edge id. Ranking Vote edges are exempt even if their target vanished (HARD RULE 8) — list them separately.

---

## Operation: Find / fix duplicate-type relations

An entity's type is a relation with `typeId = 8f151ba4de204e3c9cb499ddf96f48f1` (the **Types** property) pointing to a type entity. A **duplicate-type relation** is the *same type entity listed two or more times* on one entity — two edges with identical `(fromEntity, typeId=Types, toEntityId)`. The UI then shows the type chip twice. These are publish-skill leakage (a re-run that re-created the type edge instead of skipping it).

Note: `typeIds` on the entity **dedupes**, so a duplicate is invisible there — you must look at the raw type *relations* (edges), not the `typeIds` array. Two edges to the same type → one is redundant.

### Discovery (read-only)
Per space (or per entity), fetch every Types-relation edge and group by `(fromEntityId, toEntityId)`:
```graphql
{ relationsConnection(
    filter: { typeId: { is: "8f151ba4de204e3c9cb499ddf96f48f1" }, spaceId: { is: "<spaceId>" } },
    first: 500
  ) {
    edges { node { id fromEntityId toEntityId toEntity { name } spaceId } }
    pageInfo { hasNextPage endCursor }
  } }
```
Paginate to completion. Any `(fromEntityId, toEntityId)` key with **2+ edges** is a duplicate group; all but one edge are redundant.

Distinguish from the legitimate **multi-type** case: an entity with edges to *different* type entities (e.g. Person **and** Author) is correctly multi-typed — NOT a duplicate. Only same-`toEntityId` repeats are duplicates.

### Output template
```
## Duplicate-type relations — space {space name}
Type edges scanned: {N}
Entities with a duplicated type: {E}

| Entity | ID | Type (listed ×n) | Edge ids | Keep / delete |
|---|---|---|---|---|
| Søren Halberg Vesterby | 0146e0c9… | Person ×2 | aaa…(keep), bbb…(delete) | delete 1 |

Reply **go** to write + dry-run the cleanup (deletes the extra edges, keeps the earliest by createdAt).
```

### Fix (destructive — but low-risk; only removes redundant edges)
For each duplicate group: keep one edge (default: earliest `createdAt`), and `Graph.deleteRelation({ id })` every other edge, routing each delete to its edge's own `spaceId`. No `createRelation` needed — the kept edge already carries the type. Log: `[FIX-DUP-TYPE] {entity} ({id}) — Person listed ×2, deleting edge bbb… (keeping aaa…)`.

After publish, re-query the entity's Types edges and confirm exactly one remains per type.

---

## Operation: Delete space data (mass-destructive, RARE)

Used when wiping a test space. **Never used on a DAO space or someone else's space.**

### Gate — Anchored-entity (HARD, automatic)
Before planning, resolve `getAnchoredEntityIds(spaceId)` and **exclude those entities from the delete set by default** — the space's `page`/home entity + its Avatar (profile photo) + Cover images. These are the space's identity; deleting them empties it even after the rest is repopulated (Aug-2026 incident: profile photo + description lost). The generated script filters every `deleteEntity`/`deleteRelation`/`updateEntity`-unset op against the anchored set and logs `[SKIP] <id> (anchored)`. To ALSO delete the identity (true full teardown), the editor must type a second explicit override — `delete anchored too` — after seeing the anchored list; otherwise anchored entities survive.

### Gate — Explicit confirmation
The editor must type the space NAME exactly, not the ID. Skill computes the name via Pattern C on the space ID and asks:

> About to delete **every non-anchored entity** in space **"{space name}"** ({deletable count} of {entity count}; {A} anchored identity entities — page/avatar/cover — will be kept). This includes ones referenced by other spaces (their incoming relations will go stale).
>
> Type the space name **exactly** to confirm. Anything else cancels.

### Plan template
```
## Delete-space plan
Space: "{name}" ({id})
Will delete: {N} entities, {R} relations.
Anchored entities excluded: {A} (page + avatar + cover) — kept unless "delete anchored too" given.
Voting data (Score values / Rank Votes edges) in the space: left untouched.
Outgoing breakage: {X} relations from OTHER spaces will go stale (those need a follow-up "Find stale relations" pass).

Reply **go** to write + dry-run. (Then type the space name again to **publish**.)
```

Two confirmations: space-name-typed once before Plan, again before publish. The publish run sets `CONFIRM_DESTRUCTIVE=1` (this batch exceeds the >50-destructive-op circuit-breaker in `publishOps`) — **only** on the confirmed `publish`, never the dry-run (HARD RULE 11). If the `publish` arrives >30 min after the dry-run, re-run first (HARD RULE 10).

---

## Required output template — universal scaffold

Every operation emits ONE message in this shape before any Write/Bash:

````
## Operation: {Find duplicates | Merge duplicates | Delete orphan | Move/copy entity | Fix data type | ...}

## Discovery
{operation-specific block: row counts, sampled entities, selection metadata, decisions}

## Gates
- {gate name}: PASS | FIRE — {reason or list}
- {gate name}: PASS | FIRE — {reason or list}

If any gate is FIRE, STOP HERE. Run the gate dialog and wait.

## Plan (only if gates all PASS or were waived)
- Ops: {createEntity=n, createRelation=n, updateEntity=n, deleteRelation=n, deleteEntity=n}
- END STATE (merges): residencies + LEAVES warnings + Root check
- Script path: scripts/<YYYY-MM-DD>-<slug>.ts (will be written AFTER you reply `go`)
- Dry-run command: bun run scripts/<file>.ts (I run this — you will NOT)

Reply **go** to authorize.
````

After `go`, the skill writes + dry-runs, surfaces the log lines (`[MERGE]` / `[DELETE]` / `[SKIP]` / `[FIX]` / `[ESCALATE]`), then waits for `publish` or `stop`.

## Reference — read before writing any script

Deep detail lives in [`reference.md`](reference.md) (bundled with the skill): **script-generation rules** (file naming, `DRY_RUN` default, publish-once, which `src/` helpers to import), the **`mergeEntities` + `selectCanonicalTopic` helper contracts + code template**, the **selection-metadata queries**, the **`validate_migration.ts` workflow**, the **voting-data scrub pass**, the **critical gotchas** (backlink pagination, inline 100-node cap, edge-id ≠ entity-id, `typeIds` dedupe, no working server-side "untyped" filter, …), and **what to do when a publish fails mid-run** (sandbox network allowlist). Consult it before generating any cleanup script.

## What this skill does NOT do

- Skip Discovery, Gates, or Plan to "save time".
- Auto-publish without an explicit `publish` reply (separate from `go`).
- Pick a Main by eyeball — canonical selection is the deterministic cascade (or an explicit editor override), nothing else.
- Merge two scored entities — both-scored groups are escalated, never fused.
- Select a personal-space or dataset-space copy as canonical, or emit ops into those spaces (their copies survive; the editor's OWN personal space on explicit request is the one exception).
- Touch voting/ranking data (Score / Ranking Votes / vote values) — in any operation, ever.
- List or target **system entities** (governance Proposal entities, `Space <uuid>` bookkeeping entities, Ranking entities) as cleanup candidates — they are excluded from every candidate list (HARD RULE 12).
- Treat a **ranked** entity (≥1 inbound Ranking Vote) as bulk-deletable junk — ranked candidates always require per-entity editor review.
- Remove a topic from the Root (Geo) space via a merge. No override exists for this.
- Force-delete entities with backlinks unless the editor typed `force delete {id}` exactly.
- Touch DAO spaces unless the wallet is an editor of that DAO and the editor explicitly named the DAO space; ops for other spaces ship as fix packages, never forced.
- Reimplement merge/selection logic — use `src/` helpers (see [`reference.md`](reference.md)).
