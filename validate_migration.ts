// ─── Migration validator ────────────────────────────────────────────────────
// Verifies a VALID migration from a source entity into a target entity, per the
// three rules:
//   1. Property values — for every value on source (same propertyId + same value),
//      target has it.
//   2. Outgoing relations — for every relation on source, target has an equivalent:
//      same type, same target-entity, same relation-props, same position.
//   3. Incoming backlinks — for every backlink on source (source-entity + type),
//      an equivalent backlink now points at target.
//
// Reports each rule PASS/FAIL with the exact missing/mismatched items. Exit code
// is 0 when every source passes, 1 otherwise (usable in scripts/CI).
//
// IMPORTANT — when to run. This codebase's merge leaves the source as a husk
// (values unset, relations/backlinks removed). So AFTER a merge, reading the source
// live returns nothing and every rule trivially passes. To validate a completed
// merge, capture the source's pre-merge state first:
//
//   1) BEFORE merge:  bun run validate_migration.ts <src> <tgt> --save-snapshot snap.json
//   2) run + publish the merge
//   3) AFTER merge:   bun run validate_migration.ts <src> <tgt> --snapshot snap.json
//
// Run live (no snapshot) as a PRE-flight: it lists exactly what the target is still
// missing — i.e. what the merge must migrate (so a live run pre-merge is expected
// to FAIL until the merge has happened).
//
// Usage:
//   bun run validate_migration.ts <sourceId[,sourceId...]> <targetId> [options]
// Options:
//   --source-space <id>   only consider source data authored in this space
//   --target-space <id>   only consider target data authored in this space
//   --snapshot <file>     load source state from a snapshot instead of querying live
//   --save-snapshot <file> capture source state to a snapshot file, then exit
//   --match-space         require values to match in the SAME space (default: any space)
//   --strict-position     treat a relation position difference as a FAIL (default: warn)
//   --ignore-properties <id,...>  skip these property IDs in rule 1 (e.g. system/
//                         governance bookkeeping values that should not migrate)
//   --json                emit a machine-readable JSON report

import { gql } from './src/functions.ts';
import { readFileSync, writeFileSync } from 'fs';

// ─── CLI parsing ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);

const sourceSpace = flag('--source-space');
const targetSpace = flag('--target-space');
const snapshotIn = flag('--snapshot');
const snapshotOut = flag('--save-snapshot');
const matchSpace = has('--match-space');
const strictPosition = has('--strict-position');
const asJson = has('--json');
const ignoreProps = flag('--ignore-properties');
const ignoredProperties = new Set((ignoreProps ?? '').split(',').map(s => s.trim()).filter(Boolean));

const flagNames = new Set(['--source-space', '--target-space', '--snapshot', '--save-snapshot', '--match-space', '--strict-position', '--ignore-properties', '--json']);
const flagValues = new Set([sourceSpace, targetSpace, snapshotIn, snapshotOut, ignoreProps].filter(Boolean) as string[]);
const positional = argv.filter(a => !flagNames.has(a) && !flagValues.has(a));

const sourceIds = (positional[0] ?? '').split(',').map(s => s.trim()).filter(Boolean);
const targetId = positional[1];

if (sourceIds.length === 0 || !targetId) {
  console.error('Usage: bun run validate_migration.ts <sourceId[,sourceId...]> <targetId> [options]');
  console.error('  --source-space <id> --target-space <id> --snapshot <file> --save-snapshot <file>');
  console.error('  --match-space --strict-position --json');
  process.exit(2);
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

interface NormValue { propertyId: string; spaceId: string | null; type: string; value: string }
interface RelProp { propertyId: string; type: string; value: string }
interface RelState { typeId: string; toEntityId: string; position: string | null; props: RelProp[] }
interface BacklinkState { fromEntityId: string; typeId: string; spaceId: string | null }
interface EntityState { id: string; values: NormValue[]; relations: RelState[]; backlinks: BacklinkState[] }

const VALUE_TYPES = ['text', 'integer', 'float', 'boolean', 'date', 'datetime', 'time', 'schedule'] as const;

/** Pick the populated value field and normalize to {type, value:string}. */
function normalizeValueNode(n: any): { type: string; value: string } | null {
  for (const t of VALUE_TYPES) {
    if (n[t] != null) return { type: t, value: String(n[t]) };
  }
  return null; // relation-typed property or empty
}

// ─── Generic paginator (avoids the 50x retry loop by trusting probed schema) ──

async function paginate(connection: string, filter: string, nodeFields: string): Promise<any[]> {
  const out: any[] = [];
  let after = '';
  while (true) {
    const query = `{ ${connection}(filter: { ${filter} }, first: 500 ${after}) {
      edges { node { ${nodeFields} } }
      pageInfo { hasNextPage endCursor }
    } }`;
    const data = await gql(query, undefined, 12);
    const conn = data?.[connection];
    for (const e of conn?.edges ?? []) out.push(e.node);
    if (!conn?.pageInfo?.hasNextPage) break;
    after = `, after: "${conn.pageInfo.endCursor}"`;
  }
  return out;
}

const VALUE_NODE_FIELDS = `propertyId spaceId ${VALUE_TYPES.join(' ')}`;
const REL_NODE_FIELDS = `typeId toEntityId position entity { values { nodes { propertyId ${VALUE_TYPES.join(' ')} } } }`;
const BACKLINK_NODE_FIELDS = `fromEntityId typeId spaceId`;

/** Load an entity's full state (values, outgoing relations w/ props, backlinks) live. */
async function loadLive(id: string, space: string | undefined): Promise<EntityState> {
  const spaceClause = space ? ` spaceId: { is: "${space}" }` : '';
  const [valueNodes, relNodes, backlinkNodes] = await Promise.all([
    paginate('valuesConnection', `entityId: { is: "${id}" }${spaceClause}`, VALUE_NODE_FIELDS),
    paginate('relationsConnection', `fromEntityId: { is: "${id}" }${spaceClause}`, REL_NODE_FIELDS),
    paginate('relationsConnection', `toEntityId: { is: "${id}" }${spaceClause}`, BACKLINK_NODE_FIELDS),
  ]);

  const values: NormValue[] = [];
  for (const n of valueNodes) {
    const nv = normalizeValueNode(n);
    if (nv) values.push({ propertyId: n.propertyId, spaceId: n.spaceId ?? null, type: nv.type, value: nv.value });
  }

  const relations: RelState[] = relNodes.map((n: any) => {
    const props: RelProp[] = [];
    for (const pn of n.entity?.values?.nodes ?? []) {
      const nv = normalizeValueNode(pn);
      if (nv) props.push({ propertyId: pn.propertyId, type: nv.type, value: nv.value });
    }
    props.sort((a, b) => (a.propertyId + a.value).localeCompare(b.propertyId + b.value));
    return { typeId: n.typeId, toEntityId: n.toEntityId, position: n.position ?? null, props };
  });

  const backlinks: BacklinkState[] = backlinkNodes.map((n: any) => ({
    fromEntityId: n.fromEntityId,
    typeId: n.typeId,
    spaceId: n.spaceId ?? null,
  }));

  return { id, values, relations, backlinks };
}

// ─── Comparison keys ──────────────────────────────────────────────────────────

const valueKey = (v: NormValue) => `${v.propertyId}=${v.type}:${v.value}${matchSpace ? `@${v.spaceId}` : ''}`;
const propsKey = (props: RelProp[]) => props.map(p => `${p.propertyId}:${p.type}:${p.value}`).join('|');
const relRelaxedKey = (r: RelState) => `${r.typeId}->${r.toEntityId}#${propsKey(r.props)}`; // type+target+props
const relTypeTargetKey = (r: RelState) => `${r.typeId}->${r.toEntityId}`;
const backlinkKey = (b: BacklinkState) => `${b.fromEntityId}->${b.typeId}`;

// ─── Rule checks ──────────────────────────────────────────────────────────────

interface RuleResult { pass: boolean; checked: number; missing: string[]; warnings: string[] }

function checkValues(src: EntityState, tgt: EntityState): RuleResult {
  const tgtKeys = new Set(tgt.values.map(valueKey));
  const seen = new Set<string>();
  const missing: string[] = [];
  let checked = 0;
  for (const v of src.values) {
    if (ignoredProperties.has(v.propertyId)) continue;
    const k = valueKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    checked++;
    if (!tgtKeys.has(k)) missing.push(`property ${v.propertyId} = ${v.type}:"${v.value}"${matchSpace ? ` (space ${v.spaceId})` : ''}`);
  }
  return { pass: missing.length === 0, checked, missing, warnings: [] };
}

function checkRelations(src: EntityState, tgt: EntityState): RuleResult {
  const tgtByRelaxed = new Map<string, RelState[]>();
  const tgtByTypeTarget = new Map<string, RelState[]>();
  const push = (m: Map<string, RelState[]>, k: string, r: RelState) => { const l = m.get(k) ?? []; l.push(r); m.set(k, l); };
  for (const r of tgt.relations) {
    push(tgtByRelaxed, relRelaxedKey(r), r);
    push(tgtByTypeTarget, relTypeTargetKey(r), r);
  }
  const missing: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let checked = 0;
  for (const r of src.relations) {
    const rk = relRelaxedKey(r);
    if (seen.has(rk + (r.position ?? ''))) continue;
    seen.add(rk + (r.position ?? ''));
    checked++;
    const matches = tgtByRelaxed.get(rk);
    if (matches && matches.length > 0) {
      // type+target+props matched; check position
      const samePos = matches.some(m => (m.position ?? null) === (r.position ?? null));
      if (!samePos) {
        const msg = `relation ${r.typeId} -> ${r.toEntityId}: position differs (source "${r.position}" vs target "${matches.map(m => m.position).join('/')}")`;
        if (strictPosition) missing.push(msg); else warnings.push(msg);
      }
      continue;
    }
    // no props match — is there a same type+target with different props?
    const tt = tgtByTypeTarget.get(relTypeTargetKey(r));
    if (tt && tt.length > 0) {
      missing.push(`relation ${r.typeId} -> ${r.toEntityId}: relation-props differ (source props [${propsKey(r.props) || 'none'}] not found on target)`);
    } else {
      missing.push(`relation ${r.typeId} -> ${r.toEntityId}${r.props.length ? ` (props [${propsKey(r.props)}])` : ''}: NOT on target`);
    }
  }
  return { pass: missing.length === 0, checked, missing, warnings };
}

function checkBacklinks(src: EntityState, tgt: EntityState): RuleResult {
  const tgtKeys = new Set(tgt.backlinks.map(backlinkKey));
  const seen = new Set<string>();
  const missing: string[] = [];
  let checked = 0;
  for (const b of src.backlinks) {
    const k = backlinkKey(b);
    if (seen.has(k)) continue;
    seen.add(k);
    checked++;
    if (!tgtKeys.has(k)) missing.push(`backlink from ${b.fromEntityId} (type ${b.typeId}) does not point at target`);
  }
  return { pass: missing.length === 0, checked, missing, warnings: [] };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function printRule(name: string, r: RuleResult) {
  const status = r.pass ? '✅ PASS' : '❌ FAIL';
  console.log(`  ${status}  ${name} — ${r.checked} checked, ${r.missing.length} missing${r.warnings.length ? `, ${r.warnings.length} warning(s)` : ''}`);
  for (const m of r.missing) console.log(`      ✗ ${m}`);
  for (const w of r.warnings) console.log(`      ⚠ ${w}`);
}

const target = await loadLive(targetId, targetSpace);

// --save-snapshot: capture source state and exit (run BEFORE a merge).
if (snapshotOut) {
  if (sourceIds.length !== 1) { console.error('--save-snapshot expects exactly one sourceId'); process.exit(2); }
  const src = await loadLive(sourceIds[0], sourceSpace);
  writeFileSync(snapshotOut, JSON.stringify(src, null, 2));
  console.log(`Saved source snapshot → ${snapshotOut} (${src.values.length} values, ${src.relations.length} relations, ${src.backlinks.length} backlinks)`);
  process.exit(0);
}

const report: any = { target: targetId, sources: [] };
let allPass = true;

for (const sourceId of sourceIds) {
  let src: EntityState;
  if (snapshotIn) {
    const snap = JSON.parse(readFileSync(snapshotIn, 'utf-8'));
    src = snap.id === sourceId ? snap : snap; // snapshot is for this source
    if (snap.id !== sourceId) console.warn(`  ⚠ snapshot id ${snap.id} != requested source ${sourceId} — using snapshot as-is`);
  } else {
    src = await loadLive(sourceId, sourceSpace);
  }

  const values = checkValues(src, target);
  const relations = checkRelations(src, target);
  const backlinks = checkBacklinks(src, target);
  const pass = values.pass && relations.pass && backlinks.pass;
  allPass = allPass && pass;

  if (!asJson) {
    console.log(`\n${'='.repeat(78)}`);
    console.log(`MIGRATION CHECK  source ${sourceId}  →  target ${targetId}${snapshotIn ? '  [source from snapshot]' : ''}`);
    console.log(`  source: ${src.values.length} values, ${src.relations.length} relations, ${src.backlinks.length} backlinks`);
    console.log(`  target: ${target.values.length} values, ${target.relations.length} relations, ${target.backlinks.length} backlinks`);
    printRule('Rule 1 — property values', values);
    printRule('Rule 2 — outgoing relations (type, target, props, position)', relations);
    printRule('Rule 3 — incoming backlinks (source-entity, type)', backlinks);
    console.log(`  ${pass ? '✅ MIGRATION VALID' : '❌ MIGRATION INCOMPLETE'} for source ${sourceId}`);
  }
  report.sources.push({ sourceId, pass, values, relations, backlinks });
}

if (asJson) {
  console.log(JSON.stringify({ ...report, allPass }, null, 2));
} else {
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`OVERALL: ${allPass ? '✅ ALL MIGRATIONS VALID' : '❌ ONE OR MORE INCOMPLETE'} (${sourceIds.length} source(s) → ${targetId})`);
}

process.exit(allPass ? 0 : 1);
