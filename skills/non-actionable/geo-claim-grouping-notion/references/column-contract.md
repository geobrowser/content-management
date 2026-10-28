# Column contract, direction rules and file formats

Everything the sink (`scripts/write-grouping-to-notion.mjs`) reads and writes, so a reviewer can
predict a row from the campaign files without running anything.

## Contents
- The six columns
- Direction rules (which row lists whom)
- Notes line grammar
- Merge semantics (additive vs `--prune`)
- Input files the sink reads
- Run record (`grouping-notion.*.json`)
- The dry-run report, section by section
- Exit codes

## The six columns

All five relation columns are **self-relations on the Claims database**, created as
`single_property` (one-way) — symmetric brackets are therefore written on **both** rows
explicitly. The notes column is `rich_text`. The sink creates a missing column, never re-types
an existing one (a name clash with another type is a hard stop).

| Column | Fed by | Becomes on Geo (property id) |
|---|---|---|
| `Proposed related claims` | step-1 `decisions.json` — every verdict except `NOT-SIMILAR` / `EXCLUDED-SPACE`, `approved` not false, not `dedupSuppressed` | Related claims `504e5776788844f6a77dba3ee811d8f0` |
| `Proposed exact duplicates` | step-2 bracket `DUPLICATE` + exact-name clusters (star topology) | Duplicate claims `982866bf8ae94afe8cce8b805713e4af` |
| `Proposed semantic duplicates` | step-2 bracket `SIMILAR` | Similar claims `e81750db3f09440cab9dd01808a43ccb` |
| `Proposed supporting arguments` | step-2 bracket `SUPPORTS` | Supporting arguments `1dc6a843458848198e7a6e672268f811` |
| `Proposed opposing arguments` | step-2 bracket `OPPOSES` | Opposing arguments `4e6ec5d14292498a84e5f607ca1a08ce` |
| `Proposed grouping notes` | every line above, plus skips and editor calls | — (review only) |

Only `confidence: high` reaches a relation column by default (`--floor medium` widens it).
Lower-confidence pairs get a notes line tagged `editor call` and nothing else.

## Direction rules (which row lists whom)

Copied from geo-claim-grouping's step-2 ops template so the Notion columns predict the Geo edges
one-to-one.

| Bracket | Rows written | Tag in notes |
|---|---|---|
| `DUPLICATE`, `SIMILAR` | both rows list each other | `Exact duplicate`, `Semantic duplicate` |
| exact-name cluster | canonical row lists every copy; each copy lists the canonical (never a full mesh). Canonical = the `canonical` field if it is a roster member, else the lowest id | `Exact duplicate · same name` |
| `SUPPORTS` | the **supported** claim's row lists the supporter (`supported: "b"` → b's row lists a). One edge only, as in the ops template | `Supported by` |
| `OPPOSES`, `mutual: true` | both rows list each other | `Opposes` |
| `OPPOSES`, one-sided | the **rebutted** claim's row lists the rebutter (`rebutted: "a"` → a's row lists b) | `Opposed by` |
| `RELATED-ONLY`, `dedupSuppressed` | nothing (the step-1 Related entry already covers the pair) | — |

A direction whose edge already exists on Geo (per `existing-edges.json`) is **not** proposed; it
becomes an `[already on Geo · <Label>]` notes line instead.

## Notes line grammar

One line per counterpart, three rich_text objects so the name stays a hyperlink:

```
[<Tag> · <confidence>] <counterpart name → its Geo URL> — <reason>\n
```

Tag ordering in the column: same-name exact duplicate, Exact duplicate, Semantic duplicate, Supported by, Opposes,
Opposed by, Related, then editor calls, then already-on-Geo lines; ties by counterpart name.
Notion caps a rich_text value at 100 objects, so at most 33 lines are written followed by one
`… +N more (see the relation columns)` object. Each object is clipped to 1,900 characters.

## Merge semantics (additive vs `--prune`)

- **Additive (default):** relation = current ∪ campaign; notes = current lines whose counterpart
  (parsed from the line's Geo link) is *not* touched by this campaign, plus the campaign's lines.
  Hand-added values and earlier campaigns survive. Relation values that point at pages outside the
  roster are kept and listed under "Needs your eyes".
- **`--prune`:** every row in the database gets exactly this campaign's values (possibly empty).
  Earlier campaigns, hand edits and proposals since published to Geo are removed — each removal
  is printed as a `⚠ REMOVAL` line. Off by default for that reason.

Rows are matched by the `Geo ID` column (configurable through the roster's `geoIdProperty`);
rows sharing a Geo ID are skipped and reported. Relation values longer than 25 items are read
through the page-property endpoint so the diff never compares a truncated list.

## Input files the sink reads

All from `--campaign`, all produced by geo-claim-grouping's Stage A/B or this skill's scripts:

| File | Required | Shape |
|---|---|---|
| `roster.json` (`--roster`) | yes | `{ db, dbTitle, titleProperty, geoIdProperty, space, fetchedAt, ids: [], rows: { <geoId>: { pageId, name, url } }, duplicates: [] }` |
| `existing-edges.json` (`--existing`) | yes unless `--allow-no-geo-check` | `{ generatedAt, counts: { <prop>: { scanned, kept, pages, truncated } }, edges: { related|duplicate|similar|supporting|opposing: [ { edgeId, from, to, spaceId } ] } }` |
| `decisions.json` | one of these three | geo-claim-grouping step-1 schema: `{ adjudicatedAt, decisions: [ { pairKey, a{id,name,space}, b{…}, verdict, confidence, reason, approved } ] }` |
| `brackets.json` | one of these three | geo-claim-grouping step-2 schema: `{ adjudicatedAt, rows: [ { pairKey, a, b, bracket, supported, mutual, rebutted, dedupSuppressed, representative, confidence, reason } ] }` |
| `clusters.json` | one of these three | `[ { ids: [], canonical?, name? } ]` or `{ clusters: [ … ] }` — geo-claim-grouping defines no schema for this file, so only this shape is accepted |
| `candidates.scoped.json` | optional | fallback source of `exactNameClusters` when `clusters.json` is absent; its `scope.missing` is surfaced |

`existing-edges.json` older than 24 hours is flagged — Geo changes daily.

## Run record (`grouping-notion.*.json`)

Written to the campaign dir on every run: `grouping-notion.dryrun.json` or
`grouping-notion.publish.json`.

```
{ runAt, mode: "dry-run" | "publish", db: { id, title }, campaign, floor, prune,
  inputs: { roster, decisions, brackets, clusters, existing },
  schema: { titleProperty, geoIdProperty, present: [], toCreate: [], geoProperties },
  proposals: { pairsIn: { <prop>: n }, rowEntries: { <prop>: n }, skipped: { … } },
  counts: { rowsInDb, rowsUnchanged, rowsToWrite },
  rows: [ { geoId, pageId, name, url, changes: { <prop>: { add: [geoId], remove: [geoId] }, notes: { lines, kept } } } ],
  needsEyes: { … },
  readBack?: { checked, remaining, mismatches: [], failures: [] } }
```

## The dry-run report, section by section

Always printed, all six sections, empty ones kept (a section that vanishes hides a failure):

1. **Inputs** — roster size/space/fetch time, each campaign file with its count and
   `adjudicatedAt`, the existing-edges snapshot with per-property counts, floor, mode.
2. **Schema** — title and Geo-ID columns found; which of the six columns exist and which will
   be created. A wrong-type clash stops the run before this section.
3. **Proposals** — per column: pairs in → row entries planned; every skip reason with a count;
   already-on-Geo skips per property.
4. **Rows** — first 10 changed rows plus **every** unusual row (removals, truncated notes),
   each with full ids and geobrowser links: `+N` additions per column, `−N ⚠ REMOVAL` under prune.
5. **Write plan** — schema PATCH (if any) + row PATCH count, estimated time at the pace rate,
   the first five writes.
6. **⚠ Needs your eyes** — scope.missing ids, bracket pairs with no Related grouping, pairs
   outside the roster, unknown brackets, stale or missing existing-edges, duplicate Geo IDs,
   roster rows that vanished, relation values outside the roster, columns that pre-existed,
   truncated notes, and the prune warning. Prints `nothing` when empty.

`--publish` then creates the columns, patches the rows, and reads every planned row back; the
run must end with `0 remaining differences`.

## Exit codes

`0` ok · `1` Notion/Geo API error, or a publish whose read-back found differences or failed
writes · `2` usage or contract error (bad flags, missing input, schema conflict, malformed file).
