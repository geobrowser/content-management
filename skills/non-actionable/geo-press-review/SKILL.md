---
name: geo-press-review
description: Compare external press coverage (Google News / web) against what's published on Geo, and tell editors what to publish next. Classifies stories as already-published or not-yet-covered, ranked and justified. Also does source discovery for a topic+date. Read-only — it compares and recommends, never publishes. Triggers on "press review", "what's missing on Geo", "compare press coverage", "what should we publish", "is this covered", "find sources for", "coverage gaps", "timeline for", "what news did we miss".
metadata:
  author: geobrowser
  version: 0.5.2
---

# Geo Knowledge Graph — Press Review

Generate a press review for a Space: pull what the press is actually covering (Google News / web search), compare it against what's already published on Geo, and hand editors a ranked, justified list of **what to publish next and why**.

The point is not to summarize the news. It's to surface **actionable editorial opportunities** — real stories the press is covering that Geo is missing entirely.

**Read-only.** This skill compares and recommends. It never creates, updates, or deletes anything on Geo. Acting on a recommendation is a separate, explicit step that goes through `geo-orchestrate` (with dry-run + existence-check safeguards).

## When to apply

Use this skill when an editor or curator wants to:

- Run a **press review for a Space** — what's the press covering that we've missed?
- Decide **what to publish next**, ranked by priority.
- Check whether a specific story **is already on Geo** before publishing it.
- **Discover sources** for a topic + date (e.g. "Senate runoff", Jan 15 2026 → relevant articles).
- Build a **timeline** for a past date, not just today's cycle.

## The two buckets (the core output)

For every external story the press is covering, classify it against Geo. **Use these exact labels in the output** — they're written so a non-technical editor instantly knows what to do:

| Label (use verbatim) | Meaning | Recommendation |
|---|---|---|
| ✅ **Already on Geo** | A Geo News story clearly covers this event, with sources. | No action. |
| 🆕 **Not on Geo yet — publish new** | No Geo story matches this event; it's missing from Geo entirely. | Publish — this is the opportunity. |

Do **not** use the bare phrase "not covered" — editors don't know what it means. Always say **"Not on Geo yet — publish new"** (or, in tight UI, the chip "🆕 Not on Geo yet").

> **Only these two buckets exist — there is no third category.** A story either matches something already on Geo (✅) or it doesn't (🆕). If a Geo story covers the event, mark it ✅ and move on — do **not** assess, rank, or report how fresh, complete, or up-to-date existing Geo stories are, and do **not** add any "missing fact" / "delta" column (that comparison is out of scope for this version). The whole deliverable is the **🆕 publish-next list**; ✅ is just the "already handled" list.

The deliverable is **two tables** (both rendered as real markdown tables, never bullet lists):
- **🆕 table** — `Priority | Headline | Why | Sources`.
- **✅ table** — `Headline | Geo entity ID`.

In both, the **Headline cell is a clickable markdown link** to the story's primary source.

**Make the Headline itself a clickable link to the story's primary source** — `[Australia and Fiji sign mutual defense pact](https://apnews.com/article/…)` — so the editor clicks the headline and lands straight on the source (this is the editor's #1 requested shortcut). Use the strongest/first source as the headline's link target.

**Also list EVERY source in the Sources column, each a clickable link.** Not just the headline's one — all of them. A story backed by five outlets shows five links: `[AP](url) · [FT](url) · [Guardian](url)`. Render each as a markdown link to its actual article URL — never a bare outlet name. If you couldn't capture a URL for a source, drop it rather than listing a dead name.

## How it works — two halves, then match

### Half 1 — Geo coverage (deterministic, via the GraphQL API)

Run the coverage map to get everything Geo has published in the window:

```bash
bun run scripts/press-review-coverage-map.ts --space AI --days 7 --json geo-coverage.json
```

This produces `geo-coverage.json` — every News story with name, publish date, topics, sources (by outlet), and claim count. This is the "what we already have" side. It also flags **went-quiet topics** and **single-source stories** purely from Geo data (useful even before the external comparison).

> **Empty/thin baseline — say so explicitly.** If the space has ~0 News stories in the window (or under ~10 total), the coverage map's reassuring "(none)" gap lines are **meaningless as a comparison** — with no baseline, *every* external story will classify 🆕. Do not present this as a gap analysis. Tell the editor plainly: *"this space has no coverage baseline in this window; treat the output as a seeding list, not a gap analysis."* The script prints a `⚠ NO/THIN BASELINE` warning in this case — surface it, don't bury it.

**Half 1 uses the GraphQL API (`testnet-api.geobrowser.io`), addressed by SPACE ID — NOT the Hypergraph MCP connector.** Every DAO space is reachable there by its 32-hex space id (e.g. World affairs = `89bd89bf28ff8a0963faf92a8c905e20`, ~1,175 News stories). If the bun script can't run in your environment, query GraphQL directly (see `geo-query`) — same source of truth.

> **⚠ NEVER build the coverage map from the Hypergraph MCP connector.** It exposes only a curated subset of spaces (World affairs, US Politics, and others are NOT in it) and — critically — it **silently fuzzy-matches a space name to the nearest one it does have** (a real case: `space="World affairs"` matched to **"AI"** with no error), which would produce a coverage map of the *wrong* space and silently corrupt the whole review.
>
> **Space-verification guard (mandatory before any coverage map):** confirm the resolved space's `id` AND `page.name` EXACTLY match what was requested — `{ space(id:"<SPACE_ID>") { id page { name } } }`. If the id returns "not found", or the name doesn't match, or a tool "helpfully" substituted a different space → **STOP and report it. Never proceed on a fuzzy-matched or substituted space.** A blank/absent result means "use the GraphQL path," not "this space is empty."

### Half 2 — External press (via web search)

Use the agent's **web search / Google News** to gather what the press is actually covering for the same Space and window. Search by the Space's main topics and the date range. For each external story capture: headline, outlet, **date, and the article URL** (the URL is required — it becomes the clickable source in the report), and a one-line summary.

Guidance:
- **Topic-lane fan-out (mandatory): enumerate 8–10 distinct topic lanes BEFORE searching, then run at least one search per lane.** Derive lanes from the space's recurring topics (`geo-coverage.json` `topicCoverage`) plus the window's obvious threads (e.g. for World affairs: Ukraine/NATO, Iran, Gaza, Sudan, China/Pacific, domestic-politics-of-major-powers, …). A single-query or 3–4-lane run reads as "weak search" — the shortfall is breadth, not the search tool (verified in a Claude-vs-GPT A/B: same tool quality, the deeper fan-out found 2× the gaps).
- For a **past date**, scope every search to that date window, and **discard any source whose article date falls outside the window** — search engines bleed adjacent-week results in.
- Don't stop at the first page. Web search is lazy by default — explicitly gather the top N per topic. Claude's web search has no date operator and is US-centric: compensate with more, varied queries per lane (add outlet names like FT/Guardian/AP for non-US angles).
- **Keep each source's URL** alongside the outlet name. Don't discard it after reading — the report must link to it.
- **Prefer specific articles over live-blogs / topic hubs.** A page like `cnn.com/.../live-news/iran-war` or `aljazeera.com/.../iran-war-live` covers an *entire* topic, not one event — it is not a clean source for a specific story unless that exact development is in it. Capture the specific article; treat live-blogs as leads to chase, not as citations.

### Half 3 — Match & classify (the LLM does this)

For each external story, find the best-matching Geo story from `geo-coverage.json` (match on the **event**, not exact wording — same companies/people/action). Then:

- **A Geo story matches the event** → ✅ Already on Geo (no action; do not assess whether it's "fresh enough" — matched = done).
- **No match** → 🆕 Not on Geo yet — publish new.

Rigor requirements (each verified live to prevent a real mis-flag):
- **Every ✅ row cites the matching Geo story's entity ID** (from the coverage map) — the editor must be able to open the exact entity, not re-search it.
- **Before calling anything 🆕, re-check with an UNDATED search of the News-story TYPE in this space** — not just the window's coverage map, and not a generic name search. The coverage map only sees stories *inside* the window, and it filters on `Publish date`, so a story is invisible to it in **two** ways: (a) Geo published it a day or two before the window (e.g. an India–Japan summit published Jul 2 for a Jul 3–6 review), or (b) its `Publish date` is a **typo** (a real story had `2025-07-26` where its own text said 2026 — off by a year, so it fell outside every window). Either way the story exists; the undated re-check is what catches it. Query:
  ```graphql
  { entities(typeId: "e550fe517e904b2c8fffdf13408f5634", spaceId: "SPACE_ID",
      filter: { name: { includesInsensitive: "KEYWORD" } }, first: 25) { id name createdAt } }
  ```
  Run it per candidate 🆕 with a couple of salient keywords (person, country, event). **`first: 25`, not 5 — and if the result set comes back full, it may be truncated: a common keyword (`Venezuela`) can fill all slots with unrelated stories and hide the real match, so re-query with a more distinctive keyword (`International Criminal Court`) before concluding "no match."** (This exact truncation once returned five earthquake stories and hid the ICC-withdrawal story, nearly recommending a duplicate.) If a real News story comes back, it's ✅ (cite the ID), not 🆕. Only after this check comes back empty is it a genuine gap.
- **Cross-space re-check for off-beat 🆕s.** The coverage map is single-space by construction and never looks sideways. For any 🆕 whose subject is plausibly another space's beat (health, technology, crypto, industries — e.g. an Ebola vaccine trial, a chip launch, a stablecoin ruling), run the **same undated re-check with the `spaceId` dropped** (or against the sibling topical spaces). Verified real: an Ebola-vaccine story came back "no match" in World affairs while living in the **health** space — publishing the 🆕 would have duplicated it. One extra batched request; cheap insurance against cross-space duplicates.
- **Match on the story's CLAIMS, not just its title + description.** A Geo News story's specific facts live in its `Notable claims` relations (verified: ~17 claims on a typical story), which the coverage map does NOT include. Before you assert a match is only partial or that Geo "lacks" some fact, fetch the candidate story's claims and read them — the fact is often already there (e.g. the Kyiv "68 missiles / 351 drones" numbers were already claims). Title+description alone under-reports what Geo has.
  **MANDATORY (not judgment): whenever a 🆕 suggestion is of the form "Geo has a related story but not this specific thread/development," you MUST fetch that related story's `Notable claims` and confirm the development is absent from them before keeping it as 🆕.** Skipping this is exactly what mis-flagged the "Mojtaba absent from the funeral" thread as new when the funeral stories already carried those claims. No "related but new" 🆕 ships without the claims read.
  ```graphql
  { entity(id: "STORY_ID") { relations(first: 100) { nodes { type { name } toEntity { name } } } } }  # read the Notable claims (100 — busy stories can carry many)
  ```

**These rigor checks are essentially free — do not skip them.** Batched, all the undated re-checks for a full review cost ~4 s and all the claims-reads ~2 s (they read as expensive, but a single GraphQL request each covers all candidates). The undated re-check, the cross-space re-check, and the claims read each prevented a real mis-flag in testing.

Then **rank** the 🆕 items and **justify** each rank.

### Source-faithfulness gate (do this BEFORE listing any source — non-negotiable)

The #1 failure mode of this skill: recommending a *specific* story and attaching *loosely-related* sources that don't actually back it. Before a source appears in the report, it must pass both checks:

1. **The source actually substantiates THIS specific story** — not just the broad topic. A story titled "5th round of US-Iran ceasefire talks in Washington; Hormuz de-confliction cell agreed" needs sources that report *that development*. A generic "Iran war — live" blog is **not** a valid source for it. If you can't point to where the source states the claim, **drop that source** — don't pad the list.
2. **The recommended story is only as specific as its sources support.** Don't synthesize a precise headline (named round number, named venue, named mechanism) that the sources don't actually state. Phrase the recommendation to match what the sources say; if the sources are vaguer, make the recommendation vaguer.
3. **When tier-1 sources disagree on a number, cite the range — never a single figure the newest source doesn't back.** Death tolls and casualty counts routinely conflict across outlets and over time (e.g. Chile floods reported as 3 / 10 / 13 dead by three outlets on different days). Give the range and the most recent tier-1 figure ("3–13 dead depending on source; 13 per JPost, Jul 21"), not one number stated as fact.

If, after the gate, a 🆕 item has **no source that genuinely backs its specific claim**, do NOT recommend it as a confident gap — either rewrite it to the level the sources support, or drop it. Better to recommend fewer, well-sourced opportunities than many over-specified ones. (Same discipline as `geo-describe`'s accuracy leg: verify the *framing*, not just that something is roughly on-topic.)

### Ranking signals

- **Press volume** — how many outlets are covering it (bigger story).
- **Source quality** — tier-1 outlets (Reuters, Bloomberg, FT, AP…) weight higher.
- **Topic centrality** — does it hit a topic this Space actively maintains? (Cross-check `topicCoverage` in the JSON.)
- **Recency / momentum** — breaking vs. days-old.
- **Graph-fit** — does it connect to people/topics/stories already on Geo (richer contribution)?

## Source discovery mode

Second mode: editor gives a **topic (or URL) + a date**, and the skill returns relevant **sources**, not a full review.

> Example: editor enters "Senate runoff", target date 2026-01-15 → the skill web-searches news on that topic around that date and returns ranked candidate sources (headline, outlet, date, URL), flagging which are already cited in Geo.

Steps:
1. Web-search the topic scoped to the date window.
2. Pull candidate articles (headline, outlet, date, URL).
3. Cross-check against Geo (`geo-query` or `geo-coverage.json`): is this source already cited on an existing story?
4. Return a ranked source list, newest/most-authoritative first, marking ones Geo already uses.

This is the timeline-building use case — let editors reconstruct coverage for any date, not just today.

## How editors receive the output

- **In chat / terminal:** the ranked **🆕 table** under a clear heading like **"TOP PUBLISH OPPORTUNITIES — ACT ON THESE FIRST"**, each row with its *why* and its **sources as clickable markdown links**, and the **headline itself linked to its primary source**. Then a **✅ Already on Geo table** (`Headline | Geo entity ID`, headline also linked) showing what's handled. **Both are markdown tables — do NOT render ✅ as a prose paragraph or bullet list.**
- **Clickable headlines:** every headline is a markdown link to its primary source — the editor clicks the headline to reach the article.
- **Status chips:** label each row with the verbatim status — **🆕 Not on Geo yet** or **✅ Already on Geo**. Never the bare phrase "not covered".
- **Sources line — ALL of them, always linked:** list every outlet covering the story, each as its own link — `Sources: [NPR](url) · [CNN](url) · [AP](url) · [Reuters](url) · [Euronews](url)`. Don't truncate to a "main" source. An editor must be able to click straight to any article. A source with no URL is dropped, not shown as plain text.
- **As a file (optional):** the agent can write the review to a markdown or JSON file so it's shareable / feeds a future dashboard. In the JSON, each source is `{ outlet, url }`, not a bare string. `geo-coverage.json` is always available as the structured Geo-side artifact.

Lead the editor with the **top 3–5 🆕 stories** — that's the "publish next" list. Always attach the source URLs so they can verify.

## Hand-off (this skill recommends; it never publishes)

When the editor picks something to act on:

- **"Publish this missing story"** → hand the headline, the candidate source URLs, and any related Geo thread ID to **`geo-orchestrate`**, which runs the existence-check (golden rule — never duplicate), generates a dry-run script, shows the ops, and publishes only on explicit "go".
- **"Tell me more about what Geo has on X"** → hand off to **`geo-query`**.

The review itself is safe by construction — read + compare + rank only.

## Caveats / known limits

- **Web search is non-deterministic.** It can miss stories or surface low-quality sources. Treat the external half as "best-effort press scan," not an exhaustive feed. State this to the editor — a 🆕 ("Not on Geo yet") is a *candidate*, confirm before publishing.
- **Matching is judgment, not exact.** Same event can have very different headlines. Match on entities + action, and when unsure, mark it 🆕 and let the editor decide rather than silently calling it covered.
- **Sources on Geo are labeled strings, not entities.** Outlet is parsed from a `"Headline | Outlet"` label; ~⅓ have no parseable outlet. So "is this source already cited" is fuzzy. (Structured Source entities would fix this — open question for Preston.)
- **"This Space's topics"** is inferred from existing coverage (`topicCoverage`), since there's no canonical Space→Topics map yet.
- **Publish date** is whatever Geo stores on `94e43fe8…`; if it's ingestion rather than event date, timelines are approximate.

## Schema (verified 2026-05-08, AI space)

- News story type id: `e550fe517e904b2c8fffdf13408f5634` (the type entity lives in Root; News story *entities* live in topical spaces — query by this type ID per space).
- Publish date property: `94e43fe8faf241009eb887ab4f999723` (datetime).
- Relation type names: `Topics`, `Sources`, `Notable claims`.

## More

- `scripts/press-review-coverage-map.ts` — the Geo-side coverage map (Half 1).
- `geo-query` / `geo-orchestrate` / `geo-publish` — the skills this one reads from and hands off to.
