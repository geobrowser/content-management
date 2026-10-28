# Traps that fail quietly

Each of these returns a success, or a plausible partial answer, rather than an error.
Distilled from Notion's own specs and from runs in this workspace.

## Content and structure

| Trap | What to do instead |
|---|---|
| `<page url="...">` pointing at an **existing** page **moves** that page in as a subpage. Deleting the tag then deletes the child page. | Use `<mention-page>` to reference a page. Keep `allow_deleting_content` false unless removal is genuinely intended. |
| `<database url="...">` likewise **moves** a database. | Use `data-source-url` for a linked view, or `<mention-database>` to reference. |
| Writing complex page content from memory of CommonMark. | Read `notion://docs/enhanced-markdown-spec`. Tabs, callouts, columns, toggles and tables are XML-ish, and table cells take rich text only. |
| Configuring a view by guessing. | `notion://docs/view-dsl-spec`. Note the API **cannot create views, grouping or view tabs** at all — that is a one-time manual setup per database, and it survives re-runs. |

## Databases and properties

| Trap | What to do instead |
|---|---|
| Using a `database_id` parent on a multi-source database. | Fetch the database, read the `collection://` data source URLs, write to the right `data_source_id`. |
| Guessing property names or types before writing rows. | Inspect the schema first. Date, place, checkbox, relation, person and files properties each take a special shape. |
| Assuming a relation column can point anywhere. | A relation targets one specific database. Mirroring entities whose links span several types produces **one database per target type**, not one combined table. |
| Treating a property that exists on the schema as populated. | Coverage is usually partial. Report `n of N` populated, never just the column's existence. |

## Search and reads

| Trap | What to do instead |
|---|---|
| Assuming an empty search means nothing exists. | Search can miss content through query terms, pagination, indexing or access. Fetch known ids directly. An empty result proves neither nonexistence nor a permission failure. |
| Acting on a skill or page from search results alone. | Search returns name, URL and description only. Fetch the page to get the actual content. |
| Caching a download URL. | Skill/plugin archive URLs expire after about an hour; MCP cover and icon URLs are documented at five minutes. Use the returned expiry or re-fetch. Never assume one universal lifetime. |
| Reading a page as the editor to verify what a script wrote. | Different identity, different visibility — see SKILL.md §1. Verify integration writes with the integration. |

## Writes

| Trap | What to do instead |
|---|---|
| Treating a successful async create as "content is ready". | Call `get_async_task` only when a tool actually returns an async task id. Template population is a separate background process. Read the page back with a timeout; never reapply blindly to a partially populated page. |
| Blindly retrying a failed write. | Honour the actual `Retry-After` on 429/529 — it can exceed 60 seconds. Retrying a non-idempotent write duplicates rows. |
| Assuming a page move breaks references. | Notion ids are **stable across moves**. A page relocated to a new parent keeps its id, and databases inside it keep theirs. Re-pointing scripts after a move is unnecessary. |
| Letting a find-or-create run without checking its matching rule. | `mirror-to-notion.mjs` matches on exact database **title**, then filters by parent. It issues a workspace-wide `/search` to do so — a read, but one that touches metadata beyond the destination page. |

## Free-plan and limits

Block limits apply to specified connection types on multi-member Free workspaces, with a
separate MCP policy. Partial template output can survive a quota failure, so a failed
create can still leave content behind. Check before assuming a clean rollback.
