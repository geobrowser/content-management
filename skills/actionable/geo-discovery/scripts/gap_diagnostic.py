#!/usr/bin/env python3
"""
gap_diagnostic.py — the hardened multi-gap diagnostic for the AI space.

Given a candidate name, resolves it ROBUSTLY (exact-name, never substring) and
runs all five gap checks. Existence != no gap: an entity that exists can still be
thin (depth), stale (freshness), or mistyped/duplicated (structural).

This is the linchpin of the discovery engine (see ../../CLAUDE.md §6). Naive
substring search produces garbage in both directions — it buries popular names
(OpenAI has 800+ substring matches) AND over-narrow type filters miss broad
geo-root types. Exact-name (`isInsensitive`) + full-type resolution is the fix.

Usage:
    python gap_diagnostic.py "OpenAI" "XCENA" "Claude Opus 4.8"
    # or import: from gap_diagnostic import diagnose

No auth needed (read-only). Endpoint is Geo testnet.
"""
from __future__ import annotations
import json, sys, time, urllib.request, urllib.error

ENDPOINT = "https://testnet-api.geobrowser.io/graphql"
AI_SPACE = "41e851610e13a19441c4d980f2f2ce6b"

# Entities that count as a real "identity" for a candidate (not assertion/media noise).
IDENTITY = {"Project", "Company", "Lab", "Provider", "Organization", "Person", "Model",
            "Model family", "Agent", "Tool", "Dataset", "Benchmark", "Topic",
            "Computing hardware", "Hardware device"}
# Types that legitimately share a name but are NOT the entity (noise that buries search).
NOISE = {"Claim", "Article", "Quote", "Data block", "Image", "Tweet", "Post",
         "News story", "News event", "Evaluation"}

# Thresholds (tune against real runs — see CLAUDE.md §14.7).
DEPTH_MIN = 5      # meaningful relations below this = depth gap
STALE_DAYS = 30    # entity untouched longer than this + trending = freshness gap
TREND_FLOOR = 5    # claim mentions at/above this = "trending now" (freshness check)
TREND_TAG_FLOOR = 15  # velocity at/above this adds the secondary "TRENDING" gap tag

# Identity-type IDs — used to type-scope the fuzzy fallback so it never buries
# (substring "OpenAI" = 1596 all-types, but 5 identity-typed). Keep in sync with IDENTITY.
IDENTITY_TYPE_IDS = [
    "c7a4fc6d1afc53250a22d4209391dc79",  # Model
    "bdfa487660d4628c6a1660410f18262f",  # Model family
    "d44415aeaff1218c4035fe9a3791aff5",  # Provider
    "fa464fe0c27b4d54bbac4caa20ca7781",  # Tool
    "0c4babfb43893486af827341bbf32e09",  # Dataset
    "a7f1e5c799a04089e8741f412f135f42",  # Benchmark
    "f3c1c8687bed9cb15800e5c8ff38033d",  # Lab
    "9069cd7680cabc7b5e7aace5bc0da4d3",  # Agent
    "5ef5a5860f274d8e8f6c59ae5b3e89e2",  # Topic
    "7ed45f2bc48b419e8e4664d5ff680b0d",  # Person
    "484a18c5030a499cb0f2ef588ff16d50",  # Project
    "b9a456d44ee44f418f9cca322871cafa",  # Project (variant)
    "e059a29e6f6b437bbc15c7983d078c0d",  # Company
    "9547f4fb78744de0a9a9fdd7b4c01c0c",  # Organization
]
TYPES_REL = "8f151ba4de204e3c9cb499ddf96f48f1"   # the Types relation property
_DASHES = "-‐‑‒–—―−"  # hyphen, NB-hyphen, en/em dash, minus…
_STOP = {"ai", "the", "of", "and", "an", "a"}

# Per-space identity types are AUTO-DERIVED from the graph (space_profile.py) so the
# diagnostic works on any space with no hand-tuning. The AI constants above are the
# fallback if profiling is unavailable. Cached per space.
_IDENT_CACHE: dict = {}


def _identity_for(space_id: str):
    """(identity_name_set, identity_type_id_list) for a space — derived, AI-fallback."""
    if space_id in _IDENT_CACHE:
        return _IDENT_CACHE[space_id]
    names, ids = set(IDENTITY), list(IDENTITY_TYPE_IDS)
    try:
        try:
            from space_profile import profile
        except ImportError:
            import os
            sys.path.insert(0, os.path.dirname(__file__))
            from space_profile import profile
        p = profile(space_id)
        if p.get("identity_type_ids"):
            names, ids = set(p["identity_type_names"]), p["identity_type_ids"]
    except Exception:
        pass
    _IDENT_CACHE[space_id] = (names, ids)
    return _IDENT_CACHE[space_id]


def gql(query: str, retries: int = 3, backoff: float = 1.5) -> dict:
    body = json.dumps({"query": query}).encode()
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(
                ENDPOINT, data=body,
                headers={"Content-Type": "application/json", "Accept-Encoding": "identity"})
            with urllib.request.urlopen(req, timeout=30) as r:
                payload = json.loads(r.read().decode())
            if "errors" in payload:
                raise RuntimeError(payload["errors"])
            return payload.get("data", {})
        except (urllib.error.URLError, TimeoutError, urllib.error.HTTPError) as e:
            last = e
            if i < retries - 1:
                time.sleep(backoff ** i)
    raise RuntimeError(f"GraphQL failed after {retries}: {last}")


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


import unicodedata


def _norm(s: str) -> str:
    """Normalize a name for comparison: NFKC, fold all dash-confusables to '-',
    smart-quotes to straight, collapse whitespace, lowercase. This is why exact
    server matches miss real entities (e.g. 'GPT‑5.5' with U+2011 hyphen)."""
    s = unicodedata.normalize("NFKC", s or "")
    for d in _DASHES:
        s = s.replace(d, "-")
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = s.replace(" ", " ")
    return " ".join(s.lower().split())


def _variants(name: str):
    """Dash/space variant spellings to query exactly (catches unicode-hyphen names)."""
    vs = set()
    if any(c in name for c in _DASHES):
        base = name
        for d in _DASHES:
            base = base.replace(d, "\x00")
        for s in list(_DASHES) + [" "]:
            vs.add(base.replace("\x00", s))
    if " " in name:
        for s in "-‑–":
            vs.add(name.replace(" ", s))
    vs.discard(name)
    return list(vs)[:8]


def _token_subset(cand_n: str, name_n: str) -> bool:
    """True if the (normalized) candidate is a whole-token subset of a (normalized)
    longer name — e.g. 'mythos' inside 'claude mythos preview'. Guards short/common."""
    if len(cand_n) < 4 or cand_n in _STOP:
        return False
    ctoks = cand_n.replace("-", " ").split()
    ntoks = set(name_n.replace("-", " ").split())
    return bool(ctoks) and all(t in ntoks for t in ctoks)


_FULL = ('id name updatedAt types { name } '
         'values(first:60){ nodes { property { name } text } } '
         'relations(first:200){ nodes { type { name } } }')


def _fuzzy_identity(candidate: str, space_id: str = AI_SPACE,
                    identity_names=None, identity_ids=None):
    """Fallback when exact-name finds no identity entity. Returns [(entity, kind)] where
    kind is 'exact' (same entity, format variant) or 'token' (candidate is a token in a
    longer/related entity name). Type-scoped → no burial."""
    if identity_names is None or identity_ids is None:
        identity_names, identity_ids = _identity_for(space_id)
    cand_n = _norm(candidate)
    out = {}
    # 1. variant exact queries — catch unicode-dash / space spellings (GPT‑5.5)
    for v in _variants(candidate):
        q = (f'{{ entitiesConnection(spaceId:"{space_id}", first:20, '
             f'filter:{{name:{{isInsensitive:"{_esc(v)}"}}}}){{ nodes {{ {_FULL} }} }} }}')
        for e in (gql(q).get("entitiesConnection") or {}).get("nodes") or []:
            if any(t["name"] in identity_names for t in (e.get("types") or [])) and _norm(e["name"]) == cand_n:
                out[e["id"]] = (e, "exact")
    # 2. type-scoped substring — catch token containment (Mythos in 'Claude Mythos Preview')
    inlist = ",".join(f'"{i}"' for i in identity_ids)
    q = (f'{{ entitiesConnection(spaceId:"{space_id}", first:25, filter:{{ '
         f'name:{{includesInsensitive:"{_esc(candidate)}"}}, '
         f'relations:{{some:{{typeId:{{is:"{TYPES_REL}"}}, toEntityId:{{in:[{inlist}]}}}}}} }})'
         f'{{ nodes {{ {_FULL} }} }} }}')
    try:
        for e in (gql(q).get("entitiesConnection") or {}).get("nodes") or []:
            en = _norm(e["name"])
            if en == cand_n:
                out.setdefault(e["id"], (e, "exact"))
            elif _token_subset(cand_n, en):
                out.setdefault(e["id"], (e, "token"))
    except Exception:
        pass
    return list(out.values())


def exact_entities(name: str, space_id: str = AI_SPACE) -> list[dict]:
    """ALL entities in the space whose name == `name` (case-insensitive). No burial.
    Returns nodes with types, timestamps, values, relation-type list."""
    q = (f'{{ entitiesConnection(spaceId:"{space_id}", first:100, '
         f'filter:{{name:{{isInsensitive:"{_esc(name)}"}}}}) '
         f'{{ nodes {{ id name updatedAt types {{ name }} '
         f'values(first:60){{ nodes {{ property {{ name }} text }} }} '
         f'relations(first:200){{ nodes {{ type {{ name }} }} }} }} }} }}')
    return (gql(q).get("entitiesConnection") or {}).get("nodes") or []


def _meaningful_rels(e: dict) -> int:
    skip = {"Types", "Cover", "Avatar", "Blocks"}
    return len([r for r in (e.get("relations") or {}).get("nodes") or []
                if (r.get("type") or {}).get("name") not in skip])


def diagnose(name: str, space_id: str = AI_SPACE, velocity: int = 0) -> dict:
    """Run all five gap checks on a candidate. Returns:
    {candidate, gaps[], canonical, all_named[], detail{}}.  gaps can be multiple."""
    identity_names, identity_ids = _identity_for(space_id)
    ents = exact_entities(name, space_id)
    ident = [e for e in ents if any(t["name"] in identity_names for t in (e.get("types") or []))]
    all_named = [f"{e['name']}[{','.join(t['name'] for t in (e.get('types') or []))}]" for e in ents]

    related = []
    if not ident:
        # exact-name found nothing — try the normalized + type-scoped fuzzy fallback
        # (catches unicode-dash variants like 'GPT‑5.5' and tokens like 'Mythos' in
        #  'Claude Mythos Preview'). Without this, both false-positive as COVERAGE.
        fuzzy = _fuzzy_identity(name, space_id, identity_names, identity_ids)
        ident = [e for e, k in fuzzy if k == "exact"]      # same entity, format variant -> NOT a gap
        related = [e for e, k in fuzzy if k == "token"]    # related/longer-name entity -> flag, don't duplicate
        if ident:
            all_named = [f"{e['name']}[{','.join(t['name'] for t in (e.get('types') or []))}]" for e in ident]

    if not ident:
        gaps = ["COVERAGE"]
        if velocity >= TREND_TAG_FLOOR:
            gaps.append("TRENDING")
        detail = {"coverage": "no identity entity (exact or fuzzy)"}
        canonical = None
        if related:
            r = related[0]
            detail["related"] = ("⚠ related entity exists: "
                f"{r['name']} [{','.join(t['name'] for t in (r.get('types') or []))}] ({r['id']}) "
                "— review: add type / enrich vs create new; do NOT duplicate")
            detail["related_id"] = r["id"]
            canonical = r
        return {"candidate": name, "gaps": gaps, "canonical": canonical,
                "all_named": all_named, "detail": detail}

    best = max(ident, key=_meaningful_rels)
    br = _meaningful_rels(best)
    types = [t["name"] for t in (best.get("types") or [])]
    gaps, detail = [], {"canonical": f"{best['name']} [{','.join(types)}] {br} rels", "id": best["id"]}

    # STRUCTURAL — (a) >1 same-name identity entity (dedup/merge), OR
    #             (b) a type attached more than once to ONE entity ([Lab,Lab]) — §6 STEP 2.
    dup_types = sorted({t for t in types if types.count(t) > 1})
    if len(ident) > 1 or dup_types:
        gaps.append("STRUCTURAL")
        if len(ident) > 1:
            detail["structural"] = "multiple same-name identity entities: " + " | ".join(all_named)
            # Emit the resolved IDs so Stage 6 can write the merge action without re-resolving.
            detail["dup_ids"] = [{"id": e["id"], "name": e["name"],
                                  "types": [t["name"] for t in (e.get("types") or [])],
                                  "rels": _meaningful_rels(e)} for e in ident]
            detail["canonical_id"] = best["id"]
        if dup_types:
            detail["structural_duptype"] = f"duplicated type(s) on one entity: {dup_types} ({best['name']} [{','.join(types)}])"

    # DEPTH — thin, or missing Description / Avatar
    vals = {(v.get("property") or {}).get("name") for v in (best.get("values") or {}).get("nodes") or []}
    rels = {(r.get("type") or {}).get("name") for r in (best.get("relations") or {}).get("nodes") or []}
    miss = []
    if "Description" not in vals:
        miss.append("Description")
    if "Avatar" not in rels and any(t in ("Project", "Company", "Lab", "Provider", "Person", "Organization") for t in types):
        miss.append("Avatar")
    if br < DEPTH_MIN or miss:
        gaps.append("DEPTH")
        detail["depth"] = f"{br} rels" + (f"; missing {miss}" if miss else "")

    # FRESHNESS — trending now but content stale (WEAK: updatedAt is bumped by any edit)
    try:
        from datetime import datetime, timezone
        upd = datetime.fromtimestamp(int(best.get("updatedAt")), tz=timezone.utc)
        age = (datetime.now(timezone.utc) - upd).days
        detail["age_days"] = age
        if velocity >= TREND_FLOOR and age > STALE_DAYS:
            gaps.append("FRESHNESS")
            detail["freshness"] = f"trending ({velocity}) but untouched {age}d"
    except Exception:
        pass

    # TRENDING — secondary multi-value tag: a real gap that's also hot right now.
    # (Not a standalone gap; only tags candidates that already have a gap.)
    if gaps and velocity >= TREND_TAG_FLOOR:
        gaps.append("TRENDING")
        detail["trending"] = f"velocity {velocity} >= {TREND_TAG_FLOOR}"

    return {"candidate": name, "gaps": gaps or ["clean"], "canonical": best,
            "all_named": all_named, "detail": detail}


if __name__ == "__main__":
    names = sys.argv[1:] or ["OpenAI", "XCENA", "Claude Opus 4.8"]
    for nm in names:
        d = diagnose(nm)
        print(f"\n{nm}: {','.join(d['gaps'])}")
        for k, v in d["detail"].items():
            print(f"    {k}: {v}")
