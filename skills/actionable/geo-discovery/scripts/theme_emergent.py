#!/usr/bin/env python3
"""theme_emergent.py — Stage 5c: emergent-theme existence + variant reconciliation.

The tag-based sweep (theme_heat + theme_gaps) clusters Topics ALREADY ATTACHED to the
harvested stories, so it can only re-surface themes the upstream taxonomy already knows.
It is structurally blind to genuinely-new themes that recur in the claim TEXT but have no
Topic yet (e.g. "physical attacks on crypto holders"). Stage 5c closes that gap.

Two-part stage:
  1. (LLM, upstream — the agent) read the harvested claims and PROPOSE candidate emergent
     theme names, especially ones not represented by any existing Topic. Write a JSON file:
        [{"name": "Bitcoin ATM regulation", "synonyms": ["Bitcoin ATM", "Crypto ATM"]}, ...]
     (synonyms optional; the script also auto-probes significant tokens from the name.)
  2. (this script) run the existence ladder + variant reconciliation DETERMINISTICALLY, so
     the dedup rigor happens every run, not only when someone remembers to do it by hand:

        exact name in TARGET space        -> IN-SPACE  (already covered; maybe develop)
        only a NAME VARIANT in target     -> VARIANT   (do NOT create — would duplicate)
        exact name in another CANON space -> ELSEWHERE (bring it in / create-in-space)
        nowhere                           -> CREATE    (genuinely emergent -> Coverage(theme))

Only CREATE (and optionally ELSEWHERE) themes should become theme Gap findings. VARIANT is
the guardrail that stopped earlier runs from creating duplicate "Real-world asset
tokenization" / "Restaking" / "Crypto super PACs" topics.

Usage:
    python theme_emergent.py --space <id> --themes emergent.json [--out emergent_themes.json]
"""
from __future__ import annotations
import argparse, json, re
from gap_diagnostic import gql, _esc   # reuse the GraphQL client + escaper

TOPIC_TYPE = "5ef5a5860f274d8e8f6c59ae5b3e89e2"  # geo-root Topic

# Canonical content spaces to check for "exists elsewhere". Scoped queries are fast; the
# UNSCOPED geo-root Topic-by-name query times out (~94s), so we never do that.
CANONICAL_SPACES = {
    "crypto":        "c9f267dcb0d270718c2a3c45a64afd32",
    "ai":            "41e851610e13a19441c4d980f2f2ce6b",
    "health":        "52c7ae149838b6d47ce0f3b2a5974546",
    "world-affairs": "89bd89bf28ff8a0963faf92a8c905e20",
    "industries":    "d69608290513c2a91102c939b3265bd7",
    "podcasts":      "b5a31f8182b042437ede0f84ee02f104",
}

# words too generic to be a useful variant probe on their own
_STOP = {"the", "and", "for", "crypto", "cryptocurrency", "cryptocurrencies", "digital",
         "asset", "assets", "market", "markets", "new", "based", "onchain", "on-chain"}


def _exact_in_space(name, space_id):
    q = (f'{{ entitiesConnection(typeId:"{TOPIC_TYPE}", spaceId:"{space_id}", first:2, '
         f'filter:{{name:{{isInsensitive:"{_esc(name)}"}}}}){{ nodes {{ id name }} }} }}')
    return ((gql(q) or {}).get("entitiesConnection") or {}).get("nodes") or []


def _variant_in_space(probes, space_id):
    """Substring (includesInsensitive) probes in the target space -> Topic-type hits."""
    hits = []
    sub = " ".join(
        f'p{i}: entitiesConnection(typeId:"{TOPIC_TYPE}", spaceId:"{space_id}", first:3, '
        f'filter:{{name:{{includesInsensitive:"{_esc(p)}"}}}}){{ nodes {{ name }} }}'
        for i, p in enumerate(probes))
    try:
        d = gql("{ " + sub + " }") or {}
        for i in range(len(probes)):
            for n in (d.get(f"p{i}") or {}).get("nodes") or []:
                hits.append(n["name"])
    except Exception:
        pass
    return sorted(set(hits))


def _probes(name, synonyms):
    # Variant probes must be SPECIFIC. Single generic tokens ("Bitcoin", "attacks", "security")
    # match unrelated topics and produce false VARIANT verdicts that wrongly suppress a new theme
    # — the dangerous direction (Stage 6 review catches a false CREATE, but a false VARIANT is
    # silent). So: trust the LLM's curated `synonyms` as-is, and auto-derive only multi-word
    # BIGRAMS from the name (never bare single tokens).
    probes = list(synonyms or [])
    words = re.findall(r"[A-Za-z0-9]+", name)
    for i in range(len(words) - 1):
        a, b = words[i], words[i + 1]
        if (a.lower() not in _STOP or b.lower() not in _STOP):
            bg = f"{a} {b}"
            if len(bg) >= 7:
                probes.append(bg)
    # de-dup; keep only probes specific enough to be safe (a space-joined phrase, or a single
    # distinctive token >= 6 chars that the LLM chose deliberately)
    out = []
    for p in dict.fromkeys(probes):
        if " " in p or (len(p) >= 6 and p.lower() not in _STOP):
            out.append(p)
    return out[:8]


def classify(theme, target):
    name = theme["name"]; syn = theme.get("synonyms") or []
    if _exact_in_space(name, target):
        return {"name": name, "verdict": "IN-SPACE", "detail": "exact Topic already in target space"}
    variants = _variant_in_space(_probes(name, syn), target)
    if variants:
        return {"name": name, "verdict": "VARIANT",
                "detail": "name variant already in target space: " + ", ".join(variants[:5])}
    elsewhere = {lbl: _exact_in_space(name, sid)
                 for lbl, sid in CANONICAL_SPACES.items() if sid != target}
    hit = [lbl for lbl, ns in elsewhere.items() if ns]
    if hit:
        return {"name": name, "verdict": "ELSEWHERE",
                "detail": "exact Topic exists in: " + ", ".join(hit) + " — bring it in"}
    return {"name": name, "verdict": "CREATE",
            "detail": "no Topic and no in-space variant — genuinely emergent"}


def run(themes, target):
    return [classify(t, target) for t in themes]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--space", required=True)
    ap.add_argument("--themes", required=True, help="JSON: [{name, synonyms?[]}]")
    ap.add_argument("--out", default="emergent_themes.json")
    a = ap.parse_args()
    themes = json.load(open(a.themes))
    themes = [{"name": t} if isinstance(t, str) else t for t in themes]
    res = run(themes, a.space)
    json.dump(res, open(a.out, "w"), indent=1)
    from collections import Counter
    tally = Counter(r["verdict"] for r in res)
    print(f"{'theme':40}{'verdict':<10} detail")
    print("-" * 90)
    for r in res:
        print(f"{r['name'][:38]:40}{r['verdict']:<10} {r['detail'][:60]}")
    print(f"\n{dict(tally)}  -> file CREATE (and optionally ELSEWHERE) as theme Gap findings")
