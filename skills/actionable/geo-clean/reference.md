# geo-clean — reference

Deep detail split out of `SKILL.md`. Read this before generating any cleanup script. Paths are relative to the cloned `content-management` repo (the skill runs from there).

## Script-generation rules

- **One file, one job.** `scripts/<YYYY-MM-DD>-<operation>-<slug>.ts`. Successful scripts become a pattern library.
- **Top of file**: a comment block restating the operation, the discovery counts, and the gate results. Future-you needs this.
- **TypeScript**, runs with `bun run scripts/<file>.ts`.
- **`DRY_RUN` constant at the top, defaults `true`.**
- **Collect ALL ops in one array, publish ONCE.** Never `await publishOps` inside a loop.
- **Import battle-tested helpers** from `src/` — don't reimplement these:
  - `mergeEntities` (entity merging) — `src/entity_ops.ts`
  - `OpsBatch` (batching + per-space transaction routing) — `src/entity_ops.ts`
  - `deleteEntity`, `deleteRelation` (cleanup) — `src/entity_ops.ts`
  - `gql`, `publishOps`, `printOps` — `src/functions.ts`

## `mergeEntities` helper contract

`mergeEntities` from `src/entity_ops.ts` is the battle-tested merge path. **Always pass `summaryOut: new Map()`** so it fills per-space op counts for the Cross-Space-Impact gate.

The helper handles:
- Re-pointing incoming relations from members to Main (**paginated to completion** — uses `offset`-based pagination with `first: 500` until exhausted; logs page count).
- Copying unique values from members to Main (skip if Main already has the property; skip legacy/deprecated property IDs from `LEGACY_PROPERTY_IDS`).
- Copying unique outgoing relations to Main (skip if Main already has that exact `type + toEntity`; skip legacy/deprecated relation type IDs from `LEGACY_RELATION_TYPE_IDS`).
- Stripping the member: unset all values, delete all relations (outgoing + in-space backlinks), and emit a protocol-level `deleteEntity` op so the member ID is truly removed (not left as a nameless husk). Opt out with `keepAsGhost: true` only if an external system needs the ID.

```typescript
import { mergeEntities, type MergeOpSummary } from '../src/entity_ops.js';

const summaryOut: MergeOpSummary = new Map();
await mergeEntities({
  mainEntityId: '<canonical-id>',
  mainSpaceId: '<canonical-space-id>',
  secondaries: [{ entityId: '<dup-id>', spaceId: '<dup-space-id>' }],
  dryRun: true,
  opsBatch,
  summaryOut,
});
// Render the Cross-Space-Impact gate from summaryOut:
for (const [spaceId, counts] of summaryOut) {
  console.log(`  ${spaceId}: total=${counts.total} ` +
    `create=${counts.createRelation} update=${counts.updateEntity} ` +
    `delRel=${counts.deleteRelation} delEntity=${counts.deleteEntity}`);
}
```

## Critical gotchas

1. **Backlinks are paginated.** A naive query returning 50 backlinks doesn't mean only 50 exist. For a Main-selection decision, paginate the backlink query to completion.
2. **Edge id ≠ entity id** for relation deletes. Use the relation's own `id`, not `toEntity.id`.
3. **Cross-space relations on merged entities**: when porting a member's relations to Main, preserve the `toSpace` field if the target lives in a different space.
4. **"Find duplicates" must group across spaces** — same name in different spaces is still a duplicate candidate unless the user explicitly scoped to one space.
5. **`Graph.deleteEntity` doesn't delete incoming relations** automatically. If you bypass the orphan gate via "force delete", you must also delete each incoming edge or the UI will show ghosts.
6. **Mass merges should be batched per Main's target space.** All ops with a given target space go in one transaction. The `OpsBatch` helper handles this.
7. **`typeIds` dedupes; type *edges* do not.** To find duplicate-type relations, read the raw Types-relation edges (`relationsConnection` filtered by `typeId = 8f151ba4…`), not the entity's `typeIds` array — the array collapses repeats and hides the duplicate.
8. **No working server-side "untyped" filter.** `types` isn't a field (it's `typeIds`); `typeIds: { isNull: true }` and `entitiesConnection.totalCount` both 504; the `relationsByTypeIdConnection: { none }` filter returns false positives. Paginate the space and check `typeIds.length === 0` client-side.

## When something fails mid-publish

If `bun run` errors with a network host blocked by the host platform's sandbox, the editor adds that host to the platform's network allowlist and retries. (Exact config location varies by platform — settings UI, a `config.toml`, or similar.) Do not suggest disabling the sandbox.
