---
name: geo-query
description: Query the Geo knowledge graph via GraphQL. Use when looking up entities, searching by type, exploring relations, discovering schemas, or inspecting entity properties. Triggers on "look up", "find entity", "query geo", "search the graph", "what type is", "show me relations", "get entity".
metadata:
  author: geobrowser
  version: "0.1.0"
---

# Geo Knowledge Graph — Querying

Query and explore entities, types, properties, and relations in the Geo knowledge graph via its GraphQL API.

## When to apply

Use this skill when the user wants to:

- Look up an entity by ID.
- Search for entities of a given type (optionally scoped to a space).
- Explore what properties and relations an entity has.
- Discover the schema for an unfamiliar entity type before publishing.
- Find type, property, or relation type IDs.
- **Review / fact-check a submission** — a `geobrowser.io/.../<entity>` page made of data-block tables (see "Review a submission" below).

**Runs anywhere.** This is plain GraphQL over HTTP — no SDK, no wallet, no cloned repo required for the queries themselves. It works the same in Claude Code, Codex, Claude cowork, and **claude.ai in the browser**. (The repo paths in "More" are optional convenience references; the querying needs none of them.)

## API basics

- **Endpoint:** `https://testnet-api.geobrowser.io/graphql`
- **Method:** `POST` with `Content-Type: application/json`
- **Auth:** none required for reads.
- **UUIDs:** 32-char hex, no dashes (e.g. `7ed45f2bc48b419e8e4664d5ff680b0d`).
- **Browser links:** `https://www.geobrowser.io/space/{spaceId}/{entityId}`.

> Why GraphQL and not MCP: MCP (`hypergraph-mcp`) is convenient for casual browsing, but it can be slow and occasionally returns wrong schema data (e.g. inflated property lists). For anything that informs a write, or anything that must be exact, use the GraphQL queries below — they're deterministic.

## Core concepts (compact)

- **Entity:** a unique node in the graph (person, place, article, etc.). Has an ID, `name`, `description`, `types`, `values`, and `relations`.
- **Property:** a typed attribute on an entity (`text`, `date`, `boolean`, `decimal`, `integer`, `float`, `url`).
- **Relation:** a typed edge between two entities. Relations are themselves entities — they can have their own properties.
- **Type:** a category (`Person`, `Article`, …). Types define a schema of default properties that every entity of that type inherits.
- **Space:** an independent community/topic scope. An entity can live in multiple spaces; each has its own perspective.

Full conceptual details: see `../../../knowledge-graph-ontology.md`.

## List query: `entities` vs `entitiesConnection`

There are two list queries with the same top-level args (`typeId`, `spaceId`, `typeIds`, `spaceIds`, `filter`, `first`, `offset`, `orderBy`) but different shapes. **Choose based on result set size**:

|              | `entities`                                        | `entitiesConnection`                        |
| ------------ | ------------------------------------------------- | ------------------------------------------- |
| Return shape | flat array                                        | `{ nodes, edges, pageInfo, totalCount }`    |
| Pagination   | `first` + `offset` **(capped at offset 1000)**    | `first` + cursor (`after`/`before`)         |
| Use when     | small, bounded lookups; default for <1000 results | totalCount needed, or unbounded result sets |

**CRITICAL — offset cap:** `entities(...)`, `relations(...)`, and `values(...)` return **400 "offset cannot exceed 1000"** beyond offset 1000. For any query that might exceed 1000 results, use the `*Connection` variant with cursor pagination.

**CRITICAL — response shape:** `entities` returns a **flat array**. Do NOT wrap fields in `{ nodes { ... } }`.

```graphql
# CORRECT
{ entities(typeId: "TYPE_ID", first: 50) { id name description } }

# WRONG — `entities` is flat, no `nodes`
{ entities(typeId: "TYPE_ID", first: 50) { nodes { id name } } }

# WRONG — `typeId` is top-level, not inside `filter`
{ entities(filter: { typeIds: { anyEqualTo: "TYPE_ID" } }, first: 50) { ... } }
```

## Core queries

### Look up a single entity

This is the starting point for almost every investigation:

```graphql
{
  entity(id: "ENTITY_ID") {
    id
    name
    description
    spaceIds
    types {
      id
      name
    }
    values(first: 100) {
      nodes {
        property {
          id
          name
        }
        text
        date
        boolean
        decimal
        integer
        float
      }
    }
    relations(first: 100) {
      nodes {
        id # relation edge ID (use this to delete the relation)
        entityId # relation ENTITY ID (use this to read/update relation properties)
        type {
          id
          name
        }
        toEntity {
          id
          name
        }
      }
    }
  }
}
```

Values come back as typed fields (`text`, `date`, `boolean`, `decimal`, `integer`, `float`) — NOT a single `value` field. Check each for non-null.

### Search entities by type (optionally by space)

```graphql
# Small result set
{
  entities(typeId: "TYPE_ID", spaceId: "SPACE_ID", first: 50) {
    id
    name
    description
  }
}

# Large/unbounded — use cursor pagination
{
  entitiesConnection(typeId: "TYPE_ID", spaceId: "SPACE_ID", first: 500) {
    totalCount
    nodes {
      id
      name
      description
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

### Cursor pagination loop (TypeScript)

```typescript
async function fetchAll(
  typeId: string,
  spaceId: string,
): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  let cursor: string | null = null;

  while (true) {
    const afterClause = cursor ? `after: "${cursor}"` : "";
    const res = await fetch("https://testnet-api.geobrowser.io/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
        entitiesConnection(typeId: "${typeId}", spaceId: "${spaceId}", first: 500 ${afterClause}) {
          nodes { id name }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      }),
    });
    const { data } = await res.json();
    const conn = data.entitiesConnection;
    out.push(...(conn?.nodes ?? []));
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}
```

## Filtering

The `filter` arg accepts `EntityFilter` for field-level conditions:

```graphql
{
  entities(typeId: "TYPE_ID", filter: { name: { startsWithInsensitive: "Bitcoin" } }, first: 20) {
    id
    name
  }
}
```

Common `EntityFilter` fields:

- `id` — `UUIDFilter` (uses `is` / `isNot` / `in`; NOT `equalTo`).
- `name`, `description`, `createdAt`, `updatedAt` — `StringFilter` (`startsWithInsensitive`, `includesInsensitive`, `equalTo`).
- `spaceIds`, `typeIds` — `UUIDListFilter` (`anyEqualTo`).
- `relations`, `backlinks` — `EntityToManyRelationFilter` (`some`, `none`, `every`).
- `values` — `EntityToManyValueFilter`.
- `and`, `or`, `not`.

**CRITICAL — scope relation filters by space.** Cross-space relation filters can return `INTERNAL_SERVER_ERROR` on the server. Always include `spaceId` inside relation filters:

```graphql
relations: { some: { spaceId: { is: "SPACE_ID" }, toEntity: { ... } } }
```

**Prefer `none` over `every` for exclusion.** `every` means "all items must match the full condition" and misbehaves when items have different field values. Use `none` for "there is no X where Y":

```graphql
# "entity has no name value"
values: { none: { propertyId: { is: NAME_PROP_ID }, text: { isNull: false } } }
```

If complex filters return 500s, reduce `first` from 500 → 100 → 50.

## Schema discovery workflow

When you need to publish or understand an entity type you haven't seen before, **inspect an existing entity of that type** to learn the schema. Do this before assuming any property/relation IDs.

1. Find entities of the type (search by `typeId`).
2. Pick one and fetch it fully (all values + relations).
3. Read the property names and relation types from the result.
4. Note the IDs — property IDs, relation type IDs, and `toEntity` IDs for classification values.

```graphql
{
  entities(typeId: "7ed45f2bc48b419e8e4664d5ff680b0d", first: 3) {
    id
    name
    types {
      id
      name
    }
    values(first: 50) {
      nodes {
        property {
          id
          name
        }
        text
        date
      }
    }
    relations(first: 50) {
      nodes {
        type {
          id
          name
        }
        toEntity {
          id
          name
        }
      }
    }
  }
}
```

This is the query `geo-publish` relies on before any write — paste the discovered IDs to it as `KNOWN IDs` so it doesn't re-discover.

## Review a submission (multi-table page)

Use this when the user gives a `geobrowser.io/space/<SPACE_ID>/<ENTITY_ID>` URL or asks to "review / fact-check this submission/page". A submission is a single entity whose page contains one or more **data blocks** — each block is a filtered query rendered as a table. Reviewing means: enumerate ALL blocks, paginate ALL rows in each, and inspect entities for the issues the user named (missing entries, wrong descriptions, inaccurate properties).

1. **Parse the URL** → `…/space/<SPACE_ID>/<ENTITY_ID>`. The second hex segment is the entity id.
2. **Fetch the submission entity** (single-entity query above). In its `relations`, find entries whose `type.name` is `Blocks` / `Data block` / `Has block` / similar — each `toEntity.id` is a block. If the relation type isn't obvious, inspect each `toEntity` until you find the ones whose own type is `Data block`. Don't guess — schemas drift; confirm by inspection.
3. **Decode each block's filter** — run the single-entity query on the block; its `values`/`relations` describe what it queries (a `Type` relation = what it displays, plus property/relation filters, optional space scope). Read these off the block, not the UI.
4. **Re-run each filter and paginate FULLY** — translate the block filter into an `entities(...)` query and page until exhausted. Offset caps at 1,000; for larger blocks use cursor pagination (`createdAt` ascending, feed the last row's `createdAt` back as `greaterThan`). Don't stop at page 1.
5. **Inspect each row** per the review criteria — missing entries (cross-ref the expected list / domain knowledge), wrong descriptions (read the Description `text`), inaccurate properties (spot-check against the entity's Web URL).
6. **Report once, structured** — per block: name + id, total rows (after full pagination), and per-issue flags `[OK]` / `[MISSING]` / `[WRONG DESCRIPTION]` / `[INACCURATE PROPERTY]`, plus a summary line (e.g. "Block 'Hospitals — California': 247 rows, 12 issues (3 missing, 7 wrong descriptions, 2 inaccurate prices)"). The reviewer needs the full picture before approve / send-back / partial-approve.

## Finding type and property IDs by name

`Type` and `Property` are themselves types — you can query all of them:

```graphql
# All type definitions
{
  entities(
    typeId: "e7d737c536764c609fa16aa64a8c90ad"
    filter: { name: { includesInsensitive: "article" } }
    first: 20
  ) {
    id
    name
  }
}

# All property definitions
{
  entities(
    typeId: "808a04ceb21c4d888ad12e240613e5ca"
    filter: { name: { includesInsensitive: "date" } }
    first: 20
  ) {
    id
    name
  }
}
```

For relation types, inspect an entity that uses them — the `type { id name }` field on a relation gives you the ID.

## Well-known IDs

Prefer the SDK's exported constants where possible:

```typescript
import { SystemIds, ContentIds } from "@geoprotocol/geo-sdk";

(SystemIds.PERSON_TYPE, SystemIds.COMPANY_TYPE, SystemIds.PROJECT_TYPE, SystemIds.EVENT_TYPE);
(ContentIds.ARTICLE_TYPE, ContentIds.TALK_TYPE, ContentIds.PODCAST_TYPE, ContentIds.TOPIC_TYPE);
```

Common raw IDs (verified against the API — for GraphQL queries):

| Name            | ID                                 |
| --------------- | ---------------------------------- |
| Type (meta)     | `e7d737c536764c609fa16aa64a8c90ad` |
| Property (meta) | `808a04ceb21c4d888ad12e240613e5ca` |
| Person          | `7ed45f2bc48b419e8e4664d5ff680b0d` |
| Article         | `a2a5ed0cacef46b1835de457956ce915` |
| Topic           | `5ef5a5860f274d8e8f6c59ae5b3e89e2` |
| News story      | `e550fe517e904b2c8fffdf13408f5634` |

More type, property, and space IDs live in `../../../src/constants.ts` and `../../../knowledge-graph-ontology.md`.

## curl sanity check

```bash
curl -s --compressed 'https://testnet-api.geobrowser.io/graphql' \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ entities(typeId: \"7ed45f2bc48b419e8e4664d5ff680b0d\", first: 5) { id name } }"}' | jq .
```

## Critical gotchas — quick reference

1. **Offset cap 1000** on `entities`/`relations`/`values` — use `*Connection` + cursor for larger sets.
2. **`entities` is flat**, not `{ nodes { ... } }`.
3. **`typeId`/`spaceId` are top-level args**, not inside `filter`.
4. **Scope relation filters by `spaceId`** to avoid `INTERNAL_SERVER_ERROR`.
5. **`UUIDFilter` uses `is` / `isNot` / `in`**, not `equalTo`. `UUIDListFilter` uses `anyEqualTo`.
6. **Prefer `none` over `every`** for exclusion logic.
7. **Values come back as typed fields** (`text`, `date`, `boolean`, …), not a single `value`.
8. **Relation `id` ≠ `entityId`** — `id` is the edge (for deletion); `entityId` is the relation-as-entity (for relation properties).

## More

- `../../../knowledge-graph-ontology.md` — full ontology spec (types, properties, data types, blocks).
- `../../../src/constants.ts` — well-known type/property/space IDs and the ranked SPACES list.
- `../../../src/functions.ts` — reference `gql()` client with retry/backoff and pagination.
- Sibling skills: `geo-publish` / `geo-orchestrate` (writes this hands off to), `geo-press-review` (built on these reads).
