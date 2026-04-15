import { Graph, type Op, type PropertyValueParam } from '@geoprotocol/geo-sdk';
import { gql, publishOps } from './functions.ts';
import { TYPES, PROPERTIES, DATA_TYPE_PROPERTY, DATA_TYPE_TO_SDK } from './constants.ts';
import * as fs from 'fs';
import * as path from 'path';

// ─── Ops Batching ──────────────────────────────────────────────────────────

/** Map of spaceId → accumulated ops. Pass to functions to defer publishing. */
export type OpsBatch = Map<string, Op[]>;

/** Either publish ops immediately or accumulate them into a batch. */
async function publishOrBatch(
  ops: Op[],
  editName: string,
  spaceId: string,
  opsBatch?: OpsBatch,
): Promise<void> {
  if (opsBatch) {
    const existing = opsBatch.get(spaceId) ?? [];
    existing.push(...ops);
    opsBatch.set(spaceId, existing);
  } else {
    await publishOps(ops, editName, spaceId);
  }
}

// ─── Value Conversion Helper ────────────────────────────────────────────────

/** GQL value fields fragment — include in any query that fetches values for copying. */
const VALUE_FIELDS = `
  propertyId
  text
  integer
  float
  boolean
  date
  datetime
  time
  schedule
`;

/** Convert a GraphQL value row into a PropertyValueParam for the SDK. */
function toPropertyValueParam(v: any): PropertyValueParam | null {
  const prop = v.propertyId;

  if (v.text != null) {
    return { property: prop, type: 'text', value: v.text };
  }
  if (v.date != null) {
    return { property: prop, type: 'date', value: v.date };
  }
  if (v.datetime != null) {
    return { property: prop, type: 'datetime', value: v.datetime };
  }
  if (v.time != null) {
    return { property: prop, type: 'time', value: v.time };
  }
  if (v.integer != null) {
    return { property: prop, type: 'integer', value: Number(v.integer) };
  }
  if (v.float != null) {
    return { property: prop, type: 'float', value: Number(v.float) };
  }
  if (v.boolean != null) {
    return { property: prop, type: 'boolean', value: v.boolean };
  }
  if (v.schedule != null) {
    return { property: prop, type: 'schedule', value: v.schedule };
  }
  return null;
}

/** Query full value data for an entity in a space and return as PropertyValueParam[]. */
async function queryValueParams(entityId: string, spaceId: string, propertyFilter?: string[]): Promise<PropertyValueParam[]> {
  const filterClause = propertyFilter
    ? `propertyId: { in: [${propertyFilter.map(id => `"${id}"`).join(', ')}] }`
    : '';
  const data = await gql(`{
    values(filter: {
      entityId: { is: "${entityId}" }
      spaceId: { is: "${spaceId}" }
      ${filterClause}
    }) {
      ${VALUE_FIELDS}
    }
  }`);

  const params: PropertyValueParam[] = [];
  const seen = new Set<string>();
  for (const v of data.values ?? []) {
    if (seen.has(v.propertyId)) continue;
    seen.add(v.propertyId);
    const param = toPropertyValueParam(v);
    if (param) params.push(param);
  }
  return params;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface ValueRecord {
  propertyId: string;
  propertyEntity: { name: string } | null;
}

interface RelationRecord {
  id: string;
  entityId: string;
  typeId: string;
  toEntityId: string;
  toEntity: { name: string; typeIds: string[] } | null;
  typeEntity: { name: string } | null;
  toSpaceId: string | null;
  fromSpaceId: string | null;
  toVersionId: string | null;
  fromVersionId: string | null;
  position: string | null;
}

export interface BacklinkRecord {
  id: string;
  entityId: string;
  typeId: string;
  fromEntityId: string;
  fromEntity: { name: string } | null;
  typeEntity: { name: string } | null;
  spaceId: string;
  toSpaceId: string | null;
  fromSpaceId: string | null;
  toVersionId: string | null;
  fromVersionId: string | null;
  position: string | null;
}

export interface EntityData {
  values: ValueRecord[];
  relations: RelationRecord[];
}

// ─── Query Helpers ──────────────────────────────────────────────────────────

/** Fetch all values and outgoing relations for an entity in a specific space. */
async function queryEntityData(entityId: string, spaceId: string): Promise<EntityData> {
  const data = await gql(`{
    values(filter: {
      entityId: { is: "${entityId}" }
      spaceId: { is: "${spaceId}" }
    }) {
      propertyId
      propertyEntity { name }
    }
    relations(filter: {
      fromEntityId: { is: "${entityId}" }
      spaceId: { is: "${spaceId}" }
    }) {
      id
      entityId
      typeId
      toEntityId
      toEntity { name typeIds }
      typeEntity { name }
      toSpaceId
      fromSpaceId
      toVersionId
      fromVersionId
      position
    }
  }`);

  return {
    values: data.values ?? [],
    relations: data.relations ?? [],
  };
}

/** Fetch all backlinks (relations pointing TO an entity) across all spaces. */
async function queryBacklinks(entityId: string): Promise<BacklinkRecord[]> {
  const data = await gql(`{
    relations(filter: {
      toEntityId: { is: "${entityId}" }
    }) {
      id
      entityId
      typeId
      fromEntityId
      fromEntity { name }
      typeEntity { name }
      spaceId
      toSpaceId
      fromSpaceId
      toVersionId
      fromVersionId
      position
    }
  }`);
  return data.relations ?? [];
}

/** Fetch backlinks in a specific space only. */
async function queryBacklinksInSpace(entityId: string, spaceId: string): Promise<BacklinkRecord[]> {
  const data = await gql(`{
    relations(filter: {
      toEntityId: { is: "${entityId}" }
      spaceId: { is: "${spaceId}" }
    }) {
      id
      entityId
      typeId
      fromEntityId
      fromEntity { name }
      typeEntity { name }
      spaceId
      toSpaceId
      fromSpaceId
      toVersionId
      fromVersionId
      position
    }
  }`);
  return data.relations ?? [];
}

/** Check if an entity has any remaining backlinks in any space. */
async function hasBacklinks(entityId: string): Promise<boolean> {
  const backlinks = await queryBacklinks(entityId);
  return backlinks.length > 0;
}

// ─── Inline Entity Query Helpers ─────────────────────────────────────────
// When querying entities with inline relations, backlinks, and values via the
// entities query, the schema uses `nodes` wrappers and different field names
// than the top-level relations/values queries.

/** GraphQL fragment for inline entity fields (relations, backlinks, values). */
export const ENTITY_INLINE_FIELDS = `
  id
  relations {
    nodes {
      id entityId typeId toEntityId
      toEntity { name typeIds }
      type { name }
      toSpaceId fromSpaceId toVersionId fromVersionId position
    }
  }
  backlinks {
    nodes {
      id entityId typeId fromEntityId toEntityId
      fromEntity { name }
      type { name }
      spaceId toSpaceId fromSpaceId toVersionId fromVersionId position
    }
  }
  values {
    nodes {
      property { id name }
    }
  }
`;

/** Map an inline relation node to a RelationRecord. */
function mapRelationNode(n: any): RelationRecord {
  return {
    id: n.id,
    entityId: n.entityId,
    typeId: n.typeId,
    toEntityId: n.toEntityId,
    toEntity: n.toEntity,
    typeEntity: n.type ?? null,
    toSpaceId: n.toSpaceId ?? null,
    fromSpaceId: n.fromSpaceId ?? null,
    toVersionId: n.toVersionId ?? null,
    fromVersionId: n.fromVersionId ?? null,
    position: n.position ?? null,
  };
}

/** Map an inline backlink node to a BacklinkRecord. */
function mapBacklinkNode(n: any): BacklinkRecord {
  return {
    id: n.id,
    entityId: n.entityId,
    typeId: n.typeId,
    fromEntityId: n.fromEntityId,
    fromEntity: n.fromEntity ?? null,
    typeEntity: n.type ?? null,
    spaceId: n.spaceId,
    toSpaceId: n.toSpaceId ?? null,
    fromSpaceId: n.fromSpaceId ?? null,
    toVersionId: n.toVersionId ?? null,
    fromVersionId: n.fromVersionId ?? null,
    position: n.position ?? null,
  };
}

/** Map an inline value node to a ValueRecord. */
function mapValueNode(n: any): ValueRecord {
  return {
    propertyId: n.property?.id,
    propertyEntity: n.property ? { name: n.property.name } : null,
  };
}

/** Extract relations, backlinks, and values from an inline entity response. */
export function parseInlineEntity(e: any): { relations: RelationRecord[]; backlinks: BacklinkRecord[]; values: ValueRecord[] } {
  return {
    relations: (e.relations?.nodes ?? []).map(mapRelationNode),
    backlinks: (e.backlinks?.nodes ?? []).map(mapBacklinkNode),
    values: (e.values?.nodes ?? []).map(mapValueNode),
  };
}

/** Extract optional relation fields (spaces, versions, position) for passing to Graph.createRelation. */
function optionalRelationFields(r: Pick<RelationRecord | BacklinkRecord, 'toSpaceId' | 'fromSpaceId' | 'toVersionId' | 'fromVersionId' | 'position'>) {
  return {
    ...(r.toSpaceId ? { toSpace: r.toSpaceId } : {}),
    ...(r.fromSpaceId ? { fromSpace: r.fromSpaceId } : {}),
    ...(r.toVersionId ? { toVersion: r.toVersionId } : {}),
    ...(r.fromVersionId ? { fromVersion: r.fromVersionId } : {}),
    ...(r.position ? { position: r.position } : {}),
  };
}

// ─── Delete Entity ──────────────────────────────────────────────────────────

export interface DeleteEntityOptions {
  /** Entity ID to delete */
  entityId: string;
  /** Space to delete from */
  spaceId: string;
  /** If true, generate ops but don't publish */
  dryRun?: boolean;
  /** If true, skip orphan cleanup for "to" entities */
  skipOrphanCleanup?: boolean;
  /** Entity IDs to exclude from orphan detection (e.g. a new entity that still references them) */
  excludeFromOrphanCheck?: string[];
  /** If provided, accumulate ops into this batch instead of publishing */
  opsBatch?: OpsBatch;
  /** If provided, skip the queryEntityData call and use this data instead */
  prefetchedEntityData?: EntityData;
  /** If provided, look up entity data for orphan targets here before querying */
  entityDataCache?: Map<string, EntityData>;
  /** If provided, look up backlinks for orphan targets here before querying */
  backlinksCache?: Map<string, BacklinkRecord[]>;
  /**
   * Shared set of entity IDs being deleted. Orphan checks ignore these.
   * Mutated as new orphans are discovered. Pass this when deleting multiple
   * entities in a batch so each call sees the others. If omitted, an
   * internal set is used for the current call only.
   */
  deletingIds?: Set<string>;
}

/**
 * Delete an entity from a space:
 * 1. Unset all value properties
 * 2. Delete all outgoing relations
 * 3. Optionally check if "to" entities are now orphaned and recursively delete them
 *
 * Returns the generated ops (and publishes them unless dryRun is set).
 */
export async function deleteEntity(options: DeleteEntityOptions): Promise<Op[]> {
  const { entityId, spaceId, dryRun = false, skipOrphanCleanup = false, excludeFromOrphanCheck = [], opsBatch, prefetchedEntityData, entityDataCache, backlinksCache } = options;
  // Initialize deletingIds internally if not provided so recursive orphan
  // detection correctly ignores sibling orphans even for single-entity calls.
  const deletingIds = options.deletingIds ?? new Set<string>();
  deletingIds.add(entityId);
  const isBeingDeleted = (id: string) => deletingIds.has(id);

  const cached = prefetchedEntityData ?? entityDataCache?.get(entityId);
  console.log(`\n[deleteEntity] ${cached ? 'Using prefetched data for' : 'Querying'} entity ${entityId} in space ${spaceId}...`);
  const { values, relations } = cached ?? await queryEntityData(entityId, spaceId);

  const uniquePropertyIds = [...new Set(values.map(v => v.propertyId))];
  console.log(`  Found ${values.length} values across ${uniquePropertyIds.length} properties`);
  console.log(`  Found ${relations.length} outgoing relations`);

  const ops: Op[] = [];

  // Unset all value properties
  if (uniquePropertyIds.length > 0) {
    const result = Graph.updateEntity({
      id: entityId,
      unset: uniquePropertyIds.map(p => ({ property: p })),
    });
    ops.push(...result.ops);
  }

  // Delete all outgoing relations
  const toEntityIds: string[] = [];
  for (const r of relations) {
    const result = Graph.deleteRelation({ id: r.id });
    ops.push(...result.ops);
    toEntityIds.push(r.toEntityId);
  }

  // Delete all incoming relations (from other entities pointing to this one)
  const incomingRelations = backlinksCache?.has(entityId)
    ? backlinksCache.get(entityId)!.filter(bl => bl.spaceId === spaceId)
    : await queryBacklinksInSpace(entityId, spaceId);
  console.log(`  Found ${incomingRelations.length} incoming relations`);
  for (const r of incomingRelations) {
    const result = Graph.deleteRelation({ id: r.id });
    ops.push(...result.ops);
  }

  // Orphan cleanup: check if any "to" entities are now orphaned
  if (!skipOrphanCleanup && toEntityIds.length > 0) {
    const uniqueToIds = [...new Set(toEntityIds)].filter(id => !excludeFromOrphanCheck.includes(id) && !isBeingDeleted(id));

    // Check all orphan candidates in parallel, using cache when available
    const orphanChecks = await Promise.all(
      uniqueToIds.map(async toId => {
        const remainingBacklinks = backlinksCache?.get(toId) ?? await queryBacklinks(toId);
        const externalBacklinks = remainingBacklinks.filter(bl => !isBeingDeleted(bl.fromEntityId));
        return { toId, isOrphan: externalBacklinks.length === 0 };
      })
    );

    // Re-check deletingIds here to avoid racing with a sibling recursion that
    // may have already claimed the same orphan.
    const orphanIds = orphanChecks
      .filter(c => c.isOrphan && !deletingIds.has(c.toId))
      .map(c => c.toId);
    if (orphanIds.length > 0) {
      console.log(`  ${orphanIds.length} orphaned entities detected — recursively deleting`);
      for (const id of orphanIds) deletingIds.add(id);
      // Prevent infinite recursion on cycles (e.g. A→B→C→A) by adding the
      // current entity and sibling orphans to excludeFromOrphanCheck.
      const visited = [...excludeFromOrphanCheck, entityId, ...orphanIds];
      const orphanResults = await Promise.all(
        orphanIds.map(toId =>
          deleteEntity({
            entityId: toId,
            spaceId,
            dryRun: true,
            skipOrphanCleanup: false,
            excludeFromOrphanCheck: visited,
            entityDataCache,
            backlinksCache,
            deletingIds,
          })
        )
      );
      for (const orphanOps of orphanResults) {
        ops.push(...orphanOps);
      }
    }
  }

  if (ops.length === 0) {
    console.log('  No properties or relations found — nothing to delete.');
    return ops;
  }

  console.log(`  Generated ${ops.length} delete ops.`);

  if (!dryRun) {
    await publishOrBatch(ops, `Delete entity ${entityId}`, spaceId, opsBatch);
  }

  return ops;
}

// ─── Move Entity: Change Entity ID ─────────────────────────────────────────

export interface ChangeEntityIdOptions {
  /** Current entity ID */
  oldEntityId: string;
  /** New entity ID to migrate to */
  newEntityId: string;
  /** Space the entity lives in */
  spaceId: string;
  /** If true, generate ops but don't publish */
  dryRun?: boolean;
  /** If provided, accumulate ops into this batch instead of publishing */
  opsBatch?: OpsBatch;
}

/**
 * Change an entity's ID by recreating all its properties and relations under a new ID,
 * updating all backlinks to point to the new ID, then deleting the old entity.
 */
export async function changeEntityId(options: ChangeEntityIdOptions): Promise<Op[]> {
  const { oldEntityId, newEntityId, spaceId, dryRun = false, opsBatch } = options;

  console.log(`\n[changeEntityId] ${oldEntityId} → ${newEntityId} in space ${spaceId}`);
  const { values, relations } = await queryEntityData(oldEntityId, spaceId);

  const uniquePropertyIds = [...new Set(values.map(v => v.propertyId))];
  console.log(`  ${uniquePropertyIds.length} properties, ${relations.length} relations to migrate`);

  const ops: Op[] = [];

  // Recreate all value properties on the new entity
  if (uniquePropertyIds.length > 0) {
    const valueParams = await queryValueParams(oldEntityId, spaceId);
    if (valueParams.length > 0) {
      const remapped = valueParams.map(p => ({ ...p, property: p.property }) as PropertyValueParam);
      const result = Graph.updateEntity({
        id: newEntityId,
        values: remapped,
      });
      ops.push(...result.ops);
    }
  }

  // Recreate all outgoing relations from the new entity, reusing the same relation entity
  for (const r of relations) {
    const result = Graph.createRelation({
      fromEntity: newEntityId,
      toEntity: r.toEntityId,
      type: r.typeId,
      entityId: r.entityId,
      ...optionalRelationFields(r),
    });
    ops.push(...result.ops);
  }

  // Migrate backlinks: delete old ones pointing to oldEntityId, recreate pointing to newEntityId
  // Route ops to each relation's own spaceId
  const backlinks = await queryBacklinks(oldEntityId);
  console.log(`  ${backlinks.length} backlinks to migrate`);

  for (const bl of backlinks) {
    const blOps: Op[] = [];
    const delResult = Graph.deleteRelation({ id: bl.id });
    blOps.push(...delResult.ops);

    const createResult = Graph.createRelation({
      fromEntity: bl.fromEntityId,
      toEntity: newEntityId,
      type: bl.typeId,
      entityId: bl.entityId,
      ...optionalRelationFields(bl),
    });
    blOps.push(...createResult.ops);

    if (bl.spaceId === spaceId) {
      ops.push(...blOps);
    } else {
      // Cross-space backlink — publish/batch to the relation's own space
      if (!dryRun) {
        await publishOrBatch(blOps, `Migrate backlinks for ${oldEntityId} → ${newEntityId}`, bl.spaceId, opsBatch);
      }
    }
  }

  // Delete the old entity — skip orphan cleanup since the new entity still references the same targets
  const deleteOps = await deleteEntity({
    entityId: oldEntityId,
    spaceId,
    dryRun: true,
    skipOrphanCleanup: true,
  });
  ops.push(...deleteOps);

  console.log(`  Generated ${ops.length} total ops for changeEntityId.`);

  if (!dryRun) {
    await publishOrBatch(ops, `Move entity ${oldEntityId} → ${newEntityId}`, spaceId, opsBatch);
  }

  return ops;
}

// ─── Move Entity: Change Space ──────────────────────────────────────────────

export interface ChangeSpaceOptions {
  /** Entity ID (stays the same) */
  entityId: string;
  /** Space to move from */
  fromSpaceId: string;
  /** Space to move to */
  toSpaceId: string;
  /** If true, generate ops but don't publish */
  dryRun?: boolean;
  /** If provided, accumulate ops into this batch instead of publishing */
  opsBatch?: OpsBatch;
}

/**
 * Move an entity from one space to another, keeping the same entity ID.
 * Recreates all properties and relations in the new space, then deletes from the old space.
 * Backlinks with toSpaceId set to the old space are updated to point to the new space.
 */
export async function changeSpace(options: ChangeSpaceOptions): Promise<{ createOps: Op[]; deleteOps: Op[] }> {
  const { entityId, fromSpaceId, toSpaceId, dryRun = false, opsBatch } = options;

  console.log(`\n[changeSpace] Entity ${entityId}: space ${fromSpaceId} → ${toSpaceId}`);
  const { values, relations } = await queryEntityData(entityId, fromSpaceId);

  const uniquePropertyIds = [...new Set(values.map(v => v.propertyId))];
  console.log(`  ${uniquePropertyIds.length} properties, ${relations.length} relations to migrate`);

  const createOps: Op[] = [];

  // Recreate values in the new space
  if (uniquePropertyIds.length > 0) {
    const valueParams = await queryValueParams(entityId, fromSpaceId);
    if (valueParams.length > 0) {
      const result = Graph.updateEntity({ id: entityId, values: valueParams });
      createOps.push(...result.ops);
    }
  }

  // Recreate relations in the new space, reusing the same relation entity
  for (const r of relations) {
    const result = Graph.createRelation({
      fromEntity: entityId,
      toEntity: r.toEntityId,
      type: r.typeId,
      entityId: r.entityId,
      ...optionalRelationFields(r),
    });
    createOps.push(...result.ops);
  }

  // Update backlinks that have toSpaceId set to the old space
  const backlinks = await queryBacklinks(entityId);
  const backlinksToPatch = backlinks.filter(bl => bl.spaceId === fromSpaceId);
  console.log(`  ${backlinksToPatch.length} backlinks to update (in old space)`);

  // Backlinks in the old space need their toSpaceId updated — delete and recreate
  // These ops must be published to the relation's own space (fromSpaceId), not toSpaceId
  const backlinkOps: Op[] = [];
  for (const bl of backlinksToPatch) {
    const delResult = Graph.deleteRelation({ id: bl.id });
    backlinkOps.push(...delResult.ops);

    const createResult = Graph.createRelation({
      fromEntity: bl.fromEntityId,
      toEntity: entityId,
      type: bl.typeId,
      entityId: bl.entityId,
      ...optionalRelationFields(bl),
    });
    backlinkOps.push(...createResult.ops);
  }

  // Delete from old space
  const deleteOps = await deleteEntity({
    entityId,
    spaceId: fromSpaceId,
    dryRun: true,
    skipOrphanCleanup: true,
  });

  console.log(`  Generated ${createOps.length} create ops (new space) + ${backlinkOps.length} backlink ops (old space) + ${deleteOps.length} delete ops (old space).`);

  if (!dryRun) {
    // Publish creation in the new space first, then backlink updates + deletion in the old space
    await publishOrBatch(createOps, `Move entity ${entityId} to space ${toSpaceId}`, toSpaceId, opsBatch);
    await publishOrBatch(backlinkOps, `Update backlinks for entity ${entityId}`, fromSpaceId, opsBatch);
    await publishOrBatch(deleteOps, `Remove entity ${entityId} from space ${fromSpaceId}`, fromSpaceId, opsBatch);
  }

  return { createOps, deleteOps };
}

// ─── Merge Entities ─────────────────────────────────────────────────────────

export interface MergeEntitiesOptions {
  /** The entity to keep */
  mainEntityId: string;
  /** Space of the main entity */
  mainSpaceId: string;
  /** Entities to merge into the main entity and then delete */
  secondaries: Array<{ entityId: string; spaceId: string }>;
  /** If true, generate ops but don't publish */
  dryRun?: boolean;
  /** If true, add missing value properties and non-duplicate relations from secondaries onto the main entity (default: true) */
  addPropertiesToMain?: boolean;
  /** If provided, accumulate ops into this batch instead of publishing */
  opsBatch?: OpsBatch;
  /** If provided, use this cache for entity data lookups before querying */
  entityDataCache?: Map<string, EntityData>;
  /** If provided, use this cache for backlink lookups before querying */
  backlinksCache?: Map<string, BacklinkRecord[]>;
}

/**
 * Merge secondary entities into a main entity. Automatically handles both
 * same-space and cross-space scenarios based on the provided space IDs.
 *
 * Same-space secondaries:
 * - Value properties from secondaries are added to main if not already present
 * - Relations from secondaries are added to main (skipping duplicates)
 * - Backlinks pointing to secondaries are updated to point to main
 * - Secondary entities are deleted
 *
 * Cross-space secondaries:
 * - Multiple secondaries in the same foreign space are merged within that space first
 * - Each remaining foreign secondary is moved to the main entity's ID via changeEntityId
 * - No cross-space property deduplication — each space keeps its own properties
 */
export async function mergeEntities(options: MergeEntitiesOptions): Promise<Op[]> {
  const {
    mainEntityId: inputMainEntityId, mainSpaceId, secondaries, dryRun = false,
    addPropertiesToMain = true, opsBatch,
    entityDataCache: inputEntityDataCache,
    backlinksCache: inputBacklinksCache,
  } = options;

  console.log(`\n[mergeEntities] Merging ${secondaries.length} entities into ${inputMainEntityId} (space ${mainSpaceId})`);

  // Check if the main entity is a Property type — if so, we'll auto-migrate property references
  const mainEntityData = await gql(`{
    entities(filter: { id: { is: "${inputMainEntityId}" } }) { typeIds }
  }`);
  const typeIds: string[] = mainEntityData.entities?.[0]?.typeIds ?? [];
  const isPropertyEntity = typeIds.includes(TYPES.property);
  if (isPropertyEntity) {
    console.log(`  Main entity is a Property — will auto-migrate property references after merge`);
  }

  // Group secondaries by space
  const bySpace = new Map<string, string[]>();
  for (const s of secondaries) {
    const list = bySpace.get(s.spaceId) ?? [];
    list.push(s.entityId);
    bySpace.set(s.spaceId, list);
  }

  const allOps: Op[] = [];
  const entityDataCache = inputEntityDataCache ?? new Map<string, EntityData>();
  const backlinksCache = inputBacklinksCache ?? new Map<string, BacklinkRecord[]>();

  // ── Same-space: auto-select main entity by backlinks, then properties+relations ──
  let mainEntityId = inputMainEntityId;
  const initialSameSpace = bySpace.get(mainSpaceId);
  if (initialSameSpace && initialSameSpace.length > 0) {
    // All same-space candidates (including the original main)
    const candidates = [inputMainEntityId, ...initialSameSpace];

    interface CandidateInfo { id: string; entityData: EntityData; backlinks: BacklinkRecord[]; backlinkCount: number; propCount: number }
    let candidateInfo: CandidateInfo[];

    // Use caches if all candidates are already prefetched, otherwise query
    const allCached = candidates.every(id => entityDataCache.has(id) && backlinksCache.has(id));
    if (allCached) {
      console.log(`  All ${candidates.length} candidates found in cache — skipping query`);
      candidateInfo = candidates.map(id => {
        const entityData = entityDataCache.get(id)!;
        const backlinks = backlinksCache.get(id)!;
        const propCount = entityData.values.length + entityData.relations.length;
        return { id, entityData, backlinks, backlinkCount: backlinks.length, propCount };
      });
    } else {
      const candidateFilterIds = candidates.map(id => `"${id}"`).join(', ');
      const candidateData = await gql(`{
        entities(filter: { id: { in: [${candidateFilterIds}] } }) {
          ${ENTITY_INLINE_FIELDS}
        }
      }`);

      candidateInfo = (candidateData.entities ?? []).map((e: any) => {
        const { relations, backlinks, values } = parseInlineEntity(e);
        const entityData: EntityData = { values, relations };
        const propCount = values.length + relations.length;
        return { id: e.id as string, entityData, backlinks, backlinkCount: backlinks.length, propCount };
      });
    }

    // Sort: most blocks first → if tied, most backlinks → if tied, most properties+relations
    // This ensures the entity with the richest content (blocks) is preferred as the survivor.
    // Backlinks are the fallback when block counts are equal.
    candidateInfo.sort((a, b) => {
      const aBlocks = a.entityData.relations.filter(r => r.typeId === PROPERTIES.blocks).length;
      const bBlocks = b.entityData.relations.filter(r => r.typeId === PROPERTIES.blocks).length;
      if (bBlocks !== aBlocks) return bBlocks - aBlocks;
      if (b.backlinkCount !== a.backlinkCount) return b.backlinkCount - a.backlinkCount;
      return b.propCount - a.propCount;
    });

    mainEntityId = candidateInfo[0].id;
    if (mainEntityId !== inputMainEntityId) {
      console.log(`  Auto-selected main entity: ${mainEntityId} (backlinks: ${candidateInfo[0].backlinkCount}, props+rels: ${candidateInfo[0].propCount})`);
    }

    // Rebuild sameSpaceSecondaries to exclude the chosen main
    const sameSpaceSecondaryIds = candidates.filter(id => id !== mainEntityId);
    bySpace.set(mainSpaceId, sameSpaceSecondaryIds);

    // Cache entity data and backlinks from candidate queries
    for (const ci of candidateInfo) {
      entityDataCache.set(ci.id, ci.entityData);
      backlinksCache.set(ci.id, ci.backlinks);
    }

    // Bulk-prefetch entity data and backlinks for all relation targets (orphan candidates)
    // using a single entities query with inline relations + backlinks
    const allRelationTargetIds = new Set<string>();
    for (const ci of candidateInfo) {
      for (const r of ci.entityData.relations) {
        allRelationTargetIds.add(r.toEntityId);
      }
    }
    // Remove entities already in the cache
    for (const ci of candidateInfo) allRelationTargetIds.delete(ci.id);
    for (const id of allRelationTargetIds) {
      if (entityDataCache.has(id) && backlinksCache.has(id)) allRelationTargetIds.delete(id);
    }

    if (allRelationTargetIds.size > 0) {
      const targetIds = [...allRelationTargetIds];
      console.log(`  Bulk-prefetching data for ${targetIds.length} relation targets...`);

      const BULK = 500;
      for (let i = 0; i < targetIds.length; i += BULK) {
        const batch = targetIds.slice(i, i + BULK);
        const filterIds = batch.map(id => `"${id}"`).join(', ');
        const data = await gql(`{
          entities(filter: { id: { in: [${filterIds}] } }) {
            ${ENTITY_INLINE_FIELDS}
          }
        }`);

        // Cache entity data and backlinks from the entities response
        for (const e of data.entities ?? []) {
          const { relations, backlinks, values } = parseInlineEntity(e);
          if (!entityDataCache.has(e.id)) {
            entityDataCache.set(e.id, { values, relations });
          }
          if (!backlinksCache.has(e.id)) {
            backlinksCache.set(e.id, backlinks);
          }
        }

        // Ensure all batch IDs have entries (even if entity wasn't found)
        for (const id of batch) {
          if (!entityDataCache.has(id)) entityDataCache.set(id, { values: [], relations: [] });
          if (!backlinksCache.has(id)) backlinksCache.set(id, []);
        }
      }

      console.log(`  Prefetched ${entityDataCache.size} entity data + ${backlinksCache.size} backlink entries`);
    }
  }

  const allSecondaryIds = [...(bySpace.get(mainSpaceId) ?? []), ...secondaries.filter(s => s.spaceId !== mainSpaceId).map(s => s.entityId)];

  // ── Save pre-merge snapshot for recovery ────
  if (!dryRun) {
    const snapshotDir = path.resolve('snapshots');
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotData: Record<string, { entityData: EntityData; backlinks: BacklinkRecord[] }> = {};
    const allInvolvedIds = [mainEntityId, ...allSecondaryIds];
    for (const id of allInvolvedIds) {
      snapshotData[id] = {
        entityData: entityDataCache.get(id) ?? { values: [], relations: [] },
        backlinks: backlinksCache.get(id) ?? [],
      };
    }
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const snapshotPath = path.join(snapshotDir, `merge-snapshot-${timestamp}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshotData, null, 2));
    console.log(`  Pre-merge snapshot saved: ${snapshotPath}`);
  }

  // ── Same-space secondaries: merge properties, relations, backlinks ────
  const sameSpaceSecondaries = bySpace.get(mainSpaceId);
  if (sameSpaceSecondaries && sameSpaceSecondaries.length > 0) {
    console.log(`\n  Same-space merge: ${sameSpaceSecondaries.length} entities in space ${mainSpaceId}`);

    const mainData = entityDataCache.get(mainEntityId) ?? (await queryEntityData(mainEntityId, mainSpaceId));
    const mainPropertyIds = new Set(mainData.values.map(v => v.propertyId));
    const mainRelationKeys = new Set(
      mainData.relations.map(r => `${r.typeId}:${r.toEntityId}`)
    );

    // Track which entities already have backlinks of a given type pointing to main,
    // so we don't create duplicate backlinks when migrating from secondaries.
    const mainBacklinks = backlinksCache.get(mainEntityId) ?? await queryBacklinks(mainEntityId);
    const existingMainBacklinkKeys = new Set(
      mainBacklinks.map(bl => `${bl.fromEntityId}:${bl.typeId}`)
    );

    for (const secondaryId of sameSpaceSecondaries) {
      console.log(`\n    Processing secondary: ${secondaryId}`);
      const secondaryData = entityDataCache.get(secondaryId) ?? (await queryEntityData(secondaryId, mainSpaceId));

      const movedRelationTargets: string[] = [];
      if (addPropertiesToMain) {
        // Add missing value properties to main
        const missingPropertyIds = [...new Set(secondaryData.values.map(v => v.propertyId))]
          .filter(pid => !mainPropertyIds.has(pid));

        if (missingPropertyIds.length > 0) {
          const valueParams = await queryValueParams(secondaryId, mainSpaceId, missingPropertyIds);

          if (valueParams.length > 0) {
            console.log(`      Adding ${valueParams.length} missing properties to main entity`);
            const result = Graph.updateEntity({ id: mainEntityId, values: valueParams });
            allOps.push(...result.ops);
            for (const p of valueParams) mainPropertyIds.add(p.property as string);
          }
        }

        // Add non-duplicate relations from secondary to main
        // Build a lookup of main entity's existing relation targets by property (typeId)
        // keyed by typeId → array of { entityId, name (lowercase), typeIds }
        const mainRelTargetsByProp = new Map<string, Array<{ entityId: string; name: string; typeIds: string[] }>>();
        for (const mr of mainData.relations) {
          const list = mainRelTargetsByProp.get(mr.typeId) ?? [];
          list.push({
            entityId: mr.toEntityId,
            name: (mr.toEntity?.name ?? '').toLowerCase(),
            typeIds: mr.toEntity?.typeIds ?? [],
          });
          mainRelTargetsByProp.set(mr.typeId, list);
        }

        for (const r of secondaryData.relations) {
          // Never append a different Data Type relation onto a Property entity
          if (isPropertyEntity && r.typeId === DATA_TYPE_PROPERTY) {
            console.log(`      Skipping Data Type relation on Property entity: ${r.toEntity?.name ?? r.toEntityId}`);
            continue;
          }

          const key = `${r.typeId}:${r.toEntityId}`;
          // Check exact entity match
          if (mainRelationKeys.has(key)) {
            console.log(`      Skipping duplicate relation (same entity): ${r.typeEntity?.name ?? r.typeId} → ${r.toEntity?.name ?? r.toEntityId}`);
            continue;
          }

          // Singleton relations — Avatar and Cover should only exist once per entity.
          // If main already has one, skip adding another regardless of target entity.
          const SINGLETON_RELATION_IDS = new Set([
            '1155befffad549b7a2e0da4777b8792c', // Avatar
            '34f535072e6b42c5a84443981a77cfa2', // Cover
          ]);
          if (SINGLETON_RELATION_IDS.has(r.typeId) && (mainRelTargetsByProp.get(r.typeId) ?? []).length > 0) {
            console.log(`      Skipping singleton relation (main already has one): ${r.typeEntity?.name ?? r.typeId} → ${r.toEntity?.name ?? r.toEntityId}`);
            continue;
          }

          // Check for a "soft duplicate" — same property, same name (case-insensitive) and same type
          const existingTargets = mainRelTargetsByProp.get(r.typeId) ?? [];
          const candidateName = (r.toEntity?.name ?? '').toLowerCase();
          const candidateTypeIds = r.toEntity?.typeIds ?? [];
          const softDup = candidateName && existingTargets.some(t =>
            t.name === candidateName &&
            t.typeIds.length > 0 && candidateTypeIds.length > 0 &&
            t.typeIds.some(tid => candidateTypeIds.includes(tid))
          );

          if (softDup) {
            console.log(`      Skipping duplicate relation (same name+type): ${r.typeEntity?.name ?? r.typeId} → ${r.toEntity?.name ?? r.toEntityId}`);
            continue;
          }

          console.log(`      Adding relation: ${r.typeEntity?.name ?? r.typeId} → ${r.toEntity?.name ?? r.toEntityId}`);
          const result = Graph.createRelation({
            fromEntity: mainEntityId,
            toEntity: r.toEntityId,
            type: r.typeId,
            entityId: r.entityId,
            ...optionalRelationFields(r),
          });
          allOps.push(...result.ops);
          mainRelationKeys.add(key);
          // Also add to the soft-duplicate lookup so subsequent secondaries are checked correctly
          existingTargets.push({
            entityId: r.toEntityId,
            name: candidateName,
            typeIds: candidateTypeIds,
          });
          mainRelTargetsByProp.set(r.typeId, existingTargets);
          movedRelationTargets.push(r.toEntityId);
        }
      }

      // Migrate backlinks pointing TO the secondary → point to main instead
      // Route ops to the relation's own spaceId, not mainSpaceId
      const backlinks = backlinksCache.get(secondaryId) ?? await queryBacklinks(secondaryId);

      for (const bl of backlinks) {
        if (allSecondaryIds.includes(bl.fromEntityId)) continue;

        const blOps: Op[] = [];
        const delResult = Graph.deleteRelation({ id: bl.id });
        blOps.push(...delResult.ops);

        // Only recreate pointing to main if fromEntity doesn't already have
        // a relation of the same type pointing to main
        const backlinkKey = `${bl.fromEntityId}:${bl.typeId}`;
        if (!existingMainBacklinkKeys.has(backlinkKey)) {
          const createResult = Graph.createRelation({
            fromEntity: bl.fromEntityId,
            toEntity: mainEntityId,
            type: bl.typeId,
            entityId: bl.entityId,
            ...optionalRelationFields(bl),
          });
          blOps.push(...createResult.ops);
          // Track so subsequent secondaries also see this backlink
          existingMainBacklinkKeys.add(backlinkKey);
        } else {
          console.log(`      Skipping duplicate backlink: ${bl.fromEntityId} --[${bl.typeEntity?.name ?? bl.typeId}]--> main (already exists)`);
        }

        if (bl.spaceId === mainSpaceId) {
          allOps.push(...blOps);
        } else {
          // Cross-space backlink — publish/batch to the relation's own space
          if (!dryRun) {
            await publishOrBatch(blOps, `Migrate backlinks to ${mainEntityId}`, bl.spaceId, opsBatch);
          }
        }
      }

      // Transfer missing types from secondary to main
      // Secondary's Types relations have typeId === PROPERTIES.types
      const secondaryTypeRelations = secondaryData.relations.filter(r => r.typeId === PROPERTIES.types);
      const mainTypeIds = new Set(typeIds); // from line 680 — main entity's typeIds
      for (const typeRel of secondaryTypeRelations) {
        if (!mainTypeIds.has(typeRel.toEntityId)) {
          console.log(`      Adding type: ${typeRel.toEntity?.name ?? typeRel.toEntityId}`);
          const result = Graph.createRelation({
            fromEntity: mainEntityId,
            toEntity: typeRel.toEntityId,
            type: PROPERTIES.types,
          });
          allOps.push(...result.ops);
          mainTypeIds.add(typeRel.toEntityId);
        }
      }

      // Delete the secondary entity
      // Exclude main + any relation targets we moved over from orphan cleanup
      const deleteOps = await deleteEntity({
        entityId: secondaryId,
        spaceId: mainSpaceId,
        dryRun: true,
        skipOrphanCleanup: false,
        excludeFromOrphanCheck: [mainEntityId, ...movedRelationTargets],
        prefetchedEntityData: secondaryData,
        entityDataCache,
        backlinksCache,
      });
      allOps.push(...deleteOps);
    }

    bySpace.delete(mainSpaceId);
  }

  // ── Cross-space secondaries: merge within each space, then change entity ID ──
  // These ops are for otherSpaceId, not mainSpaceId — they publish/batch internally
  // and must NOT be added to allOps (which publishes to mainSpaceId).
  for (const [otherSpaceId, entityIds] of bySpace) {
    let survivorId = entityIds[0];

    // If multiple entities in this foreign space, merge them first
    if (entityIds.length > 1) {
      console.log(`\n  Cross-space: merging ${entityIds.length} entities within space ${otherSpaceId}`);
      await mergeEntities({
        mainEntityId: survivorId,
        mainSpaceId: otherSpaceId,
        secondaries: entityIds.slice(1).map(id => ({ entityId: id, spaceId: otherSpaceId })),
        dryRun,
        opsBatch,
      });
    }

    // Move the survivor to the main entity's ID
    console.log(`\n  Cross-space: changing entity ID ${survivorId} → ${mainEntityId} in space ${otherSpaceId}`);
    await changeEntityId({
      oldEntityId: survivorId,
      newEntityId: mainEntityId,
      spaceId: otherSpaceId,
      dryRun,
      opsBatch,
    });
  }

  // Publish the merge ops (before property migration, which publishes per-space)
  if (!dryRun && allOps.length > 0 && sameSpaceSecondaries && sameSpaceSecondaries.length > 0 && bySpace.size === 0) {
    await publishOrBatch(allOps, `Merge ${secondaries.length} entities into ${mainEntityId}`, mainSpaceId, opsBatch);
  }

  // ── Property entity: migrate references from old secondary IDs to main ──
  // This publishes per-space internally (respecting write access checks).
  // Do NOT add returned ops to allOps — they span multiple spaces and are
  // already published/batched to the correct space inside the function.
  if (isPropertyEntity) {
    for (const oldPropertyId of allSecondaryIds) {
      console.log(`\n  Migrating property references: ${oldPropertyId} → ${mainEntityId}`);
      await migratePropertyReferences({
        oldPropertyId,
        newPropertyId: mainEntityId,
        dryRun,
        opsBatch,
      });
    }
  }

  // ── Update data block filters: replace old secondary IDs with main ID ──
  // Same as above — publishes per-space internally, do not re-add to allOps.
  for (const oldId of allSecondaryIds) {
    console.log(`\n  Updating data block filters: ${oldId} → ${mainEntityId}`);
    await updateDataBlockFilters({
      oldId,
      newId: mainEntityId,
      dryRun,
      opsBatch,
    });
  }

  console.log(`\n  Generated ${allOps.length} total merge ops.`);
  return allOps;
}

// ─── Data Block Filter Updates ──────────────────────────────────────────────

export interface UpdateDataBlockFiltersOptions {
  /** Old entity/property ID to find in filters */
  oldId: string;
  /** New entity/property ID to replace with */
  newId: string;
  /** If true, generate ops but don't publish */
  dryRun?: boolean;
  /** If provided, accumulate ops into this batch instead of publishing */
  opsBatch?: OpsBatch;
}

/**
 * Scan all filter property values across all spaces for occurrences of the
 * old ID (in any position — as a property key or entity value) and replace
 * with the new ID.
 */
export async function updateDataBlockFilters(options: UpdateDataBlockFiltersOptions): Promise<Op[]> {
  const { oldId, newId, dryRun = false, opsBatch } = options;

  console.log(`\n[updateDataBlockFilters] ${oldId} → ${newId}`);

  // Query all filter values that contain the old ID
  const data = await gql(`{
    values(filter: {
      propertyId: { is: "${PROPERTIES.filter}" }
      text: { includes: "${oldId}" }
    }) {
      entityId
      spaceId
      text
    }
  }`);

  const matches = data.values ?? [];
  if (matches.length === 0) {
    console.log('  No filter values reference the old ID.');
    return [];
  }

  console.log(`  Found ${matches.length} filter value(s) containing old ID`);

  const allOps: Op[] = [];

  for (const v of matches) {
    const updatedFilter = v.text.replaceAll(oldId, newId);
    console.log(`    Updating filter on entity ${v.entityId} in space ${v.spaceId}`);

    const ops: Op[] = [];
    const result = Graph.updateEntity({
      id: v.entityId,
      values: [{ property: PROPERTIES.filter, type: 'text', value: updatedFilter }],
    });
    ops.push(...result.ops);

    if (!dryRun) {
      await publishOrBatch(ops, `Update data block filter ${v.entityId}`, v.spaceId, opsBatch);
    }
    allOps.push(...ops);
  }

  console.log(`  Total data block filter ops: ${allOps.length}`);
  return allOps;
}

// ─── Property Data Type Helpers ──────────────────────────────────────────────

/**
 * Query a property entity's data type by looking for a Data Type relation.
 * Returns the SDK value type discriminant (e.g. 'text', 'date') or null if
 * the property has no Data Type (meaning it's a relation-only property).
 */
async function getPropertyDataType(propertyId: string): Promise<string | null> {
  const data = await gql(`{
    relations(filter: {
      fromEntityId: { is: "${propertyId}" }
      typeId: { is: "${DATA_TYPE_PROPERTY}" }
    }) {
      toEntityId
    }
  }`);

  const rels = data.relations ?? [];
  if (rels.length === 0) return null;

  const dataTypeEntityId: string = rels[0].toEntityId;
  return DATA_TYPE_TO_SDK[dataTypeEntityId] ?? null;
}

/** Extract the raw value from a GQL value row given its SDK type discriminant. */
function extractValue(v: any, sdkType: string): any {
  const fieldMap: Record<string, string> = {
    text: 'text', boolean: 'boolean', integer: 'integer', float: 'float',
    date: 'date', datetime: 'datetime', time: 'time', schedule: 'schedule',
  };
  const field = fieldMap[sdkType];
  if (!field) throw new Error(`Unknown SDK type "${sdkType}" — cannot extract value`);
  const raw = v[field];
  if (sdkType === 'integer') return Number(raw);
  if (sdkType === 'float') return Number(raw);
  return raw;
}

/** Build a PropertyValueParam for a given SDK type and converted value. */
function buildValueParam(property: string, sdkType: string, value: any): PropertyValueParam {
  switch (sdkType) {
    case 'text':     return { property, type: 'text',     value };
    case 'boolean':  return { property, type: 'boolean',  value };
    case 'integer':  return { property, type: 'integer',  value };
    case 'float':    return { property, type: 'float',    value };
    case 'date':     return { property, type: 'date',     value };
    case 'datetime': return { property, type: 'datetime', value };
    case 'time':     return { property, type: 'time',     value };
    case 'schedule': return { property, type: 'schedule', value };
    default: throw new Error(`Cannot build PropertyValueParam for unknown type "${sdkType}"`);
  }
}

/**
 * Convert a value from one SDK type to another. Returns the converted value,
 * or throws if the conversion is not supported.
 */
function convertValue(value: any, fromType: string, toType: string): any {
  if (fromType === toType) return value;

  // datetime → date: strip time portion
  if (fromType === 'datetime' && toType === 'date') {
    // Datetime formats: "2025-01-01T12:00:00Z", "2025-01-01T12:00:00.000Z", etc.
    const dateStr = String(value).split('T')[0];
    console.log(`      Converting datetime → date: "${value}" → "${dateStr}"`);
    return dateStr;
  }

  // date → datetime: append midnight UTC
  if (fromType === 'date' && toType === 'datetime') {
    const dtStr = `${String(value).split('T')[0]}T00:00:00Z`;
    console.log(`      Converting date → datetime: "${value}" → "${dtStr}"`);
    return dtStr;
  }

  // integer → float: direct cast
  if (fromType === 'integer' && toType === 'float') {
    const floatVal = Number(value);
    console.log(`      Converting integer → float: ${value} → ${floatVal}`);
    return floatVal;
  }

  // float → integer: round
  if (fromType === 'float' && toType === 'integer') {
    const intVal = Math.round(Number(value));
    console.log(`      Converting float → integer: ${value} → ${intVal}`);
    return intVal;
  }

  // Any type → text
  if (toType === 'text') {
    const textVal = String(value);
    console.log(`      Converting ${fromType} → text: ${JSON.stringify(value)} → "${textVal}"`);
    return textVal;
  }

  throw new Error(
    `Unsupported value conversion: ${fromType} → ${toType}. ` +
    `Value "${value}" cannot be automatically converted.`
  );
}

// ─── Property Entity Migration ──────────────────────────────────────────────

export interface MigratePropertyIdOptions {
  /** Old property entity ID */
  oldPropertyId: string;
  /** New property entity ID */
  newPropertyId: string;
  /** If true, generate ops but don't publish */
  dryRun?: boolean;
  /** If provided, accumulate ops into this batch instead of publishing */
  opsBatch?: OpsBatch;
}

/**
 * When a Property entity is moved/merged, update all references to the old property ID:
 * - Scans ALL spaces for values/relations using the old property ID
 * - Checks write access (member or editor) before publishing to each space
 * - Logs a warning for spaces that need updates but we can't write to
 */
export async function migratePropertyReferences(options: MigratePropertyIdOptions): Promise<Op[]> {
  const { oldPropertyId, newPropertyId, dryRun = false, opsBatch } = options;

  console.log(`\n[migratePropertyReferences] ${oldPropertyId} → ${newPropertyId} (scanning all spaces)`);

  // ── Check data types of old and new property entities ──
  const [oldDataType, newDataType] = await Promise.all([
    getPropertyDataType(oldPropertyId),
    getPropertyDataType(newPropertyId),
  ]);

  const oldIsRelation = oldDataType === null;
  const newIsRelation = newDataType === null;

  console.log(`  Old property data type: ${oldIsRelation ? 'RELATION' : oldDataType}`);
  console.log(`  New property data type: ${newIsRelation ? 'RELATION' : newDataType}`);

  // Relation ↔ value mismatch is an error — cannot convert
  if (oldIsRelation && !newIsRelation) {
    throw new Error(
      `Cannot migrate property ${oldPropertyId} → ${newPropertyId}: ` +
      `old property is a relation property but new property is a value property (${newDataType}). ` +
      `Relations cannot be converted to values.`
    );
  }
  if (!oldIsRelation && newIsRelation) {
    throw new Error(
      `Cannot migrate property ${oldPropertyId} → ${newPropertyId}: ` +
      `old property is a value property (${oldDataType}) but new property is a relation property. ` +
      `Values cannot be converted to relations.`
    );
  }

  const needsConversion = !oldIsRelation && !newIsRelation && oldDataType !== newDataType;
  if (needsConversion) {
    console.log(`  Data type mismatch: ${oldDataType} → ${newDataType} — values will be converted`);
  }

  // Fetch all values and relations using the old property ID in one shot
  const allData = await gql(`{
    values(filter: { propertyId: { is: "${oldPropertyId}" } }) {
      entityId
      spaceId
      ${VALUE_FIELDS}
    }
    relations(filter: { typeId: { is: "${oldPropertyId}" } }) {
      id
      entityId
      spaceId
      fromEntityId
      toEntityId
      toSpaceId
      fromSpaceId
      toVersionId
      fromVersionId
      position
    }
  }`);

  const allValues = allData.values ?? [];
  const allRelations = allData.relations ?? [];

  if (allValues.length === 0 && allRelations.length === 0) {
    console.log('  No spaces reference the old property ID — nothing to migrate.');
    return [];
  }

  // Group values and relations by space
  const valuesBySpace = new Map<string, any[]>();
  for (const v of allValues) {
    const list = valuesBySpace.get(v.spaceId) ?? [];
    list.push(v);
    valuesBySpace.set(v.spaceId, list);
  }

  const relationsBySpace = new Map<string, any[]>();
  for (const r of allRelations) {
    const list = relationsBySpace.get(r.spaceId) ?? [];
    list.push(r);
    relationsBySpace.set(r.spaceId, list);
  }

  const affectedSpaceIds = [...new Set([...valuesBySpace.keys(), ...relationsBySpace.keys()])];
  console.log(`  Found references in ${affectedSpaceIds.length} space(s): ${affectedSpaceIds.join(', ')}`);

  // Resolve our wallet's personal space ID for membership checks
  const privateKey = process.env.PK_SW as `0x${string}`;
  let callerSpaceId: string | null = null;
  if (privateKey) {
    const { getSmartAccountWalletClient } = await import('@geoprotocol/geo-sdk');
    const client = await getSmartAccountWalletClient({
      privateKey,
      rpcUrl: 'https://rpc-geo-test-zc16z3tcvf.t.conduit.xyz',
    });
    const walletAddress = client.account.address;
    const personalData = await gql(`{
      spaces(filter: { address: { is: "${walletAddress}" } }) { id type }
    }`);
    callerSpaceId = personalData.spaces?.find((s: any) => s.type === 'PERSONAL')?.id ?? null;
  }

  const allOps: Op[] = [];

  for (const spaceId of affectedSpaceIds) {
    console.log(`\n  Scanning space ${spaceId}...`);

    // Check write access
    const spaceData = await gql(`{
      space(id: "${spaceId}") {
        type
        membersList { memberSpaceId }
        editorsList { memberSpaceId }
      }
    }`);

    const space = spaceData.space;
    let hasWriteAccess = false;
    if (!space) {
      console.error(`    ⚠ Space ${spaceId} not found — skipping`);
      continue;
    }

    if (space.type === 'PERSONAL') {
      hasWriteAccess = spaceId === callerSpaceId;
    } else {
      const members = (space.membersList ?? []).map((m: any) => m.memberSpaceId);
      const editors = (space.editorsList ?? []).map((e: any) => e.memberSpaceId);
      hasWriteAccess = callerSpaceId != null && [...members, ...editors].includes(callerSpaceId);
    }

    const ops: Op[] = [];

    // Migrate values using the old property ID in this space
    const valuesUsingOld = valuesBySpace.get(spaceId) ?? [];
    if (valuesUsingOld.length > 0) {
      console.log(`    ${valuesUsingOld.length} value(s) using old property ID`);

      const byEntity = new Map<string, any>();
      for (const v of valuesUsingOld) {
        if (!byEntity.has(v.entityId)) byEntity.set(v.entityId, v);
      }

      for (const [eid, v] of byEntity) {
        const unsetResult = Graph.updateEntity({
          id: eid,
          unset: [{ property: oldPropertyId }],
        });
        ops.push(...unsetResult.ops);

        const origParam = toPropertyValueParam(v);
        if (origParam) {
          let param: PropertyValueParam = { ...origParam, property: newPropertyId };

          // Convert value if the data types differ
          if (needsConversion && oldDataType && newDataType) {
            try {
              const rawValue = extractValue(v, oldDataType);
              const converted = convertValue(rawValue, oldDataType, newDataType);
              param = buildValueParam(newPropertyId, newDataType, converted);
            } catch (e: any) {
              console.error(`    ⚠ Skipping value on entity ${eid}: ${e.message}`);
              continue;
            }
          }

          const setResult = Graph.updateEntity({
            id: eid,
            values: [param],
          });
          ops.push(...setResult.ops);
        }
      }
    }

    // Migrate relations using the old property ID as their type in this space
    const relationsUsingOld = relationsBySpace.get(spaceId) ?? [];
    if (relationsUsingOld.length > 0) {
      console.log(`    ${relationsUsingOld.length} relation(s) using old property ID as type`);

      for (const r of relationsUsingOld) {
        const delResult = Graph.deleteRelation({ id: r.id });
        ops.push(...delResult.ops);

        const createResult = Graph.createRelation({
          fromEntity: r.fromEntityId,
          toEntity: r.toEntityId,
          type: newPropertyId,
          entityId: r.entityId,
          ...optionalRelationFields(r),
        });
        ops.push(...createResult.ops);
      }
    }

    if (ops.length > 0) {
      if (!hasWriteAccess) {
        console.error(`    ⚠ Space ${spaceId} needs ${ops.length} property migration ops but you are not a member/editor`);
      }
      if (!dryRun) {
        await publishOrBatch(ops, `Migrate property ${oldPropertyId} → ${newPropertyId}`, spaceId, opsBatch);
      }
      allOps.push(...ops);
    }
  }

  console.log(`\n  Total property migration ops: ${allOps.length}`);
  return allOps;
}
