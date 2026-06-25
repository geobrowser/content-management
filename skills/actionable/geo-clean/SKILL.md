---
name: geo-clean
description: Clean the Geo knowledge graph — find and merge duplicates, find entities without types, delete orphans, fix data types, find blank properties, fix stale relations, delete space data. Runs safeguards (orphan check, backlink-based Main selection, dry-run, explicit publish confirmation) before any destructive op. Triggers on "find duplicates", "merge", "deduplicate", "delete orphan", "delete entity", "delete space data", "fix data type", "find blank properties", "fix stale relations", "clean", "cleanup".
metadata:
  version: "0.1.0"
---

# Geo Knowledge Graph — Cleaning

Editor-facing skill for cleaning Geo: finding bad data, merging duplicates, deleting orphans, fixing types. Uses Bun + `@geoprotocol/geo-sdk` locally on the editor's machine. Every destructive op runs through a Discovery + Gates + Plan template, a dry-run, and an explicit `publish` confirmation.

This skill complements the publishing skill (which creates new entities). Both share the same local setup. Works on any host (Claude Code, other desktop agents) that can read files, run bash, and reach the network.

## Prerequisites — verify before first run

1. **`content-management` repo cloned** locally. The skill runs FROM this directory and imports helpers from `src/` (`mergeEntities`, `OpsBatch`, etc.).
2. **Bun installed** (`bun --version` works).
3. **`bun install` already run** (`node_modules/` exists).
4. **`.env` filled in**: `PK_SW=` and `DEMO_SPACE_ID=` set. Never `cat .env` or `grep PK_SW .env` — to verify presence use `test -f .env && grep -q '^PK_SW=' .env && echo ok`.
5. **Network allowlist** (if the host sandboxes outbound traffic) includes `testnet-api.geobrowser.io` plus the publish-time hosts (IPFS gateway, RPC, governance contract resolver). Hosts surface on first failed publish — add as they appear.

If any prerequisite is missing, STOP and ask the editor to fix it. Do not work around.

## HARD RULES (failure = bug)

1. Before any `Write` to `scripts/` or any `bun run`, you MUST emit the operation-specific Discovery + Gates + Plan template (below) and wait for the editor to reply `go`.
2. **Two-phase execution**:
   - After `go`: write the script with `DRY_RUN = true`, run the dry-run yourself, surface the summary to the editor.
   - Ask: *"Output looks right? Type **publish** to apply the cleanup, or **stop** to discard."*
   - On `publish`: flip `DRY_RUN = false`, run again, report the tx hash + space verify URL.
   - On `stop`: do nothing; leave the script for review.
3. **Never auto-execute a destructive op without `publish`.** `go` only authorizes the dry-run.
4. **Logging is mandatory.** Every dry-run prints per-entity decisions: `[MERGE] X (id) ← Y (id), Z (id)` / `[DELETE] X (id, 0 backlinks)` / `[SKIP] X (id, reason)`. No silent ops.
5. **Always use deterministic IDs for relation entities** created during merges: `from.slice(0,16) + to.slice(0,16)`. Reruns must be idempotent.
6. **Additive-only when in doubt.** If a "fix" could be done either by adding new data or by deleting old, prefer adding. Only delete when the user explicitly authorized.

## The operations

Each operation has a dedicated section below with its own Discovery, Gates, and Plan template.

| Operation | Destructive? | Key gate |
|---|---|---|
| Find duplicates | No | — |
| Find entities without types | No | — |
| Find blank properties | No | — |
| Find stale relations | No | — |
| Find duplicate-type relations | No | — |
| Merge duplicates | Yes | Canonical (DAO) wins + is never deleted; then most backlinks |
| Delete orphan | Yes | Must have 0 incoming relations |
| Fix data type | Yes | Old value preserved as comment until publish |
| Fix duplicate-type relations | Yes | Keep exactly one edge per (entity, type) |
| Delete space data | Yes (mass) | Editor types space name to confirm |

---

## Operation: Find duplicates (read-only)

Used standalone OR as the discovery step before a merge. **Two passes** — run Pass 1 always; run Pass 2 when the type is text-heavy (News story, Article, Claim, Event) where exact-name collisions are near-impossible.

### Pass 1 — Exact-name grouping (cheap, deterministic)
Pattern B from `geo-query` (list entities of a type): list entities of the target type (paginate every page, not just the first 50). Group by `name.toLowerCase().trim()`. Surface groups with 2+ members.

Pass 1 works well for **People / Orgs / Projects** (canonical names recur verbatim — "ethereum" published four times). It is **structurally blind to news/article near-duplicates**: two stories about the same event almost never share a byte-identical headline, so Pass 1 returns 0 groups even when genuine same-event dupes exist. Verified: exact-name grouping over 1,087 Crypto News stories → **0 groups**, while ~4 genuine same-event near-dupes were present.

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
| Group | Members | Spaces | Backlinks (each) |
|---|---|---|---|
| "ethereum" | 4 | Crypto, Crypto datasets, AI, PERSONAL | 142, 8, 2, 0 |
| ... |

### Pass 2 — semantic near-dupes ({G2} candidate groups, ADVISORY — confirm each)
| Members (headlines) | Same event? | Confidence | Reason |
|---|---|---|---|
| "Senate advances GENIUS Act in new cloture vote" / "GENIUS Act advances toward final Senate vote" | yes | high | same Senate vote, same bill |
| "Circle secures MiCA license" / "Kraken secures MiCA license" | no | high | template match, different firms — KEEP SEPARATE |

Reply with the group(s) to merge (Pass 1: or "all"; Pass 2: name them explicitly — no "all"). Main = most backlinks.
```

No write happens here. Output is the input for the Merge operation.

---

## Operation: Merge duplicates (destructive)

The most-requested op. Other group members merge INTO the Main and are deleted.

**Main-selection rule (canonical-safe):**
1. **A canonical (DAO-space) entity always wins over a personal one** — it must be the Main, because the loser gets deleted and a canonical entity must never be deleted by an auto-merge.
2. **Within the same class** (all personal, or — rare — disambiguated by the editor), **most incoming backlinks wins.**
3. **Two or more members in DAO spaces → do NOT auto-merge** (see the Canonical-Delete gate). The `mergeEntities` helper enforces this: it throws unless a non-PERSONAL secondary is explicitly waived with `allowCanonicalDelete`.

### Discovery (mandatory before Plan)

For every group the editor selected:

1. **List every member** (id, name, space, types).
2. **Count backlinks per member, paginated to completion.** Query `relations(filter: { toEntity: { id: { is: "<id>" } } })` with `first: 50` and cursor-paginate by last `createdAt` until a page returns fewer rows than `first`. **Do NOT stop at page 1.** Record the total page count alongside the row count.
3. **Record each member's space type** (`spaces(filter: { id: { in: [...] } }) { id type }` — `DAO` = canonical, `PERSONAL` = personal). This drives Main selection and the Canonical-Delete gate.
4. **Designate Main** per the canonical-safe rule above: any DAO member wins; otherwise most backlinks. (Two+ DAO members → stop, don't pick a Main.)
5. **Inventory each non-Main member's values + outgoing relations** — these will be ported to Main.
6. **Bucket the resulting ops by target space.** Each backlink op writes to the backlink's source space, not Main's space. A merge that touches Podcasts, Crypto, and PERSONAL becomes three separate transactions / governance proposals.

### Gate — Canonical-Delete (HARD STOP)

Fires if **the would-be loser is in a DAO (canonical) space** — i.e. two+ members are in DAO spaces, or the only canonical member isn't the one with the most backlinks. A canonical entity must never be deleted by an auto-merge (this is the case that can nuke a canonical space).

STOP and tell the editor:

> Group **"{name}"** can't be auto-merged — it would delete a **canonical** entity:
> | Member | Space | Type | Backlinks |
> |---|---|---|---|
> | … | … | DAO / PERSONAL | … |
>
> A canonical (DAO) entity must stay. Options:
> - **One canonical + personal copies** → make the canonical entity the Main and merge the personal copies into it (safe). Reply **go** with that Main.
> - **Two+ canonical duplicates** (e.g. two topics in the same DAO space) → this needs DAO **governance / the manual procedure**, not the auto-helper. Reply **skip**, or **force canonical-merge** to override (sets `allowCanonicalDelete` — you accept that a canonical entity will be deleted and will verify backlink migration yourself).

The `mergeEntities` helper backstops this gate: it refuses any non-PERSONAL secondary unless `allowCanonicalDelete: true` is passed.

### Gate — Big-Merge (HARD STOP)

Fires if **any single member has > 100 incoming backlinks** OR **the total planned ops > 200**.

Big merges have historically lost rows (Armando AI/Tech case, 2026-05-29: 216 deletes vs 107 creates because backlinks weren't paginated to completion). Even with the pagination fix in place, large merges produce huge cross-space governance proposals and are hard to roll back.

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
> | Space | createRelation | updateEntity | deleteRelation | deleteEntity |
> |---|---|---|---|---|
> | Crypto | 12 | 1 | 0 | 0 |
> | Podcasts | 94 | 0 | 94 | 0 |
> | PERSONAL | 1 | 0 | 0 | 1 |
>
> Each non-personal space becomes its own DAO governance proposal. The Podcasts proposal in particular will churn the podcast app's topic links for **{N}** episodes.
>
> Reply **go** to proceed across all spaces, or name spaces to exclude (e.g. `exclude Podcasts` — those backlinks stay pointing at the duplicate).

### Gate — Backlink-Pagination-Confirmation

Discovery must surface, per member:

```
Backlinks paginated to completion: YES (253 rows fetched across 6 pages of 50)
```

If the helper returns a count without a page-count breakdown, the gate fires:

> Backlink pagination for **{name}** ({id}) could not be confirmed as complete. The helper returned **{N}** rows but did not report page count. Refusing to proceed — under-migration risk. Update the helper or run the manual procedure.

### Gate — Main selection
If the Main is unclear (tied backlink counts, OR Main has 0 backlinks like every other member, OR Main is in a low-priority space), STOP and ask:

> Main is ambiguous for group **"{name}"**:
> | Candidate | ID | Space | Backlinks |
> |---|---|---|---|
> | ... | ... | ... | ... |
>
> Which entity should be Main? Reply with the id, or **skip** to leave this group untouched.

### Gate — Data-type mismatch
If members have different data-type assignments for the same property name (e.g. one stores "Birth date" as `text`, another as `date`), STOP and ask which type wins. Don't silently coerce.

### Plan template

```
## Merge plan — type {type name}
Groups: {G}
Pagination: all members confirmed paginated to completion ✓

Per-space ops:
| Space | createRelation | updateEntity | deleteRelation | deleteEntity |
|---|---|---|---|---|
| Crypto | 12 | 1 | 0 | 1 |
| Podcasts | 94 | 0 | 94 | 0 |

Duplicate handling: DELETE the duplicate entity after migration (default).
(Reply `keep duplicate as ghost` before `go` to leave the duplicate as a nameless husk instead — only do this if you need to preserve the ID for an external system.)

Per-group decisions:
[MERGE] "ethereum"  Main: 4cd3dcb0… (Crypto, 142 backlinks, 3 pages)
        ← 8bd19463… (Crypto datasets, 8 backlinks, 1 page) → DELETE
        ← 61bc9cb3… (AI, 2 backlinks, 1 page) → DELETE
        ← a54bc45b… (PERSONAL, 0 backlinks, 1 page) → DELETE
[SKIP]  "bitcoin"   reason: ambiguous Main (tie 14 / 14)
[SKIP]  "ai"        reason: Big-Merge gate (253 backlinks > 100)

Reply **go** to write + dry-run the script. (Then **publish** to actually merge.)
```

### Execution

Use `mergeEntities` from `src/entity_ops.ts` (battle-tested) — it re-points backlinks (paginated to completion), ports unique values + outgoing relations to Main, strips the member, and emits a protocol-level `deleteEntity`. Batch ops via `OpsBatch`. **Always pass `summaryOut: new Map()`** so the helper fills per-space op counts for the Cross-Space-Impact gate. Full helper contract + the code template: see [`reference.md`](reference.md).

After publish, report per-space tx hashes AND the post-merge backlink count on Main. Editor sanity-checks that Main's new backlink total ≈ the pre-merge sum (canonical + duplicates' migrated backlinks). A meaningful gap is a red flag for under-migration — investigate before approving the next merge.

---

## Operation: Delete orphan entity (destructive)

Delete an entity that no longer belongs (typo, test entity, abandoned record). **Only safe when nothing points at it.**

### Discovery
For each candidate ID:
1. Pattern C (its types, values, outgoing relations).
2. Pattern D incoming — count backlinks. Paginate fully.

### Gate — Backlink check (HARD)
If the candidate has ANY incoming relations, STOP. Do not generate a delete op. Tell the editor:

> Entity **{name}** (`{id}`) has **{N}** incoming relations:
> | From | Type |
> |---|---|
> | ... | ... |
>
> Delete would orphan these referrers. Options:
> - **Re-point** these relations to another entity first (specify target), then delete.
> - **Merge** this entity into another (use the merge operation instead of delete).
> - **Force delete** (acknowledged: referrers will be orphaned) — type `force delete {id}` exactly to confirm.

### Plan template
```
## Delete plan
[DELETE] {name} ({id}) — 0 backlinks, in space {space}
[SKIP]   {name} ({id}) — has 4 backlinks (gate fired; see above)

Will produce: deleteEntity={n}, deleteRelation={m} (outgoing relations cleaned up).

Reply **go** to write + dry-run.
```

Uses `Graph.deleteEntity({ id })`. Also emit `deleteRelation` ops for the entity's outgoing relations (use the edge `id`, not `toEntity.id`).

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

Two flavours of untyped show up; label them in the output:
- **Husks** — names like `Proposal <uuid>`. Almost always broken-publish leakage; default action **delete** (via delete-orphan op).
- **Real entities** that just lost their type (e.g. "Kaito AI"). Default action **assign type**.

Reference baseline (crypto-datasets space, paginate-and-check): **193 untyped / 1,827 (~11%)**, mostly husks plus a few real ones.

### Output template
```
## Entities without types — space {space name}
Scanned (paginated): {N} entities across {pages} pages
Untyped: {U} ({pct}%)  — husks: {h}, real: {r}
Full list: scripts/<date>-no-type-export.json

| Name | ID | Space | Husk? | createdAt |
|---|---|---|---|---|
| Proposal 00064d73-… | 00064d73… | crypto-datasets | husk | … |
| Kaito AI | … | crypto-datasets | real | … |

Decide per-entity: **assign type** (specify type id) / **delete** (use delete-orphan op) / **leave**.
(Or: "delete all husks" / "assign {type id} to all real ones".)
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

Cleanup ops use `Graph.deleteRelation({ id })` with the edge id.

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

### Gate — Explicit confirmation
The editor must type the space NAME exactly, not the ID. Skill computes the name via Pattern C on the space ID and asks:

> About to delete **every entity** in space **"{space name}"** ({entity count} entities). This includes ALL entities authored to that space, including ones referenced by other spaces (their incoming relations from other spaces will go stale).
>
> Type the space name **exactly** to confirm. Anything else cancels.

### Plan template
```
## Delete-space plan
Space: "{name}" ({id})
Will delete: {N} entities, {R} relations.
Outgoing breakage: {X} relations from OTHER spaces will go stale (those need a follow-up "Find stale relations" pass).

Reply **go** to write + dry-run. (Then type the space name again to **publish**.)
```

Two confirmations: space-name-typed once before Plan, again before publish.

---

## Required output template — universal scaffold

Every operation emits ONE message in this shape before any Write/Bash:

````
## Operation: {Find duplicates | Merge duplicates | Delete orphan | Fix data type | ...}

## Discovery
{operation-specific block: row counts, sampled entities, decisions}

## Gates
- {gate name}: PASS | FIRE — {reason or list}
- {gate name}: PASS | FIRE — {reason or list}

If any gate is FIRE, STOP HERE. Run the gate dialog and wait.

## Plan (only if gates all PASS or were waived)
- Ops: {createEntity=n, createRelation=n, updateEntity=n, deleteRelation=n, deleteEntity=n}
- Script path: scripts/<YYYY-MM-DD>-<slug>.ts (will be written AFTER you reply `go`)
- Dry-run command: bun run scripts/<file>.ts (I run this — you will NOT)

Reply **go** to authorize.
````

After `go`, the skill writes + dry-runs, surfaces the log lines (`[MERGE]` / `[DELETE]` / `[SKIP]` / `[FIX]`), then waits for `publish` or `stop`.

## Reference — read before writing any script

Deep detail lives in [`reference.md`](reference.md) (bundled with the skill): **script-generation rules** (file naming, `DRY_RUN` default, publish-once, which `src/` helpers to import), the **`mergeEntities` helper contract + code template**, the **critical gotchas** (backlink pagination, edge-id ≠ entity-id, `typeIds` dedupe, no working server-side "untyped" filter, …), and **what to do when a publish fails mid-run** (sandbox network allowlist). Consult it before generating any cleanup script.

## What this skill does NOT do

- Skip Discovery, Gates, or Plan to "save time".
- Auto-publish without an explicit `publish` reply (separate from `go`).
- Force-delete entities with backlinks unless the editor typed `force delete {id}` exactly.
- Touch DAO spaces unless the wallet is an editor of that DAO and the editor explicitly named the DAO space.
- Reimplement merge/delete logic — use `src/` helpers (see [`reference.md`](reference.md)).
