---
name: geo-mirror
description: Mirror ANY Geo entity type from ANY space into Notion as linked databases, and (Part 2) sync reviewed Notion edits back to Geo. Type-generic — News stories, podcast Episodes, Events, People, etc. — one Notion database per entity type (primary + each related type), keyed by Geo ID so re-runs update in place. Read-only on Geo in Part 1. Triggers on "mirror to notion", "geo to notion", "export space to notion", "sync geo into notion", "mirror podcast into notion", "mirror episodes/events into notion".
metadata:
  version: "0.13.0"
  author: geobrowser
---

# Geo ⇄ Notion mirror

Two directions, gated separately:

- **Part 1 — Geo → Notion.** Pull a space's News stories + their Notable claims, Sources, and Topics into three **linked Notion databases**, each row keyed by its **Geo ID**. Read-only on Geo. Re-runs update rows in place (never duplicate).
- **Part 2 — Notion → Geo.** Diff the editor's Notion edits against the current Geo version and publish the changed fields back through the geo-publish two-phase gate (diff → review → dry-run → publish). Writes via the repo's `publishOps` (personal-vs-DAO routing + circuit-breaker).

## Example prompts (what an editor types → what they get)

| Editor prompt | Result |
| --- | --- |
| *"Mirror World affairs, News, last 2 days, into my Notion Test page: `<link>`"* | 3 tables: **News story + Claim + Article** (last-2-days stories, each with its claims + sources) |
| *"Mirror the last 3 episodes of The Daily podcast into `<link>`"* | 3 tables: **Episode + Claim + Project** (`--type Episode --related <show> --limit 3`) |
| *"Mirror US Politics stories about `<topic>` into `<link>`"* | News story + Claim + Article, scoped to that topic (`--related <topicId>`) |
| *"Sync my Notion edits back to Geo — page `<link>`, World affairs"* | Part 2: diffs your Notion edits vs Geo → review → publish the changed fields back |

Always name **space + scope + Notion page**. The agent resolves the canonical space ID, the entity `--type`, and any `--related` id (podcast/topic) via geo-query. A prompt with no scope is refused (never mirror a whole space).

Several **universal scripts** editors reuse as-is — no per-run code:
- `scripts/extract-space.mjs` — Geo → normalized JSON (read-only, no key).
- `scripts/mirror-to-notion.mjs` — JSON → three linked Notion DBs (needs a Notion token).
- `scripts/plan-notion-changes.mjs` — Part 2 planner for **any** table with a `Geo ID` column: approved proposals or edited mirrored columns → a publish plan (read-only on Geo). `notion-geo-tables.mjs` holds its shared helpers; `diff-notion-vs-geo.mjs` is kept as an alias.
- `scripts/sync-to-geo.mjs` — change plan → Geo `updateEntity` ops via `publishOps` (needs the wallet key; DRY_RUN default).
- `scripts/bulk-set-property.mjs` — fill ONE Notion property across many rows fast (see "Bulk-filling a Notion property" below).
- `scripts/mirror-claims-topics.mjs` — Debate-claims tab + Topics tab → two linked DBs with agent "Proposed …" columns (see "Claims + Topics mirror" below).

## Claims + Topics mirror (curated tabs → agent review tables)

For claim/topic review work (not news stories). **Two scope modes:**

- **Space mode (default — the preferred workflow):** omit the tab flags. Claims = every **Claim** in the space whose Tags relation (set in *this* space) is **Debate or Featured**; Topics = every **Topic** in the space + any topic those claims link to from elsewhere. No `Geo On Topics tab` column.
  `node --env-file=.env scripts/mirror-claims-topics.mjs --space <SPACE_ID> --parent <NOTION_PAGE_ID> [--skip-hierarchy] [--publish]`
  Re-runs are incremental: new rows are created, existing rows are PATCHed only when a Geo value differs (unchanged rows and all non-Geo columns are left alone), and rows that fell out of scope are reported, never deleted. `--skip-hierarchy` leaves `Geo Broader topics` untouched for DBs that store the two Geo directions separately (US Politics - new).
- **Tab mode:** `--claims-tab` + `--topics-tab` (+ `--added-since` or `--all-tab`) — only what a space's curated tabs show. Used for the first AI / World affairs runs; superseded by space mode.

Two inline DBs under the parent:

- **`AI claims`** — claims on the claims tab tagged **Debate or Featured**. Columns: `Geo Name` (title), `Geo ID`, `Geo URL`, `Geo Tags` (**multi-select, no Tags DB**), `Geo Is factual`, `Geo Score`, `Geo Topics` ⇄ topics, plus `Geo Supporting arguments`, `Geo Opposing arguments`, `Geo Related people`, `Geo Related projects`, `Geo Sources` — text columns with one **linked name per line** (each opens the entity on Geo). These aren't relation columns because most targets (argument claims, articles, people) aren't rows in the mirror; Notion caps a text property at 100 segments, so >48 links end in "… +N more".
- **`AI topics`** — every Topics-tab topic **plus every topic the mirrored claims link to**. Columns: `Geo Name`, `Geo ID`, `Geo URL`, `Geo Description`, `Geo Tags`, `Geo Score`, `Geo In space`, `Geo On Topics tab`, `Geo Claims`, `Geo Broader topics` ⇄ `Geo Subtopics`.
- **Agent columns** (created empty, **never written by re-runs**): claims `Proposed rename`, `Proposed Topics` (⇄ topics `Proposed Claims`), `Proposed Tags`; topics `Proposed rename`, `Proposed description`, `Proposed Broader Topics` ⇄ `Proposed Subtopics`.

Naming convention: every column mirrored from Geo = `Geo ` + the Geo property name. Agent columns = `Proposed …`.

```bash
# dry run (default) — extract + plan, no Notion writes
node --env-file=.env scripts/mirror-claims-topics.mjs --space <SPACE_ID> \
  --claims-tab <DEBATE_CLAIMS_PAGE_ID> --topics-tab <TOPICS_PAGE_ID> \
  --parent <NOTION_PAGE_ID> --added-since YYYY-MM-DD --out extract.json
# after the editor confirms
… same args … --publish
```

- **Date scope = when the claim was added to the tab** (the Collection-item relation's `createdAt`), not entity `createdAt`/`updatedAt`. Claim `createdAt` is flattened on migrated entities, and `updatedAt` is bumped by background edits (scores etc.) — "updated in last 3 days" matched 210/242 claims. `--added-since` is required (or `--all-tab`).
- The tab ids are the `tabId=` in the geobrowser URL. DB titles are `<space name> claims` / `<space name> topics` (override with `--db-prefix`).
- **Tabs can mix block kinds.** *Collection* blocks list items by hand (Collection item relations). *Query* blocks (e.g. World affairs Topics tab) store a `Filter` JSON — `{"spaceId":{"in":[…]},"filter":{"<relationTypeId>":{"is"|"in":…}}}` — which the script evaluates with the relations scoped to the filter's spaces (unscoped also matches tags set in *other* spaces: WA "Main topics" 7 unscoped vs 4 on the tab). Query-block items have no "added" date, so `--added-since` doesn't drop them.
- DB lookup is by title among the parent's children; re-runs add missing columns and update rows by `Geo ID`.
- **Space-mode sweep gotchas:** filter topics with the native `typeId` arg, not a Types-relation filter (500s on large spaces); page size 200 returns INTERNAL_SERVER_ERROR on World affairs topics, so the sweep uses 100 and halves on error. Entities tagged Debate/Featured but with **no Claim type** are skipped (2 in AI) — flag them for a type fix in Geo.
- **Names are per space.** `Geo Name` is the `Name` value set **in the mirrored space**, not `entity.name` (Geo's denormalized display name, often from another space — WA "Strait of Hormuz blockade" vs entity.name "…blockage"). When the space has no Name of its own, `Geo Name` falls back to `entity.name` and `Geo Name source` = `Other space (fallback)`; never publish a fallback as this space's value.
- **Verifying relations:** Notion's page API returns at most **25 items per relation property** — a read-back count below the extract is expected for topics with >25 claims; compare against `min(n, 25)` per row.

## Mirror ONE Geo page's collections ("mirror this page into Notion")

An editor pastes a geobrowser page URL and asks for *everything on it*. That page is not a
type and not a space: it is **Blocks**, and a Data block holds **Collection item** relations.
Each such block is a named collection the editor can see — "Accepted sources",
"Source materials". Mirror one collection → one Notion database.

**Do not hand-write this.** A pilot run that improvised its own scripts put most Geo properties
into the Notion page *bodies* instead of columns, and had to be redone.

```bash
# 1. read the page: lists every collection, its item count, its type mix, and writes one ids file each
node skills/actionable/geo-mirror/scripts/extract-page-collections.mjs <PAGE_ID> --space <SPACE_ID> --out-dir /tmp/pagemirror
# it prints the exact next two commands per collection. Show the editor the counts first.
# 2. extract one collection (flags as printed), then 3. mirror it
node skills/actionable/geo-mirror/scripts/extract-space.mjs <SPACE_ID> --ids-file /tmp/pagemirror/<name>.ids.json \
  --any-type --any-space --label "<collection name>" --out /tmp/pagemirror/<name>.extract.json
node --env-file=.env skills/actionable/geo-mirror/scripts/mirror-to-notion.mjs /tmp/pagemirror/<name>.extract.json --parent <NOTION_PAGE_ID> --dry-run
```

Three flags exist only for this job:

| Flag | Why a page collection needs it |
|---|---|
| `--any-type` | Collections mix types. One real collection held 49 items across **Publisher, Organization, Project, Public broadcaster, Federal agency, Public record, Company, Court**. Without it, `--ids-file` keeps only the one `--type` you named and reports the rest as off-type. One DB for the lot; the types survive as a `Geo types` multi-select. |
| `--any-space` | A collection references entities resident in **other** spaces — 12 of those 49. Without it they are dropped as off-space. Kept rows get an **`Other space`** checkbox: their values aggregate across spaces, so they are **read-only — never rename them or sync them back**. |
| `--label "<name>"` | Names the database after the collection ("Accepted sources"), not after a type. |

Both flags require `--ids-file`; neither can sweep.

**Verified 2026-09-25** on `da96a4c26e718bfa6c27c3b1f3c316cd` / `ece97658dd5b4f569af6a09156e3c672`
("Sources and source materials for US conduct in Afghanistan"): 2 collections, 49 + 79 items,
49/49 kept with `--any-space` (37 without it), 12 value columns, 8 types preserved.

## Accepted sources mirror

"Source" is **not a Geo type** — it's any entity (Publisher, Project, Person, Think tank…) that a space tags **"Source accepted by the space"** (`044f2dc2ce504281a69afda8b5285853`), with the tag asserted **in that space**. `scripts/mirror-sources.mjs` mirrors every such entity across AI, World affairs, Relationships and US Politics (override with `--spaces "Name=id,…"`) into ONE inline DB `Accepted sources`, one row per entity:

- `Geo Name`, `Geo ID`, `Geo Types` (multi-select), `Geo Accepted in` (multi-select of spaces)
- per space: `Geo URL — <space>`, `Geo Tags — <space>` (multi-select; acceptance and tags differ by space)
- `Geo Description`, `Geo Website`, `Geo Wikipedia`, `Geo X`, `Geo LinkedIn`, `Geo Year founded`, `Geo RSS Feed URL`, `Geo Editorial board URL`; `Geo Credibility score` / `Geo Relevance score` (select); `Geo Owners` / `Geo Founders` (linked names)
- agent columns: `Proposed rename`, `Proposed description`, `Proposed Types`, `Proposed Tags`

```bash
node --env-file=.env scripts/mirror-sources.mjs --parent <NOTION_PAGE_ID> --out sources.json   # dry run
… --publish
```
Internal trust work from the old Sources page (Reasons to Trust / Not to Trust, review status, publisher profiles) is Notion-only editorial data — not mirrored; migrate it separately.

## Bulk-filling a Notion property — never do it row-by-row

**If a task means "set property X on hundreds of Notion rows", do NOT loop `update-page` in the agent.** The Notion MCP's `update-page` takes **one page per call**, so each row costs a full agent round trip (~5–7s). Measured on a real task: **482 rows ≈ 50 minutes**. The same writes as paced REST calls run at Notion's allowed ~3 req/s → **~3 minutes**. (`create-pages` batches 100 at a time; `update-page` does not — that asymmetry is the whole trap.)

Use the script instead. The agent's job is to **decide** the values and emit a JSON plan; the script does the writing:

```bash
# 1. agent writes a plan file:  [{"name":"<row>","parent":"<value>"}, …]
#    ("parent":"ROOT" / null / "" means leave the row alone)
# 2. dry-run — reports what would change, writes nothing:
node --env-file=.env scripts/bulk-set-property.mjs \
  --db <DATABASE_ID_OR_URL> --plan plan.json --property "New broader topics"
# 3. publish:
node --env-file=.env scripts/bulk-set-property.mjs \
  --db <DATABASE_ID_OR_URL> --plan plan.json --property "New broader topics" --publish
```

Handles: relation / rich_text / select / url properties · matches rows by `--match` column (default `Name`) · resolves relation values to page IDs in `--target-db` (default: same DB, i.e. a self-referencing hierarchy) · paces at `--rate` req/s with retry on 429/5xx.

**It only writes rows that actually change** — so a re-run after tweaking a few values costs seconds, not another full pass. Verified live: 3/3 written at 1.9 rows/s, immediate re-run reported `TO WRITE: 0`.

It reports, rather than guesses, on: rows in the plan with no matching Notion row, relation values that don't exist as rows, and **duplicate `Name`s** (it uses the first and warns — dedupe those first or the hierarchy attaches to the wrong row).

> **Synced relation pairs: write ONE side only.** If the two properties are a synced pair (e.g. `New broader topics` ⇄ `New subtopics`), setting the child's parent auto-fills the parent's children list. Writing both sides doubles the cost for zero gain.

> **Sharing requirement.** These scripts authenticate as the **integration** (`NOTION_TOKEN`), not as you. A database you can see in the Notion UI (or via MCP, which uses your own login) will still 404 for the script until that page/database is explicitly connected to the integration (page → ⋯ → Connections). The 404 message names the integration, so it's easy to spot.

## Properties are columns — the body is never the only home for a value

Every populated Geo value becomes a Notion **property** (column), typed: datetime → date,
float/integer → number, boolean → checkbox, URL-looking text → url, else rich text. Relations to
entities that get their own DB become Notion **relations**. The page **body** carries the Geo
page composition — grouped sections, headings, claim bullets — and provenance. It is additive.

If a value or relationship can only be found by opening a row, the mirror is wrong: it cannot be
filtered, grouped, diffed, or read by Part 2. A pilot run that hand-rolled its own scripts did
exactly that and had to be repeated. Route the job to these scripts instead.

## What gets mirrored — one database per entity type

The mirror is **type-generic** but stays lean. It creates a DB for the **primary type** plus the **core content relations** — by default **Notable claims → `Geo Claim`** and **Sources → `Geo Article`/`Geo Project`** — so a typical mirror is **~3 databases**, not one per related type. Columns come from **each type's own value properties**. Examples:

- **News story** → `Geo News story` (Name, Summary, Description, Publish datetime) + `Geo Claim` + `Geo Article`.
- **Episode** (podcast) → `Geo Episode` (Name, Air date, Duration, Audio URL, Description) + `Geo Claim` + `Geo Project` (its Sources).

Core relations become **linked columns** on the primary DB. **Every other relation** (Topics, Related people/entities, Hosts, Guests, Podcast…) is mirrored in the primary row's **page body** (name + link), not as its own table — keeping the page uncluttered. Add more linked DBs with `--link "Notable claims,Sources,Hosts,Guests"`. Column types map from Geo dataTypes (Text→text, Datetime→date, Float/Integer→number, Checkbox→checkbox, URL→url).

**Geo ID** is the stable key on every row: re-running the mirror **updates the matching row** (adds new, leaves the rest), and Part 2's diff joins on it. Don't remove or edit the Geo ID column in Notion.

**Cover images:** each Story's Geo Cover (an `ipfs://` Image) is resolved to an HTTPS gateway URL and set as the Notion page **cover + icon** (plus a Cover URL property). Switch the Stories DB to a **Gallery view** and it renders like Geo's own News feed. Gateway defaults to `gateway.pinata.cloud`; override with `IPFS_GATEWAY` env.

**Review status** (`To review` / `Reviewed` / `Edited in Notion`) is on Stories + Claims — the editor's workflow column and the hook Part 2 uses to find what changed.

**Each Story's Notion page BODY is a faithful mirror of the composed Geo page** — not just the database columns, and not a flat claim dump. It walks the story's actual **page Blocks** (the Data blocks in position order): each becomes a section **heading** (block Name) + **intro** (block Description) + the **claims that block groups** (its Collection-item relations), reproducing Geo's grouped sections ("Wong collusion guilty plea" → its claims, "Foreign sanctions conspiracy charge" → its claims, …). Then Related stories, Sources (linked), Related entities, and Topics. A story with no page blocks falls back to a flat Notable-claims list. The columns drive the table/list view; the body is the readable mirror. Re-runs replace the body idempotently.

### ⚠ What the Notion API can and can't do (read before promising a layout)
The databases are created **inline** (`is_inline: true`) so each renders as a **full table embedded in the parent page** — not a collapsed sub-page link you have to click into. (Re-running also flips any pre-existing linked DBs to inline.) What the API still **cannot** create: **views** (Gallery/Board/Calendar), **grouping**, or **view-tabs** (like the "Claim quality / Issue / Classification" tabs on a reference DB). Those are a **one-time manual setup** per database:
1. Open **Geo Stories — {space}** → add a **Gallery** view → card preview = **Cover** → now it looks like the news feed.
2. Optionally group by **Review status** or **Topics**, and add view-tabs.
Do this once; re-runs keep your views and only update the row data.

## NOTION gates (run BEFORE any Notion write)

1. **Token present.** The editor supplies a Notion **internal integration token** in `.env` as `NOTION_TOKEN` (never printed/pasted into chat — same rule as the wallet key). Check presence without reading the value:
   ```bash
   grep -q '^NOTION_TOKEN=' .env && echo ok || echo "missing — add NOTION_TOKEN=secret_... to .env"
   ```
2. **Connection confirmed.** Verify the token authenticates and can see the parent page before mirroring:
   ```bash
   curl -s -o /dev/null -w '%{http_code}' https://api.notion.com/v1/users/me -H "Authorization: Bearer $NOTION_TOKEN" -H 'Notion-Version: 2022-06-28'   # 200 = connected
   ```
   Also confirm the integration is **shared into the parent page** (Notion → page → ⋯ → Connections → add the integration) — without it, database creation 404s. State "Notion connected ✓" to the editor.
3. **Scope confirmed — REQUIRED, never mirror a whole space.** Get the editor's explicit **space ID** (use the hardcoded canonical IDs — see geo-query, never fuzzy-resolve a space name) AND the **Notion parent page ID**, plus **at least one narrowing dimension**: a **date range** (`--since` / `--until`, on Publish datetime), a **`--topic <id>`**, a **`--limit N`**, or an explicit **`--ids-file <path>`**. **If the editor gives only a space, STOP and ask them to narrow it** — which tab/feed (News, Events, Governance…), which topic, or which date range. Geo spaces hold thousands of entities and grow daily; an unbounded mirror would flood Notion. The extractor enforces this too — it **refuses to run with no scope** (exit 2) unless an explicit `--all` is passed (rarely what anyone wants; confirm loudly before using it). Echo the resolved scope back before running.

> **Tabs / types:** a space tab (News, Events, People, Podcasts…) is just a filter on an **entity type**. Pass that type via `--type <id>` (default = News story). The mirror is type-generic, so Episodes, Events, People, etc. all work — resolve the type id (and any `--related` filter, e.g. a specific podcast or topic) from the tab with geo-query, then mirror. A tab that mixes types → mirror each type in a separate run.

## GEO gate (Part 1 is read-only)

Part 1 never writes to Geo — no publish gates needed. It only READS via the scoped GraphQL sweep. (Part 2 will route every write back through **geo-publish**'s gates — dry-run → `go` → `publish`.)

## Run it

**Step 1 — extract (read-only, safe to run freely). `--type` picks the entity type (default News story); a scope is REQUIRED:**
```bash
# News stories (default type), date range:
node scripts/extract-space.mjs 4582fbbee28a16589154f7e36f1ee3c5 --since 2026-08-19 --out mirror.json
# podcast Episodes of a specific show (--type + --related the podcast entity):
node scripts/extract-space.mjs b5a31f8182b042437ede0f84ee02f104 --type 972d201ad78045689e01543f67b26bee --related <PODCAST_ID> --limit 3 --out mirror.json
# an exact id list — a curated tab, a review set. The ONLY scope that skips the whole-type sweep:
node scripts/extract-space.mjs <SPACE_ID> --type <TYPE_ID> --ids-file ids.json --out mirror.json
# scope options: --since/--until (date range, auto-detects the type's date prop) | --related <ENTITY_ID> | --limit N
# NO scope → refuses (exit 2) rather than dump a whole type/space.
```
Find the `--type` id via geo-query (`type = <name>`) and, for "episodes of show X" / "stories about topic Y", the `--related` entity id. It prints the counts. Show the editor the counts + the top few names as the confirmation surface.

**Step 2 — dry-run the Notion write (nothing created):**
```bash
node --env-file=.env scripts/mirror-to-notion.mjs mirror.json --parent <NOTION_PAGE_ID> --dry-run
```

**Step 3 — mirror (after the editor confirms):**
```bash
node --env-file=.env scripts/mirror-to-notion.mjs mirror.json --parent <NOTION_PAGE_ID>
```
Creates/locates the three DBs, upserts every row by Geo ID, links Stories→Claims→Sources. Prints the three database IDs — hand those to the editor (they're the anchors Part 2 will diff against).

## Part 2 — publish Notion changes back to Geo

**Works on any mirrored table.** A Notion database with a **`Geo ID`** column holds content mirrored from Geo. Its name, and the page it's on, don't matter: it could be a `mirror-to-notion.mjs` table, a "- new" page, or a table an editor or agent made. `scripts/plan-notion-changes.mjs` finds every such table on a page and plans the changes, and `scripts/sync-to-geo.mjs` publishes them. (`diff-notion-vs-geo.mjs` still works; it now just runs the same planner.)

**How columns map to Geo properties (by name, no fixed list):**
- **Title column** → Name.
- **`Geo <X>`** → property X (the mirrored value).
- **`Proposed rename`** → Name; **`Proposed <X>`** → X (a proposal).
- **Unprefixed `<X>`** (only in tables with no `Geo …` columns, the older style) → X, but only if the table's entities already carry X or X is a system property (Name, Description). An editor's "Notes" column is never published just because Geo has a property with that name.
- **Our own bookkeeping** (`Geo ID`, `Geo URL`, `Geo Name source`, `Publish status`, `Review status`) is never published.
- **Property IDs** come from Geo: the property the table's entities already use under that name, otherwise a unique name match, with the SDK's system property as the tiebreaker. Ambiguous names are skipped, not guessed.

**Two table styles, decided per table:**

| Style | How to spot it | What gets published | Approval |
|---|---|---|---|
| **Proposal table** | has `Proposed …` columns (e.g. the "- new" pages) | filled `Proposed …` values. The `Geo …` columns are the mirrored baseline and every refresh rewrites them, so they are never published directly | **Required:** row's `Publish status` = Approved. Run `--setup` once |
| **Direct table** | no `Proposed …` columns (e.g. `mirror-to-notion.mjs` tables) | mirrored columns whose value differs from Geo. An empty cell never blanks a Geo value | Only if the table has a `Publish status` column |

**GEO gate (Part 2 writes to Geo).** Same contract as geo-publish:
- **Key:** `GEO_PRIVATE_KEY` in `.env`, never printed.
- **Two phases:** a read-only plan the editor reviews, then a dry run, then an explicit publish.
- **DAO spaces** (e.g. World affairs): the publish creates a **proposal and vote**, not an instant edit. Tell the editor.
- **Access:** `publishOps` refuses a space the wallet doesn't own or edit.

```bash
# once per page with proposal tables: add "Publish status" (Approved / Hold / Sent to Geo / Live on Geo)
node --env-file=.env scripts/plan-notion-changes.mjs --page <PAGE> --setup
# optional: every filled value, approval ignored (read-only; sync-to-geo refuses to publish it)
node --env-file=.env scripts/plan-notion-changes.mjs --page <PAGE> --preview-all --out preview.json
# the plan — show the editor its table and "Skipped" list (use --limit N for small batches)
node --env-file=.env scripts/plan-notion-changes.mjs --page <PAGE> --out plan.json
node --env-file=.env scripts/sync-to-geo.mjs plan.json             # dry run
node --env-file=.env scripts/sync-to-geo.mjs plan.json --publish   # only after the editor says "publish"
node --env-file=.env scripts/plan-notion-changes.mjs --mark-sent plan.json
```
Options: `--db <id>` (a database instead of, or besides, a page; repeatable), `--recursive` (also search sub-pages), `--space <id>` (default: the most common space in each table's `Geo URL`s), `--include-qa-flagged`.

**Checked against the live value in the table's space, before anything is planned:**
- **Not in the space** → skipped. The row belongs to another space.
- **QA-flagged** (any `QA flag…` column set) → skipped unless `--include-qa-flagged`.
- **Fallback name** (`Geo Name source` = "Other space (fallback)") → Name skipped; it isn't this space's name.
- **Stale proposal** (live value ≠ the row's `Geo <X>`) → skipped. Geo changed after the mirror, so refresh first.
- **Already live** (live value = the Notion value) → nothing to publish; the row is marked `Live on Geo`.
- **Already sent** → not planned again while the vote is pending.
- **Non-text property** (number, date, relation…) → reported. Use geo-publish.

**Not handled; use geo-publish:** relation, tag and hierarchy proposals (e.g. `Proposed Topics`, `Proposed Broader Topics`), new entities and intentional clears. The planner counts them so they aren't forgotten.

**Verified end to end on a scratch page, without publishing:**
- **Tables found:** a custom-named proposal table; an old-style direct table in a sub-page (with `--recursive`); a table without `Geo ID` was ignored.
- **Proposal table:** 1 planned, 1 marked Live on Geo; the stale, fallback and QA-flagged rows were skipped.
- **Direct table:** 1 planned, and its editor `Notes` column was not published.
- **Publish path:** the dry run built 2 ops; after `--mark-sent`, a new plan had 0 changes ("waiting for the vote").
- **Old command:** `diff-notion-vs-geo.mjs` gave the same result.
- **AI - new (read-only preview):** 422 renames; skipped 11 QA-flagged rows, 4 fallback names and 2 rows from another space.

## Gotchas

- **Query efficiency:** the extractor sweeps stories scoped by `spaceId`+`typeId`, root page 100, with bounded nested relations — never the big-root-page × unfiltered-nested-relations shape (see geo-query "Memory blow-up").
- **Date filter is on `Publish datetime`, not entity `createdAt`.** Entity `createdAt` on this API is epoch seconds and (for pre-migration entities) flattened — "past 2 weeks news" means the article dateline, which is the `Publish datetime` property. The extractor filters on that.
- **`--since` with no date range** keeps only stories that HAVE a Publish datetime; a story missing that value is dropped from a ranged run (flag it to the editor if counts look low).
- **Notion rate limits** (~3 req/s): large spaces (hundreds of stories) take a few minutes — the script paces itself; let it finish.
- **Sibling "… datasets" spaces double every relation — dedupe on the target, never scope by space.** A story mirrored into its sibling dataset space (World affairs ↔ `World affairs datasets`) returns each relation edge **twice**, once per space, with *different* relation ids but the same target. Unfixed, the Notion page body repeats every section heading and claim. The fix in `extract-space.mjs` is `uniqTargets()` on the target id. Do **not** "fix" this by adding `spaceId: { is: … }` to the relation filters — that is **lossy**: some targets (e.g. a claim's `Sources`) live *only* in the dataset space, so scoping silently drops them. Verified: scoping dropped all sources on the Niger story's claims and one story-level source.
- **Part 2 writes to the space you NAMED, never `spaceIds[0]`.** An entity that lives in both a space and its sibling `… datasets` space has values in both; `spaceIds[0]` is often the dataset copy. the Part 2 planner compares against that space's copy (falling back to a sibling only when the value exists nowhere else) and targets the **named space** for write-back — so a sync edits the copy the editor is looking at, not the dataset copy (which would silently leave the space page stale). A regression here means edits vanish into the dataset space.
- **Verify a Part-2 sync via the per-space VALUE, not `entity.name`.** `entity.name` is denormalized and can resolve from a *sibling* space, so it won't change when you edit the named space's copy — checking it makes a successful sync look like it failed. Confirm with the per-space value: `entity(id){ values(filter:{ property:{is:"a126ca53…"} }){ nodes{ spaceId text } } }` and read the row whose `spaceId` is the space you wrote to.
- **DAO spaces: a synced edit is a PROPOSAL, not live** until it's voted through — the per-space value won't change until then. Don't judge by the space page immediately after publishing.
- **Whichever side you edited last wins the next diff.** Notion is the diff's source of truth. If you edit a field directly in Geo, re-run the Part-1 mirror *before* editing in Notion — otherwise the stale Notion cell will propose reverting your Geo edit.
- **Re-runs are safe:** upsert-by-Geo-ID means running again with the same range updates in place, never duplicates. A wider range adds the new rows.
