# The toolkit's Notion scripts — inventory and known defects

All six live in this repo under `skills/`, authenticate as the **integration**
(`NOTION_TOKEN` in `.env`), and pin `Notion-Version: 2022-06-28`. Run them from the repo
root — imports resolve relative to it. Load env only through Node's flag
(`node --env-file=.env …`); never pass a token on the command line.

## Inventory

| Script | Direction | Writes Notion? |
|---|---|---|
| `scripts/notion-read.mjs` | read | no |
| `skills/actionable/geo-mirror/scripts/mirror-to-notion.mjs` | Geo → Notion | **yes** |
| `skills/actionable/geo-mirror/scripts/diff-notion-vs-geo.mjs` | Notion → plan | no |
| `skills/actionable/geo-mirror/scripts/bulk-set-property.mjs` | Notion → Notion | **yes** |
| `skills/non-actionable/geo-claim-grouping-notion/scripts/roster-from-notion.mjs` | read | no |
| `skills/non-actionable/geo-claim-grouping-notion/scripts/write-grouping-to-notion.mjs` | Notion → Notion | **yes** |

`notion-read.mjs` is the orientation tool: `whoami` confirms the token and prints the
integration and workspace, `inventory` lists everything the integration can see, `schema`
dumps a database's property schema, `props` a row's properties. **Start with `whoami` and
`inventory` when something 404s** — they answer "is this page even connected" directly.

`diff-notion-vs-geo.mjs` is geo-mirror Part 2 and is itself **read-only**: it writes a
change plan for review. Applying that plan to Geo is a separate, gated operation. In v1 it
diffs title, rich_text and url columns only — relations, dates, numbers and checkboxes are
**not** diffed, so a change to one of those is invisible to it.

## Known defects — carry these, they do not announce themselves

### `roster-from-notion.mjs` — type assertion (fixed 2026-09-17)

It is deliberately schema-agnostic: any database with a title column and a `Geo ID`
rich_text column is accepted. That once made a **wrong-type mirror silently valid** — on
2026-09-16 it read a Topics database, accepted all 70 `Topic` ids as a claims roster, and
printed a clean success summary with a valid-looking `roster.json`.

It now re-resolves every kept id against Geo (read-only GraphQL, no wallet, no env) and
**refuses the run with exit 2** unless all of them carry the expected type. The result is
recorded in `roster.json` under `typeCheck`, and the console prints `N/N are type … ✓`.

- `--type <32hex>` rosters a different entity type (default `Claim`).
- `--skip-type-check` bypasses it for offline use — `typeCheck.checked` is then `false`,
  and a roster in that state has not been verified.

### `scope-candidates.mjs --top` samples at 80

Default is 80. With more kept pairs than that it prints `CAPPED — n kept pairs wait for
the next batch` and proceeds, so the adjudication is a sample rather than a pass.

`candidates.scoped.json` has always recorded this (`capped`, `scoped.keptBeforeCap`), but
nothing surfaced it. **The sink now reads it and reports a capped scope in its "Needs your
eyes" section** (fixed 2026-09-17), so a partial adjudication can no longer print
`nothing` there. The default still samples — set `--top` above the kept-pair count when
the whole batch should be adjudicated.

### `mirror-to-notion.mjs` creates one database per linked type

`--link` defaults to `"Notable claims,Sources"`. If the mirrored entities' links span
several target types, you get a database per type — an AI-space claims mirror produced
six. Pass `--link ""` for a single table, or name only the relation you want. Decide
before running: extra tables are children of the destination page and must be cleaned up
by hand.

### `extract-space.mjs --ids-file` (added 2026-09-17)

`--since`, `--related` and `--limit` are all applied **after** the entire type has been
paged, so on a large space every one of them still pays for the full read — and `--limit N`
returns an arbitrary N when the entities carry no date property.

`--ids-file <path>` skips the sweep entirely and fetches exactly the entities named, in
batches. It accepts JSON (`{"ids":[…]}` or `[…]`) or a whitespace/comma separated list, and
satisfies the no-unscoped-mirror gate on its own. Ids that do not resolve, are not resident
in `--space`, or are not `--type` are reported and skipped rather than mirrored, and the
extract records its own scope under `scope.ids`.

This is how to mirror a curated tab out of a large space: resolve the tab to an id list,
then extract those ids.

### `write-grouping-to-notion.mjs` owns its six columns exclusively

`Proposed related claims`, `Proposed exact duplicates`, `Proposed semantic duplicates`,
`Proposed supporting arguments`, `Proposed opposing arguments`, `Proposed grouping notes`.
Do not hand-edit them and do not reproduce its writes with REST calls — the skill's own
rule. Re-runs are additive; confirm the plan reports `mode: additive` and zero removals.

To change a verdict, edit `decisions.json` / `brackets.json` in the campaign directory and
re-run the dry-run. Nothing is transcribed into a script.

### Campaign directories are session-scoped

Discovery output lands in the session scratchpad by default only if `--out` says so;
otherwise it defaults to `scripts/<date>-claim-grouping-<slug>/` **inside the repo**,
which accumulates artifacts in a working clone. Always pass `--out` to the scratchpad —
and remember the scratchpad is cleared with the session, so publish or copy out anything
that took real time to compute.
