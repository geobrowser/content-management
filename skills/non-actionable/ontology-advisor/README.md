# ontology-advisor

A Claude Code skill that provides ontology guidance for [Geo](https://www.geobrowser.io)'s knowledge graph — grounded in a consolidated `ONTOLOGY.md` as the judgment prior and the live graph as the source of truth.

**Read-only.** Drafts suggested text for types, properties, relations, and descriptions, then hands off to [`geo-publish`](https://www.geobrowser.io/space/41e851610e13a19441c4d980f2f2ce6b) for writes.

Published as an entity on Geo: [ontology-advisor in AI space](https://www.geobrowser.io/space/41e851610e13a19441c4d980f2f2ce6b/fcfc89b6fb9046c992d6a43524555bdb).

## How it was built

The skill was assembled by consolidating Geo's ontology documentation into a single canonical `references/ONTOLOGY.md`, then extracting mechanical rules into a separate `references/rules.json` — canonical property names, type synonyms to avoid, known type duplications, and canonical space IDs.

Ambiguities in the original docs were resolved by querying the live graph and surfacing actual behavior:

- The canonical `Person`/`Project` duplication
- The description-drift rule for canonical types (e.g. when only a domain-space override exists but geo-root has no canonical description)
- The Pattern A/B/C recipe for name collisions (populated broad + empty narrow → reclaim; populated broad, no narrow → propose new; multiple populated → flag fragmentation)

A small set of Python helpers wraps the GraphQL API so the model can reach for one focused primitive per question.

## The five modes

| Mode | What it does |
|---|---|
| **1. Explain** | Pure Q&A from `ONTOLOGY.md` with no graph query. ("What's a Topic vs a Tag?") |
| **2. Advisory** | Anchor a proposed change in both the ontology AND the existing graph state via existence + sample-before-reuse checks. ("Should I create a `Hospital` type?") |
| **3. Inspect & critique** | List types in a space, find duplicates, categorize by domain. ("What's in space X?") |
| **4. Diff against ontology** | Surface canonical drift, sparse descriptions, free-text values that should be relations. ("Is this type missing anything canonical?") |
| **5. Fetch & draft** | Bulk reads, CSV exports, draft descriptions. The only mode that writes files — and never to the graph. |

## Installation

Clone into your Claude Code skills directory:

```bash
git clone https://github.com/mufasasa/ontology-advisor.git ~/.claude/skills/ontology-advisor
```

The skill becomes available to Claude Code automatically — invoke it via `/ontology-advisor` or rely on its description triggers (`"should I create a type"`, `"what properties for"`, `"duplicate types"`, etc.).

### Requirements

- **Python 3** for the helpers (`geo_graphql.py`, `helpers.py`, `lint.py`)
- The `requests` library: `pip install requests`
- **No API key required** for read access to the testnet graph

### Running helpers directly

Scripts must be run from inside the `scripts/` directory — `geo_graphql` is imported as a local module:

```bash
cd ~/.claude/skills/ontology-advisor/scripts
python3 -c "
from helpers import find_similar_types, summarize_type
for r in find_similar_types('Hospital', canonical_only=True):
    print(r)
"
```

## Files

- `SKILL.md` — the skill definition and full playbook (loaded by Claude Code)
- `references/ONTOLOGY.md` — the judgment prior (always loaded on invocation)
- `references/rules.json` — mechanical lookups (canonical property names, type synonyms, known duplications, canonical space IDs)
- `scripts/geo_graphql.py` — slim live GraphQL client with paging helpers
- `scripts/helpers.py` — the on-demand primitives the playbook reaches for
- `scripts/lint.py` — content-standards checks (naming, descriptions, value formats)

## License

MIT
