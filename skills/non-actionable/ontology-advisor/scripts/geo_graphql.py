#!/usr/bin/env python3
"""
geo_graphql.py — thin client + query helpers for the Geo knowledge graph.

Shared by the dataset-validator (and, later, the graph-health auditor).
Authoritative source for live schemas and entity IDs. No auth needed for reads.

Endpoint: https://testnet-api.geobrowser.io/graphql

Key gotchas baked in (see geo-query skill for the full list):
  - `entities(...)` returns a FLAT array (no { nodes }).
  - typeId / spaceId are TOP-LEVEL args, not inside `filter`.
  - name filter uses StringFilter: includesInsensitive / startsWithInsensitive (NOT equalTo).
  - id filter uses UUIDFilter: is / isNot / in.
  - values come back as typed fields (text/date/boolean/decimal/integer/float).
"""
from __future__ import annotations
import json
import time
import urllib.request
import urllib.error
from typing import Any

ENDPOINT = "https://testnet-api.geobrowser.io/graphql"

# Meta type IDs (stable, from the geo-query skill)
TYPE_META_ID = "e7d737c536764c609fa16aa64a8c90ad"      # the type of types
PROPERTY_META_ID = "808a04ceb21c4d888ad12e240613e5ca"  # the type of properties
DESCRIPTION_PROP_ID = "9b1f76ff9711404c861e59dc3fa7d037"  # the canonical Description property


def gql(query: str, retries: int = 3, backoff: float = 1.5) -> dict[str, Any]:
    """POST a GraphQL query; return the parsed `data` dict. Raises on hard error."""
    body = json.dumps({"query": query}).encode("utf-8")
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                ENDPOINT,
                data=body,
                headers={"Content-Type": "application/json", "Accept-Encoding": "identity"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            if "errors" in payload:
                # validation errors won't fix on retry — surface immediately
                raise RuntimeError(f"GraphQL errors: {payload['errors']}")
            return payload.get("data", {})
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(backoff ** attempt)
    raise RuntimeError(f"GraphQL request failed after {retries} attempts: {last_err}")


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def search_entities_by_name(
    name: str, space_id: str | None = None, type_id: str | None = None, first: int = 25
) -> list[dict]:
    """Case-insensitive name search, optionally scoped by space and/or type.
    Returns flat list of {id, name, spaceIds, types[]}."""
    args = [f'filter: {{ name: {{ includesInsensitive: "{_esc(name)}" }} }}', f"first: {first}"]
    if space_id:
        args.insert(0, f'spaceId: "{space_id}"')
    if type_id:
        args.insert(0, f'typeId: "{type_id}"')
    q = f"{{ entities({', '.join(args)}) {{ id name spaceIds types {{ id name }} }} }}"
    return gql(q).get("entities", []) or []


def get_property_values(entity_id: str, property_id: str, first: int = 50) -> list[dict]:
    """Return every Value record for (entity, property) across ALL spaces — each
    carries the `spaceId` that set it. The plain `entity.description` field
    aggregates these into a single value with no space attribution, which can
    silently surface a niche-space override as if it were canonical (e.g.
    the canonical Person type's description leaking the baseball-space value
    when no value is set in geo-root). Use this whenever description drift
    matters."""
    q = (
        '{ values(filter: {entityId: {is: "%s"}, propertyId: {is: "%s"}}, '
        'first: %d) { id spaceId text } }' % (entity_id, property_id, first)
    )
    return gql(q).get("values") or []


def get_entity(entity_id: str) -> dict | None:
    """Full single-entity fetch: types, values (typed fields), relations."""
    q = f"""{{
      entity(id: "{entity_id}") {{
        id name description spaceIds
        types {{ id name }}
        values(first: 200) {{ nodes {{ property {{ id name }} text date boolean decimal integer float }} }}
        relations(first: 200) {{ nodes {{ id entityId type {{ id name }} toEntity {{ id name types {{ id name }} }} }} }}
      }}
    }}"""
    return gql(q).get("entity")


def get_type_schema(type_id: str) -> dict:
    """Resolve a type entity and the property names/ids it declares via its Properties relations.
    Returns {id, name, description, spaceIds, properties: [{id, name}]}.
    Description is the highest-signal field for semantic-alignment checks
    (e.g. canonical `Skill`'s description spells out 'human practice' explicitly)."""
    ent = get_entity(type_id)
    if not ent:
        return {"id": type_id, "name": None, "description": None, "spaceIds": [], "properties": []}
    props = []
    for r in (ent.get("relations", {}).get("nodes") or []):
        if (r.get("type") or {}).get("name") == "Properties" and r.get("toEntity"):
            props.append({"id": r["toEntity"]["id"], "name": r["toEntity"]["name"]})
    return {
        "id": ent["id"],
        "name": ent.get("name"),
        "description": ent.get("description"),
        "spaceIds": ent.get("spaceIds") or [],
        "properties": props,
    }


def find_types_by_name(name: str, space_id: str | None = None, first: int = 25) -> list[dict]:
    """Find Type entities by name (to detect duplicates like the 7 'Person' types)."""
    return search_entities_by_name(name, space_id=space_id, type_id=TYPE_META_ID, first=first)


# ---------------------------------------------------------------------------
# Bulk-scan helpers — added for graph-health.
# These use `entitiesConnection` (cursor-paginated) and the cheap `totalCount`
# field. The flat `entities(...)` query above is capped and has no pagination
# cursor; for enumerating an entire space, use these.
# ---------------------------------------------------------------------------

def count_entities_of_type(type_id: str, space_id: str | None = None) -> int:
    """totalCount for a (type, space) pair in one cheap call (first:1)."""
    args = [f'typeId: "{type_id}"', "first: 1"]
    if space_id:
        args.append(f'spaceId: "{space_id}"')
    q = f"{{ entitiesConnection({', '.join(args)}) {{ totalCount }} }}"
    conn = gql(q).get("entitiesConnection") or {}
    return int(conn.get("totalCount") or 0)


def count_entities_of_types_batched(
    type_ids: list[str], space_id: str | None = None, batch_size: int = 50
) -> dict[str, int]:
    """totalCount for many type_ids in one (or a few) GraphQL POSTs via aliases.
    Returns {type_id: count}. ~50× faster than calling count_entities_of_type
    in a Python loop for big spaces (AI space: 24s -> ~0.5s)."""
    out: dict[str, int] = {}
    space_arg = f', spaceId: "{space_id}"' if space_id else ""
    for i in range(0, len(type_ids), batch_size):
        chunk = type_ids[i : i + batch_size]
        # Use aliases t0..tN so the response keys are predictable.
        subqs = [
            f't{j}: entitiesConnection(typeId: "{tid}"{space_arg}, first: 1) {{ totalCount }}'
            for j, tid in enumerate(chunk)
        ]
        q = "{ " + " ".join(subqs) + " }"
        data = gql(q) or {}
        for j, tid in enumerate(chunk):
            conn = data.get(f"t{j}") or {}
            out[tid] = int(conn.get("totalCount") or 0)
    return out


def list_types_in_space(space_id: str, page_size: int = 100, max_pages: int = 50) -> list[dict]:
    """Every Type entity used in `space_id` with its in-space totalCount.
    Returns [{id, name, totalCount}, ...] sorted by count desc.

    We page through Type-meta entities scoped to the space, then annotate each
    with its in-space totalCount.
    """
    types_seen: dict[str, dict] = {}
    cursor: str | None = None
    pages = 0
    while pages < max_pages:
        args = [f'typeId: "{TYPE_META_ID}"', f'spaceId: "{space_id}"', f"first: {page_size}"]
        if cursor:
            args.append(f'after: "{cursor}"')
        q = (
            "{ entitiesConnection(" + ", ".join(args) + ") { "
            "nodes { id name } pageInfo { hasNextPage endCursor } } }"
        )
        conn = gql(q).get("entitiesConnection") or {}
        for n in (conn.get("nodes") or []):
            if n["id"] not in types_seen:
                types_seen[n["id"]] = {"id": n["id"], "name": n.get("name")}
        pi = conn.get("pageInfo") or {}
        if not pi.get("hasNextPage"):
            break
        cursor = pi.get("endCursor")
        pages += 1
    # Batch the totalCount lookups — N+1 sequential calls used to take ~24s
    # on the AI space (29 types); aliasing them into one GraphQL POST drops
    # that to ~0.5s.
    try:
        counts = count_entities_of_types_batched(
            list(types_seen.keys()), space_id=space_id
        )
    except Exception:
        counts = {}
    out = []
    for t in types_seen.values():
        t["totalCount"] = counts.get(t["id"])
        out.append(t)
    out.sort(key=lambda r: (r.get("totalCount") or 0), reverse=True)
    return out


def entities_of_type(
    type_id: str,
    space_id: str | None = None,
    page_size: int = 200,
    max_pages: int = 200,
):
    """Yield every {id, name} for (type, space). max_pages caps a runaway loop."""
    cursor: str | None = None
    pages = 0
    while pages < max_pages:
        args = [f'typeId: "{type_id}"', f"first: {page_size}"]
        if space_id:
            args.append(f'spaceId: "{space_id}"')
        if cursor:
            args.append(f'after: "{cursor}"')
        q = (
            "{ entitiesConnection(" + ", ".join(args) + ") { "
            "nodes { id name } pageInfo { hasNextPage endCursor } } }"
        )
        conn = gql(q).get("entitiesConnection") or {}
        for n in (conn.get("nodes") or []):
            yield n
        pi = conn.get("pageInfo") or {}
        if not pi.get("hasNextPage"):
            return
        cursor = pi.get("endCursor")
        pages += 1


def entity_value_scan(
    type_id: str,
    space_id: str | None = None,
    page_size: int = 50,
    max_pages: int = 200,
    values_first: int = 100,
    relations_first: int = 100,
):
    """Yield rich rows for content checks:
    { id, name, values: [{property{id,name}, text, date, boolean, decimal, integer, float}],
      relations: [{type{id,name}, toEntity{id, name, types[]}}] }.
    Heavier than entities_of_type — callers should sample, not full-traverse."""
    cursor: str | None = None
    pages = 0
    while pages < max_pages:
        args = [f'typeId: "{type_id}"', f"first: {page_size}"]
        if space_id:
            args.append(f'spaceId: "{space_id}"')
        if cursor:
            args.append(f'after: "{cursor}"')
        q = (
            "{ entitiesConnection(" + ", ".join(args) + ") { "
            "nodes { id name "
            f"values(first: {values_first}) {{ nodes {{ property {{ id name }} "
            "text date boolean decimal integer float } } "
            f"relations(first: {relations_first}) {{ nodes {{ type {{ id name }} "
            "toEntity { id name types { id name } } } } "
            "} pageInfo { hasNextPage endCursor } } }"
        )
        conn = gql(q).get("entitiesConnection") or {}
        for n in (conn.get("nodes") or []):
            yield {
                "id": n["id"],
                "name": n.get("name"),
                "values": ((n.get("values") or {}).get("nodes") or []),
                "relations": ((n.get("relations") or {}).get("nodes") or []),
            }
        pi = conn.get("pageInfo") or {}
        if not pi.get("hasNextPage"):
            return
        cursor = pi.get("endCursor")
        pages += 1


if __name__ == "__main__":
    CRYPTO = "c9f267dcb0d270718c2a3c45a64afd32"
    print("find_types_by_name('Person'):")
    for t in find_types_by_name("Person")[:8]:
        print(f"  {t['id']}  spaces={len(t.get('spaceIds') or [])}")
    print("\nlist_types_in_space(crypto) — top 10 by count:")
    types = list_types_in_space(CRYPTO)
    print(f"  {len(types)} types total")
    for t in types[:10]:
        print(f"  {t['totalCount']:>6}  {t['id']}  {t['name']}")
    print("\nentities_of_type(Person type in crypto) — first 3:")
    PERSON_CRYPTO = "7ed45f2bc48b419e8e4664d5ff680b0d"
    for i, e in enumerate(entities_of_type(PERSON_CRYPTO, space_id=CRYPTO, page_size=3, max_pages=1)):
        print(f"  {e['id']}  {e.get('name')}")
        if i >= 2:
            break
    print("\nentity_value_scan(Person in crypto) — first 1 with values/relations:")
    for e in entity_value_scan(PERSON_CRYPTO, space_id=CRYPTO, page_size=1, max_pages=1, values_first=5, relations_first=5):
        print(f"  {e['id']}  {e.get('name')}  "
              f"vals={len(e['values'])} rels={len(e['relations'])}")
        break
