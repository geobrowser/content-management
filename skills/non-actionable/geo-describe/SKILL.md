---
name: geo-describe
description: >
  Write accurate, original, rules-compliant descriptions for Geo entities at scale. For each
  entity it extracts the facts from the provided source(s), verifies them with tiered parallel
  research so every claim is sourced and cross-checked, composes a neutral ~50-word description
  that does not lead with the entity name, then gates the output for copyright-closeness, factual
  accuracy, and the Geo description rules before queueing it for human review and publish. Use when
  generating or fixing descriptions for a dataset of entities (books, tokens, people, projects),
  or on requests like "write descriptions for these", "rewrite this description", "these are copied
  from the source", "make these copyright-safe", "describe these entities", or when an ingested
  dataset has missing, thin, or source-lifted descriptions. Does NOT build category hierarchies,
  decide entity types, or publish on its own — it emits vetted descriptions plus Source citations
  for geo-publish and the human gate.
version: "0.1.0"
authors: Armando (spec), CptMoh (build)
tools: Claude Code
compatibility: >
  Best on Claude Code (parallel research subagents + network access for verification). The
  closeness/accuracy gate (scripts/check_similarity.py) runs on Python 3 stdlib alone for the
  lexical checks; the optional semantic check additionally needs `sentence-transformers`
  (degrades gracefully with a warning if absent). A web search tool is used for Tier-1/2 accuracy
  research.
---

# geo-describe

Produces trustworthy descriptions for Geo entities: it rewrites from a source so the wording is
**original** (copyright-safe), verifies the **facts** with research proportional to their risk,
holds the output to Geo's **description rules**, and gates every result before it reaches the
human + publish step. One job: turn `(entity, type, source material)` into a vetted description
plus the `Source` citations Geo needs.

**Scope boundary (single responsibility).** This skill does not build category hierarchies (that
is the taxonomy skill), does not decide an entity's type, and does not publish. It emits a
reviewed description + Source relations and hands the write to `geo-publish` behind the human gate.

## When to use
A curator has a set of entities whose descriptions are missing, thin, or lifted from a scraped
source, and wants original, accurate, rules-compliant descriptions written at scale. Also for a
single "rewrite this description so it isn't copied" request.

## Inputs
A list of rows, each: `name` (required), `type` (required — for context, not assigned here),
`source_text` and/or `source_url` (the material to describe from), optional `source_license`
(`public-domain` | `cc-by-sa` | `all-rights-reserved` | unknown). One row is the single-entity case.

> v2 (not in this version): backfilling descriptions on entities already on Geo by reading their
> current value first. For now, callers supply the source material.

## Dependencies
- Python 3 (stdlib) for `scripts/check_similarity.py` lexical gate. Optional
  `sentence-transformers` for the semantic check — the script warns and skips it if not installed.
- A web search tool for Tier-1/2 accuracy verification (e.g. WebSearch).
- `geo-publish` (+ the operator's signing key) for the eventual write — invoked separately, after review.

## Guardrails (non-negotiable)
- **Never auto-publish.** Output is a proposal queued for human review; the human gate is final.
- **Facts, not expression.** Facts are free to reuse; the source's *wording/structure* is not.
  Extract facts, then write from them — never synonym-swap the source's sentences (patchwriting).
  Why: copied/lightly-edited expression stays "substantially similar" and is a copyright risk.
- **Every factual claim cites a Source (P6).** The research that verifies a claim also yields its
  citation — emit `Sources` relations, don't drop provenance.
- **Relations over free text (P3).** If the description names a real-world thing (a person, org,
  product), flag it to be linked as a relation, not buried in description prose.
- **Accuracy is tiered, not assumed.** Every claim is checked to a level proportional to its risk
  (below); anything that can't be confirmed is flagged for human review, never published as fact.
- **Flag, don't guess.** On conflicting sources or an unverifiable claim, surface it — do not
  invent a resolution.

## Procedure

### Stage 1 — Ingest + classify the source
For each row, capture the source text + URL and classify the license. If `cc-by-sa` (e.g.
Wikipedia) and the goal is license-free output, treat the source strictly as a **fact source**
(re-express independently; share-alike does not attach to facts). If `all-rights-reserved`, only
facts may be reused. See `references/copyright-and-licensing.md` when a license is unclear or the
output may reuse expression.

### Stage 2 — Extract a fact list
Pull the discrete claims as a neutral list (who / what / when / numbers / relations) — the
fact-extraction step is what breaks dependence on the source's phrasing. Note which claims are
well-sourced vs. single-sourced vs. extraordinary/unsupported (drives Stage 3 tiering).

### Stage 3 — Verify accuracy (tiered, run in parallel)
Verify claims to a depth proportional to risk; fan the research out across claims/entities in
parallel for scale. Do **not** re-research what a reputable dataset already sourced.
- **Tier 0 — trust + light check:** field already carries a reputable source → keep, capture the citation.
- **Tier 1 — one corroboration:** a single-sourced claim → one confirming search; on confirm, record the source.
- **Tier 2 — multi-source or flag:** extraordinary / unsourced / conflicting → corroborate across
  ≥2 independent sources; if it can't be confirmed, **flag it** (do not include it as fact).
The sources gathered here become the `Sources` relations for Stage 6.

### Stage 4 — Compose (source hidden, to the rules)
Write from the **fact list with the source text closed**, following `references/description-rules.md`:
one or two short sentences (~50 words), neutral tone, does not start with the entity name or
restate it, covers what it is and why it matters, no repeated property data. Restructure the
information (reorder/regroup/abstract) — do not track the source clause-by-clause.

### Stage 5 — Gate (originality + accuracy + rules)
Run the deterministic closeness check, then the judgment checks. Read lexical and semantic
together — see `references/closeness-and-accuracy-checks.md` for the metrics and thresholds.
```
python3 scripts/check_similarity.py --candidate cand.txt --source src.txt --json
```
- **Originality:** high lexical overlap (a verbatim run ≥ 7–10 words, high ROUGE-2/L, high shingled
  Jaccard) → **reject and regenerate**, regardless of meaning.
- **Drift:** low lexical overlap **and** low semantic similarity → likely hallucination → **flag**.
- **Ideal:** low lexical overlap + faithful to the fact list → pass.
- **Rules:** ≤ ~50 words, 1–2 sentences, doesn't lead with the name, neutral, what + why.
Loop Stage 4 → 5 until a row passes or is flagged for a human.

### Stage 6 — Emit for review + publish
Produce, per row: `{name, description, sources:[{url, …}], relation_candidates:[…], confidence,
flags:[…]}`. Batch runs: checkpoint progress and collect flagged rows into a review queue.
The operator reviews; on approval the descriptions + `Sources` relations are written via
`geo-publish` (DAO → propose+vote; personal → publishEdit). If any source was CC BY-SA and its
expression was reused, surface the attribution / share-alike / "changes made" obligations in the review.

## At scale
Parallelize Stage 3 research across rows; cap concurrency to stay within rate limits; checkpoint
after each batch so a long run is resumable; never block the whole batch on one hard row — flag it
and move on. "100% accurate" in practice means: every claim sourced and cross-checked to its tier,
with low-confidence claims withheld and flagged — not a guarantee no error ever slips through.

## Gotchas
- **Attribution ≠ a copyright fix.** Citing a source addresses plagiarism, not copying of expression.
- **Patchwriting fails the gate.** Keeping the source's sentence skeleton and swapping words stays
  substantially similar — restructure and re-express instead.
- **Thresholds are heuristics, calibrate on your samples** — they reduce risk, they are not a legal clearance.
- **The copyright material is best-practice, not legal advice.** When unsure on licensing, flag for a human.

## Output
A vetted description per entity + its `Source` relations + relation candidates, confidence, and
any flags — queued for human review, then published via `geo-publish`. Flagged rows are never
auto-published.

## Files
- `references/description-rules.md` — the Geo description rules + good/bad input→output examples (read in Stage 4).
- `references/closeness-and-accuracy-checks.md` — metrics, thresholds, and the lexical+semantic combination logic (read in Stage 5).
- `references/copyright-and-licensing.md` — idea/expression, derivative-work risk, CC BY-SA reuse obligations (read in Stage 1 when a license is unclear or expression may be reused).
- `scripts/check_similarity.py` — the deterministic closeness gate (verbatim run, ROUGE-L/LCS, shingled Jaccard; optional SBERT cosine). Run it; `--help` documents flags.
