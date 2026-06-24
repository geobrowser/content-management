# Gap finding drafting conventions (Stage 6)

How to write a `Gap finding` record so a human curator can act on it without re-deriving context.
Applies to both entity-level and theme-level discoveries.

## Name — the finding in plain language (NOT a code)
- State what's wrong / missing, readably. Sentence case. No machine suffixes.
- ❌ `OpenAI — Structural — 2026-05-31`
- ✅ `OpenAI is split across three duplicate entities (Company, Person, Lab)`
- ✅ `TrueFoundry, an enterprise-AI gateway startup, is missing from the AI space`
- ✅ `Claude Opus 4.8 is missing a description`
- The date goes in the **Publish date** property, never the name.

## Description — plain prose, human-first
- 1–3 sentences a curator can skim. What it is, what's wrong, and where it surfaced from.
- Avoid analyst shorthand ("Trending entity (velocity 16) carries same-name twins…").
- ✅ "Mistral AI appears twice in the AI space — once typed Lab, once Project/Provider — and the two should be merged into a single canonical entity. Surfaced from coverage of Mistral's custom-chip plans."

## Recommended action — the to-do first, IDs as reference
- Lead with a plain imperative (Merge / Create / Enrich / Develop), then the specifics and entity IDs.
- For COVERAGE on a model/program: REQUIRE a parent link (enrich-vs-create gate) — e.g. "Create GPT-5.5 as a Model and link Developed by -> OpenAI." A model/program is rarely a standalone; tie it to its lab/parent.
- For STRUCTURAL: name the canonical survivor + the duplicate IDs to merge.

## Required properties — always set
- **Publish date** (datetime, the run date) — MUST be set. (Early runs omitted it; don't.)
- **Gap types** (multi-value): the primary gap(s) + `Trending` when velocity ≥ TREND_TAG_FLOOR.
- **Gap status**: `Proposed`.
- **Gap finding subject**: the existing entity (enrich/dedup) or empty (to-create).
- **Discoverer**, **Sources**, **Suggested type** (for to-create), **Topics**.

## Gap-type notes
- **Trending** is a *secondary tag*, never standalone — it marks a real gap that's also hot.
- **Freshness** is under-detected: the current check only fires when an existing entity is
  trending AND its `updatedAt` is >30d old, but `updatedAt` is bumped by any edit (incl. news
  linking), so it rarely triggers. A true freshness gap (entity exists but its content predates
  a development named in today's claims) needs an LLM content-vs-claims diff — not yet built.
  Until then, expect few/no Freshness discoveries; don't treat their absence as "all fresh."
