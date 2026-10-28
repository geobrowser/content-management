#!/usr/bin/env python3
"""
theme_gaps.py — theme-level gap diagnostic (Stage 5b).

For each hot theme, resolve whether the target space has a developed Topic for it —
emitting a theme-level gap (Coverage / Structural / Depth at Topic altitude). These
become theme Gap findings (structuring work: create / attach / develop a topic page).

Resolution is EXACT-name + Topic-type-filtered. At scale (crypto produced many themes)
the name→Topic resolution is BATCHED via GraphQL aliases — one POST per ~8 themes
instead of one per theme — so Stage 5b finishes in seconds, not a flaky multi-minute
crawl. The structure check (1 query) runs only for topics that exist in-space (few).

Usage:
    python theme_gaps.py --in harvest.json --space <space_id> [--min-heat 2] [--top 20]
"""
from __future__ import annotations
import argparse, json
from collections import Counter
from gap_diagnostic import gql, _esc   # reuse the client
from theme_heat import themes          # reuse the clustering

TOPIC_TYPE = "5ef5a5860f274d8e8f6c59ae5b3e89e2"  # geo-root Topic


def _topic_q_alias(alias, name, space_id):
    # SPACE-SCOPED — the unscoped Topic-by-name query times out against geo-root's huge
    # Topic index (~94s → fail); scoping to the target space returns in ~1s.
    return (f'{alias}: entitiesConnection(typeId:"{TOPIC_TYPE}", spaceId:"{space_id}", first:5, '
            f'filter:{{name:{{isInsensitive:"{_esc(name)}"}}}}){{ nodes {{ id name }} }}')


def resolve_topics_batched(names, space_id, chunk=8):
    """{name_lower: [in-space topic nodes] or None-on-error} — scoped, aliased, per-chunk retry."""
    out = {}
    for i in range(0, len(names), chunk):
        part = names[i:i + chunk]
        sub = " ".join(_topic_q_alias(f"r{j}", n, space_id) for j, n in enumerate(part))
        try:
            data = gql("{ " + sub + " }")
            for j, n in enumerate(part):
                out[n.lower()] = (data.get(f"r{j}") or {}).get("nodes") or []
        except Exception:
            for n in part:
                try:
                    q = "{ " + _topic_q_alias("r", n, space_id) + " }"
                    out[n.lower()] = (gql(q).get("r") or {}).get("nodes") or []
                except Exception:
                    out[n.lower()] = None
    return out


def _classify(name, space_id, in_space):
    # `in_space` = topics of this name already in the target space (space-scoped query).
    if in_space is None:
        return None, "query error (skipped)"
    if not in_space:
        # Absent from this space. Whether it exists elsewhere (create-in-space) or nowhere
        # (create new) is the curator's intake preflight — we don't pay the slow global query.
        return "STRUCTURAL", "Topic not in this space — bring it in (Create-in-space if it exists elsewhere, else create) and develop the page"
    eid = in_space[0]["id"]
    try:
        r = (gql(f'{{ entity(id:"{eid}"){{ relations(first:120){{ nodes {{ type {{ name }} }} }} }} }}') or {}).get("entity") or {}
        rc = Counter((x.get("type") or {}).get("name") for x in (r.get("relations") or {}).get("nodes") or [])
    except Exception:
        return None, "structure check error"
    members = rc.get("Related entities", 0) + rc.get("Related projects", 0) + rc.get("Related people", 0)
    page = "Blocks" in rc or "Tabs" in rc
    if members < 3 and not page:
        return "DEPTH", f"Topic exists in-space but thin (subtopics={rc.get('Subtopics',0)} members={members} page=no) — develop it"
    return None, f"Topic developed (subtopics={rc.get('Subtopics',0)} members={members} page={page})"


def diagnose_themes(names, space_id):
    """Batched + space-scoped: returns [{theme, gap, detail}] for the given theme names."""
    resolved = resolve_topics_batched(list(names), space_id)
    out = []
    for nm in names:
        gap, detail = _classify(nm, space_id, resolved.get(nm.lower()))
        out.append({"theme": nm, "gap": gap, "detail": detail})
    return out


def diagnose_theme(name, space_id):  # back-compat single-theme path
    return tuple(diagnose_themes([name], space_id)[0][k] for k in ("gap", "detail"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default="harvest.json")
    ap.add_argument("--space", required=True)
    ap.add_argument("--min-heat", type=int, default=2)
    ap.add_argument("--top", type=int, default=20, help="cap: diagnose the top-N themes by heat")
    a = ap.parse_args()
    docs = json.load(open(a.inp))
    rows = [r for r in themes(docs) if (r["news"] + r["pod"]) >= a.min_heat]
    rows.sort(key=lambda r: -(r["news"] + r["pod"]))
    capped = rows[:a.top]
    if len(rows) > a.top:
        print(f"(capped to top {a.top} of {len(rows)} themes by heat)")
    res = {d["theme"]: d for d in diagnose_themes([r["theme"] for r in capped], a.space)}
    print(f"{'theme':40}{'heat':>5}  theme-gap -> action")
    print("-" * 90)
    for r in capped:
        d = res[r["theme"]]
        tag = f"{d['gap']}(theme)" if d["gap"] else "—ok—"
        print(f"{r['theme'][:40]:40}{r['news']+r['pod']:>5}  {tag}: {d['detail']}")
