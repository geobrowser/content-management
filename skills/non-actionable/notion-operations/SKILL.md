---
name: notion-operations
description: How to read and write Notion correctly from this toolkit — which of the two identities to use, how to write hundreds of rows without silent loss, and the traps that fail quietly rather than loudly. Use before any Notion work that goes beyond reading one page: building or refreshing a mirror, writing columns onto a mirrored database, bulk-updating rows, inspecting or changing a database schema, or diagnosing "the page exists but the script 404s". Also use when a Notion result looks wrong but nothing errored. Not a replacement for geo-mirror or geo-claim-grouping-notion — those own their own procedures; this is the shared substrate underneath them.
metadata:
  version: "1.0.1"
  author: mantas
  updated: "2026-09-17"
---

# Notion operations

The toolkit reaches Notion two different ways, pins an API version three releases old,
and writes rows at a pace the API dictates. Each of those is fine once known and a silent
failure until then.

> **Notion failures are quiet.** An unconnected page 404s, a wrong parent moves a page
> instead of linking it, a capped query returns a clean partial answer. Almost nothing
> here announces itself. Verify by reading back, not by the absence of an error.

## 1. Two identities — decide this first

This is the single most common source of confusion, and it has bitten a real run.

| | **Integration token** | **MCP connector** |
|---|---|---|
| Who it is | the bot `Notion - Geo` | the editor, personally |
| How | `NOTION_TOKEN` in the toolkit `.env`, raw REST | `mcp__claude_ai_Notion__notion-*` |
| Sees | **only pages explicitly connected to the integration** | everything the editor can see |
| Edits show as | the integration, in page history | the editor |
| Available to | any script, and any subagent | the main session only |

**Consequences you must plan around:**

- A page the editor can open in a browser **still 404s** for a script until it is
  explicitly connected to the integration. That is not a bug and not a permissions
  error you can fix from here — report *which* page needs connecting, and to which
  integration, and stop. Do not work around it and do not write somewhere else.
- The two identities **cannot see each other's work properly**. An edit made through
  the connector may leave no trace the integration can attribute: it can see the object
  changed but not who changed it. If a script reports that something moved or vanished
  and cannot say why, a human or the main session acting as the editor is the first
  hypothesis, not corruption.
- **A subagent usually has no MCP Notion tools at all.** Check its tool list rather than
  assuming: where the connector is absent, the integration token is the only path. Never
  hand a subagent a plan that assumes connector access.

**Rule:** state which identity a step uses before running it, and use one identity for
one job. Reading as the editor to "check" what a script wrote proves less than it looks
like — you may be seeing a page the script cannot reach at all.

## 2. Before writing anything

1. **Reach the destination first.** `GET /pages/<id>` with the integration token, before
   any other work. This is the step most likely to stop the task, so it should cost ten
   seconds, not ten minutes.
2. **Read the schema; never guess property names or types.** Date, place, checkbox,
   relation, person and files properties each take a distinct shape, and a wrong shape is
   rejected per-row rather than up front. See `references/notion-traps.md`.
3. **Resolve the data source, not just the database.** Since API `2025-09-03` a database
   can hold several data sources. Fetch the database, read its `collection://` URLs, and
   write to the right `data_source_id`. A `database_id` parent works only while a database
   has exactly one source — which is why the legacy pin below has held so far.
4. **Name the destination explicitly** — page id and database id, both full. Never rely on
   "the first database on the page" or an implicit default parent.

## 3. Bulk writes

The API paces you at roughly **3 requests/second** in practice. Budget from that:
a 272-row mirror is about 9 minutes, a 108-row column update about 36 seconds.

- **Dry-run, read the plan, then publish.** Every toolkit writer supports it. Read
  section 3 of the plan (what changes) and section 6 (what needs eyes) before committing.
- **Confirm the mode is additive** when updating something already populated. Check the
  plan reports `mode: additive` and zero removals. A plan that removes anything on a
  re-run is a bug in the inputs, not a detail to accept.
- **Never run a long write in a silent foreground stretch.** Background it and poll.
  A 600-second silence has already killed one run in this workspace to a watchdog.
- **Read back.** The toolkit writers re-read and report `N rows checked, 0 remaining
  differences`. That line, not the exit code, is the evidence the write landed.
- **On 429/529, honour the actual `Retry-After` header.** It can exceed 60 seconds, and
  blindly retrying a non-idempotent write duplicates rows.

## 4. Traps that fail silently

The full list, with what to do instead, is in `references/notion-traps.md`. The four
that cost the most time here:

| Trap | Instead |
|---|---|
| `<page url="...">` with an **existing** page **moves** that page in as a subpage; deleting the tag deletes the child. | `<mention-page>` to reference. Keep `allow_deleting_content` false unless removal is intended. |
| `<database url="...">` likewise **moves** a database. | `data-source-url` for a linked view, or `<mention-database>`. |
| An empty search result proves **neither** nonexistence **nor** a permission failure. | Fetch known ids directly and check the connection model before concluding anything. |
| A successful async create does **not** mean content is ready. | Read the page back with a timeout. Never reapply blindly to a partially populated page. |

## 5. This toolkit's scripts

Inventory, exact defects and workarounds: `references/toolkit-scripts.md`. The three
facts worth carrying in your head:

- **Every Notion script pins `Notion-Version: 2022-06-28`** — the legacy version, two
  releases behind current (`2026-03-11`). It works *because* every mirror database has a
  single data source. The day one gets a second, these scripts change behaviour with no
  error. Do not "fix" this casually: moving forward means auditing `archived` → `in_trash`
  and the `after` → `position` change together. See `references/api-versions-and-limits.md`.
- **`roster-from-notion.mjs` now asserts entity type** (fixed 2026-09-17). It re-resolves
  every id against Geo and refuses the run unless all are `Claim`. Before that it accepted
  70 `Topic` ids as a claims roster and printed a clean success summary. `--type` rosters a
  different type; `--skip-type-check` bypasses it offline. If you see the check skipped in
  `roster.json`, treat the roster as unverified.
- **`scope-candidates.mjs --top` defaults to 80 and samples.** It prints `CAPPED` and
  proceeds. The sink now surfaces a capped scope in **Needs your eyes** (fixed 2026-09-17),
  so it can no longer read as a complete pass — but the default still samples. Set `--top`
  above the kept-pair count when you want the whole batch adjudicated.

## 6. Reporting Notion work

Numbers without scope are not evidence. Every count carries its population and the UTC
time it was read. Say which identity performed each step. If a page could not be reached,
name it and the integration it needs connecting to. An empty "could not verify" section
is a claim that everything was checked — make it true or fill it in.
