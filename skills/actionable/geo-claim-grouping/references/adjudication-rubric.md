# Adjudication rubric — claim relations (Similar / Duplicate / Related)

Read this in full before adjudicating any candidate batch. The pre-cluster score got the pair in front of you; from here on it carries **zero** evidential weight.

> **Taxonomy update (Geo team review, 2026-08-12).** The verdicts below are STEP-1 verdicts — broad recall that decides only whether a pair enters the `Related claims` grouping (`504e5776788844f6a77dba3ee811d8f0`). Bracket assignment happens in STEP 2 under the strict rubric at the end of this file. Never copy a step-1 verdict into a step-2 bracket.

## Step-2 bracket rubric (strict — team definitions, 2026-08-12)

Run step 2 only on pairs whose Related grouping is already published/approved. RE-read both claims and assign exactly ONE bracket:

| Bracket | Test | Team's worked example |
|---|---|---|
| **DUPLICATE** → `Duplicate claims` `982866bf8ae94afe8cce8b805713e4af` (mirrored) | Same claim created twice; wording identical or NEAR-identical | "AI companions are better than social isolation." / "AI companions are better **compared with** social isolation." |
| **SIMILAR** → `Similar claims` `e81750db3f09440cab9dd01808a43ccb` (mirrored) | Distinct formulations of the SAME core assertion — wording/framing/emphasis/specificity differ slightly, but **no material difference in what is being claimed** | "AI companions can provide meaningful social interaction for older adults." / "AI companions can offer valuable social engagement to elderly people." |
| **SUPPORTS** → `Supporting arguments` `1dc6a843458848198e7a6e672268f811` (directional) | One claim is evidence/argument FOR the other. Edge goes FROM the supported claim TO the supporter (the supported claim's page lists its arguments); mirror only if genuinely mutual | "Netanyahu is a war criminal." ← supported by "The ICC has a warrant out for Netanyahu." |
| **OPPOSES** → `Opposing arguments` `4e6ec5d14292498a84e5f607ca1a08ce` | The claims contradict or take opposite debate positions (mutual → mirrored edges); a one-sided rebuttal is directional (from the rebutted claim to the rebutting one) | "Companies should be allowed to replace employees with AI…" / "Companies should NOT be allowed to replace employees with AI…" |
| **RELATED-ONLY** (no new edge) | Distinct assertions about the same broader issue/topic/event/context — the step-1 Related edge already captures it | "AI companions are better than social isolation." / "AI companions should become common in elderly care." |

Boundary guidance for step 2:

- **The old broad SIMILAR bar does NOT survive into brackets.** Tightly-coupled-but-distinct assertions (stage-of-process updates, sequential developments of one saga, complementary quantifications/facets, same-side debate positions with different arguments) are **RELATED-ONLY**. This is the exact miscalibration the team review corrected.
- **SIMILAR vs DUPLICATE:** if the two sentences are near-identical word-for-word → DUPLICATE. If the same assertion is genuinely re-formulated (different vocabulary/structure, same claim) → SIMILAR.
- **SIMILAR vs RELATED-ONLY:** ask "is there ANY material difference in what is being claimed?" Different scope (one country vs worldwide), different quantity, different stage, different subject facet → material difference → RELATED-ONLY.
- **Default when unsure:** RELATED-ONLY. The Related edge is already live; a wrong extra bracket is worse than no extra bracket.

## Contents
- The bar: "same assertion family"
- Verdict taxonomy
- Confidence rubric
- Worked examples
- Boundary guidance (the traps)
- Direction semantics
- Procedure + decisions.json contract

## The bar: assertion family + tightly-coupled claims (broadened 2026-08-05)

Two claims are SIMILAR when a reader who cares about one would want the other, for either of two reasons:

1. **Same assertion family** — substantially the same assertion: restated, updated, narrowed, broadened, or quantified differently.
2. **Tightly coupled** *(editor-broadened 2026-08-05 — the first pilot's bar was too narrow; its staged pairs were nearly identical)* — a distinct assertion about the **same specific event, process, decision, metric, statement, or debate question**: stage-of-process updates (preliminary → full approval), sequential developments of one saga, complementary quantifications or facets of one occurrence, and same-side or orthogonal positions within one specific debate.

The anchor must still be *specific*: a shared specific subject (the same license application, the same ruling, the same debate question), not a shared subject *area*. "Both about Bitcoin regulation" is Related-claims territory; "both about Binance's Greek MiCA application" is SIMILAR territory.

Claims in Geo are self-contained 1–2-sentence assertions with no author (ontology rule). Judge ONLY what each sentence asserts — not what its sources imply, not what you know about the wider story. Cross-space pairs are judged identically — space residency never changes a verdict.

## Verdict taxonomy

| Verdict | Test | Consequence |
|---|---|---|
| **SIMILAR** | Same assertion family, OR a distinct assertion tightly coupled to the same specific event/process/metric/debate question (broadened bar); NOT identical meaning | `createRelation` proposed (subject to confidence floor) |
| **DUPLICATE** | Identical meaning — a rephrasing adds/removes nothing material | NO edge. Routed to `duplicates-for-geo-clean.json` → geo-clean merge. Creating a Similar edge here is a bug (HARD RULE 4) |
| **SUPPORTS** | One claim functions as evidence or an argument FOR the other (they are NOT the same assertion) | NO edge here. Routed to `argument-flags.json` (`Supporting arguments` `1dc6a843458848198e7a6e672268f811`) for a separate geo-publish decision |
| **OPPOSES** | One claim contradicts or argues against the other | NO edge here. Routed to `argument-flags.json` (`Opposing arguments` `4e6ec5d14292498a84e5f607ca1a08ce`) |
| **NOT-SIMILAR** | Everything else: same template different facts, same subject *area* without a shared specific anchor, unrelated | Dropped from ops. Loose-topical pairs are `Related claims` territory (`a8aa1b654afd4ac786a243481d806846`) — this skill never emits those either |

**Two-bucket discipline:** there is no "partially similar" middle verdict. The 2026-07 press-review eval killed its third bucket as the most error-prone part of the report; the same failure mode applies here. Tie-breaks (updated 2026-08-05): torn between SIMILAR and NOT-SIMILAR **when the pair shares a specific anchor** (same event/process/debate question) → lean **SIMILAR** (the editor demotes from the report); torn with **no specific shared anchor** → NOT-SIMILAR. Torn between SIMILAR and DUPLICATE → **DUPLICATE** (merge review is cheaper than a wrong edge between copies).

## Confidence rubric

- **high** — you would defend the verdict to another editor without re-reading the claims. Only `high` SIMILAR pairs are staged as ops (default floor).
- **medium** — plausible either way; a reasonable editor could disagree. SIMILAR-medium pairs go in the report's "editor calls" table, NOT into ops. DUPLICATE/SUPPORTS/OPPOSES-medium still route to their byproduct files (they are advisory queues, not ops).
- Anything weaker than medium is not a verdict — record NOT-SIMILAR.

## Worked examples

| Claim A | Claim B | Verdict | Conf | Reason |
|---|---|---|---|---|
| "Spot Bitcoin ETF inflows hit a record in June 2026" | "Bitcoin ETFs saw all-time-high inflows in June 2026" | DUPLICATE | high | identical proposition, rephrased → merge, no edge |
| "The GENIUS Act establishes a federal regulatory framework for stablecoins" | "The GENIUS Act requires stablecoin issuers to hold 1:1 reserves" | SIMILAR | high | same assertion family — what the Act mandates — distinct facets, neither argues for/against |
| "Strait of Hormuz vessel traffic fell to 8–25 transits per day by July 21, 2026" | "Tanker crossings through the Strait of Hormuz fell to as low as one per day by 24 July 2026" | SIMILAR | high | same metric, same subject, updated figures/date — classic family variant |
| "Circle secures a MiCA license in France" | "Kraken secures a MiCA license in Ireland" | NOT-SIMILAR | high | template match, different firms and facts — token overlap is anti-evidence |
| "Institutional adoption is driving the 2026 Bitcoin rally" | "BlackRock's IBIT recorded $2B of inflows in a single week" | SUPPORTS | medium | B is evidence for A, not a variant of it |
| "Tether's reserves are not fully backed" | "Tether's attestations show USDT is fully backed" | OPPOSES | high | direct contradiction |
| "El Salvador's Bitcoin adoption has increased tourism" | "El Salvador purchased 80 BTC in March 2026" | NOT-SIMILAR | high | shared subject *area* only, no specific shared anchor — Related-claims territory |
| "Ripple received preliminary CASP approval from Luxembourg's CSSF" | "Ripple received full CASP authorization from Luxembourg's CSSF" | SIMILAR | high | stage-of-process on ONE application — broadened bar (was NOT-SIMILAR under the 08-04 bar) |
| "AI benchmarks no longer reflect real-world capability" | "AI companies optimize for benchmark scores rather than usefulness" | SIMILAR | high | same specific critique family within one debate question |
| "The US government should hold a Strategic Bitcoin Reserve" | "An executive order on March 6, 2025, established the U.S. Strategic Bitcoin Reserve" | SIMILAR | medium | normative vs factual on the same specific proposal — coupled under the broadened bar; editor call |

## Boundary guidance (the traps)

**Template-headline trap.** News-derived claims share sentence templates ("X raises $Y Series Z", "X secures MiCA license", "X drops below $N as …"). High Jaccard on a template = different facts wearing the same clothes. Check the *entities and quantities*, not the shape. This is the single most common false-positive source (documented in geo-clean Pass 2).

**Same-story siblings.** `signals.sameStorySiblings: true` means the pair's only structural link is co-extraction from one news story. Under the broadened bar these CAN be SIMILAR when both claims quantify or characterize the same specific occurrence (a streak's record status + its dollar total). They stay NOT-SIMILAR when they cover different aspects of a broad operation (USDT seized vs raids executed — different facts that merely share a parent story).

**Update-vs-duplicate line.** Same metric with materially different figures/dates = SIMILAR (an update). Same figures restated = DUPLICATE. "Materially" = the newer sentence adds information a reader would notice.

**Normative vs factual.** "X should happen" vs "X happened" remain different kinds of assertion → NOT-SIMILAR by default (or SUPPORTS/OPPOSES when one is deployed as an argument about the other). Exception under the broadened bar: when both attach to the same specific decision or proposal ("the Act should pass" / "the Act passed committee"), treat as tightly coupled → SIMILAR-medium, editor call.

**Stage-of-process claims — FLIPPED 2026-08-05.** "Preliminary approval granted" vs "full authorization granted", "reportedly set to be rejected" vs "officially withdrawn": sequential developments of ONE specific process are now **SIMILAR** (the reader tracking one stage wants the others). They remain distinct entities — never DUPLICATE. (The old crypto-sweep KEEP verdicts were about *merging*; keeping separate entities and linking them as Similar are compatible.)

**Debate claims (normative corpora, e.g. curated debate pages).** Positions within one specific debate question: same side or orthogonal facet → SIMILAR; directly opposite side → **OPPOSES** (never a Similar edge); different debate questions that merely share a theme word → NOT-SIMILAR. "Benchmarks no longer reflect capability" / "companies optimize benchmarks over usefulness" = SIMILAR (same critique family). "AI can never become conscious" / "Artificial consciousness is possible" = OPPOSES.

**Already-Related pairs.** `signals.alreadyRelatedClaims: true` does not preclude SIMILAR — if the pair meets the family bar, propose the edge and flag the coexistence in the report (editor may want to keep one, both, or swap).

**Sources are context, not proof.** Shared citation names/URLs justify a closer read; they never upgrade a verdict on their own — two different assertions citing the same article stay NOT-SIMILAR.

## Direction semantics

- SIMILAR is symmetric; direction is mechanical. Mode `both` (default — editor decision 2026-08-04): two mirrored edges so each claim's page lists the other. Mode `one` (opt-in): single edge from the lexically smaller claim ID; the reverse stays visible only via backlinks. Set by Gate 4, recorded in `decisions.json.params.direction`.
- SUPPORTS/OPPOSES flags are directional and must record which claim is the argument: `{ "argument": "a"|"b", "target": the other }`. The eventual `Supporting/Opposing arguments` edge runs FROM the target claim TO the argument claim (the target *has* supporting arguments), matching the ontology's claim schema.

## Procedure + decisions.json contract

1. Load `candidates.json`. Adjudicate EVERY exported pair — no sampling, no skipping low-score rows (they earned their slot).
2. For each pair read: `a.name`, `a.description`, `b.name`, `b.description`, `signals` (shared citation names, `sameStorySiblings`, `daysApart`, `alreadyRelatedClaims`), and source names/URLs. Nothing else is needed; never re-query mid-batch.
3. Record verdict + confidence + a one-line reason that names the decisive feature ("same metric, updated figures", "template match, different firms").
4. Write `decisions.json` (schema in [`ops-script-template.md`](ops-script-template.md)) and materialize the byproducts `duplicates-for-geo-clean.json` and `argument-flags.json` with full pair records copied from `candidates.json` (hand-off sessions must not need this session's context).
5. Tally verdicts for the Discovery template. SIMILAR-high count = planned ops count (× 2 in `both` mode) minus later skips.
