#!/usr/bin/env python3
"""Closeness gate for geo-describe: how close is a candidate description to its source?

Reports lexical/structural overlap signals (stdlib only) and, optionally, semantic cosine
(needs sentence-transformers). Reads candidate + one-or-more sources, prints one JSON object
with the signals, a verdict (reject / review / pass), and the reasons that fired.

Dependencies:
  - Python 3 standard library (lexical signals — always available).
  - Optional: sentence-transformers, for --semantic cosine. If absent, cosine is null and the
    lexical gate still runs.

The thresholds are engineering defaults; calibrate on your own (source, good, bad) samples.
This is a risk-reduction heuristic, not a legal clearance.

Examples:
  python3 check_similarity.py --candidate cand.txt --source src.txt --json
  python3 check_similarity.py --candidate-text "..." --source src1.txt --source src2.txt
  python3 check_similarity.py --candidate cand.txt --source src.txt --semantic
"""
import argparse
import json
import re
import sys
from difflib import SequenceMatcher


def tokenize(text):
    return re.findall(r"\w+", text.lower())


def ngrams(tokens, n):
    return [tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1)] if len(tokens) >= n else []


def max_verbatim_run(cand_tokens, src_tokens):
    """Longest contiguous run of tokens shared between candidate and source."""
    if not cand_tokens or not src_tokens:
        return 0
    sm = SequenceMatcher(a=cand_tokens, b=src_tokens, autojunk=False)
    return max((blk.size for blk in sm.get_matching_blocks()), default=0)


def lcs_len(a, b):
    """Length of the longest common subsequence of two token lists (for ROUGE-L)."""
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if x == y else max(prev[j], cur[-1]))
        prev = cur
    return prev[-1]


def rouge_l_f(cand, src):
    lcs = lcs_len(cand, src)
    if not cand or not src or lcs == 0:
        return 0.0
    prec, rec = lcs / len(cand), lcs / len(src)
    return round(2 * prec * rec / (prec + rec), 3)


def rouge2_precision(cand, src):
    cb, sb = ngrams(cand, 2), set(ngrams(src, 2))
    if not cb:
        return 0.0
    return round(sum(1 for g in cb if g in sb) / len(cb), 3)


def jaccard_shingle(cand, src, k=5):
    cs, ss = set(ngrams(cand, k)), set(ngrams(src, k))
    if not cs or not ss:
        return 0.0
    return round(len(cs & ss) / len(cs | ss), 3)


def semantic_cosine(cand_text, src_texts):
    try:
        from sentence_transformers import SentenceTransformer, util
    except ImportError:
        print("note: sentence-transformers not installed; cosine skipped", file=sys.stderr)
        return None
    model = SentenceTransformer("all-MiniLM-L6-v2")
    emb = model.encode([cand_text] + src_texts)
    sims = [float(util.cos_sim(emb[0], emb[i + 1])) for i in range(len(src_texts))]
    return round(max(sims), 3)


def read_candidate(args):
    if args.candidate_text is not None:
        return args.candidate_text
    with open(args.candidate, encoding="utf-8") as fh:
        return fh.read()


def main():
    p = argparse.ArgumentParser(
        description="Closeness gate for geo-describe (lexical signals + optional semantic cosine).",
        epilog="Needs Python 3 stdlib; --semantic additionally needs sentence-transformers.",
    )
    src_in = p.add_argument_group("inputs")
    src_in.add_argument("--candidate", help="path to the candidate description file")
    src_in.add_argument("--candidate-text", help="candidate description text (instead of a file)")
    src_in.add_argument("--source", action="append", default=[],
                        help="path to a source file; repeat for multiple sources (worst case wins)")
    p.add_argument("--semantic", action="store_true",
                   help="also compute SBERT cosine (needs sentence-transformers)")
    p.add_argument("--json", action="store_true", help="print JSON only (no human summary)")
    th = p.add_argument_group("thresholds (overridable)")
    th.add_argument("--max-run", type=int, default=8, help="verbatim-run word count that rejects (default 8)")
    th.add_argument("--rouge-l", type=float, default=0.55, help="ROUGE-L F that rejects (default 0.55)")
    th.add_argument("--rouge2", type=float, default=0.35, help="ROUGE-2 precision that rejects (default 0.35)")
    th.add_argument("--jaccard", type=float, default=0.20, help="shingle Jaccard that rejects (default 0.20)")
    th.add_argument("--cosine-drift", type=float, default=0.45,
                   help="cosine below this (with low lexical overlap) flags drift (default 0.45)")
    args = p.parse_args()

    if not args.candidate and args.candidate_text is None:
        p.error("provide --candidate <file> or --candidate-text <text>")
    if not args.source:
        p.error("provide at least one --source <file>")

    cand_text = read_candidate(args)
    src_texts = []
    for path in args.source:
        with open(path, encoding="utf-8") as fh:
            src_texts.append(fh.read())

    cand = tokenize(cand_text)
    per_source = []
    for st in src_texts:
        s = tokenize(st)
        per_source.append({
            "max_verbatim_run": max_verbatim_run(cand, s),
            "rouge_l_f": rouge_l_f(cand, s),
            "rouge2_precision": rouge2_precision(cand, s),
            "jaccard_shingle": jaccard_shingle(cand, s),
        })
    # worst case across sources
    signals = {k: max(d[k] for d in per_source) for k in per_source[0]}
    signals["cosine"] = semantic_cosine(cand_text, src_texts) if args.semantic else None
    signals["candidate_words"] = len(cand)

    reasons = []
    if signals["max_verbatim_run"] >= args.max_run:
        reasons.append(f"verbatim run {signals['max_verbatim_run']} >= {args.max_run} words")
    if signals["rouge_l_f"] > args.rouge_l:
        reasons.append(f"ROUGE-L {signals['rouge_l_f']} > {args.rouge_l}")
    if signals["rouge2_precision"] > args.rouge2:
        reasons.append(f"ROUGE-2 precision {signals['rouge2_precision']} > {args.rouge2}")
    if signals["jaccard_shingle"] > args.jaccard:
        reasons.append(f"shingle Jaccard {signals['jaccard_shingle']} > {args.jaccard}")

    high_lexical = bool(reasons)
    if high_lexical:
        verdict = "reject"
    elif signals["cosine"] is not None and signals["cosine"] < args.cosine_drift:
        verdict = "review"
        reasons.append(f"low cosine {signals['cosine']} with low lexical overlap — possible drift")
    else:
        verdict = "pass"

    result = {"verdict": verdict, "reasons": reasons, "signals": signals, "per_source": per_source}
    print(json.dumps(result, indent=2))
    if not args.json:
        print(f"\n=> {verdict.upper()}" + (f": {'; '.join(reasons)}" if reasons else ""), file=sys.stderr)
    sys.exit(0 if verdict == "pass" else 1)


if __name__ == "__main__":
    main()
