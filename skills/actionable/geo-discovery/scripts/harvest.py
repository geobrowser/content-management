#!/usr/bin/env python3
"""
harvest.py — fetch the daily content stream for a Geo space.

Stage 1 of the discovery workflow. Read-only, no auth. Space-parametrized so the
same workflow runs on AI / crypto / health / etc.

Pulls the most recent News stories in a space (by createdAt epoch, NOT the empty
Publish date property) and, for each, its Notable claims (claim text) and Topics.
Optionally also pulls AI-podcast-allowlist episodes for cross-source theme heat.

Usage:
    python harvest.py --space 41e851610e13a19441c4d980f2f2ce6b --days 2 --out harvest.json
    python harvest.py --space <id> --days 2 --with-episodes --out harvest.json
"""
from __future__ import annotations
import argparse, json, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

ENDPOINT = "https://testnet-api.geobrowser.io/graphql"
NEWS_TYPE = "e550fe517e904b2c8fffdf13408f5634"
EPISODE_TYPE = "972d201ad78045689e01543f67b26bee"
PODCASTS_SPACE = "b5a31f8182b042437ede0f84ee02f104"
# On-domain podcasts are derived per space by TOPIC OVERLAP (see harvest()), not a
# hand-curated allowlist — so the workflow self-configures on any space. An episode is
# kept iff its Topics overlap the target space's own DISTINCTIVE topic vocabulary.
# Default raised to 2 so a single shared (often broad) topic no longer pulls in an
# off-domain show (the crypto run was leaking Iran/politics/AI podcasts via overlap=1).
MIN_TOPIC_OVERLAP = 2

# Broad/generic topics are excluded from the overlap test — sharing one of these is NOT
# evidence an episode is on-domain (a politics show and a crypto-politics story both carry
# "U.S. politics"). Mirrors theme_heat.BROAD; extend per observed leakage.
BROAD_TOPICS = {
    "ai", "business & finance", "technology", "society", "global affairs", "science",
    "companies & projects", "u.s. politics", "crypto", "cryptocurrencies", "health",
    "philosophy", "innovation", "debates", "social issues", "investing", "world affairs",
    "ethics", "corporate strategy", "apps & software", "china", "middle east",
    "wars & conflicts", "u.s. economy", "geopolitics", "iran & regional influence",
    "russia-ukraine war", "military operations", "macroeconomic factors affecting crypto markets",
}

# Pure politics / general-news shows that ride in on a stray shared topic. Episodes from
# these are dropped regardless of overlap (cheap precision backstop; extend as needed).
SHOW_DENYLIST = {
    "up first from npr", "the daily", "the lawfare podcast", "lawfare", "the bulwark podcast",
    "the commentary magazine podcast", "the dispatch podcast", "the duran podcast",
    "left, right & center", "the globalist", "the joe rogan experience", "intelligence squared",
    "call me back - with dan senor", "the bulwark", "tangle", "strict scrutiny",
    "wsj what's news", "up first", "99% invisible",
}


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


def _epoch(s):
    try:
        return datetime.fromtimestamp(int(s), tz=timezone.utc)
    except Exception:
        return None


def _recent(type_id, space_id, days, limit=120):
    q = (f'{{ entitiesConnection(typeId:"{type_id}", spaceId:"{space_id}", first:{limit}, '
         f'orderBy:CREATED_AT_DESC) {{ nodes {{ id name createdAt }} }} }}')
    now = datetime.now(timezone.utc)
    out = []
    for n in (gql(q).get("entitiesConnection") or {}).get("nodes") or []:
        dt = _epoch(n.get("createdAt"))
        if dt and (now - dt).days <= days:
            out.append(n)
    return out


def _doc(eid):
    q = (f'{{ entity(id:"{eid}") {{ name relations(first:300) {{ nodes {{ '
         f'type {{ name }} toEntity {{ name }} }} }} }} }}')
    e = (gql(q) or {}).get("entity") or {}
    rels = (e.get("relations") or {}).get("nodes") or []
    def names(rt):
        return [(r.get("toEntity") or {}).get("name") for r in rels
                if (r.get("type") or {}).get("name") == rt and (r.get("toEntity") or {}).get("name")]
    return {"name": e.get("name"),
            "claims": names("Notable claims"),
            "topics": names("Topics"),
            "podcast": (names("Podcast") or [""])[0]}


def harvest(space_id, days, with_episodes=False, min_overlap=MIN_TOPIC_OVERLAP,
            show_allowlist=None):
    # show_allowlist: lowercased show names always kept (recall complement). If None, look it
    # up per-space from space_profile.PODCAST_ALLOWLIST so the workflow self-configures.
    if show_allowlist is None:
        try:
            from space_profile import show_allowlist as _saw
            show_allowlist = _saw(space_id)
        except Exception:
            show_allowlist = set()
    docs = []
    for n in _recent(NEWS_TYPE, space_id, days):
        d = _doc(n["id"]); d["kind"] = "news"; docs.append(d)
    if with_episodes:
        # the space's DISTINCTIVE topic vocabulary, derived from its own news (lowercased,
        # broad/generic topics removed so a shared "U.S. politics" doesn't count as on-domain)
        space_topics = {t.lower() for d in docs for t in (d.get("topics") or []) if t}
        space_topics -= BROAD_TOPICS
        for n in _recent(EPISODE_TYPE, PODCASTS_SPACE, days):
            d = _doc(n["id"])
            show = (d.get("podcast") or "").strip().lower()
            # precedence: denylist drop > allowlist keep > distinctive-topic-overlap gate
            if show in SHOW_DENYLIST:
                continue
            ep_topics = {t.lower() for t in (d.get("topics") or []) if t} - BROAD_TOPICS
            overlap = ep_topics & space_topics
            if show in show_allowlist:
                d["kind"] = "episode"; d["topic_overlap"] = sorted(overlap)
                d["kept_by"] = "allowlist"; docs.append(d)
            elif len(overlap) >= min_overlap:
                # known crypto show? no — kept by sharing >= min_overlap distinctive topics
                d["kind"] = "episode"; d["topic_overlap"] = sorted(overlap)
                d["kept_by"] = "topic-overlap"; docs.append(d)
    return docs


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--space", required=True)
    ap.add_argument("--days", type=int, default=2)
    ap.add_argument("--with-episodes", action="store_true")
    ap.add_argument("--min-topic-overlap", type=int, default=MIN_TOPIC_OVERLAP)
    ap.add_argument("--out", default="harvest.json")
    a = ap.parse_args()
    docs = harvest(a.space, a.days, a.with_episodes, a.min_topic_overlap)
    json.dump(docs, open(a.out, "w"), indent=1)
    nnews = sum(1 for d in docs if d["kind"] == "news")
    neps = sum(1 for d in docs if d["kind"] == "episode")
    nclaims = sum(len(d["claims"]) for d in docs)
    print(f"harvested {nnews} news + {neps} episodes, {nclaims} claims -> {a.out}")
