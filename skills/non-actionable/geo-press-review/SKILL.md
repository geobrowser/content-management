---
name: geo-press-review
description: Compare external press coverage (Google News / web) against what's published on Geo, and tell editors what to publish next. Classifies stories as already-published / needs-update / not-yet-covered, ranked and justified. Also does source discovery for a topic+date. Read-only — it compares and recommends, never publishes. Triggers on "press review", "what's missing on Geo", "compare press coverage", "what should we publish", "is this covered", "find sources for", "coverage gaps", "timeline for", "what news did we miss".
metadata:
  author: geobrowser
  version: 0.2.0
---

# Geo Knowledge Graph — Press Review

Generate a press review for a Space: pull what the press is actually covering (Google News / web search), compare it against what's already published on Geo, and hand editors a ranked, justified list of **what to publish next and why**.

The point is not to summarize the news. It's to surface **actionable editorial opportunities** — real stories the press is covering that Geo is missing, under-covering, or needs to update.

**Read-only.** This skill compares and recommends. It never creates, updates, or deletes anything on Geo. Acting on a recommendation is a separate, explicit step that goes through `geo-orchestrate` (with dry-run + existence-check safeguards).

## When to apply

Use this skill when an editor or curator wants to:

- Run a **press review for a Space** — what's the press covering that we've missed?
- Decide **what to publish or update next**, ranked by priority.
- Check whether a specific story **is already on Geo** before publishing it.
- **Discover sources** for a topic + date (e.g. "Senate runoff", Jan 15 2026 → relevant articles).
- Build a **timeline** for a past date, not just today's cycle.

## The three buckets (the core output)

For every external story the press is covering, classify it against Geo. **Use these exact labels in the output** — they're written so a non-technical editor instantly knows what to do:

| Label (use verbatim) | Meaning | Recommendation |
|---|---|---|
| ✅ **Already on Geo** | A Geo News story clearly covers this event, with sources. | No action. |
| 🔄 **On Geo — needs update** | A Geo story exists but the press now has newer developments, more sources, or new claims it's missing. | Update — list what's new. |
| 🆕 **Not on Geo yet — publish new** | No Geo story matches this event; it's missing from Geo entirely. | Publish — this is the opportunity. |

Do **not** use the bare phrase "not covered" — editors don't know what it means. Always say **"Not on Geo yet — publish new"** (or, in tight UI, the chip "🆕 Not on Geo yet").

The deliverable is a ranked table of the 🔄 and 🆕 items: `Priority | Headline | Status | Why | Sources (with links) | Matching Geo story (if any)`.

**List EVERY source for a story, and make each a clickable link.** Not just the first or a "primary" one — all of them. A story backed by five outlets shows five links. Render each as a markdown link to its actual article URL — `[NPR](https://www.npr.org/…)` — never just `NPR`. The whole point is the editor clicks through to verify and pull the sources. If you couldn't capture a URL for one source, drop that source rather than listing a dead name — but still list all the others.

## How it works — two halves, then match

### Half 1 — Geo coverage (deterministic, via script)

Run the coverage map to get everything Geo has published in the window:

```bash
bun run scripts/press-review-coverage-map.ts --space AI --days 7 --json geo-coverage.json
```

This produces `geo-coverage.json` — every News story with name, publish date, topics, sources (by outlet), and claim count. This is the "what we already have" side. It also flags **went-quiet topics** and **single-source stories** purely from Geo data (useful even before the external comparison).

### Half 2 — External press (via web search)

Use the agent's **web search / Google News** to gather what the press is actually covering for the same Space and window. Search by the Space's main topics and the date range. For each external story capture: headline, outlet, **date, and the article URL** (the URL is required — it becomes the clickable source in the report), and a one-line summary.

Guidance:
- Search **broadly and by topic**, not just "today's headlines" — e.g. for the AI space, search the recurring topics from `geo-coverage.json` (`topicCoverage`) so you compare like-for-like.
- For a **past date**, scope every search to that date window so you reconstruct the timeline, not today's news.
- Don't stop at the first page. Web search is lazy by default — explicitly gather the top N per topic.
- **Keep each source's URL** alongside the outlet name. Don't discard it after reading — the report must link to it.

### Half 3 — Match & classify (the LLM does this)

For each external story, find the best-matching Geo story from `geo-coverage.json` (match on the **event**, not exact wording — same companies/people/action). Then:

- **Match found, Geo story is current** → ✅ Already on Geo.
- **Match found, but external press has newer facts / more outlets / new claims** → 🔄 On Geo — needs update. List specifically what's new.
- **No match** → 🆕 Not on Geo yet — publish new.

Then **rank** the 🔄 and 🆕 items and **justify** each rank.

### Ranking signals

- **Press volume** — how many outlets are covering it (bigger story).
- **Source quality** — tier-1 outlets (Reuters, Bloomberg, FT, AP…) weight higher.
- **Topic centrality** — does it hit a topic this Space actively maintains? (Cross-check `topicCoverage` in the JSON.)
- **Recency / momentum** — breaking vs. days-old.
- **Gap size** — fully missing (🆕) ranks above a minor update (🔄).
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

- **In chat / terminal:** the ranked table under a clear heading like **"TOP PUBLISH OPPORTUNITIES — ACT ON THESE FIRST"**, leading with 🆕 (Not on Geo yet), then 🔄 (needs update), each with its *why* and its **sources as clickable markdown links**.
- **Status chips:** label each row with the verbatim status — **🆕 Not on Geo yet**, **🔄 Needs update**, **✅ Already on Geo**. Never the bare phrase "not covered".
- **Sources line — ALL of them, always linked:** list every outlet covering the story, each as its own link — `Sources: [NPR](url) · [CNN](url) · [AP](url) · [Reuters](url) · [Euronews](url)`. Don't truncate to a "main" source. An editor must be able to click straight to any article. A source with no URL is dropped, not shown as plain text.
- **As a file (optional):** the agent can write the review to a markdown or JSON file so it's shareable / feeds a future dashboard. In the JSON, each source is `{ outlet, url }`, not a bare string. `geo-coverage.json` is always available as the structured Geo-side artifact.

Lead the editor with the **top 3–5 🆕 stories** — that's the "publish next" list. Offer 🔄 updates as quick wins. Always attach the source URLs so they can verify.

## Hand-off (this skill recommends; it never publishes)

When the editor picks something to act on:

- **"Publish this missing story"** / **"update this one"** → hand the headline, the candidate source URLs, and the matching Geo story ID (if any) to **`geo-orchestrate`**, which runs the existence-check (golden rule — never duplicate), generates a dry-run script, shows the ops, and publishes only on explicit "go".
- **"Tell me more about what Geo has on X"** → hand off to **`geo-query`**.

The review itself is safe by construction — read + compare + rank only.

## Caveats / known limits

- **Web search is non-deterministic.** It can miss stories or surface low-quality sources. Treat the external half as "best-effort press scan," not an exhaustive feed. State this to the editor — a 🆕 ("Not on Geo yet") is a *candidate*, confirm before publishing.
- **Matching is judgment, not exact.** Same event can have very different headlines. Match on entities + action, and when unsure, mark it 🔄/🆕 and let the editor decide rather than silently calling it covered.
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
