# API versions, limits, and the migration this toolkit has not done

> **This file rots.** The Notion API changelog runs at roughly weekly cadence. Anything
> here older than a month should be re-read at the source before it is trusted:
> [changelog](https://developers.notion.com/page/changelog) ·
> [llms.txt](https://developers.notion.com/llms.txt) (the whole doc tree in one file) ·
> [request limits](https://developers.notion.com/reference/request-limits).
> Verified 2026-09-16; restated here 2026-09-17.

## Versions

| Version | Status |
|---|---|
| `2026-03-11` | Current. |
| `2025-09-03` | Previous. |
| `2022-06-28` | Legacy — **still serves single-data-source databases**. This is what the toolkit pins. |

### What changed, and why it matters here

**`2025-09-03` — databases split from data sources.** Retrieve Database now returns a
*list* of data sources, and most operations moved to `/v1/data_sources`. A `database_id`
parent is only unambiguous while a database has exactly one source.

**`2026-03-11` — three breaking renames:**

- `archived` → `in_trash`
- the `after` parameter → a `position` object (`after_block` / `start` / `end`)
- block type `transcription` → `meeting_notes`
- requires JS/TS SDK v5.12.0+

## Why the toolkit is still on 2022-06-28, and what a migration costs

All six Notion scripts hardcode `2022-06-28`. This is **working, not broken**: every
mirror database this toolkit creates has a single data source, which is precisely the
case the legacy version still serves.

The risk is narrow but silent. The day any mirrored database gains a second data source,
`database_id`-parented calls become ambiguous and behaviour changes with no error.

A migration is not a one-line version bump. It means, together:

1. Auditing every `archived` reference for the `in_trash` rename.
2. Auditing block insertion for the `after` → `position` change.
3. Replacing `database_id` parents with resolved `data_source_id`s.
4. Re-running each writer's dry-run and comparing plans before and after.

Treat it as its own task with its own verification, not as maintenance folded into
another change.

## Rate limits

Per-connection, fixed 60-second window: **600 req/min** on Business/Enterprise,
**180 req/min** otherwise (changed 2026-09-09). A separate shared workspace limit can
return a `Retry-After` longer than 60 seconds.

Observed in practice from this toolkit: sustained writes settle at roughly **3 req/s**
(~0.5 rows/s for row-plus-body mirroring, since each row is several calls). Budget from
the observed rate, not the ceiling.

**On 429 or 529, honour the header.** Never blind-retry a non-idempotent write.

## Search

The 2026-09-10 changelog supersedes the earlier September split: content queries sent to
`notion-search` can route to AI search where available. Use `ai_search` explicitly when
`fetch self` reports it available; otherwise keyword search. User lookup stays on
`search`. **On the Geo connection, AI search is plan-gated** — do not assume it.
