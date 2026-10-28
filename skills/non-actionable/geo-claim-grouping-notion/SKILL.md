---
name: geo-claim-grouping-notion
description: Write claim-grouping results into a Notion Claims mirror as review columns instead of Geo proposals. Runs geo-claim-grouping's discovery and adjudication unmodified — scoped to the claims that are in the mirror — then fills five self-relation columns on the Claims database (Proposed exact duplicates, Proposed semantic duplicates, Proposed related claims, Proposed supporting / opposing arguments) plus Proposed grouping notes with a hyperlinked line per counterpart. Read-only on Geo; it never publishes. Use when an editor wants exact duplicates, semantic duplicates, related, supporting or opposing claims proposed in Notion for review, when a Claims mirror needs grouping columns, or as the step after geo-mirror. Triggers on "claim grouping to Notion", "write claim groups into Notion", "propose exact or semantic duplicates and related claims in the Claims database", "grouping review columns", "notion claim grouping". Not for publishing to Geo (geo-claim-grouping) or building the mirror (geo-mirror).
metadata:
  version: "0.2.0"
  author: mantas
---

# geo-claim-grouping → Notion

geo-claim-grouping finds and adjudicates claim pairs, then publishes `createRelation` ops to Geo.
This skill keeps its discovery and adjudication **unchanged** and swaps the destination: the
results land in the **Notion Claims mirror** as review columns, where an editor can prune,
annotate and decide before anything reaches Geo. Nothing here writes to Geo — there is no ops
script, no `publishOps`, no wallet key.

**Scope in this version:** candidates come from the same Geo space as the mirror, and **both sides
of every pair must be rows of the target database** (the mirror holds only Debate/Featured claims,
so most raw candidates are dropped by the scope step). Cross-space and off-mirror counterparts are
a later increment (a pairs database) — see "What this skill does NOT do".

## What it writes

Six columns on the Claims database, created on first publish, owned exclusively by this skill.
The full contract — direction rules, notes grammar, merge semantics, file formats, exit codes — is
in `references/column-contract.md`; read it before changing the sink.

| Column | Filled from | Becomes on Geo |
|---|---|---|
| `Proposed related claims` | step-1 decisions: every verdict except NOT-SIMILAR (both rows) | Related claims `504e5776…` |
| `Proposed exact duplicates` | bracket DUPLICATE (both rows) + exact-name clusters as a star: canonical ↔ each copy | Duplicate claims `982866bf…` |
| `Proposed semantic duplicates` | bracket SIMILAR (both rows) | Similar claims `e81750db…` |
| `Proposed supporting arguments` | bracket SUPPORTS — on the **supported** claim's row, listing the supporter | Supporting arguments `1dc6a843…` |
| `Proposed opposing arguments` | bracket OPPOSES — mutual → both rows; one-sided → on the **rebutted** claim's row | Opposing arguments `4e6ec5d1…` |
| `Proposed grouping notes` | one line per counterpart: `[Tag · confidence] <name → Geo URL> — reason`, plus `already on Geo` and `editor call` lines | — |

The relation columns are one-way self-relations, so symmetric brackets are written on both rows
explicitly. Only `high` confidence reaches a relation column (`--floor medium` widens it); lower
confidence gets a notes line tagged `editor call`. A direction that already exists on Geo is never
proposed again — it becomes an `[already on Geo · …]` note.

The skill is **schema-agnostic**: any Claims database with a title column and a `Geo ID`
rich_text column works — geo-mirror's `Geo Claim — <space>` tables and the editor's hand-built
`<Space> claims` mirrors alike. Every other column (`Geo …`, `* new`, `Proposed Topics`,
`Proposed rename`, `QA flag`, …) is never read for writing and never sent in a request.

**Schema-agnostic is not type-agnostic.** `roster-from-notion.mjs` re-resolves every id it keeps
against Geo and refuses the run (exit 2) unless all of them are `Claim`. Without that check a
Topics mirror once produced a clean 70-id "claims" roster that every later step trusted. Pass
`--type <32hex>` to roster a different type deliberately, or `--skip-type-check` when offline.

## When to use / when not

- **Use** when the editor wants claim groups proposed in Notion for review, when a Claims mirror
  should carry grouping columns, or right after a mirror refresh.
- **Not for publishing to Geo.** Approved pairs go to Geo through geo-claim-grouping's own ops
  path (its Stage C/D) — hand off, never improvise a publish here.
- **Not for building or refreshing the mirror** (geo-mirror or the editor's refresh scripts) and
  **not for merging duplicates** (geo-clean owns merges; a `Proposed exact duplicates` entry is a
  link proposal, not a merge).

## Prerequisites

- A Claims mirror database shared with the Notion integration, with a title column and a
  `Geo ID` rich_text column (a `Geo URL` column is used for links and to infer the space).
- `NOTION_TOKEN` in `.env` (scripts load it with `--env-file`; it is never printed).
- `node_modules` installed (`npm ci` or `bun install`) — the discovery script imports the Geo SDK
  through `src/functions.ts`. Node ≥ 22 runs that `.ts` file directly (type stripping); `bun run
  --env-file=.env` works too.
- Run everything from the repo root: the parent's discovery resolves `../../../../src/functions.ts`
  from its own folder.

## NOTION gates (run BEFORE any Notion write)

Same contract as geo-mirror:

1. **Token present** — check without reading the value:
   ```bash
   grep -q '^NOTION_TOKEN=' .env && echo ok || echo "missing — add NOTION_TOKEN=ntn_... to .env"
   ```
2. **Connection confirmed** — `curl -s -o /dev/null -w '%{http_code}' https://api.notion.com/v1/users/me -H "Authorization: Bearer $NOTION_TOKEN" -H 'Notion-Version: 2022-06-28'` must print `200`, and the database must be **connected to the integration** (Notion → database → ⋯ → Connections). A 404 that names the integration means it is not shared; nothing is missing.
3. **Scope echoed** — before the sink runs, state the database id + title, the row count, the
   Geo space id, the campaign dir, `--floor` and additive/prune mode, and get the editor's
   confirmation.

## HARD RULES (failure = bug)

1. **Never writes Geo.** No SDK import, no ops script, no key. Discovery and the edge pull are
   read-only GraphQL. A request to "publish these to Geo" is routed to geo-claim-grouping.
2. **Only the six columns it owns.** The sink creates a missing column, never re-types an
   existing one (a name clash with another type stops the run), and never sends any other
   property. `Geo …`, `* new`, `Proposed Topics/Tags/rename` and QA columns are untouched by
   construction.
3. **Both sides in the roster.** Every proposed pair joins two rows of the target database;
   `scope-candidates.mjs` drops the rest and reports why.
4. **Never propose what is already on Geo in that direction.** `existing-edges.json` is required;
   `--allow-no-geo-check` exists only for offline fixtures and prints a loud warning.
5. **Geo direction semantics, copied from the parent's ops template.** Supporter on the supported
   row; rebutter on the rebutted row; mutual opposition on both; exact and semantic duplicates on both;
   exact-name clusters as a star to the canonical (lowest id), never a full mesh.
6. **Decisions come from files, never transcribed.** The sink reads `decisions.json` /
   `brackets.json` / `clusters.json` at runtime — the parent's HARD RULE 5 applies unchanged.
7. **Two-phase.** Dry-run first, post the six-section report, wait for the literal reply
   `publish`; `--publish` ends with a read-back that must report **0 remaining differences**.
8. **Additive by default.** `--prune` (this campaign only) removes earlier proposals, hand edits
   and proposals since published to Geo — every removal is printed; use it only on request.
9. **Full ids + geobrowser links** in every editor-facing line; never truncated ids.
10. **Podcasts claims are never grouped** — inherited from the parent's discovery (HARD RULE 12
    there): dual-resident claims are dropped at export and never reach the roster.

## Run it — six steps

Campaign dirs live under `scripts/<YYYY-MM-DD>-claim-grouping-notion-<slug>/` and are never
committed. Placeholders: `<DB>` = Claims database id or URL, `<C>` = campaign dir.

**1 · Roster from the mirror** (read-only; `ids` is the `--scope-file` shape):
```bash
node --env-file=.env skills/non-actionable/geo-claim-grouping-notion/scripts/roster-from-notion.mjs --db <DB> --out <C>/roster.json
```
It prints rows read, ids kept, the space, the **type check** (`N/N are type …`), duplicate Geo IDs
(excluded) and rows without an id. The type check is a read-only Geo call — no wallet, no env — and
its result is recorded in `roster.json` under `typeCheck`.

**2 · Discovery — geo-claim-grouping's script, unmodified, scoped** (read-only on Geo):
```bash
node --env-file=.env skills/actionable/geo-claim-grouping/scripts/discover_candidates.ts \
  --space <spaceId from roster.json> --scope-file <C>/roster.json --cap 2000 --no-semantic --out <C>
```
`--scope-file` keeps every pair that touches **any** roster claim, so the counterpart can be any
claim in the space — hence the high cap and step 3. If `summary.json` says `capped: true`, re-run
with `--resume --cap <pairsConsidered>`.

Semantic recall (drop `--no-semantic`, add `--resume`) costs ~6–8.5 s per roster claim (~40 min for
250) and is bounded to `--space` plus any `--pool` spaces. **On a debate-style space it is not
optional.** Where a space has no News stories and about one source per claim, both structural
admission branches are dead, and text overlap cannot admit a semantic duplicate by construction —
a 272-claim run went from **9 candidate pairs to 271**, surfacing 11 real semantic duplicates every
one of which sat below the Jaccard floor. On news-driven spaces the structural path already carries
most of the recall and the second pass matters less.

**3 · Scope to the roster** (pure file transform):
```bash
node skills/non-actionable/geo-claim-grouping-notion/scripts/scope-candidates.mjs --candidates <C>/candidates.json --roster <C>/roster.json --top 80
```
**`--top` defaults to 80 and samples.** With more kept pairs than the cap it prints `CAPPED` and
proceeds, so the adjudication becomes a sample rather than a pass. Set `--top` above the kept-pair
count, or accept it knowingly — the sink surfaces a capped scope in its **Needs your eyes** section
so a partial adjudication cannot read as a complete one.
Writes `<C>/candidates.scoped.json` — the file to adjudicate — and reports what was dropped
(both sides off, same-space-not-in-mirror, other space), the surviving exact-name clusters and any
`scope.missing` ids (roster claims the Geo corpus did not contain).

**4 · Adjudicate — exactly as geo-claim-grouping does.** Read the parent's rubric
([`../../actionable/geo-claim-grouping/references/adjudication-rubric.md`](../../actionable/geo-claim-grouping/references/adjudication-rubric.md)),
adjudicate every pair in `candidates.scoped.json`, and write
`<C>/decisions.json` (step 1) and `<C>/brackets.json` (step 2) in the parent's schemas, with the
usual byproducts. **Stop before the parent's Stage C** (no template, no `go`, no ops script).

**5 · Edges already on Geo, then dry-run the sink:**
```bash
node skills/non-actionable/geo-claim-grouping-notion/scripts/existing-edges-from-geo.mjs --roster <C>/roster.json
node --env-file=.env skills/non-actionable/geo-claim-grouping-notion/scripts/write-grouping-to-notion.mjs --db <DB> --campaign <C> --roster <C>/roster.json
```
Post the report (below) and ask: *"Reply **publish** to write these columns to `<DB title>`, or
**stop**."* Nothing has been written yet.

**6 · Publish and read back** (only after the editor replied `publish`):
```bash
node --env-file=.env skills/non-actionable/geo-claim-grouping-notion/scripts/write-grouping-to-notion.mjs --db <DB> --campaign <C> --roster <C>/roster.json --publish
```
Creates the missing columns, patches only the rows that change, re-reads every planned row and
prints `read-back: N rows checked, 0 remaining differences ✓`. Hand the editor the database link
and `<C>/grouping-notion.publish.json`. An immediate re-run reports `0 rows change`.

## The dry-run report

Always six sections, empty ones kept — a section that vanishes hides a failure:

```
DRY RUN — geo-claim-grouping-notion → "<title>" (<id>)
1 Inputs      roster N ids (space, fetched) · decisions.json n · brackets.json n · clusters · existing-edges [per property] · floor · mode
2 Schema      title column · Geo ID ok · columns present [...] · TO CREATE [...]
3 Proposals   per column: pairs in → row entries · skipped by reason · already on Geo per direction
4 Rows        first 10 changed rows + EVERY row with a removal: +adds / −removes per column, with names and Geo links
5 Write plan  schema PATCH + row PATCHes · estimated time · first 5 writes
6 ⚠ Needs your eyes   scope.missing · brackets without a Related decision · pairs outside the roster · stale existing-edges · duplicate Geo IDs · pre-existing columns · prune removals
```
Section 6 is the point of the report: it lists everything the agent inferred, dropped or could
not verify. Never leave it empty to look clean — it prints `nothing` only when there is nothing.

## What this skill does NOT do

- **Publish to Geo.** Approved pairs go through geo-claim-grouping's Stage C/D; a future
  increment can seed that from the Notion columns.
- **Cross-space or off-mirror pairs.** They need a pairs database (planned); today they are
  dropped at step 3 and counted.
- **Views.** The Notion API cannot create views, grouping or tabs — add a "Grouping review" view
  once by hand; re-runs keep it.
- **Merges.** A duplicate proposal is a link, not a merge (geo-clean).

## Gotchas

- **Already-Related pairs never reach candidates.** Discovery drops pairs that are already in
  the Root Related grouping before the cap, so a step-2 bracket for a pair whose Related edge is
  live on Geo needs `existing-edges.json` as its pair source — a follow-up script.
- **`signals.alreadyRelatedClaims` in `candidates.json` is the legacy Crypto property**, not Root
  Related. Only `existing-edges.json` answers "is this already on Geo".
- **Relation values longer than 25 items** come back truncated from the query endpoint; the sink
  pages the property endpoint so the diff never compares a truncated list.
- **Notes are capped** at 100 rich_text objects (33 lines + an overflow marker); each object at
  1,900 characters.
- **An unmapped space is cosmetic in discovery** (log labels show the first 8 hex chars; the
  default `--out` would too) — always pass `--out`.
- **The roster is a snapshot.** A row added to the mirror after step 1 is unknown to the sink and
  listed under "roster rows missing" only if it disappeared; re-run step 1 after a mirror refresh.
- **Python on this machine:** `python3` may resolve to the Windows Store stub; use `python` for
  `skill-dev/skill_versions.py` and `check_skill.py`.

## More / hand-offs

- geo-claim-grouping — discovery script, rubric, decisions/brackets schemas, the Geo publish path:
  [`../../actionable/geo-claim-grouping/SKILL.md`](../../actionable/geo-claim-grouping/SKILL.md),
  [`../../actionable/geo-claim-grouping/references/adjudication-rubric.md`](../../actionable/geo-claim-grouping/references/adjudication-rubric.md),
  [`../../actionable/geo-claim-grouping/references/ops-script-template.md`](../../actionable/geo-claim-grouping/references/ops-script-template.md)
- geo-mirror — building the mirror, the Notion gates, `bulk-set-property.mjs`:
  [`../../actionable/geo-mirror/SKILL.md`](../../actionable/geo-mirror/SKILL.md)
- geo-clean — merging duplicates: [`../../actionable/geo-clean/SKILL.md`](../../actionable/geo-clean/SKILL.md)
- Bundled: `references/column-contract.md` (the contract), `scripts/roster-from-notion.mjs`,
  `scripts/scope-candidates.mjs`, `scripts/existing-edges-from-geo.mjs`,
  `scripts/write-grouping-to-notion.mjs` (each prints `--help`).
