# Accuracy verification (the research leg)

How Stage 3 verifies facts before composing, and how Stage 5 checks faithfulness. Goal: every
claim in the final description is true and sourced to a level proportional to its risk; anything
that can't be confirmed is flagged, never published as fact. "100% accurate" = this discipline,
not a guarantee.

## Tier the research (don't verify everything equally)
- **Tier 0 — trust + light check:** field already carries a reputable source → keep it, capture the citation.
- **Tier 1 — one corroboration:** a single-sourced, ordinary claim → one confirming search.
- **Tier 2 — multi-source or flag:** extraordinary / unsourced / superlative / conflicting claim →
  corroborate across ≥2 independent sources; if it can't be confirmed, flag it.
Fan the research out across claims/entities in parallel for scale. The sources you gather here
become the `Sources` relations (P6).

## Verify the FRAMING, not just existence
A claim can be "real" but distorted. Corroborate its specifics, not just the topic. If the true
framing differs, **correct to the verified fact** or flag — do not pass the original framing.
> Example (real run): a row claimed Aave "processes over $1 trillion in loans **daily**".
> Research showed $1T is **cumulative all-time** volume (Feb 2026), not daily → corrected, the
> "daily" framing dropped.

## Dynamic metrics → qualitative, never baked
TVL, trading volume, market cap, token price, user counts, and rankings ("the largest", "#1")
change constantly. Verify them at time of writing but phrase them **qualitatively and durably**
("a leading…", "one of the largest…"), never bake a specific number or a rank that will go stale.
See `dynamic-vs-durable-metric` — dynamic metrics are curation-only, not static description values.
> Example: "largest DeFi lending protocol by TVL" → write "a leading DeFi lending protocol", not
> a TVL figure or a hard "#1".

## Verification record (structure the Stage-3 output)
Per claim: `{claim, tier, verdict, sources[], note}` where verdict ∈ verified | corrected | flagged.
Compose Stage 4 from `verified` + `corrected` claims only; `flagged` claims are withheld and listed
for the human reviewer.

## Faithfulness check (Stage 5)
Every sentence in the description must be entailed by a verified/corrected claim — no unsupported
additions. Optional automated drift check: run the closeness script with the **verified fact list**
as the source and `--semantic` — you want HIGH cosine to the facts (faithful) while the originality
run against the ORIGINAL source stays LOW lexical overlap (original). Low-low against the facts =
drift/hallucination → flag.

## Worked example — Aave (real run, 2026-06-24)
- "Founded by Stani Kulechov; ETHLend 2017 → Aave 2018" → Tier 1, **verified** (multiple sources).
- "Largest DeFi lending protocol by TVL" → Tier 2, **verified** (DefiLlama, ~2× next) but a
  **dynamic metric** → soften to "a leading…".
- "Processes >$1T in loans daily" → Tier 2, **corrected** ($1T cumulative, not daily) → drop "daily".
- Composed (verified+corrected only): *"Decentralized lending protocol on Ethereum where users
  deposit and borrow crypto without an intermediary; founded by Stani Kulechov as ETHLend in 2017
  and rebranded in 2018, it is a leading DeFi lending protocol."*
