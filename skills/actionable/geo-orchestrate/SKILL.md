---
name: geo-orchestrate
description: Editor-facing entry point for Geo workflows. Translates natural-language intent ("find X and merge into Y", "assign Topics to all Claims about Bitcoin", "publish a podcast episode", "deduplicate Persons", "add Web URL to every Project") into a query plan + a publish plan, generates a runnable script, dry-runs it, confirms with the editor, then publishes. Triggers on "I want to", "find and merge", "deduplicate", "assign", "bulk update", "for all entities of type", "edit Geo", "fix", "clean up", "merge duplicates".
metadata:
  author: geobrowser
  version: 0.1.0
---

# Geo Knowledge Graph — Orchestrator

The skill non-technical editors invoke. It routes between `geo-query` (read) and `geo-publish` (write), and for non-trivial jobs it writes a runnable `.mjs` script in the user's project, dry-runs it, and shows the editor the plan before anything is published.

This is the entry point editors should use. `geo-query` and `geo-publish` are the building blocks the orchestrator calls.

## When to apply

Use this skill when:

- The editor describes an outcome, not a step ("merge these duplicates", "add Web URL to every Person").
- The task involves both reading and writing (most real editor work).
- The task is bulk or repetitive — script generation is justified.
- The editor says "I want to..." or asks "can you...".

Do NOT use this skill if:

- The user is asking a pure question about Geo → call `geo-query` directly.
- The user already has the IDs and just wants to publish one entity → call `geo-publish` directly.

## The orchestrator algorithm

Every job goes through these five steps. Skip them and you will publish wrong data.

**HARD RULES (failure = bug):**
1. Before any `Write` to `scripts/` or any `Bash` running `bun run`, you MUST emit the "Discovery + Gates + Plan" block (template below) as a single message AND wait for the editor to reply "go".
2. The duplicate-candidate search in Step 2 is by **name only, across all types and all spaces**. Never restrict by type — "Bitcoin" the Project is a duplicate of "Bitcoin" the Token for editor-review purposes.
3. "I have everything I need" / "Writing the script" / any equivalent short summary is NOT a substitute for the template. Emit the full template even when everything looks clean.

## Required output template (fill and post BEFORE any Write/Bash)

````
## Discovery
**Schema**
- Type: <name> (`<id>`)
- Properties to set: <name> (`<id>`, dataType=<text|url|date|...>), ...
- Relation types: <name> (`<id>`), ...

**Duplicate candidates** — name-only search across ALL types and ALL spaces:
| Name | ID | Type | Space |
|---|---|---|---|
| ... | ... | ... | ... |
(or: "no candidates found")

**Current state** (for updates only): <list values[] and relations, or "n/a — create only">

**Off-schema delta**: <list properties/relations NOT on the type schema, or "none — all on schema">

## Gates
- **Gate 1 (semantic-duplicate)**: PASS | FIRE — <reason or hits>
- **Gate 2 (schema-violation)**: PASS | FIRE — <reason or off-schema list>

If either gate is FIRE, STOP HERE. Run the gate dialog (see below) and wait for the editor.

## Plan (only if both gates PASS or were waived)
- Target space: <id> (personal | DAO)
- Ops: createEntity=<n>, createRelation=<n>, updateEntity=<n>, deleteRelation=<n>
- Script path: `scripts/<YYYY-MM-DD>-<slug>.ts` (will be written AFTER you reply "go")
- Dry-run: `bun run scripts/<file>.ts` (you run this — I will NOT)

Reply **"go"** to authorize writing the script.
````

### 1. Intent

Restate the editor's request in one short sentence. Ask **one** clarifying question only if the request is genuinely ambiguous about what should change. Resist asking "are you sure?" — that's step 5's job.

### 2. Discover (must produce ALL four outputs below — no exceptions)

Call `geo-query`. Discover is NOT complete until you have produced and shown the editor all four outputs:

1. **Schema** — type ID + property IDs + relation type IDs for every type involved.
2. **Duplicate-candidate list** — for every entity you plan to CREATE, run a name search **by name only, across ALL types and ALL spaces** (`geo-query` Pattern A — no `space` filter, no `type` filter). List every hit with its name, ID, **type**, and space. If zero hits, say "no candidates found". Filtering by the type you're about to create defeats the gate (e.g., searching only Project entities will miss Bitcoin-the-Token, which is still a duplicate concern).
3. **Current state** — for every entity you plan to UPDATE, the existing `values[]` and relations.
4. **Off-schema delta** — for every property and relation type in your planned ops, mark whether it IS or IS NOT on the entity type's declared schema.

**Never guess IDs.** If `geo-query` can't find what you need, stop and tell the editor — don't substitute defaults.

After producing the four outputs, evaluate the gates below. If either fires, STOP and run the dialog with the editor BEFORE writing any script.

**Safeguards aren't side rails — they ARE the product.** Golden rule (from the curator): *before creating or updating anything, verify the exact same thing or something semantically similar does not already exist.*

**Gate 1 — Semantic-duplicate.** Triggers if output #2 (duplicate-candidate list) is non-empty for any planned create. For Claims the rule is **exact meaning only**: rephrasings count, partial overlaps do NOT ("sky is blue" vs "sky is blue because ocean is blue" → not duplicates).

STOP and ask:
> Found an existing entity that may already mean the same thing: **{name}** (`{id}`) in space **{space}**.
> - **Use existing** → I'll skip the create and reuse this ID.
> - **Publish anyway** → confirm these are NOT duplicates and I'll proceed.

**Gate 2 — Schema-violation.** Triggers if output #4 (off-schema delta) lists any property or relation type not on the entity type's schema.

STOP and ask:
> You're about to add property **{property name}** (`{property id}`) to a **{type name}** entity. This property isn't on **{type name}**'s schema.
> Off-schema properties: {list}.
> - **Add to schema first** → I'll generate a schema-update op to extend **{type name}**.
> - **Publish anyway** → the property will land on the entity but won't render in the UI.
> - **Skip the property** → drop it from this publish.

### 3. Plan (MANDATORY — post this message BEFORE writing any script)

You MUST post the confirmation template (bottom of file) as a single message and wait for the editor to reply "go" or to change something. The Plan message lists, in order:

- The **target space(s)** and whether they're personal or DAO.
- The **ops the script will produce**, counted by kind (`createEntity: 0`, `createRelation: 24`, `updateEntity: 47`, `deleteRelation: 3`).
- **Gate results** (semantic-duplicate, schema-violation) — pass / waived / list of hits.
- Anything **uncertain** flagged with `?`.
- The **dry-run command** and the **publish command**, both copy-pasteable.

Do NOT proceed to Step 4 until the editor replies. "Go" authorizes ONE dry-run only.

### 4. Generate (do NOT execute)

ONLY after the editor replied "go" in Step 3: write a `.ts` script in the user's project (`scripts/<date>-<slug>.ts`) with `DRY_RUN = true` at the top.

**You do NOT run the script.** The editor runs `bun run scripts/<file>.ts` themselves. Report the file path and the dry-run command, then stop. Do not call `Bash` to execute it unless the editor explicitly asks ("run it" / "do the dry run for me").

### 5. Confirm + publish

Wait for the editor to reply "go" (or to change something). Only then flip `DRY_RUN` to `false` and re-run. After publishing, surface the transaction hash / proposal ID and the verify URL on `geobrowser.io`.

## Common editor jobs and how to decompose them

### Job — "Find duplicates of type X across all spaces and merge them"

1. **Discover** (`geo-query`): `list_entities({ type: "X", compact: true, limit: 500 })` → group by lowercased name → for each group `get_related_entities({ direction: "incoming" })` to count backlinks → pick Main (most backlinks, then highest-priority space using the SPACES rank from `content-management/src/constants.ts`).
2. **Plan**: "Found N dup groups across M spaces. Will merge them into Mains. Skipping K Property groups due to data-type mismatch."
3. **Generate**: script imports `mergeEntities` from `content-management/src/entity_ops.js`, batches ops with `OpsBatch`, prints op counts, dry-runs.
4. **Confirm + publish**: flip `DRY_RUN`, re-run, show transaction hashes per space.

### Job — "Assign Topics to Claims" (Arturas's example)

1. **Discover** (`geo-query`): `list_entities({ type: "Claim", limit: 500 })` and `list_entities({ type: "Topic", limit: 500 })`.
2. **Reason** (LLM): for each Claim, propose 0–N matching Topics from the list. Bucket matches by confidence (high / medium / low). Surface low-confidence to the editor for review.
3. **Plan**: "Will create N `Topics` relations from Claims to Topics. P matches are low-confidence — drop them or hand-review?"
4. **Generate**: script collects `Graph.createRelation` ops for every accepted `claim → topic` pair into one `allOps` array, publishes once.
5. **Confirm + publish.**

### Job — "Add Web URL to every Person matching {filter}"

1. **Discover** (`geo-query`): `search_entities({ type: "Person", filters: [...] })` → for each, `get_entity` to confirm no existing Web URL.
2. **Plan**: "Will set `ContentIds.WEB_URL_PROPERTY` on N Persons. URLs sourced from {CSV / chat list / scraped}."
3. **Generate**: script uses `Graph.updateEntity({ values: [{ property: WEB_URL, type: "url", value }] })` per entity, all in `allOps`, single publish.
4. **Confirm + publish.**

### Job — "Publish a new podcast episode" (single-entity)

1. **Discover** (`geo-query`): Pattern C schema-discovery query for an existing `Episode` to learn property/relation IDs.
2. **Plan**: standard `geo-publish` plan template (Space / Name / Type / Description).
3. Write a tiny `.ts` in `scripts/` that imports `Graph` from `@geoprotocol/geo-sdk` and `publishOps` from `../src/functions.js`. Even single-entity publishes go through this path — there's no separate CLI shortcut.

### Job — "Delete a list of orphan entities"

1. **Discover** (`geo-query`): for each candidate, `get_entity` + `get_related_entities({ direction: "incoming" })` to confirm zero backlinks.
2. **Plan**: "Will delete N entities. Orphan cleanup ON / OFF?"
3. **Generate**: script imports `deleteEntity` from `content-management/src/entity_ops.js`, uses `OpsBatch`, prints, dry-runs.
4. **Confirm + publish.**

## Script generation rules

When you write a script for the editor:

- **One file, one job.** `scripts/2026-05-08-merge-bitcoin-duplicates.ts`. Date prefix so successful scripts become a pattern library.
- **Top of file: comment block** restating the editor's intent and the discovered data (entity IDs, schema, source spaces). Future-you needs this.
- **TypeScript `.ts`** so it runs with `bun run scripts/<file>.ts`. The repo is set up for Bun (see `bun.lock`); `bun install` once and TypeScript executes natively.
- **`DRY_RUN` constant at top, default `true`.** Same convention as `content-management/03_merge_duplicates.ts`.
- **Collect ALL ops in one array, publish ONCE.** This rule is in `geo-publish`; it bites just as hard from a generated script.
- **Print before publishing.** Either `console.log(allOps.length)` plus a sample of the ops, or write to a `.txt` file via `printOps` (mirror `content-management/src/functions.ts`).
- **Idempotency where it matters.** For relation entities and image attachments, use deterministic IDs (`from.slice(0,16) + to.slice(0,16)`) so reruns don't create duplicates.
- **Reuse, don't reimplement.** Import from `geo-publish`'s vendored SDK and from `content-management/src/` whenever the operation already exists. Don't rewrite `mergeEntities`.

## Confirmation template

Use ONE message for the plan, in this exact shape, then wait for the editor:

> **Plan**
> 1. Read N {type} entities from {space(s)}.
> 2. Generate {M} ops: createEntity={a}, createRelation={b}, updateEntity={c}, deleteRelation={d}.
> 3. Target space: {space} ({personal | DAO}).
> 4. Script written to: `scripts/<file>.ts` (DRY_RUN = true).
>
> **Gates**
> - Semantic-duplicate check: {pass | N hits surfaced above | waived by editor}
> - Schema-violation check: {pass | N off-schema properties surfaced above | waived by editor}
>
> **Dry-run command:**
> ```
> bun run scripts/<file>.ts
> ```
>
> If the dry-run prints what you expect, reply **"go"** and I'll flip DRY_RUN to false and re-run for real.

## Safety rails

- **Run both hard gates before generating ops** (§2a). Semantic-duplicate check + schema-violation check. No skipping; an editor "waive" is explicit, not implicit.
- **Default to dry-run.** Editors must see the op count before anything is published.
- **One confirmation per publish.** "Go" doesn't authorize future runs of the same script.
- **No silent fallbacks.** If a query fails or returns nothing, stop and tell the editor — don't substitute defaults.
- **DAO-space permissions.** If the target is a DAO space and the editor isn't an editor of it, surface the error explicitly. Don't silently downgrade.
- **Don't auto-edit shared state.** Never run a publish without explicit "go", even if a previous run on the same script succeeded.
- **Stop after the first failed transaction.** Don't keep firing `sendTransaction` calls hoping the next one will land.

## Hand-offs

- → `geo-query` for any read.
- → `geo-publish` for the actual op build + transaction submission via `publishOps` from `src/functions.ts`.
- ← when the editor's request is ambiguous, return to the editor with **one** clarifying question, then continue.
- → manual fallback: if the job is too risky for automation (mass deletes, cross-space merges with unclear Mains), point the editor to the matching guide in `content-management/documentation/From Rush/`.

## More

- Building-block skills: `geo-query` (discovery/reads), `geo-publish` (the write path + safeguards).
- Reusable repo logic to import instead of reimplementing: `../../../src/entity_ops.ts` (delete/merge/changeSpace), `../../../src/functions.ts` (`gql`, `publishOps`, `printOps`).
- Worked dup-merge / delete walk-throughs: the editor guides in `../../../documentation/From Rush/`.
- Real generated scripts to copy as patterns: `../../../scripts/` (dated `.ts` files).
