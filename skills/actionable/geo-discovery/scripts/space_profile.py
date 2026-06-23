#!/usr/bin/env python3
"""
space_profile.py — derive a space's discovery config at run time, so the workflow
self-configures on ANY space instead of being hand-tuned per space.

The only hand-maintained thing is the GLOBAL denylist below — the set of
content / assertion / media / taxonomy type names that recur in every space and
must never count as a candidate "identity" (they bury exact-name search). It is
universal, so it is configured ONCE, not per space.

    identity_types(space) = (types in space) − denylist − (count < MIN_COUNT)

profile(space_id) -> { identity_type_ids, identity_type_names, datasets_space }

Used by gap_diagnostic.py (identity resolution) and run.py. No auth (read-only).
"""
from __future__ import annotations
import json, sys, time, urllib.request, urllib.error

ENDPOINT = "https://testnet-api.geobrowser.io/graphql"
TYPE_META_ID = "e7d737c536764c609fa16aa64a8c90ad"   # the type-of-types
MIN_COUNT = 5                                        # ignore orphan/tiny types

# GLOBAL denylist — universal content/system/taxonomy types (never an identity).
# Exact lowercased names + suffix patterns. Domain record types (Audit, Exploit,
# Contract, …) are intentionally NOT here — they are real entities worth coverage.
_DENY_EXACT = {
    "claim", "article", "quote", "data block", "text block", "image", "cover",
    "avatar", "tweet", "post", "news story", "news event", "evaluation", "paper",
    "page", "talk", "type", "property", "space", "podcast", "episode", "category",
    "descriptor", "metric",
}
_DENY_SUFFIX = (" category", " status", " type", " standard",  # enum / taxonomy lists
                " model", " vector", " approach", " capability")  # descriptors, not identities

# Per-space publish target for Gap findings (reuse the shared ontology by ID).
# One line per space; add new spaces here. Crypto datasets ID: TBD (operator).
DATASETS_SPACE = {
    "41e851610e13a19441c4d980f2f2ce6b": "941964642f4d3e70ef48f54a3915277d",  # AI -> AI datasets
    "c9f267dcb0d270718c2a3c45a64afd32": "5908c73ad336472ccbd983491d2d17e4",  # crypto -> crypto datasets (DAO 0xf6B3938c48ADdE5C6570d968533601AcC804479b)
}

# Per-space podcast ALLOWLIST (show names, lowercased). Episodes from these shows are always
# kept by harvest.py — they bypass the topic-overlap gate so a known on-domain crypto/AI show
# can't be dropped by a single off-topic week. This is the recall complement to harvest.py's
# SHOW_DENYLIST (precision) and the topic-overlap test (the self-configuring default for shows
# not named here). Optional: a space with no entry simply relies on topic-overlap.
PODCAST_ALLOWLIST = {
    # crypto
    "c9f267dcb0d270718c2a3c45a64afd32": {
        "bankless", "unchained", "0xresearch", "the breakdown", "bitcoin audible",
        "tftc: a bitcoin podcast", "what bitcoin did", "the pomp podcast", "coin bureau",
        "the a16z show", "empire", "the chopping block",
    },
    # AI (example; extend per space)
    "41e851610e13a19441c4d980f2f2ce6b": {
        "latent space: the ai engineer podcast", "machine learning street talk (mlst)",
        "no priors: artificial intelligence | technology | startups",
        "the ai daily brief: artificial intelligence news and analysis",
        '"the cognitive revolution" | ai builders, researchers, and live player analysis',
    },
}


def show_allowlist(space_id: str) -> set:
    """Lowercased podcast show names always kept for this space (empty set if none configured)."""
    return PODCAST_ALLOWLIST.get(space_id, set())


def gql(query, retries=3, backoff=1.5):
    body = json.dumps({"query": query}).encode()
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(ENDPOINT, data=body,
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
    raise RuntimeError(f"GraphQL failed: {last}")


def _denied(name: str) -> bool:
    n = (name or "").strip().lower()
    if not n or n in _DENY_EXACT:
        return True
    return any(n.endswith(s) for s in _DENY_SUFFIX)


def list_types_in_space(space_id: str, page_size: int = 100, max_pages: int = 50):
    """Every Type entity used in the space, with in-space totalCount."""
    seen, cursor, pages = {}, None, 0
    while pages < max_pages:
        args = [f'typeId:"{TYPE_META_ID}"', f'spaceId:"{space_id}"', f"first:{page_size}"]
        if cursor:
            args.append(f'after:"{cursor}"')
        q = ("{ entitiesConnection(" + ", ".join(args) +
             ") { nodes { id name } pageInfo { hasNextPage endCursor } } }")
        conn = gql(q).get("entitiesConnection") or {}
        for n in (conn.get("nodes") or []):
            seen.setdefault(n["id"], {"id": n["id"], "name": n.get("name")})
        pi = conn.get("pageInfo") or {}
        if not pi.get("hasNextPage"):
            break
        cursor = pi.get("endCursor"); pages += 1
    # batch in-space counts via GraphQL aliases (one POST)
    ids = list(seen)
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        sub = " ".join(
            f'c{j}: entitiesConnection(typeId:"{tid}", spaceId:"{space_id}", first:1)'
            f'{{ totalCount }}' for j, tid in enumerate(chunk))
        try:
            data = gql("{ " + sub + " }")
            for j, tid in enumerate(chunk):
                seen[tid]["totalCount"] = (data.get(f"c{j}") or {}).get("totalCount") or 0
        except Exception:
            for tid in chunk:
                seen[tid].setdefault("totalCount", 0)
    return sorted(seen.values(), key=lambda t: -(t.get("totalCount") or 0))


def identity_types(space_id: str, min_count: int = MIN_COUNT):
    """Auto-derived identity types: in-space types minus the global denylist minus
    tiny/orphan types. Returns {"ids": [...], "names": [...], "dropped": [...]}."""
    types = list_types_in_space(space_id)
    keep, dropped = [], []
    for t in types:
        if _denied(t.get("name")):
            dropped.append((t.get("name"), "denylist")); continue
        if (t.get("totalCount") or 0) < min_count:
            dropped.append((t.get("name"), f"count<{min_count}")); continue
        keep.append(t)
    return {"ids": [t["id"] for t in keep],
            "names": [t["name"] for t in keep],
            "kept": keep, "dropped": dropped}


def profile(space_id: str) -> dict:
    idn = identity_types(space_id)
    return {
        "space_id": space_id,
        "identity_type_ids": idn["ids"],
        "identity_type_names": idn["names"],
        "datasets_space": DATASETS_SPACE.get(space_id),
        "podcast_allowlist": sorted(show_allowlist(space_id)),
        "_kept": idn["kept"], "_dropped": idn["dropped"],
    }


if __name__ == "__main__":
    sid = sys.argv[1] if len(sys.argv) > 1 else "41e851610e13a19441c4d980f2f2ce6b"
    p = profile(sid)
    print(f"space: {sid}")
    print(f"datasets target: {p['datasets_space']}")
    print(f"\nIDENTITY types ({len(p['identity_type_names'])}):")
    for t in p["_kept"]:
        print(f"  {t['name']:26} {t['id'][:8]}  n={t['totalCount']}")
    print(f"\ndropped ({len(p['_dropped'])}): " +
          ", ".join(f"{n}({why})" for n, why in p["_dropped"][:40]))
