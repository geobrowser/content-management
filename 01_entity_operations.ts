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
/*
const ops = await mergeEntities({
  mainEntityId: 'REPLACE_WITH_MAIN_ENTITY_ID',
  mainSpaceId:  'REPLACE_WITH_MAIN_SPACE_ID',
  secondaries: [
    { entityId: 'REPLACE_WITH_SECONDARY_1', spaceId: 'REPLACE_WITH_SPACE_A' },
    { entityId: 'REPLACE_WITH_SECONDARY_2', spaceId: 'REPLACE_WITH_SPACE_B' },
  ],
  //dryRun: true,
  //appendRelations: true; //Setting append relations to true appends extra relations from the secondary entity (in same space) to the main entity
});
printOps(ops, '.', 'merge_entities_ops.txt');
/**/

console.log('Uncomment an operation above and fill in the IDs to run it.');
