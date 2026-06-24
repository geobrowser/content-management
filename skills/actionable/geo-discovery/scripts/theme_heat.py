#!/usr/bin/env python3
"""
theme_heat.py — cluster a harvest into themes and flag cross-source signal.

Stage 5 of the discovery workflow. Reads harvest.json (from harvest.py), clusters
docs by their Topics, and classifies each theme by where it's hot:

  - CROSS-SOURCE (news + episodes)  -> sustained/durable -> DEEP-eligible
  - podcast-only                    -> conceptual/evergreen -> STANDARD topic-page
  - news-only                       -> event-driven, possibly a flash -> provisional

Depth tier is then a function of heat + cross-source (see CLAUDE.md §9). No "wait a
week" needed: two independent sources agreeing today is the sustained signal.

Usage:
    python theme_heat.py --in harvest.json
"""
from __future__ import annotations
import argparse, json
from collections import Counter, defaultdict

# ultra-broad container topics that aren't actionable themes
BROAD = {"AI", "Business & finance", "Technology", "Society", "Global affairs", "Science",
         "Companies & projects", "U.S. politics", "Crypto", "Health", "Philosophy",
         "Innovation", "Debates", "Social issues", "Investing", "World affairs",
         "Ethics", "Corporate strategy", "Apps & software", "China"}


def themes(docs):
    news_heat, pod_heat, claim_vol = Counter(), Counter(), Counter()
    for d in docs:
        is_news = d.get("kind") == "news"
        for t in set(d.get("topics") or []):
            if t in BROAD:
                continue
            (news_heat if is_news else pod_heat)[t] += 1
            claim_vol[t] += len(d.get("claims") or [])
    rows = []
    for t in set(news_heat) | set(pod_heat):
        nt, pt = news_heat[t], pod_heat[t]
        if nt + pt < 2:
            continue
        if nt and pt:
            signal, tier = "CROSS-SOURCE", "DEEP-eligible"
        elif pt:
            signal, tier = "podcast-only", "STANDARD"
        else:
            signal, tier = "news-only", "provisional"
        rows.append({"theme": t, "news": nt, "pod": pt, "claims": claim_vol[t],
                     "signal": signal, "tier": tier})
    rows.sort(key=lambda r: (-(r["news"] + r["pod"]), -r["claims"]))
    return rows


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default="harvest.json")
    a = ap.parse_args()
    docs = json.load(open(a.inp))
    print(f"{'theme':42}{'news':>5}{'pod':>5}{'claims':>8}  signal -> tier")
    print("-" * 80)
    for r in themes(docs)[:20]:
        print(f"{r['theme'][:42]:42}{r['news']:>5}{r['pod']:>5}{r['claims']:>8}  "
              f"{r['signal']} -> {r['tier']}")
