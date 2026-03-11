# Geo Content Management

Tools for managing entities in the [Geo knowledge graph](https://geobrowser.io) via the [GRC-20 SDK](https://github.com/geobrowser/grc-20).

## Prerequisites

- `.env` configured with `PK_SW` (see `.env.example`)
- `bun` installed, dependencies available (`bun install`)
- A personal space on testnet (or membership/editorship in a DAO space)

## Entity Operations

All operations live in `01_entity_operations.ts`. Uncomment the operation you want, fill in the IDs, and run:

```bash
bun run 01_entity_operations.ts
```

### 1. Delete Entity

Delete an entity and all its properties/relations from a space. Optionally performs recursive orphan cleanup for entities that become unreferenced.

```ts
const ops = await deleteEntity({
  entityId: 'ENTITY_ID',
  spaceId: 'SPACE_ID',
  // dryRun: true,           // preview without publishing
  // skipOrphanCleanup: true, // skip recursive orphan deletion
});
```

### 2. Change Entity ID

Move an entity to a new ID within the same space. Recreates all properties, relations, and backlinks under the new ID, then deletes the old one.

```ts
const ops = await changeEntityId({
  oldEntityId: 'OLD_ENTITY_ID',
  newEntityId: 'NEW_ENTITY_ID',
  spaceId: 'SPACE_ID',
  // dryRun: true,
});
```

### 3. Change Space

Move an entity from one space to another, keeping the same entity ID. Recreates all data in the destination space and cleans up the source.

```ts
const { createOps, deleteOps } = await changeSpace({
  entityId: 'ENTITY_ID',
  fromSpaceId: 'FROM_SPACE_ID',
  toSpaceId: 'TO_SPACE_ID',
  // dryRun: true,
});
```

### 4. Merge Entities

Merge one or more secondary entities into a main entity. Handles both same-space and cross-space merges. If the main entity is a Property type, automatically migrates property references across all accessible spaces.

```ts
const ops = await mergeEntities({
  mainEntityId: 'MAIN_ENTITY_ID',
  mainSpaceId: 'MAIN_SPACE_ID',
  secondaries: [
    { entityId: 'SECONDARY_1', spaceId: 'SPACE_A' },
    { entityId: 'SECONDARY_2', spaceId: 'SPACE_B' },
  ],
  // dryRun: true,
  // appendRelations: true, // append extra relations from secondaries to main
});
```

## Project Structure

```
01_entity_operations.ts     # Entry point — uncomment an operation and run
src/
  entity_ops.ts             # Core operation logic (delete, move, merge, migrate)
  constants.ts              # Ontology IDs (types, properties, data types, views)
  functions.ts              # Shared helpers (GraphQL client, publishing, ops serialization)
knowledge-graph-ontology.md # Full ontology specification
```

## References

- [GRC-20 Serialization Spec](https://github.com/geobrowser/grc-20/blob/main/spec.md)
- [Knowledge Graph Ontology](knowledge-graph-ontology.md)
