import { printOps } from './src/functions.js';
import {
  deleteEntity,
  changeEntityId,
  changeSpace,
  mergeEntities,
  migratePropertyReferences,
} from './src/entity_ops.js';

// ─── Configuration ──────────────────────────────────────────────────────────
// Uncomment and fill in the operation you want to run, then execute:
//   bun run 05_entity_operations.ts
/*
// ─── 1. Delete Entity ──────────────────────────────────────────────────────
const spaceId = 'REPLACE_WITH_SPACE_ID';
const entityId = 'REPLACE_WITH_ENTITY_ID';
const ops = await deleteEntity({
  entityId,
  spaceId,
  // dryRun: true,           // set to true to preview without publishing
  // skipOrphanCleanup: true, // set to true to skip recursive orphan deletion
});
printOps(ops, '.', 'delete_entity_ops.txt');
/**/

// ─── 2. Move Entity: Change Entity ID ──────────────────────────────────────
/*
const ops = await changeEntityId({
  oldEntityId: 'REPLACE_WITH_OLD_ENTITY_ID',
  newEntityId: 'REPLACE_WITH_NEW_ENTITY_ID',
  spaceId:     'REPLACE_WITH_SPACE_ID',
 // dryRun: true,
});
printOps(ops, '.', 'change_entity_id_ops.txt');
/**/

// ─── 3. Move Entity: Change Space ──────────────────────────────────────────
// Double check that this handles properties correctly

/*
const { createOps, deleteOps } = await changeSpace({
  entityId:    'REPLACE_WITH_ENTITY_ID',
  fromSpaceId: 'REPLACE_WITH_FROM_SPACE_ID',
  toSpaceId:   'REPLACE_WITH_TO_SPACE_ID',
  // dryRun: true,
});
printOps(createOps, '.', 'change_space_create_ops.txt');
printOps(deleteOps, '.', 'change_space_delete_ops.txt');
/**/

// ─── 4. Merge Entities ──────────────────────────────────────────────────────
// Works for both same-space and cross-space — just provide each secondary's space.
// Automatically identifies property entities and updates property references in any spaces that you have membership or editor status
// Choose the main entity (1. space rank, 2. # of backlinks, 3. # of properties)
//  - Note: # of properties - count the number of properties filled out and number of relations on the entity. If the number of backlinks is equal, choose the enitity with more properties / relations defined. Otherwise just choose randomly. 
// If merging any entities in the same space, choose a main entity (criteria 2 and 3 above)
//  - Identify main entity state (properties / relations)
//  - value properties on the main entity remain unchanged
//  - value properties that exist on secondary entity, but not on main entity, should get added to main entity
//  - relations that exist on secondary properties but not on main entity, should be added to main entity
//  - When adding a relation, need to check whether that relation already exists on the main entity (same to entity). Should also check whether the to entity has a duplicate (e.g. to entity has same name and type as a to entity already existing on the main entity's property) 
/*
const ops = await mergeEntities({
  mainEntityId: '412ff593e9154012a43d4c27ec5c68b6',
  mainSpaceId:  'a19c345ab9866679b001d7d2138d88a1',
  secondaries: [
    { entityId: 'd69608290513c2a91102c939b3265bd7', spaceId: 'd69608290513c2a91102c939b3265bd7' },
  ],
  // dryRun: true,
  // addPropertiesToMain: false //Setting append relations to true appends extra relations from the secondary entity (in same space) to the main entity
});
printOps(ops, '.', 'merge_entities_ops.txt');
/**/

console.log('Uncomment an operation above and fill in the IDs to run it.');
