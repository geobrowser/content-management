#!/usr/bin/env python3
"""
helpers.py — the small on-demand primitives behind ontology-advisor.

Each function answers ONE conversational question. Claude reaches for them
from the playbook in SKILL.md when the user's request needs to be grounded
in live graph data. Read-only. Returns plain dicts/lists so the answer text
is easy to compose around them.

The judgment layer is ONTOLOGY.md; the mechanical layer is rules.json (via
lint.py); these helpers are the ground-truth layer. If the live graph and
rules.json disagree, trust the graph.

Endpoint: https://testnet-api.geobrowser.io/graphql (no auth needed for reads).
"""
from __future__ import annotations
import csv
import json
import os
from typing import Any

import geo_graphql as g
from lint import Linter


class SpaceNotFound(ValueError):
    """Raised when a space_id does not resolve to a real space.
    Lets the playbook distinguish 'bad ID' from 'empty space'."""


# ---------------------------------------------------------------------------
# Space-tier classification — load canonical space IDs from rules.json so
# search results can be sorted/filtered by reuse priority. Without this every
# `find_similar_*` call mixes geo-root canonical entities with personal-space
# junk and the model has to disambiguate by hand.
#
#   tier 0 = geo-root      (highest reuse priority)
#   tier 1 = canonical domain space (crypto, ai, health, world-affairs, technology)
#   tier 2 = other / personal / unknown
# ---------------------------------------------------------------------------

_RULES_PATH = os.path.join(os.path.dirname(__file__), "..", "references", "rules.json")
try:
    with open(_RULES_PATH) as _f:
        _RULES = json.load(_f)
    _CANON = _RULES.get("canonical_space_ids", {}) or {}
except Exception:
    _CANON = {}

GEO_ROOT_ID: str | None = (_CANON.get("geo-root") or {}).get("id")
CANONICAL_SPACE_IDS: set[str] = {
    v["id"] for v in _CANON.values() if isinstance(v, dict) and "id" in v
}
SPACE_ID_TO_NAME: dict[str, str] = {
    v["id"]: name for name, v in _CANON.items() if isinstance(v, dict) and "id" in v
}


def _space_tier(space_id: str | None) -> int:
    if not space_id:
        return 2
    if space_id == GEO_ROOT_ID:
        return 0
    if space_id in CANONICAL_SPACE_IDS:
        return 1
    return 2


def _best_tier(space_ids: list[str] | None) -> tuple[int, str]:
    """Best (lowest) tier across an entity's spaceIds + the matching short label.
    Empty spaceIds → tier 2 / 'other'."""
    if not space_ids:
        return 2, "other"
    best_tier = 2
    best_label = "other"
    for sid in space_ids:
        tier = _space_tier(sid)
        if tier < best_tier:
            best_tier = tier
            best_label = SPACE_ID_TO_NAME.get(sid, "other")
    return best_tier, best_label


# ---------------------------------------------------------------------------
# 0. space_exists — "is this a real space?"
# ---------------------------------------------------------------------------

def space_exists(space_id: str) -> bool:
    """True if `space(id:)` resolves. Use before reporting '0 types' so the
    user knows whether their ID is wrong or the space is genuinely empty."""
    sid = (space_id or "").strip()
    if not sid:
        return False
    r = g.gql(f'{{ space(id: "{sid}") {{ id }} }}')
    return bool((r or {}).get("space"))


# ---------------------------------------------------------------------------
# 1. list_types_in_space — "what types are in space X?"
# ---------------------------------------------------------------------------

def list_types_in_space(space_id: str) -> list[dict]:
    """Every Type used in the space with its in-space totalCount.
    Sorted by count desc. Returns [{id, name, totalCount}, ...].

    Raises SpaceNotFound if the space doesn't exist — so '0 types' from this
    helper unambiguously means 'real but empty space', never 'bad ID'."""
    if not space_exists(space_id):
        raise SpaceNotFound(f"Space not found: {space_id!r}")
    return g.list_types_in_space(space_id)


# ---------------------------------------------------------------------------
# 2. summarize_type — "tell me about this type"
# ---------------------------------------------------------------------------

def summarize_type(type_id: str, space_id: str | None = None, sample: int = 5) -> dict:
    """Name, totalCount, declared properties, sample entity names, and the
    per-space Description analysis used by the sample-before-reuse check.

    `description_canonical` is the Description value set in geo-root (the
    authoritative anchor). `description_overrides` lists every other space's
    Description value. `description_drift=True` means no canonical value
    exists but a niche-space override does — the situation that silently
    surfaces a niche description (e.g. baseball's) as if it were canonical.

    With `space_id`: counts and entity samples scoped to that space.
    Without `space_id`: counts and samples GLOBALLY — required for the
    sample-before-reuse check, where the point is to confirm semantic
    alignment across the whole type."""
    schema = g.get_type_schema(type_id)

    # --- Per-space Description analysis -----------------------------------
    desc_values = []
    try:
        desc_values = g.get_property_values(type_id, g.DESCRIPTION_PROP_ID)
    except Exception:
        pass
    canonical_desc: str | None = None
    overrides: list[dict] = []
    for v in desc_values:
        sid = v.get("spaceId")
        text = (v.get("text") or "").strip()
        if not text:
            continue
        if sid == GEO_ROOT_ID:
            canonical_desc = text
        else:
            label = SPACE_ID_TO_NAME.get(sid, sid[:8] + "…")
            overrides.append({"space_id": sid, "space_label": label, "text": text})
    description_drift = (not canonical_desc) and bool(overrides)

    # Backward-compat `description` field — prefer canonical; fall back to the
    # entity-level value the schema already returned (which can be niche-space
    # — flagged by description_drift so callers can warn).
    legacy_description = canonical_desc or schema.get("description")

    summary: dict = {
        "id": type_id,
        "name": schema.get("name"),
        "description": legacy_description,
        "description_canonical": canonical_desc,
        "description_overrides": overrides,
        "description_drift": description_drift,
        "spaceIds": schema.get("spaceIds", []),
        "properties": schema.get("properties", []),
        "totalCount": None,
        "sample_entities": [],
    }
    try:
        summary["totalCount"] = g.count_entities_of_type(type_id, space_id=space_id)
    except Exception:
        pass
    for i, e in enumerate(g.entities_of_type(type_id, space_id=space_id,
                                              page_size=sample, max_pages=1)):
        summary["sample_entities"].append({"id": e["id"], "name": e.get("name")})
        if i + 1 >= sample:
            break
    return summary


# ---------------------------------------------------------------------------
# 3. find_duplicate_type_names — "any duplicate types?"
# ---------------------------------------------------------------------------

def find_duplicate_type_names(space_id: str) -> list[dict]:
    """In-space + cross-space duplicate Type entities by name.

    Returns a list of {name, scope, ids, in_space_ids?}:
      - scope='in_space' when 2+ Type entities of the same name exist IN this space
      - scope='cross_space' when this space's type also exists as 2+ Type entities globally
    """
    in_space = g.list_types_in_space(space_id)
    findings: list[dict] = []

    # in-space duplicates
    by_name: dict[str, list[dict]] = {}
    for t in in_space:
        by_name.setdefault((t["name"] or "").strip().casefold(), []).append(t)
    for nm, group in by_name.items():
        if len(group) >= 2:
            findings.append({
                "name": group[0]["name"],
                "scope": "in_space",
                "ids": [t["id"] for t in group],
            })

    # cross-space duplicates (look up each in-space type name globally)
    for t in in_space:
        name = (t.get("name") or "").strip()
        if not name:
            continue
        globals_ = g.find_types_by_name(name, first=25)
        norm = name.casefold()
        exact = [c for c in globals_ if (c.get("name") or "").strip().casefold() == norm]
        if len(exact) >= 2:
            findings.append({
                "name": name,
                "scope": "cross_space",
                "ids": [c["id"] for c in exact],
                "in_space_id": t["id"],
            })
    return findings


# ---------------------------------------------------------------------------
# 4. find_similar_types — "does a Hospital type already exist?"
# ---------------------------------------------------------------------------

def find_similar_types(
    name: str,
    space_id: str | None = None,
    first: int = 25,
    canonical_only: bool = False,
) -> list[dict]:
    """Type entities whose name includes the query (case-insensitive). Use this
    before suggesting a NEW type — Principle 5 (No duplication) says check first.

    Results are tier-classified and sorted: geo-root (tier 0) → canonical-domain
    (tier 1) → other (tier 2). `canonical_only=True` drops tier 2 entirely."""
    cands = g.find_types_by_name(name, space_id=space_id, first=first)
    out = []
    for c in cands:
        tier, label = _best_tier(c.get("spaceIds") or [])
        if canonical_only and tier > 1:
            continue
        out.append({**c, "tier": tier, "tier_label": label})
    out.sort(key=lambda r: r["tier"])
    return out


# ---------------------------------------------------------------------------
# 4b. find_similar_properties — "does a Goals property already exist?"
# ---------------------------------------------------------------------------

def find_similar_properties(
    name: str,
    space_id: str | None = None,
    first: int = 10,
    canonical_only: bool = False,
) -> list[dict]:
    """Property entities whose name includes the query (case-insensitive).
    Use before suggesting a NEW property — Principle 8 (reuse canonical names) says
    check first, and rules.json.canonical_property_names lists the most common ones.

    Results are tier-classified and sorted: geo-root (tier 0) → canonical-domain
    (tier 1) → other (tier 2). Set `canonical_only=True` to drop tier-2 results
    (personal-space junk like 'my address').

    Returns [{id, name, spaceIds, data_type, description, tier, tier_label}].
    data_type is resolved from each property's 'Data type' relation (N+1 calls;
    keep first small)."""
    cands = g.search_entities_by_name(
        name, space_id=space_id, type_id=g.PROPERTY_META_ID, first=first
    )
    out = []
    for c in cands:
        tier, label = _best_tier(c.get("spaceIds") or [])
        if canonical_only and tier > 1:
            continue
        ent = g.get_entity(c["id"])
        data_type = None
        description = None
        if ent:
            for r in ((ent.get("relations") or {}).get("nodes") or []):
                if (r.get("type") or {}).get("name") == "Data type":
                    data_type = (r.get("toEntity") or {}).get("name")
                    break
            description = ent.get("description")
        out.append({
            "id": c["id"],
            "name": c.get("name"),
            "spaceIds": c.get("spaceIds") or [],
            "data_type": data_type,
            "description": description,
            "tier": tier,
            "tier_label": label,
        })
    out.sort(key=lambda r: r["tier"])
    return out


# ---------------------------------------------------------------------------
# 4c. list_properties_in_space — "what properties are defined in space X?"
# ---------------------------------------------------------------------------

def list_properties_in_space(space_id: str) -> list[dict]:
    """All Property entities in a space with their data types.
    Returns [{id, name, data_type}] sorted by name — useful for multi-space
    export, drift checks, and answering 'does a property like X exist here?'.

    Uses entity_value_scan internally so the Data type relation is fetched in
    the same batch query (no N+1 penalty)."""
    if not space_exists(space_id):
        raise SpaceNotFound(f"Space not found: {space_id!r}")
    out = []
    for e in g.entity_value_scan(
        g.PROPERTY_META_ID, space_id=space_id,
        page_size=100, max_pages=50,
        values_first=5, relations_first=10,
    ):
        data_type = None
        for r in e["relations"]:
            if (r.get("type") or {}).get("name") == "Data type":
                data_type = (r.get("toEntity") or {}).get("name")
                break
        out.append({"id": e["id"], "name": e.get("name"), "data_type": data_type})
    out.sort(key=lambda r: (r.get("name") or "").casefold())
    return out


# ---------------------------------------------------------------------------
# 5. entities_missing — "which entities of type X are missing Y?"
# ---------------------------------------------------------------------------

def entities_missing(
    type_id: str,
    field: str,
    space_id: str | None = None,
    limit: int = 50,
) -> dict:
    """List entities of `type_id` that lack `field`. `field` is matched case-
    insensitively against value-property names AND relation type names — so
    'description' catches a missing Description text value and 'sources' catches
    a missing Sources relation.

    Returns {checked, missing: [{id, name}], truncated_at}."""
    f = field.strip().casefold()
    checked = 0
    missing: list[dict] = []
    for e in g.entity_value_scan(type_id, space_id=space_id,
                                  page_size=25,
                                  max_pages=max(1, (limit // 25) * 4 + 1),
                                  values_first=50, relations_first=50):
        checked += 1
        has = False
        for v in e["values"]:
            pn = ((v.get("property") or {}).get("name") or "").strip().casefold()
            if pn == f and any(v.get(k) is not None
                                for k in ("text", "date", "boolean", "decimal", "integer", "float")):
                has = True
                break
        if not has:
            for r in e["relations"]:
                tn = ((r.get("type") or {}).get("name") or "").strip().casefold()
                if tn == f:
                    has = True
                    break
        if not has:
            missing.append({"id": e["id"], "name": e.get("name")})
            if len(missing) >= limit:
                break
    return {"checked": checked, "missing": missing, "truncated_at": limit}


# ---------------------------------------------------------------------------
# 6. sample_values_for_property — "how is this property actually used?"
# ---------------------------------------------------------------------------

def sample_values_for_property(
    type_id: str,
    property_name: str,
    space_id: str | None = None,
    n: int = 10,
) -> list[dict]:
    """Up to n recorded values for `property_name` on entities of `type_id`,
    so the user can see how the property is actually populated. Includes both
    value-properties (text/number/etc.) and relations (toEntity name + type).
    Returns [{entity_id, entity_name, value? | relation_target?}, ...]."""
    target = property_name.strip().casefold()
    out: list[dict] = []
    for e in g.entity_value_scan(type_id, space_id=space_id,
                                  page_size=25, max_pages=20,
                                  values_first=50, relations_first=50):
        if len(out) >= n:
            break
        # check values first
        for v in e["values"]:
            pn = ((v.get("property") or {}).get("name") or "").strip().casefold()
            if pn != target:
                continue
            for k in ("text", "date", "boolean", "decimal", "integer", "float"):
                if v.get(k) is not None:
                    out.append({"entity_id": e["id"], "entity_name": e.get("name"),
                                "value": v[k], "kind": k})
                    break
            if len(out) >= n:
                break
        if len(out) >= n:
            break
        # then relations
        for r in e["relations"]:
            tn = ((r.get("type") or {}).get("name") or "").strip().casefold()
            if tn != target:
                continue
            te = r.get("toEntity") or {}
            out.append({
                "entity_id": e["id"], "entity_name": e.get("name"),
                "relation_target": {
                    "id": te.get("id"), "name": te.get("name"),
                    "types": [t.get("name") for t in (te.get("types") or [])],
                },
                "kind": "relation",
            })
            if len(out) >= n:
                break
    return out


# ---------------------------------------------------------------------------
# 7. value_looks_like_existing_entity — "should this be a relation?"
# ---------------------------------------------------------------------------

def value_looks_like_existing_entity(
    text: str, space_id: str | None = None
) -> list[dict]:
    """Search the graph for an entity whose name exactly matches `text`. If we
    find any, the caller can recommend converting the text value to a relation
    (Principle 3). Returns up to 10 matches: [{id, name, types[]}].

    The API's name filter is substring-based (includesInsensitive), so a common
    word can return 25 unrelated headlines containing it. We pull a larger
    candidate set and keep only case-insensitive EXACT matches. If nothing
    exact in the scoped space, retry unscoped — the entity may live in a
    sibling space."""
    text = (text or "").strip()
    if not text:
        return []
    norm = text.casefold()
    cands = g.search_entities_by_name(text, space_id=space_id, first=100)
    exact = [c for c in cands if (c.get("name") or "").strip().casefold() == norm]
    if not exact and space_id:
        cands = g.search_entities_by_name(text, first=100)
        exact = [c for c in cands if (c.get("name") or "").strip().casefold() == norm]

    out = []
    for c in exact:
        # dedupe type names — entities tagged with the same type in multiple
        # spaces would otherwise show as ['Topic','Topic','Topic',...]
        seen_types: list[str] = []
        for t in (c.get("types") or []):
            tn = t.get("name")
            if tn and tn not in seen_types:
                seen_types.append(tn)
        tier, label = _best_tier(c.get("spaceIds") or [])
        out.append({
            "id": c["id"],
            "name": c.get("name"),
            "types": seen_types,
            "spaceIds": c.get("spaceIds") or [],
            "tier": tier,
            "tier_label": label,
        })
    out.sort(key=lambda r: r["tier"])
    return out[:10]


# ---------------------------------------------------------------------------
# 8. types_to_csv — "export the types in this space as a CSV"
# ---------------------------------------------------------------------------

def types_to_csv(space_id: str, out_path: str) -> str:
    """Write [id, name, totalCount] for every type in the space to a CSV.
    Returns the absolute output path."""
    rows = g.list_types_in_space(space_id)
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "totalCount"])
        for r in rows:
            w.writerow([r.get("id"), r.get("name"), r.get("totalCount")])
    return out_path


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    CRYPTO = "c9f267dcb0d270718c2a3c45a64afd32"
    PROJECT_CRYPTO = "484a18c5030a499cb0f2ef588ff16d50"

    print("=== list_types_in_space(crypto) — top 5 ===")
    for t in list_types_in_space(CRYPTO)[:5]:
        print(f"  {t['totalCount']:>5}  {t['name']}")

    print("\n=== summarize_type(Project) ===")
    s = summarize_type(PROJECT_CRYPTO, space_id=CRYPTO, sample=3)
    print(f"  name={s['name']}  totalCount={s['totalCount']}")
    print(f"  properties ({len(s['properties'])}): " +
          ", ".join(p['name'] or '?' for p in s['properties'][:8]))
    print(f"  sample: " + "; ".join(e['name'] for e in s['sample_entities']))

    print("\n=== find_duplicate_type_names(crypto) — first 5 ===")
    for d in find_duplicate_type_names(CRYPTO)[:5]:
        print(f"  [{d['scope']}] {d['name']}: {len(d['ids'])} ids")

    print("\n=== find_similar_types('Hospital') ===")
    for t in find_similar_types("Hospital")[:5]:
        sp = len(t.get("spaceIds") or [])
        print(f"  {t['id']}  {t['name']}  (in {sp} space{'s' if sp != 1 else ''})")

    print("\n=== entities_missing(Project, 'description', crypto, limit=5) ===")
    m = entities_missing(PROJECT_CRYPTO, "description", space_id=CRYPTO, limit=5)
    print(f"  checked={m['checked']}, missing={len(m['missing'])}")
    for e in m["missing"][:3]:
        print(f"    {e['id'][:12]}…  {e['name']}")

    print("\n=== sample_values_for_property(Project, 'Website', crypto) ===")
    for v in sample_values_for_property(PROJECT_CRYPTO, "Website", space_id=CRYPTO, n=3):
        if "value" in v:
            print(f"  {v['entity_name']}: {v['value']}")
        elif "relation_target" in v:
            print(f"  {v['entity_name']} → {v['relation_target']['name']}")

    print("\n=== value_looks_like_existing_entity('Ethereum', crypto) ===")
    for hit in value_looks_like_existing_entity("Ethereum", space_id=CRYPTO):
        print(f"  {hit['id']}  {hit['name']}  types={hit['types']}")

    print("\n=== types_to_csv ===")
    p = types_to_csv(CRYPTO, "/tmp/ontology-advisor-smoke/crypto_types.csv")
    print(f"  wrote {p}")

    print("\n=== find_similar_properties('Goals') ===")
    for prop in find_similar_properties("Goals")[:5]:
        print(f"  {prop['id'][:12]}…  {prop['name']}  type={prop['data_type']}  desc={str(prop['description'])[:60]}")

    print("\n=== list_properties_in_space(crypto) — first 5 ===")
    props = list_properties_in_space(CRYPTO)
    print(f"  total: {len(props)}")
    for p in props[:5]:
        print(f"  {p['id'][:12]}…  {p['name']}  type={p['data_type']}")
