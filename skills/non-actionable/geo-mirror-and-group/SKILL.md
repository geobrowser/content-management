---
name: geo-mirror-and-group
description: Run the whole Geo → Notion → claim-grouping pipeline from one request instead of eight. Mirrors a scoped set of claims into a Notion page, builds the roster, runs discovery, scopes it, waits for adjudication, then produces the sink dry-run. Decides semantic recall and batch size from the corpus rather than from defaults. Use when someone asks to "mirror and group", "mirror the claims in this space and group them", "do the full pipeline", "set up a grouping review in Notion", or when a mirror already exists and only the grouping half is wanted. Read-only on Geo — it never writes to the graph and never publishes the grouping columns. Not a replacement for geo-mirror, geo-claim-grouping or geo-claim-grouping-notion; it drives them and keeps their gates.
metadata:
  version: "1.0.1"
  author: mantas
  updated: "2026-09-18"
---

# Mirror and group

The pipeline is eight scripts across three skills. Run by hand it takes eight round trips,
a campaign directory invented on the spot, and two settings that are silently wrong more
often than right. `scripts/run-pipeline.mjs` chains the mechanical stages and derives
those two settings from the corpus.

> **What it will not do.** It never writes to Geo, never runs `geo-mirror` Part 2, and
> never passes the sink's `--publish`. It stops at a dry-run and hands it to the editor.
> Adjudication is judgement, not a script — it happens *inside* the pipeline, between
> `prepare` and `finish`, and an agent does it in conversation.

## The four stages

| Stage | Does | Writes |
|---|---|---|
| `probe` | counts the type, samples signal coverage, decides semantic recall and warns on large spaces | nothing |
| `mirror` | `extract-space` → `mirror-to-notion` dry-run → write | **Notion** |
| `prepare` | `roster-from-notion` (type-asserted) → `discover_candidates` → `scope-candidates` | campaign files |
| — **adjudicate** — | you judge every pair under the rubric and write `decisions.json` + `brackets.json` | campaign files |
| `finish` | `existing-edges-from-geo` → sink **dry-run** | nothing |
| — **editor says publish** — | the sink's `--publish`, run by the editor | **Notion** |

State lives in `pipeline.json` in the campaign directory, so a later stage knows what an
earlier one decided.

## The two decisions it makes for you

**Semantic recall.** `probe` checks whether the space contains News stories. If it does
not, the `(shared story AND shared topic)` branch of discovery's structural gate is
unsatisfiable for *every* pair, and — where claims also carry about one source each —
`>=2 shared citations` is unreachable too. That leaves text overlap as the only live
admission path, which is precisely the gate a same-meaning-different-wording pair fails
by construction. On such a corpus the empty `Proposed semantic duplicates` column is
guaranteed before the run starts.

Measured: a 272-claim debate space went from **9 candidate pairs to 271** with semantic
recall on, surfacing **11 real semantic duplicates**, every one below the Jaccard floor
(lowest 0.11). A news-driven space produced 803 pairs with the structural path carrying
more of the recall than semantic did.

`--semantic auto` (the default) follows the probe. `on` / `off` override it.

**Override it ON for a small roster in a large space.** The probe measures the *space*;
recall depends on the *roster*. Structural admission needs both sides of a pair inside the
mirror, so a 30-claim roster drawn from a 22,000-claim space pairs almost entirely outward
— measured: **0** both-in-roster pairs with recall off, **26** with it on, same 30 claims.
As a rule of thumb, force it on when the roster is under a few hundred rows or under a few
percent of the space, however news-driven the space looks.

**Batch size.** `scope-candidates.mjs --top` defaults to 80 and samples silently past
that. `prepare` counts the both-in-roster pairs first and passes `--top` sized to them, so
the adjudication is never a sample that reads as a pass.

## Running it

```bash
cd <your geo-skills clone>
R="node --env-file=.env skills/non-actionable/geo-mirror-and-group/scripts/run-pipeline.mjs"
C=<a campaign dir in your scratchpad>

# 1 — measure before deciding anything
$R --space <32hex> --stage probe --campaign "$C"

# 2 — mirror (scope is REQUIRED; --ids-file for a large space)
$R --space <32hex> --parent <notionPageId> --stage mirror --campaign "$C" --ids-file ids.json

# 3 — roster + discovery + scope, using the database id stage 2 printed
$R --space <32hex> --stage prepare --campaign "$C" --db <claimsDbId>

#     ... adjudicate every pair, write decisions.json + brackets.json into "$C" ...

# 4 — existing edges + sink dry-run, and stop
$R --space <32hex> --stage finish --campaign "$C" --db <claimsDbId>
```

Already have a mirror? Skip straight to `prepare` with its `--db`.

## Scoping a large space

`probe` warns when the type is large. `extract-space.mjs` applies `--since`, `--related`
and `--limit` *after* paging the whole type, so on a 22,000-claim space each of them still
pays for the full read, and `--limit N` returns an arbitrary N when the type has no date
property. Use `--ids-file`: resolve a curated tab to an id list, then mirror exactly those.

To turn a tab into ids: `entity(id: <tabId>)` → its `Blocks` relations
(`beaba5cba67741a8b35377030613fc70`) → each block's `Collection item` relations
(`a99f9ce12ffa4dac8c61f6310d46064a`), or the block's `Filter` value for query blocks.

## Gates that stay in force

Every underlying skill keeps its own rules. This runner adds none and removes none.

1. **Never write to Geo.** Read-only throughout. `geo-mirror` Part 2 (`diff-notion-vs-geo`
   → `sync-to-geo`) is a different job with its own gate; this pipeline does not touch it.
2. **The dry-run is the end of the agent's authority.** The sink's `--publish` belongs to
   the editor. The runner will not pass it, and neither should you on their behalf.
3. **Adjudicate every exported pair.** No sampling. If the batch is too big to judge
   honestly, say so rather than judging a subset and reporting a pass.
4. **Confirm the space before mirroring.** Full 32-char id, resolved against the live
   graph, never a fuzzy name match.
5. **A count carries its population and timestamp.** These spaces grow daily — the same
   space measured two days apart gave 272 and then 369 claims. Never blend two snapshots.

## Reading the result

The sink's dry-run has six sections. Two matter most:

- **Section 3** — what would change, and what was skipped and why.
- **Section 6 — "Needs your eyes"** — it now reports a capped scope, stale existing-edges,
  off-roster pairs and duplicate Geo IDs. `nothing` there is a claim that all of those
  were checked and clean.

Then hand the editor the exact `--publish` command and stop.

## What this does not do

- Adjudicate. Discovery proposes; judgement is the model's, against
  [`../../actionable/geo-claim-grouping/references/adjudication-rubric.md`](../../actionable/geo-claim-grouping/references/adjudication-rubric.md).
- Merge duplicates. A `Proposed exact duplicates` entry is a link. Merging is `geo-clean`,
  behind its orphan check and human confirmation.
- Publish anything, to Geo or to Notion.
- Create Notion views. The API cannot; grouping and view tabs are a one-time manual setup
  per database and survive re-runs.
