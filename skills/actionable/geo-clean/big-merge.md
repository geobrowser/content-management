# Manual big-merge procedure

The Big-Merge gate in `SKILL.md` fires when a single member has **>100 incoming backlinks** or the merge plans **>200 ops**. At that scale the auto-`mergeEntities` helper has historically under-migrated rows (Armando AI/Tech, 2026-05-29: 216 deletes vs 107 creates because backlinks weren't paginated to completion), and the resulting cross-space governance proposals are large and hard to roll back. Do the merge in supervised stages instead.

> Only run this after the editor replied **`force big-merge`**. It is destructive and produces real governance proposals.

## Principle

Migrate **one source space at a time**, verify the backlink count after each stage, and never delete the duplicate until every backlink that pointed at it has been re-pointed and confirmed. Under-migration is the failure mode — bias toward over-counting and re-checking.

## Steps

1. **Lock the Main.** Confirm the canonical entity (most backlinks, highest-priority space) with the editor. Record its starting backlink count, **paginated to completion** (page through `relations(filter: { toEntity: { id: { is: "<main>" } } })` with `first: 50` by `createdAt` until a page returns < 50). Write down `mainBacklinks_before` and the page count.

2. **Inventory each duplicate.** For every member to merge in: record its backlink count (paginated to completion, with page count), its unique values, and its unique outgoing relations. Sum the expected post-merge total: `expected = mainBacklinks_before + Σ(duplicate backlinks)`.

3. **Migrate backlinks per source space.** For each space that holds backlinks to a duplicate, build a batch that, for each backlink edge: `deleteRelation({ id: edge.id })` then `createRelation({ fromEntity, toEntity: main, type, entityId: edge.entityId, ...optionalRelationFields })` — preserving `toSpace`/`fromSpace`/`position`. Keep each space's ops in its own `OpsBatch` bucket → its own transaction/proposal. Dry-run, eyeball the per-space counts, then publish that **one** space.

4. **Verify after every space.** Re-query Main's backlinks (paginated). The running total must rise by exactly the number of edges you migrated from that space. If it doesn't, STOP — do not proceed to the next space, and do not delete anything. Investigate the gap.

5. **Port values + outgoing relations** to Main (skip any property/relation Main already has; skip `LEGACY_PROPERTY_IDS` / `LEGACY_RELATION_TYPE_IDS`).

6. **Delete the duplicates only at the end**, once `mainBacklinks_now === expected`. Strip each member (unset values, delete remaining relations) and emit a protocol-level `deleteEntity`.

7. **Final check.** `mainBacklinks_after ≈ expected`. A meaningful gap is a red flag for under-migration — investigate before declaring the merge done.

## Why not just raise the helper's cap

The cap exists because the failure is silent: the helper returns "success" while having dropped rows. The per-space, verify-as-you-go procedure above makes any under-migration visible at the stage it happens, instead of after every duplicate is already deleted.
