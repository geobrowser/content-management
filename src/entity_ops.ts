import { Graph, type Op, type PropertyValueParam } from '@geoprotocol/geo-sdk';
import { gql, publishOps } from './functions.ts';
import { TYPES, DATA_TYPE_PROPERTY, DATA_TYPE_TO_SDK } from './constants.ts';

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
    return { property: prop, type: 'integer', value: v.integer };
  }
  if (v.float != null) {
    return { property: prop, type: 'float', value: v.float };
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
  typeId: string;
  toEntityId: string;
  toEntity: { name: string } | null;
  typeEntity: { name: string } | null;
  toSpaceId: string | null;
}

interface BacklinkRecord {
  id: string;
  typeId: string;
  fromEntityId: string;
  fromEntity: { name: string } | null;
  typeEntity: { name: string } | null;
  spaceId: string;
}

interface EntityData {
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
      typeId
      toEntityId
      toEntity { name }
      typeEntity { name }
      toSpaceId
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
      typeId
      fromEntityId
      fromEntity { name }
      typeEntity { name }
      spaceId
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
      typeId
      fromEntityId
      fromEntity { name }
      typeEntity { name }
      spaceId
    }
  }`);
  return data.relations ?? [];
}

/** Check if an entity has any remaining backlinks in any space. */
async function hasBacklinks(entityId: string): Promise<boolean> {
  const backlinks = await queryBacklinks(entityId);
  return backlinks.length > 0;
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
  const { entityId, spaceId, dryRun = false, skipOrphanCleanup = false, excludeFromOrphanCheck = [] } = options;

  console.log(`\n[deleteEntity] Querying entity ${entityId} in space ${spaceId}...`);
  const { values, relations } = await queryEntityData(entityId, spaceId);

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

  // Orphan cleanup: check if any "to" entities are now orphaned
  if (!skipOrphanCleanup && toEntityIds.length > 0) {
    const uniqueToIds = [...new Set(toEntityIds)].filter(id => !excludeFromOrphanCheck.includes(id));
    for (const toId of uniqueToIds) {
      // Check if the entity still has backlinks from other entities
      const remainingBacklinks = await queryBacklinks(toId);
      // Filter out the relation from the entity we're deleting
      const externalBacklinks = remainingBacklinks.filter(bl => bl.fromEntityId !== entityId);
      if (externalBacklinks.length === 0) {
        console.log(`  Orphaned entity detected: ${toId} — recursively deleting`);
        const orphanOps = await deleteEntity({
          entityId: toId,
          spaceId,
          dryRun: true, // collect ops, we'll publish everything together
          skipOrphanCleanup: false,
          excludeFromOrphanCheck,
        });
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
    await publishOps(ops, `Delete entity ${entityId}`, spaceId);
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
}

/**
 * Change an entity's ID by recreating all its properties and relations under a new ID,
 * updating all backlinks to point to the new ID, then deleting the old entity.
 */
export async function changeEntityId(options: ChangeEntityIdOptions): Promise<Op[]> {
  const { oldEntityId, newEntityId, spaceId, dryRun = false } = options;

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

  // Recreate all outgoing relations from the new entity
  for (const r of relations) {
    const result = Graph.createRelation({
      fromEntity: newEntityId,
      toEntity: r.toEntityId,
      type: r.typeId,
    });
    ops.push(...result.ops);
  }

  // Migrate backlinks: delete old ones pointing to oldEntityId, recreate pointing to newEntityId
  const backlinks = await queryBacklinks(oldEntityId);
  console.log(`  ${backlinks.length} backlinks to migrate`);

  for (const bl of backlinks) {
    const delResult = Graph.deleteRelation({ id: bl.id });
    ops.push(...delResult.ops);

    const createResult = Graph.createRelation({
      fromEntity: bl.fromEntityId,
      toEntity: newEntityId,
      type: bl.typeId,
    });
    ops.push(...createResult.ops);
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
    await publishOps(ops, `Move entity ${oldEntityId} → ${newEntityId}`, spaceId);
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
}

/**
 * Move an entity from one space to another, keeping the same entity ID.
 * Recreates all properties and relations in the new space, then deletes from the old space.
 * Backlinks with toSpaceId set to the old space are updated to point to the new space.
 */
export async function changeSpace(options: ChangeSpaceOptions): Promise<{ createOps: Op[]; deleteOps: Op[] }> {
  const { entityId, fromSpaceId, toSpaceId, dryRun = false } = options;

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

  // Recreate relations in the new space
  for (const r of relations) {
    const result = Graph.createRelation({
      fromEntity: entityId,
      toEntity: r.toEntityId,
      type: r.typeId,
    });
    createOps.push(...result.ops);
  }

  // Update backlinks that have toSpaceId set to the old space
  const backlinks = await queryBacklinks(entityId);
  const backlinksToPatch = backlinks.filter(bl => bl.spaceId === fromSpaceId);
  console.log(`  ${backlinksToPatch.length} backlinks to update (in old space)`);

  // Backlinks in the old space need their toSpaceId updated — delete and recreate
  // (these are relations FROM other entities TO this entity, stored in fromSpaceId)
  // We can only update them if they're in a space we control
  for (const bl of backlinksToPatch) {
    const delResult = Graph.deleteRelation({ id: bl.id });
    createOps.push(...delResult.ops); // include in create batch for the old space

    const createResult = Graph.createRelation({
      fromEntity: bl.fromEntityId,
      toEntity: entityId,
      type: bl.typeId,
    });
    createOps.push(...createResult.ops);
  }

  // Delete from old space
  const deleteOps = await deleteEntity({
    entityId,
    spaceId: fromSpaceId,
    dryRun: true,
    skipOrphanCleanup: true,
  });

  console.log(`  Generated ${createOps.length} create ops (new space) + ${deleteOps.length} delete ops (old space).`);

  if (!dryRun) {
    // Publish creation in the new space first, then deletion in the old space
    await publishOps(createOps, `Move entity ${entityId} to space ${toSpaceId}`, toSpaceId);
    await publishOps(deleteOps, `Remove entity ${entityId} from space ${fromSpaceId}`, fromSpaceId);
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
  /** If true, copy non-duplicate relations from secondaries onto the main entity (default: false) */
  appendRelations?: boolean;
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
  const { mainEntityId, mainSpaceId, secondaries, dryRun = false, appendRelations = false } = options;

  console.log(`\n[mergeEntities] Merging ${secondaries.length} entities into ${mainEntityId} (space ${mainSpaceId})`);

  // Check if the main entity is a Property type — if so, we'll auto-migrate property references
  const mainEntityData = await gql(`{
    entities(filter: { id: { is: "${mainEntityId}" } }) { typeIds }
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
  const allSecondaryIds = secondaries.map(s => s.entityId);

  // ── Same-space secondaries: merge properties, relations, backlinks ────
  const sameSpaceIds = bySpace.get(mainSpaceId);
  if (sameSpaceIds && sameSpaceIds.length > 0) {
    console.log(`\n  Same-space merge: ${sameSpaceIds.length} entities in space ${mainSpaceId}`);

    const mainData = await queryEntityData(mainEntityId, mainSpaceId);
    const mainPropertyIds = new Set(mainData.values.map(v => v.propertyId));
    const mainRelationKeys = new Set(
      mainData.relations.map(r => `${r.typeId}:${r.toEntityId}`)
    );

    for (const secondaryId of sameSpaceIds) {
      console.log(`\n    Processing secondary: ${secondaryId}`);
      const secondaryData = await queryEntityData(secondaryId, mainSpaceId);

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

      // Optionally add non-duplicate relations from secondary to main
      const movedRelationTargets: string[] = [];
      if (appendRelations) {
        for (const r of secondaryData.relations) {
          const key = `${r.typeId}:${r.toEntityId}`;
          if (!mainRelationKeys.has(key)) {
            console.log(`      Adding relation: ${r.typeEntity?.name ?? r.typeId} → ${r.toEntity?.name ?? r.toEntityId}`);
            const result = Graph.createRelation({
              fromEntity: mainEntityId,
              toEntity: r.toEntityId,
              type: r.typeId,
            });
            allOps.push(...result.ops);
            mainRelationKeys.add(key);
            movedRelationTargets.push(r.toEntityId);
          }
        }
      }

      // Migrate backlinks pointing TO the secondary → point to main instead
      const backlinks = await queryBacklinks(secondaryId);
      for (const bl of backlinks) {
        if (allSecondaryIds.includes(bl.fromEntityId)) continue;

        const delResult = Graph.deleteRelation({ id: bl.id });
        allOps.push(...delResult.ops);

        const key = `${bl.typeId}:${mainEntityId}`;
        if (!mainRelationKeys.has(key)) {
          const createResult = Graph.createRelation({
            fromEntity: bl.fromEntityId,
            toEntity: mainEntityId,
            type: bl.typeId,
          });
          allOps.push(...createResult.ops);
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
      });
      allOps.push(...deleteOps);
    }

    bySpace.delete(mainSpaceId);
  }

  // ── Cross-space secondaries: merge within each space, then change entity ID ──
  for (const [otherSpaceId, entityIds] of bySpace) {
    let survivorId = entityIds[0];

    // If multiple entities in this foreign space, merge them first
    if (entityIds.length > 1) {
      console.log(`\n  Cross-space: merging ${entityIds.length} entities within space ${otherSpaceId}`);
      const withinOps = await mergeEntities({
        mainEntityId: survivorId,
        mainSpaceId: otherSpaceId,
        secondaries: entityIds.slice(1).map(id => ({ entityId: id, spaceId: otherSpaceId })),
        dryRun,
      });
      allOps.push(...withinOps);
    }

    // Move the survivor to the main entity's ID
    console.log(`\n  Cross-space: changing entity ID ${survivorId} → ${mainEntityId} in space ${otherSpaceId}`);
    const moveOps = await changeEntityId({
      oldEntityId: survivorId,
      newEntityId: mainEntityId,
      spaceId: otherSpaceId,
      dryRun,
    });
    allOps.push(...moveOps);
  }

  // Publish the merge ops (before property migration, which publishes per-space)
  if (!dryRun && allOps.length > 0 && sameSpaceIds && sameSpaceIds.length > 0 && bySpace.size === 0) {
    await publishOps(allOps, `Merge ${secondaries.length} entities into ${mainEntityId}`, mainSpaceId);
  }

  // ── Property entity: migrate references from old secondary IDs to main ──
  // This publishes per-space internally (respecting write access checks)
  if (isPropertyEntity) {
    for (const oldPropertyId of allSecondaryIds) {
      console.log(`\n  Migrating property references: ${oldPropertyId} → ${mainEntityId}`);
      const migrationOps = await migratePropertyReferences({
        oldPropertyId,
        newPropertyId: mainEntityId,
        dryRun,
      });
      allOps.push(...migrationOps);
    }
  }

  console.log(`\n  Generated ${allOps.length} total merge ops.`);
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
  return v[field];
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

  // Numeric → text
  if (['integer', 'float', 'boolean'].includes(fromType) && toType === 'text') {
    const textVal = String(value);
    console.log(`      Converting ${fromType} → text: ${value} → "${textVal}"`);
    return textVal;
  }

  // date/datetime/time → text
  if (['date', 'datetime', 'time'].includes(fromType) && toType === 'text') {
    const textVal = String(value);
    console.log(`      Converting ${fromType} → text: "${value}" → "${textVal}"`);
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
}

/**
 * When a Property entity is moved/merged, update all references to the old property ID:
 * - Scans ALL spaces for values/relations using the old property ID
 * - Checks write access (member or editor) before publishing to each space
 * - Logs a warning for spaces that need updates but we can't write to
 */
export async function migratePropertyReferences(options: MigratePropertyIdOptions): Promise<Op[]> {
  const { oldPropertyId, newPropertyId, dryRun = false } = options;

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

  // Discover all spaces that reference the old property ID (as values or relations)
  const discoveryData = await gql(`{
    values(filter: { propertyId: { is: "${oldPropertyId}" } }) {
      spaceId
    }
    relations(filter: { typeId: { is: "${oldPropertyId}" } }) {
      spaceId
    }
  }`);

  const valueSpaces = (discoveryData.values ?? []).map((v: any) => v.spaceId);
  const relationSpaces = (discoveryData.relations ?? []).map((r: any) => r.spaceId);
  const affectedSpaceIds = [...new Set([...valueSpaces, ...relationSpaces])];

  if (affectedSpaceIds.length === 0) {
    console.log('  No spaces reference the old property ID — nothing to migrate.');
    return [];
  }

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
      // We can write to our own personal space
      hasWriteAccess = spaceId === callerSpaceId;
    } else {
      // DAO space — check if we're a member or editor
      const members = (space.membersList ?? []).map((m: any) => m.memberSpaceId);
      const editors = (space.editorsList ?? []).map((e: any) => e.memberSpaceId);
      hasWriteAccess = callerSpaceId != null && [...members, ...editors].includes(callerSpaceId);
    }

    const ops: Op[] = [];

    // Find all values using the old property ID in this space
    const valueData = await gql(`{
      values(filter: {
        propertyId: { is: "${oldPropertyId}" }
        spaceId: { is: "${spaceId}" }
      }) {
        entityId
        ${VALUE_FIELDS}
      }
    }`);

    const valuesUsingOld = valueData.values ?? [];
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

    // Find all relations using the old property ID as their type in this space
    const relationData = await gql(`{
      relations(filter: {
        typeId: { is: "${oldPropertyId}" }
        spaceId: { is: "${spaceId}" }
      }) {
        id
        fromEntityId
        toEntityId
      }
    }`);

    const relationsUsingOld = relationData.relations ?? [];
    if (relationsUsingOld.length > 0) {
      console.log(`    ${relationsUsingOld.length} relation(s) using old property ID as type`);

      for (const r of relationsUsingOld) {
        const delResult = Graph.deleteRelation({ id: r.id });
        ops.push(...delResult.ops);

        const createResult = Graph.createRelation({
          fromEntity: r.fromEntityId,
          toEntity: r.toEntityId,
          type: newPropertyId,
        });
        ops.push(...createResult.ops);
      }
    }

    if (ops.length > 0) {
      if (!hasWriteAccess) {
        console.error(`    ⚠ Space ${spaceId} needs ${ops.length} property migration ops but you are not a member/editor — skipping publish`);
      } else if (!dryRun) {
        await publishOps(ops, `Migrate property ${oldPropertyId} → ${newPropertyId}`, spaceId);
      }
      allOps.push(...ops);
    }
  }

  console.log(`\n  Total property migration ops: ${allOps.length}`);
  return allOps;
}
