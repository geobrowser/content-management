import { Graph, type PropertyValueParam } from '@geoprotocol/geo-sdk';
import { gql, publishOps } from './src/functions.js';
import { DATA_TYPES, DATA_TYPE_PROPERTY, DATA_TYPE_TO_SDK, SPACES } from './src/constants.js';
import * as fs from 'fs';

// ─── Configuration ──────────────────────────────────────────────────────────
// Two-phase fix for properties that reference incorrect (old) data type entities:
//
// Phase 1: Fix each property's Data Type relation to point to the correct entity
// Phase 2: Fix values on entities — convert mistyped values to the correct SDK type
//          (e.g. "15908" stored as text → 15908 stored as integer)
//
// Run with: bun run 05_fix_data_types.ts

const DRY_RUN = false; // Set to false to actually publish fixes

// Old (incorrect) → correct data type entity ID mapping
const OLD_TO_CORRECT: Record<string, string> = {
  'db22a933c151866ca01a4d9e471d5797': DATA_TYPES.text,
  '37a13ac05b6887ab83e772d4ece101ab': DATA_TYPES.boolean,
  '4258025c2fa481c3a7acc4cbde4b82c2': DATA_TYPES.integer,
  'd1f0423c3165808d942ff929bf9fc4ce': DATA_TYPES.float,
  'ced1a1c416628b57b3df543ec8ed47b8': DATA_TYPES.decimal,
  '31cc314f1c168c1cb49e6396b7510ed8': DATA_TYPES.date,
  'eef2373859108a4ba8251ad145fdc2f7': DATA_TYPES.time,
  'ef3ccb2d52bb8a31b4802b0e6305ac1e': DATA_TYPES.datetime,
  '28df8e42d6f389828d0156c20a9ee183': DATA_TYPES.schedule,
  '799dd1cff0068f7db65245cc6ace96ab': DATA_TYPES.point,
  'cf14d6bcd4c683f19139ce65552e99e0': DATA_TYPES.bytes,
  'eb924b1b07ed818984c3596a979113b9': DATA_TYPES.embedding,
  '128a4a5c75a48d2da3255ac7d25a1e11': DATA_TYPES.embedding,
};

// Human-readable names for logging
const DATA_TYPE_NAMES: Record<string, string> = {
  [DATA_TYPES.text]:      'Text',
  [DATA_TYPES.boolean]:   'Checkbox',
  [DATA_TYPES.integer]:   'Integer',
  [DATA_TYPES.float]:     'Float64',
  [DATA_TYPES.decimal]:   'Decimal',
  [DATA_TYPES.date]:      'Date',
  [DATA_TYPES.time]:      'Time',
  [DATA_TYPES.datetime]:  'Datetime',
  [DATA_TYPES.schedule]:  'Schedule',
  [DATA_TYPES.point]:     'Point',
  [DATA_TYPES.bytes]:     'Bytes',
  [DATA_TYPES.embedding]: 'Embedding',
  [DATA_TYPES.relation]:  'Relation',
};

// SDK type string for each correct data type entity ID
const CORRECT_SDK_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(DATA_TYPE_TO_SDK).map(([entityId, sdkType]) => [entityId, sdkType])
);

// GQL value fields
const VALUE_FIELDS = `
  entityId
  entity { name }
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Detect which SDK type a GQL value row is currently stored as. */
function detectCurrentType(v: any): string | null {
  if (v.text != null) return 'text';
  if (v.integer != null) return 'integer';
  if (v.float != null) return 'float';
  if (v.boolean != null) return 'boolean';
  if (v.date != null) return 'date';
  if (v.datetime != null) return 'datetime';
  if (v.time != null) return 'time';
  if (v.schedule != null) return 'schedule';
  return null;
}

// Sentinel: returned by parseTextValue when the value is blank and should just be unset
const UNSET = Symbol('UNSET');

/** Expand SI/metric suffixes: K, M, B, T → numeric multiplier */
function expandSuffix(s: string): number | null {
  const match = s.match(/^([<>≈~]?\s*[-+]?\d[\d,]*\.?\d*)\s*([KMBTkmbt])\s*$/);
  if (!match) return null;
  const num = Number(match[1].replace(/[<>≈~\s,]/g, ''));
  if (isNaN(num)) return null;
  const multipliers: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  const mult = multipliers[match[2].toLowerCase()];
  return mult ? num * mult : null;
}

/** Strip common formatting from a numeric string: %, $, commas, leading </>/≈/~ */
function stripNumericFormatting(s: string): number | null {
  // Try suffix expansion first (340B → 340e9)
  const suffixed = expandSuffix(s);
  if (suffixed !== null) return suffixed;

  // Strip $, %, commas, leading comparison operators, whitespace
  let cleaned = s.replace(/[$%,]/g, '').replace(/^[<>≈~]\s*/, '').trim();
  // Remove trailing non-numeric words (e.g. "50 within 5 years..." → "50")
  cleaned = cleaned.replace(/^([-+]?\d[\d.]*)\s+\D.*$/, '$1');
  const num = Number(cleaned);
  if (!isNaN(num) && Number.isFinite(num)) return num;
  return null;
}

/**
 * Parse a text value into the correct SDK type.
 * Returns UNSET for blank values, null if not parseable.
 */
function parseTextValue(text: string, toType: string): any | null | typeof UNSET {
  const trimmed = text.trim();
  if (!trimmed) return UNSET;

  switch (toType) {
    case 'text':
      return trimmed;

    case 'integer': {
      const num = stripNumericFormatting(trimmed);
      if (num !== null) return Math.round(num);
      return null;
    }

    case 'float': {
      const num = stripNumericFormatting(trimmed);
      if (num !== null) return num;
      return null;
    }

    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (['true', '1', 'yes', 'approved', 'positive'].includes(lower)) return true;
      if (['false', '0', 'no', 'not approved', 'negative'].includes(lower)) return false;
      return null;
    }

    case 'date': {
      // YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.match(/^\d{4}-\d{2}-\d{2}/)![0];
      // YYYY-MM (year-month) → first of month
      if (/^\d{4}-\d{2}$/.test(trimmed)) return `${trimmed}-01`;
      // YYYY (year only) → Jan 1
      if (/^\d{4}$/.test(trimmed)) return `${trimmed}-01-01`;
      // MM/DD/YYYY
      const mdyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (mdyMatch) {
        const [, mm, dd, yyyy] = mdyMatch;
        return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
      }
      return null;
    }

    case 'datetime': {
      // YYYY-MM-DD already with T
      if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed;
      // YYYY-MM-DD without T
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00Z`;
      // YYYY-MM → first of month
      if (/^\d{4}-\d{2}$/.test(trimmed)) return `${trimmed}-01T00:00:00Z`;
      // YYYY → Jan 1
      if (/^\d{4}$/.test(trimmed)) return `${trimmed}-01-01T00:00:00Z`;
      // MM/DD/YYYY
      const mdyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (mdyMatch) {
        const [, mm, dd, yyyy] = mdyMatch;
        return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`;
      }
      return null;
    }

    case 'time': {
      // HH:MM, HH:MM:SS, or HH:MM:SS.sss
      if (/^\d{2}:\d{2}(:\d{2})?/.test(trimmed)) return trimmed;
      return null;
    }

    case 'schedule': {
      return trimmed;
    }

    default:
      return null;
  }
}

/** Build a PropertyValueParam for the SDK. */
function buildValueParam(property: string, sdkType: string, value: any): PropertyValueParam {
  return { property, type: sdkType as any, value };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '*** DRY RUN — no changes will be published ***\n' : '*** LIVE RUN — fixes will be published ***\n');

  let totalRelationsFixed = 0;
  let totalValuesFixed = 0;
  let totalValuesSkipped = 0;

  // Collect all affected property IDs and their correct SDK type
  // propertyId → { correctSdkType, propertyName }
  const affectedProperties = new Map<string, { correctSdkType: string; propertyName: string }>();

  // Report tracking
  const reportProperties: Array<{ name: string; id: string; space: string; oldType: string; newType: string }> = [];
  const reportConverted: Array<{ entityName: string; entityId: string; space: string; property: string; from: string; to: string; oldValue: string; newValue: string }> = [];
  const reportSkipped: Array<{ entityName: string; entityId: string; space: string; property: string; targetType: string; rawValue: string; reason: string }> = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1: Fix Data Type relations on properties
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(80));
  console.log('PHASE 1: Fix Data Type relations on property entities');
  console.log('═'.repeat(80));

  for (const [oldDataTypeId, correctDataTypeId] of Object.entries(OLD_TO_CORRECT)) {
    if (oldDataTypeId === correctDataTypeId) continue;

    const correctSdkType = CORRECT_SDK_TYPE[correctDataTypeId];
    if (!correctSdkType) continue; // skip types we don't handle (e.g. point, bytes, embedding)

    for (const space of SPACES) {
      const data = await gql(`{
        relations(filter: {
          toEntityId: { is: "${oldDataTypeId}" }
          typeId: { is: "${DATA_TYPE_PROPERTY}" }
          spaceId: { is: "${space.id}" }
        }) {
          id
          entityId
          fromEntityId
          fromEntity { name }
          toSpaceId
          fromSpaceId
          toVersionId
          fromVersionId
          position
        }
      }`);

      const relations = data.relations ?? [];
      if (relations.length === 0) continue;

      const correctName = DATA_TYPE_NAMES[correctDataTypeId] ?? correctDataTypeId;
      console.log(`\n  ${space.name}: ${relations.length} property(s) → old ${oldDataTypeId} (should be ${correctName})`);

      const ops: any[] = [];

      for (const rel of relations) {
        const propertyName = rel.fromEntity?.name ?? rel.fromEntityId;
        const propertyId = rel.fromEntityId;
        console.log(`    ${propertyName} (${propertyId})`);

        // Track for Phase 2 and report
        affectedProperties.set(propertyId, { correctSdkType, propertyName });
        reportProperties.push({ name: propertyName, id: propertyId, space: space.name, oldType: oldDataTypeId, newType: correctName });

        // Delete old relation
        const delResult = Graph.deleteRelation({ id: rel.id });
        ops.push(...delResult.ops);

        // Create new relation with same entity ID and optional fields
        const createResult = Graph.createRelation({
          fromEntity: propertyId,
          toEntity: correctDataTypeId,
          type: DATA_TYPE_PROPERTY,
          entityId: rel.entityId,
          ...(rel.toSpaceId ? { toSpace: rel.toSpaceId } : {}),
          ...(rel.fromSpaceId ? { fromSpace: rel.fromSpaceId } : {}),
          ...(rel.toVersionId ? { toVersion: rel.toVersionId } : {}),
          ...(rel.fromVersionId ? { fromVersion: rel.fromVersionId } : {}),
          ...(rel.position ? { position: rel.position } : {}),
        });
        ops.push(...createResult.ops);

        totalRelationsFixed++;
      }

      if (!DRY_RUN && ops.length > 0) {
        console.log(`    Publishing ${ops.length} ops to ${space.name}...`);
        await publishOps(ops, `Fix data type relations`, space.id);
      } else if (ops.length > 0) {
        console.log(`    Would publish ${ops.length} ops to ${space.name}`);
      }
    }
  }

  console.log(`\n  Phase 1 complete: ${totalRelationsFixed} relation(s) fixed across ${affectedProperties.size} unique property(s)`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2: Fix values on entities that use the affected properties
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('PHASE 2: Fix mistyped values on entities using affected properties');
  console.log('═'.repeat(80));

  for (const [propertyId, { correctSdkType, propertyName }] of affectedProperties) {
    console.log(`\n  Property: ${propertyName} (${propertyId}) — should be ${correctSdkType}`);

    for (const space of SPACES) {
      // Find all values using this property in this space
      const valueData = await gql(`{
        values(filter: {
          propertyId: { is: "${propertyId}" }
          spaceId: { is: "${space.id}" }
        }) {
          ${VALUE_FIELDS}
        }
      }`);

      const values = valueData.values ?? [];
      if (values.length === 0) continue;

      console.log(`    ${space.name}: ${values.length} value(s)`);

      const ops: any[] = [];
      // Deduplicate by entityId (take first occurrence)
      const seen = new Set<string>();

      for (const v of values) {
        if (seen.has(v.entityId)) continue;
        seen.add(v.entityId);

        const currentType = detectCurrentType(v);
        if (!currentType) {
          console.log(`      ${v.entity?.name ?? v.entityId}: no value detected — skipping`);
          continue;
        }

        // Already the correct type
        if (currentType === correctSdkType) continue;

        const rawValue = v[currentType];
        const converted = parseTextValue(String(rawValue), correctSdkType);

        if (converted === null) {
          console.log(`      ${v.entity?.name ?? v.entityId}: cannot parse "${rawValue}" as ${correctSdkType} — unsetting`);
          reportSkipped.push({ entityName: v.entity?.name ?? '', entityId: v.entityId, space: space.name, property: propertyName, targetType: correctSdkType, rawValue: String(rawValue), reason: `Cannot parse as ${correctSdkType} — value deleted` });
          const unsetResult = Graph.updateEntity({
            id: v.entityId,
            unset: [{ property: propertyId }],
          });
          ops.push(...unsetResult.ops);
          totalValuesSkipped++;
          continue;
        }

        // Blank value — just unset
        if (converted === UNSET) {
          console.log(`      ${v.entity?.name ?? v.entityId}: blank value — unsetting`);
          reportConverted.push({ entityName: v.entity?.name ?? '', entityId: v.entityId, space: space.name, property: propertyName, from: currentType, to: '(unset)', oldValue: String(rawValue), newValue: '' });
          const unsetResult = Graph.updateEntity({
            id: v.entityId,
            unset: [{ property: propertyId }],
          });
          ops.push(...unsetResult.ops);
          totalValuesFixed++;
          continue;
        }

        console.log(`      ${v.entity?.name ?? v.entityId}: ${currentType}("${rawValue}") → ${correctSdkType}(${JSON.stringify(converted)})`);
        reportConverted.push({ entityName: v.entity?.name ?? '', entityId: v.entityId, space: space.name, property: propertyName, from: currentType, to: correctSdkType, oldValue: String(rawValue), newValue: String(converted) });

        // Unset old value, set new value with correct type
        const unsetResult = Graph.updateEntity({
          id: v.entityId,
          unset: [{ property: propertyId }],
        });
        ops.push(...unsetResult.ops);

        const param = buildValueParam(propertyId, correctSdkType, converted);
        const setResult = Graph.updateEntity({
          id: v.entityId,
          values: [param],
        });
        ops.push(...setResult.ops);

        totalValuesFixed++;
      }

      if (!DRY_RUN && ops.length > 0) {
        console.log(`      Publishing ${ops.length} ops to ${space.name}...`);
        await publishOps(ops, `Fix mistyped values for ${propertyName}`, space.id);
      } else if (ops.length > 0) {
        console.log(`      Would publish ${ops.length} ops to ${space.name}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Write report
  // ═══════════════════════════════════════════════════════════════════════════
  const lines: string[] = [];

  lines.push('PROPERTIES WITH DATA TYPE RELATION UPDATED');
  lines.push('='.repeat(80));
  if (reportProperties.length === 0) {
    lines.push('  (none)');
  } else {
    for (const p of reportProperties) {
      lines.push(`  ${p.name}  (${p.id})  [${p.space}]  → ${p.newType}`);
    }
  }

  lines.push('');
  lines.push('ENTITIES WITH VALUES CONVERTED');
  lines.push('='.repeat(80));
  if (reportConverted.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of reportConverted) {
      lines.push(`  ${e.entityName || e.entityId}  (${e.entityId})  [${e.space}]`);
      lines.push(`    property: ${e.property}  |  ${e.from}("${e.oldValue}") → ${e.to}(${e.newValue})`);
    }
  }

  lines.push('');
  lines.push('ENTITIES WITH VALUES THAT COULD NOT BE CONVERTED (value deleted)');
  lines.push('='.repeat(80));
  if (reportSkipped.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of reportSkipped) {
      lines.push(`  ${e.entityName || e.entityId}  (${e.entityId})  [${e.space}]`);
      lines.push(`    property: ${e.property}  |  value: "${e.rawValue}"  |  target: ${e.targetType}  |  ${e.reason}`);
    }
  }

  lines.push('');
  lines.push('SUMMARY');
  lines.push('='.repeat(80));
  lines.push(`  Properties updated: ${reportProperties.length}`);
  lines.push(`  Values converted:   ${reportConverted.length}`);
  lines.push(`  Values skipped:     ${reportSkipped.length}`);
  lines.push(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const reportText = lines.join('\n');
  fs.writeFileSync('fix_data_types_report.txt', reportText);
  console.log(`\nReport written to fix_data_types_report.txt`);

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`Summary${DRY_RUN ? ' (dry run)' : ''}:`);
  console.log(`  Phase 1: ${totalRelationsFixed} data type relation(s) fixed`);
  console.log(`  Phase 2: ${totalValuesFixed} value(s) converted, ${totalValuesSkipped} skipped`);
  console.log(`${'═'.repeat(80)}`);
}

main().catch(console.error);
