import { Graph, type Op, type PropertyValueParam } from '@geoprotocol/geo-sdk';
import { getWalletAddress, gql, publishOps } from './functions.ts';
import {
  TYPES, PROPERTIES, DATA_TYPE_PROPERTY, DATA_TYPE_TO_SDK,
  CURATED_TOPIC_ENTITY_ID, FEATURED_TOPIC_ENTITY_ID, TAGS_RELATION_TYPE_ID,
  EXCLUDED_VALUE_PROPERTY_IDS, EXCLUDED_RELATION_TYPE_IDS,
} from './constants.ts';

/** Run async functions with limited concurrency. Rejects immediately if any task fails. */
async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = 10): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let hasError = false;

  async function worker() {
    while (nextIndex < items.length && !hasError) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
import * as fs from 'fs';
import * as path from 'path';

// Curated / Featured topic constants (FEATURED_TOPIC_ENTITY_ID,
// CURATED_TOPIC_ENTITY_ID, TAGS_RELATION_TYPE_ID) now live in constants.ts and
// are imported above — shared with the deterministic selector in select_canonical.ts.
// mergeEntities' internal same-space auto-select still uses them, but the topic
// merge script now picks the canonical up front (see SELECTION_RULES.md).

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

/** Writers preview by default: they publish only with `dryRun: false` or an `opsBatch`. */
function notePreview(fn: string, options: { dryRun?: boolean; opsBatch?: OpsBatch }): void {
  if (options.dryRun === undefined && !options.opsBatch) {
    console.log(`  ${fn}: preview only — pass dryRun: false or an opsBatch to publish.`);
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
export async function queryValueParams(entityId: string, spaceId: string, propertyFilter?: string[]): Promise<PropertyValueParam[]> {
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
    // Voting data (Score etc.) is system-maintained and never copied — this is
    // the choke point for every value-copy path (merge, move, changeEntityId).
    if (EXCLUDED_VALUE_PROPERTY_IDS.has(v.propertyId)) {
      console.log(`    Skipping voting value property (never migrated): ${v.propertyId}`);
      continue;
    }
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

/** Paginate any `*Connection` query and return all node objects. */
async function fetchAllConnectionNodes<T>(
  connectionName: string,
  filterClause: string,
  nodeFields: string,
  pageSize = 500,
): Promise<T[]> {
  const all: T[] = [];
  let afterClause = '';
  while (true) {
    const data = await gql(`{
      ${connectionName}(filter: { ${filterClause} }, first: ${pageSize} ${afterClause}) {
        edges { node { ${nodeFields} } }
        pageInfo { hasNextPage endCursor }
      }
    }`);
    const conn = data[connectionName];
    for (const e of conn?.edges ?? []) all.push(e.node as T);
    if (!conn?.pageInfo?.hasNextPage) break;
    afterClause = `, after: "${conn.pageInfo.endCursor}"`;
  }
  return all;
}

const OUTGOING_RELATION_FIELDS = `
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
`;

const BACKLINK_FIELDS = `
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
`;

/** Fetch all values and outgoing relations for an entity in a specific space. */
export async function queryEntityData(entityId: string, spaceId: string): Promise<EntityData> {
  const [values, relations] = await Promise.all([
    fetchAllConnectionNodes<ValueRecord>(
      'valuesConnection',
      `entityId: { is: "${entityId}" } spaceId: { is: "${spaceId}" }`,
      `propertyId propertyEntity { name }`,
    ),
    fetchAllConnectionNodes<RelationRecord>(
      'relationsConnection',
      `fromEntityId: { is: "${entityId}" } spaceId: { is: "${spaceId}" }`,
      OUTGOING_RELATION_FIELDS,
    ),
  ]);
  return { values, relations };
}

/** Fetch all backlinks (relations pointing TO an entity) across all spaces. */
async function queryBacklinks(entityId: string): Promise<BacklinkRecord[]> {
  return fetchAllConnectionNodes<BacklinkRecord>(
    'relationsConnection',
    `toEntityId: { is: "${entityId}" }`,
    BACKLINK_FIELDS,
  );
}

/** Fetch backlinks in a specific space only. */
async function queryBacklinksInSpace(entityId: string, spaceId: string): Promise<BacklinkRecord[]> {
  return fetchAllConnectionNodes<BacklinkRecord>(
    'relationsConnection',
    `toEntityId: { is: "${entityId}" } spaceId: { is: "${spaceId}" }`,
    BACKLINK_FIELDS,
  );
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
  /** If provided, only delete orphans whose typeIds include at least one of these types.
   *  Entities of other types (e.g. Person, Company) are left even if orphaned. */
  orphanTypeFilter?: Set<string>;
  /**
   * If true, do NOT delete incoming relations (backlinks) pointing at this entity.
   * Used by a MOVE, which relocates the entity's own values + outgoing relations
   * but leaves references intact so they keep resolving to the same global id
   * (now living in another space). Default false. Orphan cleanup should be off too.
   */
  keepIncomingRelations?: boolean;
}

/**
 * Delete an entity from a space:
 * 1. Unset all value properties
 * 2. Delete all outgoing relations
 * 3. Optionally check if "to" entities are now orphaned and recursively delete them
 *
 * Returns the generated ops. Publishes them only with `dryRun: false`; with an
 * `opsBatch` they are added to the batch instead. Otherwise it is a preview.
 */
export async function deleteEntity(options: DeleteEntityOptions): Promise<Op[]> {
  const { entityId, spaceId, dryRun = !options.opsBatch, skipOrphanCleanup = false, excludeFromOrphanCheck = [], opsBatch, prefetchedEntityData, entityDataCache, backlinksCache, orphanTypeFilter, keepIncomingRelations = false } = options;
  notePreview('deleteEntity', options);
  // Initialize deletingIds internally if not provided so recursive orphan
  // detection correctly ignores sibling orphans even for single-entity calls.
  const deletingIds = options.deletingIds ?? new Set<string>();
  deletingIds.add(entityId);
  const isBeingDeleted = (id: string) => deletingIds.has(id);

  const cached = prefetchedEntityData ?? entityDataCache?.get(entityId);
  console.log(`\n[deleteEntity] ${cached ? 'Using prefetched data for' : 'Querying'} entity ${entityId} in space ${spaceId}...`);
  const { values, relations } = cached ?? await queryEntityData(entityId, spaceId);

  const allPropertyIds = [...new Set(values.map(v => v.propertyId))];
  // Voting values (Score) are system-maintained — not ours to unset, even on deletion.
  const uniquePropertyIds = allPropertyIds.filter(pid => !EXCLUDED_VALUE_PROPERTY_IDS.has(pid));
  if (uniquePropertyIds.length < allPropertyIds.length) {
    console.log(`  Leaving ${allPropertyIds.length - uniquePropertyIds.length} voting value(s) (Score) untouched`);
  }
  console.log(`  Found ${values.length} values across ${allPropertyIds.length} properties`);
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

  // Delete all outgoing relations (except votes — never touched by our ops)
  const toEntityIds: string[] = [];
  for (const r of relations) {
    if (EXCLUDED_RELATION_TYPE_IDS.has(r.typeId)) {
      console.log(`  Leaving outgoing vote relation untouched: ${r.id}`);
      continue;
    }
    const result = Graph.deleteRelation({ id: r.id });
    ops.push(...result.ops);
    toEntityIds.push(r.toEntityId);
  }

  // Delete all incoming relations (from other entities pointing to this one),
  // unless the caller wants to keep them (e.g. a MOVE preserves references).
  if (!keepIncomingRelations) {
    const incomingRelations = backlinksCache?.has(entityId)
      ? backlinksCache.get(entityId)!.filter(bl => bl.spaceId === spaceId)
      : await queryBacklinksInSpace(entityId, spaceId);
    console.log(`  Found ${incomingRelations.length} incoming relations`);
    let skippedVoteBacklinks = 0;
    for (const r of incomingRelations) {
      if (EXCLUDED_RELATION_TYPE_IDS.has(r.typeId)) { skippedVoteBacklinks++; continue; }
      const result = Graph.deleteRelation({ id: r.id });
      ops.push(...result.ops);
    }
    if (skippedVoteBacklinks > 0) {
      console.log(`  Left ${skippedVoteBacklinks} incoming vote relation(s) (Rank Votes) untouched`);
    }
  }

  // Orphan cleanup: check if any "to" entities are now orphaned
  if (!skipOrphanCleanup && toEntityIds.length > 0) {
    // Build a type lookup from relations for orphan type filtering
    const toEntityTypeIds = new Map<string, string[]>();
    for (const r of relations) {
      if (r.toEntity?.typeIds) toEntityTypeIds.set(r.toEntityId, r.toEntity.typeIds);
    }

    const uniqueToIds = [...new Set(toEntityIds)].filter(id => {
      if (excludeFromOrphanCheck.includes(id) || isBeingDeleted(id)) return false;
      if (orphanTypeFilter) {
        const typeIds = toEntityTypeIds.get(id) ?? [];
        if (!typeIds.some(t => orphanTypeFilter.has(t))) return false;
      }
      return true;
    });

    // Check orphan candidates with limited concurrency to avoid overwhelming the API
    const orphanChecks = await pMap(uniqueToIds, async toId => {
      const remainingBacklinks = backlinksCache?.get(toId) ?? await queryBacklinks(toId);
      const externalBacklinks = remainingBacklinks.filter(bl => !isBeingDeleted(bl.fromEntityId));
      return { toId, isOrphan: externalBacklinks.length === 0 };
    });

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
      const orphanResults = await pMap(orphanIds, toId =>
        deleteEntity({
          entityId: toId,
          spaceId,
          dryRun: true,
          skipOrphanCleanup: false,
          excludeFromOrphanCheck: visited,
          entityDataCache,
          backlinksCache,
          deletingIds,
          orphanTypeFilter,
        })
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
  /**
   * When true (default) the source's values + outgoing relations are recreated
   * under newEntityId in this space — a genuine ID move. When false, ONLY the
   * incoming references are redirected and the source is deleted; the source's
   * own data is dropped, not copied. A cross-space MERGE uses false so the target
   * keeps its own space(s): recreating the source's values/relations here would
   * give the target a presence in the source's space (incoming references do not
   * — they resolve cross-space by global id).
   */
  migrateValuesAndRelations?: boolean;
}

/**
 * Change an entity's ID by recreating all its properties and relations under a new ID,
 * updating all backlinks to point to the new ID, then deleting the old entity.
 * With `migrateValuesAndRelations: false`, only references are redirected (no data move).
 */
export async function changeEntityId(options: ChangeEntityIdOptions): Promise<Op[]> {
  const { oldEntityId, newEntityId, spaceId, dryRun = !options.opsBatch, opsBatch, migrateValuesAndRelations = true } = options;
  notePreview('changeEntityId', options);

  console.log(`\n[changeEntityId] ${oldEntityId} → ${newEntityId} in space ${spaceId}${migrateValuesAndRelations ? '' : ' (references only)'}`);
  const { values, relations } = await queryEntityData(oldEntityId, spaceId);

  const uniquePropertyIds = [...new Set(values.map(v => v.propertyId))];
  console.log(`  ${uniquePropertyIds.length} properties, ${relations.length} relations on source${migrateValuesAndRelations ? ' to migrate' : ' (dropped — not copied to target, preserving its spaces)'}`);

  const ops: Op[] = [];

  // Recreate the source's own values + outgoing relations under the new ID — ONLY
  // when migrating data. A cross-space merge skips this so the target is not given
  // a presence (values/outgoing relations) in the source's space. References below
  // are still redirected and resolve cross-space by global id.
  if (migrateValuesAndRelations) {
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
      if (EXCLUDED_RELATION_TYPE_IDS.has(r.typeId)) {
        console.log(`  Skipping vote relation (never migrated): ${r.id}`);
        continue;
      }
      const result = Graph.createRelation({
        fromEntity: newEntityId,
        toEntity: r.toEntityId,
        type: r.typeId,
        entityId: r.entityId,
        ...optionalRelationFields(r),
      });
      ops.push(...result.ops);
    }
  }

  // Redirect backlinks: delete old ones pointing to oldEntityId, recreate pointing to newEntityId.
  // Only handle backlinks that live in THIS space. Backlinks in other spaces are the
  // caller's responsibility (e.g. when mergeEntities orchestrates a multi-space merge,
  // the same-space-merge path handles non-foreign-space backlinks). Skip recreating a
  // reference the target already has (same fromEntity + type) to avoid duplicates.
  const backlinks = (await queryBacklinks(oldEntityId)).filter(bl => bl.spaceId === spaceId);
  const existingTargetRefs = new Set(
    (await queryBacklinks(newEntityId)).map(bl => `${bl.fromEntityId}:${bl.typeId}`)
  );
  console.log(`  ${backlinks.length} backlinks to redirect in space ${spaceId}`);

  for (const bl of backlinks) {
    // Votes are never redirected — a Rank Votes backlink is someone's vote on the
    // OLD entity; rewriting it would fabricate a vote on the new one.
    if (EXCLUDED_RELATION_TYPE_IDS.has(bl.typeId)) {
      console.log(`    Leaving vote backlink untouched (Rank Votes): "${bl.fromEntity?.name ?? bl.fromEntityId}"`);
      continue;
    }
    const delResult = Graph.deleteRelation({ id: bl.id });
    ops.push(...delResult.ops);

    const key = `${bl.fromEntityId}:${bl.typeId}`;
    if (!existingTargetRefs.has(key)) {
      const createResult = Graph.createRelation({
        fromEntity: bl.fromEntityId,
        toEntity: newEntityId,
        type: bl.typeId,
        entityId: bl.entityId,
        ...optionalRelationFields(bl),
      });
      ops.push(...createResult.ops);
      existingTargetRefs.add(key);
    } else {
      console.log(`    Skipping duplicate reference: ${bl.fromEntityId} --[${bl.typeEntity?.name ?? bl.typeId}]--> target (already exists)`);
    }
  }

  // Delete the old entity — skip orphan cleanup (conservative: never delete shared
  // targets like the Topic type even when the source's relations are being dropped).
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

// ─── Move / Copy Entity between spaces ──────────────────────────────────────

export interface MoveEntityOptions {
  /** Entity ID (stays the same across spaces) */
  entityId: string;
  /** Space the entity currently lives in */
  fromSpaceId: string;
  /** Space to move/copy it into */
  toSpaceId: string;
  /**
   * 'move' (default): recreate the entity's values + outgoing relations in the
   *   target space, then remove them from the source — the entity ends up in the
   *   target space only.
   * 'copy': recreate in the target but keep the source — the entity becomes
   *   multi-space (like Geo's "Copy to").
   */
  mode?: 'move' | 'copy';
  /** If true, generate ops but don't publish */
  dryRun?: boolean;
  /** If provided, accumulate ops into this batch instead of publishing */
  opsBatch?: OpsBatch;
}

/**
 * Move (or copy) an entity from one space to another, keeping the same entity ID.
 * Type-agnostic: works for any entity (topics, people, …) — it only touches the
 * entity's own values and outgoing relations.
 *
 * References TO the entity (backlinks) are deliberately LEFT UNTOUCHED: because the
 * entity ID is unchanged, they keep resolving to it (now in the target space) as
 * cross-space references. This preserves them — the move analogue of the merge's
 * reference-preservation, and it diverges intentionally from Geo's "Move to", which
 * deletes source-space references.
 *
 * NOTE: only the entity's own data moves — not the entities it points to (those
 * relations become cross-space) nor its block children (not cascaded).
 */
export async function moveEntity(options: MoveEntityOptions): Promise<{ createOps: Op[]; deleteOps: Op[] }> {
  const { entityId, fromSpaceId, toSpaceId, mode = 'move', dryRun = !options.opsBatch, opsBatch } = options;
  notePreview('moveEntity', options);

  console.log(`\n[moveEntity] ${mode} ${entityId}: space ${fromSpaceId} → ${toSpaceId}`);
  const { values, relations } = await queryEntityData(entityId, fromSpaceId);

  const uniquePropertyIds = [...new Set(values.map(v => v.propertyId))];
  console.log(`  ${uniquePropertyIds.length} properties, ${relations.length} outgoing relations`);

  const createOps: Op[] = [];

  // Recreate values in the target space (same entity id).
  if (uniquePropertyIds.length > 0) {
    const valueParams = await queryValueParams(entityId, fromSpaceId);
    if (valueParams.length > 0) {
      createOps.push(...Graph.updateEntity({ id: entityId, values: valueParams }).ops);
    }
  }

  // Recreate outgoing relations in the target space. For a MOVE we reuse the same
  // relation entity id (the relation relocates); for a COPY we mint a NEW id so the
  // two per-space copies stay independent (matches Geo's "Copy to").
  for (const r of relations) {
    if (EXCLUDED_RELATION_TYPE_IDS.has(r.typeId)) {
      console.log(`  Skipping vote relation (never migrated): ${r.id}`);
      continue;
    }
    createOps.push(...Graph.createRelation({
      fromEntity: entityId,
      toEntity: r.toEntityId,
      type: r.typeId,
      ...(mode === 'move' ? { entityId: r.entityId } : {}),
      ...optionalRelationFields(r),
    }).ops);
  }

  // Source cleanup (MOVE only): remove the entity's own values + outgoing relations
  // from the source, but KEEP incoming references (backlinks) so they survive and
  // resolve cross-space. For COPY, leave the source entirely as-is.
  let deleteOps: Op[] = [];
  if (mode === 'move') {
    deleteOps = await deleteEntity({
      entityId,
      spaceId: fromSpaceId,
      dryRun: true,
      skipOrphanCleanup: true,
      keepIncomingRelations: true,
    });
  }

  console.log(`  Generated ${createOps.length} create ops (target) + ${deleteOps.length} delete ops (source).`);

  if (!dryRun) {
    await publishOrBatch(createOps, `${mode === 'copy' ? 'Copy' : 'Move'} entity ${entityId} to space ${toSpaceId}`, toSpaceId, opsBatch);
    if (deleteOps.length > 0) {
      await publishOrBatch(deleteOps, `Remove entity ${entityId} from space ${fromSpaceId}`, fromSpaceId, opsBatch);
    }
  }

  return { createOps, deleteOps };
}

// ─── Move Entity: Change Space (legacy) ─────────────────────────────────────
// Predates moveEntity and is kept for the existing numbered scripts. Unlike
// moveEntity ('move' mode), it also rewrites the entity's old-space backlinks.
// Prefer moveEntity for new work — it preserves references untouched.

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
  const { entityId, fromSpaceId, toSpaceId, dryRun = !options.opsBatch, opsBatch } = options;
  notePreview('changeSpace', options);

  console.log(`\n[changeSpace] Entity ${entityId}: space ${fromSpaceId} → ${toSpaceId}`);
  const { values, relations } = await queryEntityData(entityId, fromSpaceId);

  const uniquePropertyIds = [...new Set(values.map(v => v.propertyId))];
  console.log(`  ${uniquePropertyIds.length} properties, ${relations.length} relations to migrate`);

  const createOps: Op[] = [];

  // Recreate values in the new space (voting values excluded inside queryValueParams)
  if (uniquePropertyIds.length > 0) {
    const valueParams = await queryValueParams(entityId, fromSpaceId);
    if (valueParams.length > 0) {
      const result = Graph.updateEntity({ id: entityId, values: valueParams });
      createOps.push(...result.ops);
    }
  }

  // Recreate relations in the new space, reusing the same relation entity
  for (const r of relations) {
    if (EXCLUDED_RELATION_TYPE_IDS.has(r.typeId)) {
      console.log(`  Skipping vote relation (never migrated): ${r.id}`);
      continue;
    }
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
    // Votes are never rewritten — a Rank Votes backlink is someone's vote.
    if (EXCLUDED_RELATION_TYPE_IDS.has(bl.typeId)) {
      console.log(`  Leaving vote backlink untouched (Rank Votes): ${bl.id}`);
      continue;
    }
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
  /** Entities to merge into the main entity and then delete. `residentSpaceIds` =
   * all spaces the entity lives in; `keptSpaceIds` = spaces where the entity
   * SURVIVES the merge (personal/dataset residencies + spaces it represents) —
   * backlinks living in a kept space stay pointing at the surviving copy. */
  secondaries: Array<{ entityId: string; spaceId: string; residentSpaceIds?: string[]; keptSpaceIds?: string[] }>;
  /** Personal/dataset spaces: never emit ops for them. A secondary resident in one
   * survives there; backlinks living there keep pointing at that surviving copy. */
  untouchableSpaceIds?: Set<string>;
  /**
   * Safety override. By default the merge refuses to delete/vacate any
   * secondary that lives in a canonical (DAO) space — a canonical entity must
   * never be the merge loser silently (see the Canonical-Delete gate in
   * geo-clean). Set true ONLY after the editor approved a plan whose END STATE
   * showed exactly which canonical-space copies get removed.
   */
  allowCanonicalDelete?: boolean;
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
  /** If true, skip auto-selection and use the provided mainEntityId as-is. */
  disableAutoSelect?: boolean;
  /**
   * Caller-supplied output object. After the merge runs:
   *   - `out.canonicalId` is set to the entity ID chosen as canonical (whether
   *     auto-selected or forced).
   *   - `out.canonicalName` is set to the chosen entity's Name (best-effort —
   *     empty when no candidates had a Name value, e.g. a fresh entity).
   * Useful when the caller needs to attach follow-up ops (e.g. a rename) to the
   * canonical or print a summary without inspecting the returned ops.
   */
  out?: { canonicalId?: string; canonicalName?: string };
  /**
   * Optional set of "original" entity ids supplied by the caller (e.g. the CSV
   * row). When provided, the canonical announce log marks each line with
   * `[csv]` (in this set) or `[snapshot]` (not in this set — i.e. added later
   * via expansion). Purely cosmetic; doesn't affect merge behavior.
   */
  seedIds?: Set<string>;
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
    mainEntityId: inputMainEntityId, mainSpaceId, secondaries, dryRun = !options.opsBatch,
    addPropertiesToMain = true, allowCanonicalDelete = false, opsBatch,
    entityDataCache: inputEntityDataCache,
    backlinksCache: inputBacklinksCache,
    disableAutoSelect = false,
    out,
    seedIds,
    untouchableSpaceIds,
  } = options;
  notePreview('mergeEntities', options);

  // Where each secondary survives (all residencies incl. personal/dataset) — used
  // to leave backlinks in untouchable spaces pointing at the surviving copy.
  const residencyById = new Map<string, Set<string>>();
  const keptById = new Map<string, Set<string>>();
  for (const s of secondaries) {
    if (s.residentSpaceIds) residencyById.set(s.entityId, new Set(s.residentSpaceIds));
    if (s.keptSpaceIds) keptById.set(s.entityId, new Set(s.keptSpaceIds));
  }

  console.log(`\n[mergeEntities] Merging ${secondaries.length} entities into ${inputMainEntityId} (space ${mainSpaceId})`);

  // ── Canonical-Delete guard: a canonical (DAO) entity must never be the merge
  // loser without explicit authorization. Secondaries get stripped+deleted
  // (same-space) or vacated via changeEntityId (cross-space). Untouchable
  // (personal/dataset) residencies are exempt — those are skipped, not deleted.
  // Fail-safe: a space whose type can't be verified counts as canonical.
  if (!allowCanonicalDelete && secondaries.length > 0) {
    const secondarySpaceIds = [...new Set(secondaries.map(s => s.spaceId))]
      .filter(id => !untouchableSpaceIds?.has(id));
    if (secondarySpaceIds.length > 0) {
      const spaceData = await gql(`{
        spaces(filter: { id: { in: [${secondarySpaceIds.map(id => `"${id}"`).join(', ')}] } }) { id type }
      }`);
      const typeBySpace = new Map<string, string>((spaceData.spaces ?? []).map((s: any) => [s.id, s.type]));
      const unsafe = secondaries.filter(s =>
        !untouchableSpaceIds?.has(s.spaceId) && (typeBySpace.get(s.spaceId) ?? 'UNKNOWN') !== 'PERSONAL',
      );
      if (unsafe.length > 0) {
        const list = unsafe.map(s => `${s.entityId} (space ${s.spaceId}: ${typeBySpace.get(s.spaceId) ?? 'type unverifiable'})`).join(', ');
        throw new Error(
          `[mergeEntities] Refusing to merge — a canonical entity would be deleted/vacated. ` +
          `${unsafe.length} secondary entity(ies) are not in a PERSONAL space: ${list}. ` +
          `A canonical (DAO) entity must never be the merge loser silently: make the canonical entity the Main (it survives), ` +
          `or pass allowCanonicalDelete: true ONLY after the editor approved a plan whose END STATE shows these removals.`
        );
      }
    }
  }

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
  // Default the exposed canonical to the input main; the auto-select block below
  // may override this when same-space candidates exist.
  if (out) out.canonicalId = mainEntityId;
  const initialSameSpace = bySpace.get(mainSpaceId);
  if (initialSameSpace && initialSameSpace.length > 0) {
    // All same-space candidates (including the original main)
    const candidates = [inputMainEntityId, ...initialSameSpace];

    interface CandidateInfo { id: string; name: string; entityData: EntityData; backlinks: BacklinkRecord[]; backlinkCount: number; propCount: number; hasCuratedTag: boolean; hasFeaturedTopicTag: boolean }
    let candidateInfo: CandidateInfo[];

    // Use caches if all candidates are already prefetched, otherwise query
    const allCached = candidates.every(id => entityDataCache.has(id) && backlinksCache.has(id));
    if (allCached) {
      console.log(`  All ${candidates.length} candidates found in cache — skipping query`);
      candidateInfo = candidates.map(id => {
        const entityData = entityDataCache.get(id)!;
        const backlinks = backlinksCache.get(id)!;
        const propCount = entityData.values.length + entityData.relations.length;
        return { id, name: '', entityData, backlinks, backlinkCount: backlinks.length, propCount, hasCuratedTag: false, hasFeaturedTopicTag: false };
      });
    } else {
      const candidateFilterIds = candidates.map(id => `"${id}"`).join(', ');
      const candidateData = await gql(`{
        entities(filter: { id: { in: [${candidateFilterIds}] } }) {
          name
          ${ENTITY_INLINE_FIELDS}
        }
      }`);

      candidateInfo = (candidateData.entities ?? []).map((e: any) => {
        const { relations, backlinks, values } = parseInlineEntity(e);
        const entityData: EntityData = { values, relations };
        const propCount = values.length + relations.length;
        const rawName = e.name;
        const name = (rawName == null || rawName === 'null') ? '' : rawName;
        return { id: e.id as string, name, entityData, backlinks, backlinkCount: backlinks.length, propCount, hasCuratedTag: false, hasFeaturedTopicTag: false };
      });
    }

    // The inline `backlinks { nodes }` query caps results (typically at 100), so
    // candidateInfo[*].backlinks.length is an undercount for heavily-linked entities.
    // Fetch the true total via relationsConnection.totalCount for accurate auto-select.
    // Also check for "Tags → Featured topic" and "Tags → Curated topic" relations
    // (in any space) — Featured topic trumps all other criteria, then Curated topic.
    // Also fetch entity name (so cached candidates get a name too).
    await Promise.all(candidateInfo.map(async ci => {
      const data = await gql(`{
        entity: entities(filter: { id: { is: "${ci.id}" } }) { name }
        backlinks: relationsConnection(filter: { toEntityId: { is: "${ci.id}" } }) { totalCount }
        featured: relations(filter: {
          fromEntityId: { is: "${ci.id}" }
          toEntityId:   { is: "${FEATURED_TOPIC_ENTITY_ID}" }
          typeId:       { is: "${TAGS_RELATION_TYPE_ID}" }
        }) { id }
        curated: relations(filter: {
          fromEntityId: { is: "${ci.id}" }
          toEntityId:   { is: "${CURATED_TOPIC_ENTITY_ID}" }
          typeId:       { is: "${TAGS_RELATION_TYPE_ID}" }
        }) { id }
      }`);
      if (!ci.name) {
        const rawName = data.entity?.[0]?.name;
        ci.name = (rawName == null || rawName === 'null') ? '' : rawName;
      }
      ci.backlinkCount = data.backlinks?.totalCount ?? ci.backlinkCount;
      ci.hasFeaturedTopicTag = (data.featured ?? []).length > 0;
      ci.hasCuratedTag = (data.curated ?? []).length > 0;
    }));

    if (disableAutoSelect) {
      // Keep the caller-provided main as canonical regardless of candidate stats.
      // Still move the provided main to the front of candidateInfo so downstream
      // logic that reads candidateInfo[0] sees it correctly.
      const mainCi = candidateInfo.find(ci => ci.id === inputMainEntityId);
      const others = candidateInfo.filter(ci => ci.id !== inputMainEntityId);
      if (mainCi) candidateInfo = [mainCi, ...others];
      mainEntityId = inputMainEntityId;
    } else {
      // Sort:
      //   1. Has Featured topic tag (any tagged candidate wins outright)
      //   2. Has Curated topic tag
      //   3. Most blocks (richest content)
      //   4. Most backlinks (real totalCount)
      //   5. Most properties+relations (tiebreak)
      candidateInfo.sort((a, b) => {
        if (a.hasFeaturedTopicTag !== b.hasFeaturedTopicTag) return a.hasFeaturedTopicTag ? -1 : 1;
        if (a.hasCuratedTag !== b.hasCuratedTag) return a.hasCuratedTag ? -1 : 1;
        const aBlocks = a.entityData.relations.filter(r => r.typeId === PROPERTIES.blocks).length;
        const bBlocks = b.entityData.relations.filter(r => r.typeId === PROPERTIES.blocks).length;
        if (bBlocks !== aBlocks) return bBlocks - aBlocks;
        if (b.backlinkCount !== a.backlinkCount) return b.backlinkCount - a.backlinkCount;
        return b.propCount - a.propCount;
      });

      mainEntityId = candidateInfo[0].id;
    }

    // Always announce the canonical clearly so it's easy to scan in batch runs.
    const chosen = candidateInfo.find(ci => ci.id === mainEntityId);
    const tag = chosen?.hasFeaturedTopicTag ? ' [Featured topic]'
      : chosen?.hasCuratedTag ? ' [Curated topic]'
      : '';
    const reason = disableAutoSelect ? ' (forced)' : '';
    // When `seedIds` is supplied, mark each line with origin: [csv] = supplied
    // by caller, [snapshot] = added via expansion.
    const originTag = (id: string): string => {
      if (!seedIds) return '';
      return seedIds.has(id) ? ' [csv]' : ' [snapshot]';
    };
    const others = candidateInfo
      .filter(ci => ci.id !== mainEntityId)
      .map(ci => `      - "${ci.name || ci.id}" (${ci.id.slice(0,8)})${originTag(ci.id)}`);
    console.log(`\n  ★ CANONICAL: "${chosen?.name ?? ''}" (${mainEntityId})${tag}${reason}${originTag(mainEntityId)}`);
    if (others.length > 0) {
      console.log(`    secondaries (${others.length}):`);
      console.log(others.join('\n'));
    }

    // Expose the chosen canonical to the caller (used for post-merge renames etc.)
    if (out) {
      out.canonicalId = mainEntityId;
      out.canonicalName = chosen?.name ?? '';
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

      // The inline `relations { nodes }` and `backlinks { nodes }` queries cap
      // at ~100 nodes per entity. For orphan detection downstream, capped
      // backlink counts can cause a non-orphan target to be wrongly flagged as
      // orphan when all its cached backlinks happen to be being-deleted and the
      // (uncached) overflow ones aren't. Re-fetch capped entries via paginated
      // helpers before caching.
      const INLINE_NODE_CAP = 100;
      let capRefreshCount = 0;

      const BULK = 500;
      for (let i = 0; i < targetIds.length; i += BULK) {
        const batch = targetIds.slice(i, i + BULK);
        const filterIds = batch.map(id => `"${id}"`).join(', ');
        const data = await gql(`{
          entities(filter: { id: { in: [${filterIds}] } }) {
            ${ENTITY_INLINE_FIELDS}
          }
        }`);

        // Process each entity: refresh truncated lists, then cache.
        await Promise.all((data.entities ?? []).map(async (e: any) => {
          const id = e.id as string;
          const { relations, backlinks, values } = parseInlineEntity(e);
          if (entityDataCache.has(id) && backlinksCache.has(id)) return;

          const needBacklinks = backlinks.length >= INLINE_NODE_CAP;
          const needRelations = relations.length >= INLINE_NODE_CAP;
          if (needBacklinks || needRelations) capRefreshCount++;

          const [finalBacklinks, finalRelations] = await Promise.all([
            needBacklinks ? queryBacklinks(id) : Promise.resolve(backlinks),
            needRelations
              ? fetchAllConnectionNodes<RelationRecord>(
                  'relationsConnection',
                  `fromEntityId: { is: "${id}" }`,
                  OUTGOING_RELATION_FIELDS,
                )
              : Promise.resolve(relations),
          ]);
          if (!entityDataCache.has(id)) entityDataCache.set(id, { values, relations: finalRelations });
          if (!backlinksCache.has(id)) backlinksCache.set(id, finalBacklinks);
        }));

        // Ensure all batch IDs have entries (even if entity wasn't found)
        for (const id of batch) {
          if (!entityDataCache.has(id)) entityDataCache.set(id, { values: [], relations: [] });
          if (!backlinksCache.has(id)) backlinksCache.set(id, []);
        }
      }

      if (capRefreshCount > 0) {
        console.log(`  Refreshed ${capRefreshCount} cache entries that hit the inline 100-node cap`);
      }
      console.log(`  Prefetched ${entityDataCache.size} entity data + ${backlinksCache.size} backlink entries`);
    }
  }

  // Dedupe: a multispace secondary appears once per space in `secondaries` but
  // is a single entity ID — downstream loops (data-block filters, property
  // migration) must not run per-occurrence.
  const allSecondaryIds = [...new Set([
    ...(bySpace.get(mainSpaceId) ?? []),
    ...secondaries.filter(s => s.spaceId !== mainSpaceId).map(s => s.entityId),
  ])];

  // ── Save pre-merge snapshot for recovery ────
  if (!dryRun) {
    const snapshotDir = path.resolve('snapshots', 'merges');
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

    // The shared entityDataCache may have been populated from a cross-space
    // inline query (capped at ~100 and not space-filtered), so it can both
    // miss relations and include foreign-space ones. Always re-fetch via
    // paginated, space-filtered queryEntityData for same-space merge accuracy.
    const mainData = await queryEntityData(mainEntityId, mainSpaceId);
    const mainPropertyIds = new Set(mainData.values.map(v => v.propertyId));
    const mainRelationKeys = new Set(
      mainData.relations.map(r => `${r.typeId}:${r.toEntityId}`)
    );

    // Track which entities already have backlinks of a given type pointing to main,
    // so we don't create duplicate backlinks when migrating from secondaries.
    const mainBacklinks = await queryBacklinks(mainEntityId);
    const existingMainBacklinkKeys = new Set(
      mainBacklinks.map(bl => `${bl.fromEntityId}:${bl.typeId}`)
    );

    // Delete any outgoing relation from main that points AT a secondary being
    // merged. After the merge, those relations would dangle on a now-empty
    // entity (rendered as the raw id in UIs) — and rewriting them to point at
    // main would just create a self-relation. Just remove them.
    const secondarySet = new Set(sameSpaceSecondaries);
    const mainRelsToSecondaries = mainData.relations.filter(
      r => secondarySet.has(r.toEntityId) && !EXCLUDED_RELATION_TYPE_IDS.has(r.typeId)
    );
    for (const r of mainRelsToSecondaries) {
      console.log(`    Removing main's relation pointing at secondary: ${r.typeEntity?.name ?? r.typeId} → ${r.toEntity?.name ?? r.toEntityId}`);
      const delResult = Graph.deleteRelation({ id: r.id });
      allOps.push(...delResult.ops);
      mainRelationKeys.delete(`${r.typeId}:${r.toEntityId}`);
    }

    for (const secondaryId of sameSpaceSecondaries) {
      console.log(`\n    Processing secondary: ${secondaryId}`);
      const secondaryData = await queryEntityData(secondaryId, mainSpaceId);

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

          // Voting data is never copied onto the canonical
          if (EXCLUDED_RELATION_TYPE_IDS.has(r.typeId)) {
            console.log(`      Skipping vote relation (never migrated): ${r.typeEntity?.name ?? r.typeId} → ${r.toEntity?.name ?? r.toEntityId}`);
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

      // Migrate backlinks pointing TO the secondary → point to main instead.
      // Route ops to the relation's own spaceId, not mainSpaceId.
      // Always paginate (don't trust the capped inline cache).
      const backlinks = await queryBacklinks(secondaryId);

      // If this secondary id is ALSO being processed as a foreign-space
      // secondary, skip backlinks in those foreign spaces — changeEntityId
      // will migrate them. Otherwise we'd generate duplicate delete+create
      // op pairs for the same backlink.
      const foreignSpacesHandledByChangeEntityId = new Set(
        secondaries
          .filter(s => s.entityId === secondaryId && s.spaceId !== mainSpaceId)
          .map(s => s.spaceId),
      );

      for (const bl of backlinks) {
        if (allSecondaryIds.includes(bl.fromEntityId)) continue;
        if (foreignSpacesHandledByChangeEntityId.has(bl.spaceId)) continue;

        // Votes are never migrated: a Rank Votes backlink is another user's vote
        // (its Rank usually lives in their personal space). Redirecting it to the
        // canonical would rewrite their vote AND generate ops for spaces we can't
        // publish to (fix-package noise). Leave it untouched.
        if (EXCLUDED_RELATION_TYPE_IDS.has(bl.typeId)) {
          console.log(`      Leaving vote backlink untouched (Rank Votes): "${bl.fromEntity?.name ?? bl.fromEntityId}" (space ${bl.spaceId.slice(0, 8)})`);
          continue;
        }

        // A backlink living in a space where this secondary SURVIVES the merge
        // (personal/dataset residency, or a space the entity represents) stays
        // valid as-is — it keeps pointing at the surviving copy.
        if (
          keptById.get(secondaryId)?.has(bl.spaceId) ||
          (untouchableSpaceIds?.has(bl.spaceId) && residencyById.get(secondaryId)?.has(bl.spaceId))
        ) {
          console.log(`      Leaving backlink in space ${bl.spaceId.slice(0, 8)} untouched — secondary survives there`);
          continue;
        }

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

      // Transfer missing types from secondary to main.
      // Dedup against `mainRelationKeys` (typeId:toEntityId), which is the
      // SAME Set used by the main relation-copy loop above. It's:
      //   1. built from the chosen canonical's existing relations (not from
      //      `typeIds` field, which may be for the wrong entity post-auto-select);
      //   2. shared across secondaries within this merge — so successive
      //      secondaries don't re-add what an earlier one already created.
      const secondaryTypeRelations = secondaryData.relations.filter(r => r.typeId === PROPERTIES.types);
      for (const typeRel of secondaryTypeRelations) {
        const key = `${PROPERTIES.types}:${typeRel.toEntityId}`;
        if (!mainRelationKeys.has(key)) {
          console.log(`      Adding type: ${typeRel.toEntity?.name ?? typeRel.toEntityId}`);
          const result = Graph.createRelation({
            fromEntity: mainEntityId,
            toEntity: typeRel.toEntityId,
            type: PROPERTIES.types,
          });
          allOps.push(...result.ops);
          mainRelationKeys.add(key);
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
    // Untouchable spaces are skipped wholesale — nothing of ours to vacate there;
    // the secondary's copy in that space survives by design.
    if (untouchableSpaceIds?.has(otherSpaceId)) {
      console.log(`\n  Skipping untouchable space ${otherSpaceId} — secondaries survive there by policy`);
      continue;
    }
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
        // The outer call already passed the Canonical-Delete gate for these
        // secondaries; the within-space sub-merge must not re-refuse them.
        allowCanonicalDelete,
        untouchableSpaceIds,
      });
    }

    // Vacate the survivor from this foreign space: references-only, ALWAYS.
    // Merge (like move) removes the topic from the source space — it never grants
    // the canonical a new residency; that's what COPY is for, and deliberate
    // placement is the move operation's job. The twin's space-local values are
    // dropped with the residency. References are redirected and keep resolving
    // cross-space by global id.
    console.log(`\n  Cross-space: vacating ${survivorId} → ${mainEntityId} in space ${otherSpaceId} (references-only; space loses the topic unless the canonical already lives here)`);
    await changeEntityId({
      oldEntityId: survivorId,
      newEntityId: mainEntityId,
      spaceId: otherSpaceId,
      dryRun,
      opsBatch,
      migrateValuesAndRelations: false,
    });
  }

  // Publish/batch the same-space merge ops to mainSpaceId.
  // Foreign-space ops (changeEntityId, cross-space backlinks) publish themselves
  // to their respective spaces, so allOps only contains same-space (mainSpaceId) ops.
  if (!dryRun && allOps.length > 0 && sameSpaceSecondaries && sameSpaceSecondaries.length > 0) {
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
  const { oldId, newId, dryRun = !options.opsBatch, opsBatch } = options;
  notePreview('updateDataBlockFilters', options);

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
  const { oldPropertyId, newPropertyId, dryRun = !options.opsBatch, opsBatch } = options;
  notePreview('migratePropertyReferences', options);

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
  const privateKey = (process.env.GEO_PRIVATE_KEY ?? process.env.PK_SW) as `0x${string}`;
  let callerSpaceId: string | null = null;
  if (privateKey) {
    // v0.20: config-derived wallet via functions.ts (no hardcoded RPC).
    // Address lowercased — new infra stores addresses lowercase, case-sensitive filter.
    const walletAddress = (await getWalletAddress()).toLowerCase();
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
