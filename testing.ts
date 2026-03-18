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

// ─── 1. Delete Entity ──────────────────────────────────────────────────────
const spaceId = 'a19c345ab9866679b001d7d2138d88a1';
const entityId = 'c1d3cd1449714e6e9c9215771741fee8';
const ops = await deleteEntity({
  entityId,
  spaceId,
  dryRun: true,           // set to true to preview without publishing
  // skipOrphanCleanup: true, // set to true to skip recursive orphan deletion
});
printOps(ops, '.', 'delete_entity_ops.txt');
/**/