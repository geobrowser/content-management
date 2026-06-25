#!/usr/bin/env python3
"""
prioritize.py — the gate + rank + two-track routing for discovered gaps.

Turns diagnosed candidates into two independently-budgeted, ranked action lists
(see ../../CLAUDE.md §7):

  - INTEGRITY track : structural gaps (dedup/mistyping). Batch top-N into ONE wave.
  - GROWTH track    : coverage/depth/freshness. Top items collapse into a hot THEME wave.

Ranking is DATA-DRIVEN by default — no operator scoring input required:
  score ~ trending(velocity)  +  gap_value  +  theme_fit
where `theme_fit` = membership in a hot CROSS-SOURCE theme (from Stage 5 theme heat).
The stream tells us what matters; you don't have to pre-declare it. (The old manual
"strategic anchors" presupposed the very thing discovery is meant to surface — so they
are now an OPTIONAL bias, not a required input. `relevance` is likewise optional,
defaulting to 1.0.)

Usage:
    python prioritize.py            # demo set, fully data-driven
    # or import: from prioritize import route
"""
from __future__ import annotations

RELEVANCE_FLOOR = 0.0      # default keeps everything; raise only to hard-gate noise
INTEGRITY_CAP = 5          # dedups actioned per cycle (batched into 1 wave)
GROWTH_CAP = 5             # growth gaps actioned per cycle

# scoring weights (growth track). Theme-fit replaces the old manual anchor weight.
W_TREND, W_GAPVAL, W_THEME = 0.5, 0.3, 0.2
GAP_VALUE = {"COVERAGE": 1.0, "STRUCTURAL": 0.9, "FRESHNESS": 0.6, "DEPTH": 0.5}
GAP_EFFORT = {"COVERAGE": 3, "STRUCTURAL": 1, "FRESHNESS": 2, "DEPTH": 2}


def _lc(xs):
    return {str(x).lower() for x in (xs or [])}


def integrity_score(relevance, velocity, vmax):
    return relevance * (0.6 * (velocity / vmax) + 0.4) * 100


def growth_score(relevance, velocity, vmax, gaps, strategic):
    gv = max((GAP_VALUE[g] for g in gaps if g in GAP_VALUE), default=0.0)
    return relevance * (W_TREND * (velocity / vmax) + W_GAPVAL * gv + W_THEME * strategic) * 100


def route(candidates: list[dict], hot_themes=None, anchors=None) -> dict:
    """candidates: [{name, velocity, gaps, themes?, relevance?, anchors?}].
    hot_themes: set of hot theme/topic names (from Stage 5) — the data-driven relevance signal.
    anchors:    OPTIONAL operator bias (set of focus strings). Omit for a pure data-driven run.
    Returns {"integrity":[...], "growth":[...], "dropped":[...], "clean":[...]}."""
    hot = _lc(hot_themes)
    anch = _lc(anchors)
    vmax = max((c.get("velocity", 0) for c in candidates), default=1) or 1
    integ, growth, dropped, clean = [], [], [], []
    for c in candidates:
        relevance = c.get("relevance", 1.0)
        if relevance < RELEVANCE_FLOOR:
            dropped.append(c); continue
        gaps = c.get("gaps") or []
        if gaps == ["clean"] or not gaps:
            clean.append(c); continue
        themes = _lc(c.get("themes"))
        c_anch = _lc(c.get("anchors"))
        theme_fit = 1.0 if (hot and themes & hot) else 0.0
        anchor_fit = 1.0 if (anch and ((c_anch & anch) or (themes & anch))) else 0.0
        strategic = max(theme_fit, anchor_fit)  # data-driven by default; anchors only add bias
        if "STRUCTURAL" in gaps:
            integ.append({**c, "score": integrity_score(relevance, c.get("velocity", 0), vmax)})
        growth_gaps = [g for g in gaps if g in ("COVERAGE", "DEPTH", "FRESHNESS")]
        if growth_gaps:
            growth.append({**c, "in_hot_theme": bool(theme_fit),
                           "score": growth_score(relevance, c.get("velocity", 0), vmax, gaps, strategic),
                           "effort": min(GAP_EFFORT[g] for g in growth_gaps)})
    integ.sort(key=lambda x: -x["score"])
    growth.sort(key=lambda x: -x["score"])
    return {"integrity": integ, "growth": growth, "dropped": dropped, "clean": clean}


def render(routed: dict):
    print("=" * 70, "\n🔧 INTEGRITY TRACK (structural dedup) — batch top-N into ONE merge wave\n" + "=" * 70)
    for i, c in enumerate(routed["integrity"], 1):
        mark = "✅" if i <= INTEGRITY_CAP else "⏸"
        print(f"{i:>2} {c['name']:20}{c['score']:>6.1f}  trend={c.get('velocity',0):<3} {mark}")
    print("\n" + "=" * 70, "\n🌱 GROWTH TRACK (coverage/depth/freshness) — theme-bundled ingestion\n" + "=" * 70)
    for i, c in enumerate(routed["growth"], 1):
        mark = "✅ ACTION" if i <= GROWTH_CAP else "⏸ defer"
        hot = "🔥" if c.get("in_hot_theme") else "  "
        print(f"{i:>2} {c['name']:24}{c['score']:>6.1f}  trend={c.get('velocity',0):<3} {hot} {','.join(c['gaps']):16} {mark}")
    if routed["dropped"]:
        print("\nDROPPED (below relevance floor):", ", ".join(c["name"] for c in routed["dropped"]))
    if routed["clean"]:
        print("CLEAN (no gap, no action):", ", ".join(c["name"] for c in routed["clean"]))


if __name__ == "__main__":
    # Fully data-driven: only velocity + gaps + (data-derived) hot themes. No manual relevance/anchors.
    hot_themes = {"compute & chips", "frontier labs"}
    demo = [
        {"name": "OpenAI", "velocity": 32, "gaps": ["STRUCTURAL"], "themes": ["frontier labs"]},
        {"name": "Amazon", "velocity": 17, "gaps": ["STRUCTURAL"]},
        {"name": "Mythos", "velocity": 4, "gaps": ["COVERAGE"], "themes": ["frontier labs"]},
        {"name": "XCENA", "velocity": 14, "gaps": ["COVERAGE"], "themes": ["compute & chips"]},
        {"name": "Claude Opus 4.8", "velocity": 6, "gaps": ["DEPTH"], "themes": ["frontier labs"]},
        {"name": "Robinhood", "velocity": 19, "gaps": ["COVERAGE"]},   # off-theme: high trend, no theme-fit
        {"name": "Nvidia", "velocity": 23, "gaps": ["clean"]},
    ]
    render(route(demo, hot_themes=hot_themes))
