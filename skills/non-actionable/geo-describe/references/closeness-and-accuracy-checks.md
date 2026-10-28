# Closeness + accuracy checks

How Stage 5 gates an output. Read lexical/structural and semantic signals **together** — neither
alone is sufficient. Thresholds are engineering defaults; calibrate on a labelled sample of your
own `(source, good-rewrite, bad-rewrite)` triples. They reduce risk; they are not a legal clearance.

## The metrics (what `scripts/check_similarity.py` reports)

| Signal | What it catches | "Too close" default |
|---|---|---|
| `max_verbatim_run` (words) | longest exact copied run | **≥ 7–10 words → reject** |
| `rouge_l_f` (LCS-based) | reordered/spaced-out copying, structural mirroring | **> ~0.5–0.6 → reject** |
| `rouge2_precision` | shared bigrams vs the source | **> ~0.3–0.4 → patchwriting → reject** |
| `jaccard_shingle` (k=5) | bag-of-shingles overlap | tuned; weak vs true paraphrase — pair with cosine |
| `cosine` (SBERT, optional) | semantic closeness / faithfulness | paraphrase ≈ 0.8–0.99 |

If `sentence-transformers` is absent, `cosine` is `null` — the lexical gate still runs; treat the
semantic/faithfulness read as a manual judgment in that case.

## Combination logic (decision table)

| Lexical overlap | Semantic (cosine / judgment) | Verdict |
|---|---|---|
| High | any | **REJECT — regenerate** (copied or patchwritten expression) |
| Low | High (faithful to facts) | **PASS** (ideal: re-expressed, accurate) |
| Low | Low (drifted off the facts) | **FLAG** — likely hallucination/omission, human review |
| Medium | — | tighten the rewrite and re-run; don't ship borderline |

- "High lexical" = any single strong signal trips (verbatim run, ROUGE-2/L, or Jaccard over threshold).
- Semantic alone is **not** a rejection signal — a faithful paraphrase *should* score high cosine.
  Rejection comes from lexical overlap; cosine is for catching drift and confirming faithfulness.

## Accuracy (the faithfulness half)

The closeness script checks *originality*; accuracy is checked against the Stage-3 fact list:
- every sentence in the output must be **entailed by a verified claim** (no unsupported additions);
- numbers/dates/names must match a source captured in Stage 3;
- low semantic similarity to the fact list **with** low lexical overlap = drift → flag.
Use an NLI/QA-style or LLM-judge check; when in doubt, flag for a human rather than pass.

## Reading the script output
`scripts/check_similarity.py --candidate cand.txt --source src.txt --json` prints one JSON object
with the signals above plus a `verdict` (`reject` / `pass` / `review`) and the `reasons` that
fired. Pass `--source` multiple times to compare against several sources (worst-case overlap wins).
