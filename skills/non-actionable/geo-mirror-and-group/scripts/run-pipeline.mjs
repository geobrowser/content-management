#!/usr/bin/env node
// geo-mirror-and-group — one runner for the whole Geo → Notion → grouping pipeline.
//
// WHY THIS EXISTS: the pipeline is eight scripts across three skills. Driving it by hand
// means eight round trips, a campaign directory invented each time, and two settings
// (semantic recall on/off, --top) that are silently wrong more often than right. This
// runner chains the mechanical stages, derives those two settings from the corpus rather
// than from a default, and records what it did in pipeline.json.
//
// It does NOT adjudicate — that is model judgement, and it sits between `prepare` and
// `finish`. It NEVER writes to Geo, and it never passes the sink's --publish.
//
// Usage (from the repo root):
//   node --env-file=.env skills/non-actionable/geo-mirror-and-group/scripts/run-pipeline.mjs \
//     --space <32hex> --parent <notionPageId> [--type <32hex>] [--campaign <dir>] \
//     [--ids-file <p> | --limit N | --since YYYY-MM-DD | --related <id> | --all] \
//     [--stage probe|mirror|prepare|finish] [--semantic auto|on|off] [--link "..."]
//
// Exit codes: 0 ok · 1 a stage failed · 2 usage error
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAIM_TYPE = '96f859efa1ca4b229372c86ad58b694b';
const ENDPOINT = 'https://api-testnet.geobrowser.io/graphql';
const HEX32 = /^[0-9a-f]{32}$/;
const USAGE = [
  'usage: node --env-file=.env skills/non-actionable/geo-mirror-and-group/scripts/run-pipeline.mjs \\',
  '  --space <32hex> --parent <notionPageId> [--type <32hex>] [--campaign <dir>]',
  '  [--ids-file <p> | --limit N | --since YYYY-MM-DD [--until ...] | --related <id> | --all]',
  '  [--stage probe|mirror|prepare|finish]   default: probe',
  '  [--semantic auto|on|off]                default: auto - decided from corpus shape',
  '  [--db <32hex>]                          the Claims database, for prepare/finish',
  '  [--link "Notable claims"]               passed to geo-mirror; "" for a single table',
].join('\n');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const norm = (s) => (s || '').trim().replace(/-/g, '').toLowerCase();

const space = norm(opt('--space'));
const parent = norm(opt('--parent'));
const typeId = norm(opt('--type', CLAIM_TYPE));
const stage = opt('--stage', 'probe');
const semanticMode = opt('--semantic', 'auto');
const idsFile = opt('--ids-file');

if (!HEX32.test(space)) { console.error('--space must be a 32-hex space id\n\n' + USAGE); process.exit(2); }
if (!['probe', 'mirror', 'prepare', 'finish'].includes(stage)) { console.error('--stage must be probe|mirror|prepare|finish'); process.exit(2); }
if (!['auto', 'on', 'off'].includes(semanticMode)) { console.error('--semantic must be auto|on|off'); process.exit(2); }
if (stage === 'mirror' && !HEX32.test(parent)) { console.error('--parent (Notion page id) is required for stage mirror'); process.exit(2); }

const campaign = opt('--campaign') || join(process.env.TEMP || process.env.TMPDIR || '.', `geo-mg-${space.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}`);
mkdirSync(campaign, { recursive: true });
const statePath = join(campaign, 'pipeline.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { space, typeId, parent, campaign, stages: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

const S = (...p) => join('skills', ...p);
function run(label, file, args) {
  console.log(`\n▸ ${label}`);
  console.log(`  node ${file} ${args.join(' ')}`);
  const r = spawnSync(process.execPath, ['--env-file=.env', file, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${r.status}). Pipeline stopped; nothing after this ran.`);
    state.stages[label] = { ok: false, at: new Date().toISOString() };
    save();
    process.exit(1);
  }
  state.stages[label] = { ok: true, at: new Date().toISOString() };
  save();
}
async function gql(query) {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

// ── PROBE — measure the corpus, then decide the two settings that are usually wrong ──
async function probe() {
  const meta = await gql(`{ space(id: "${space}") { page { name } } }`);
  const spaceName = meta.space?.page?.name ?? '(unnamed)';
  // totalCount is a single cheap query. Do NOT page the type just to count it — on a
  // 22k-claim space that is 22 round trips for a number the server already knows.
  const countQ = await gql(`{ entitiesConnection(typeId: "${typeId}", spaceId: "${space}", first: 1) { totalCount } }`);
  const total = countQ.entitiesConnection?.totalCount ?? 0;
  console.log(`\nSpace    : ${spaceName} (${space})`);
  console.log(`Type     : ${typeId}`);
  console.log(`Entities : ${total}   read ${new Date().toISOString()}`);

  // Which admission gates can fire at all depends on signal coverage. structPass needs
  // >=2 shared citations OR (a shared story AND a shared topic) — with no stories the
  // second branch is unsatisfiable for every pair in the space.
  let sampled = 0, withSources = 0, withStories = 0, withTopics = 0;
  const d = await gql(`{ entitiesConnection(typeId: "${typeId}", spaceId: "${space}", first: 250) { nodes { id relations(first: 60) { nodes { type { name } } } } } }`).catch(() => null);
  for (const n of d?.entitiesConnection?.nodes ?? []) {
    sampled++;
    const rel = (n.relations?.nodes ?? []).map((r) => r.type?.name).filter(Boolean);
    if (rel.includes('Sources')) withSources++;
    if (rel.includes('Topics')) withTopics++;
    if (rel.includes('Notable claims')) withStories++;
  }
  const stories = await gql(`{ entitiesConnection(typeId: "e550fe517e904b2c8fffdf13408f5634", spaceId: "${space}", first: 1) { nodes { id } } }`).catch(() => null);
  const hasStories = (stories?.entitiesConnection?.nodes ?? []).length > 0;
  const pct = (n) => (sampled ? `${n}/${sampled} (${Math.round((100 * n) / sampled)}%)` : 'n/a');

  console.log(`\nSignal coverage, sampled ${sampled}:`);
  console.log(`  Sources (citations) : ${pct(withSources)}`);
  console.log(`  Topics              : ${pct(withTopics)}`);
  console.log(`  News stories in space: ${hasStories ? 'yes' : 'NONE'}`);

  const newsDriven = hasStories;
  const rec = newsDriven ? 'off' : 'on';
  console.log(`\nCorpus shape: ${newsDriven ? 'NEWS-DRIVEN — the structural gate can fire' : 'DEBATE-DRIVEN — the story branch of the structural gate is dead'}`);
  console.log(`  -> semantic recall recommended: ${rec.toUpperCase()}`);
  if (rec === 'on') console.log(`     (~6-8.5 s per scope claim; budget ~${Math.max(1, Math.round((total * 7) / 60))} min if you mirror all ${total})`);
  if (total > 400 && !idsFile) console.log(`  -> ${total} entities is large. Scope with --ids-file (resolve a curated tab to ids) rather than mirroring the whole type.`);

  state.probe = { spaceName, total, sampled, withSources, withStories, withTopics, hasStories, newsDriven, semanticRecommended: rec, at: new Date().toISOString() };
  save();
  console.log(`\nstate: ${statePath}`);
}

// ── MIRROR — extract, then write. geo-mirror Part 1 only, never Part 2. ──
function mirror() {
  const extract = join(campaign, 'extract.json');
  const scope = [];
  if (idsFile) scope.push('--ids-file', idsFile);
  else if (opt('--limit')) scope.push('--limit', opt('--limit'));
  else if (opt('--since')) { scope.push('--since', opt('--since')); if (opt('--until')) scope.push('--until', opt('--until')); }
  else if (opt('--related')) scope.push('--related', opt('--related'));
  else if (has('--all')) scope.push('--all');
  else { console.error('stage mirror needs a scope: --ids-file | --limit | --since | --related | --all'); process.exit(2); }

  run('extract', S('actionable', 'geo-mirror', 'scripts', 'extract-space.mjs'), [space, '--type', typeId, ...scope, '--out', extract]);
  const link = opt('--link');
  const linkArgs = link === undefined ? [] : ['--link', link];
  run('mirror:dry-run', S('actionable', 'geo-mirror', 'scripts', 'mirror-to-notion.mjs'), [extract, '--parent', parent, ...linkArgs, '--dry-run']);
  run('mirror:write', S('actionable', 'geo-mirror', 'scripts', 'mirror-to-notion.mjs'), [extract, '--parent', parent, ...linkArgs]);
  console.log('\n✔ mirror complete. Take the "Geo <Type> — <Space>" database id from the output above');
  console.log('  and pass it as --db to stage prepare.');
}

// ── PREPARE — roster, discovery, scope. Stops where judgement begins. ──
function prepare() {
  const db = norm(opt('--db'));
  if (!HEX32.test(db)) { console.error('stage prepare needs --db <32hex> — the Claims database that stage mirror created'); process.exit(2); }
  const roster = join(campaign, 'roster.json');
  run('roster', S('non-actionable', 'geo-claim-grouping-notion', 'scripts', 'roster-from-notion.mjs'), ['--db', db, '--out', roster, '--type', typeId]);

  let useSemantic;
  if (semanticMode === 'on') useSemantic = true;
  else if (semanticMode === 'off') useSemantic = false;
  else if (state.probe) useSemantic = state.probe.semanticRecommended === 'on';
  else { useSemantic = true; console.log('\n  ! no probe on record — defaulting semantic recall ON, which is the safe choice for an unmeasured corpus'); }
  console.log(`\n  semantic recall: ${useSemantic ? 'ON' : 'OFF'}  (--semantic ${semanticMode})`);

  run('discovery', S('actionable', 'geo-claim-grouping', 'scripts', 'discover_candidates.ts'),
    ['--space', space, '--scope-file', roster, '--cap', '2000', ...(useSemantic ? [] : ['--no-semantic']), '--out', campaign]);

  // Size --top to the kept pairs so the adjudication is never silently a sample.
  const cand = JSON.parse(readFileSync(join(campaign, 'candidates.json'), 'utf8'));
  const ids = new Set(JSON.parse(readFileSync(roster, 'utf8')).ids.map((s) => String(s).toLowerCase()));
  const kept = (cand.pairs || []).filter((p) => ids.has(String(p.a?.id).toLowerCase()) && ids.has(String(p.b?.id).toLowerCase())).length;
  const top = Math.max(80, kept);
  console.log(`\n  both-in-roster pairs: ${kept}  ->  --top ${top} (sized to the batch, so nothing is sampled away)`);
  run('scope', S('non-actionable', 'geo-claim-grouping-notion', 'scripts', 'scope-candidates.mjs'),
    ['--candidates', join(campaign, 'candidates.json'), '--roster', roster, '--top', String(top)]);

  state.prepare = { db, kept, top, semantic: useSemantic };
  save();
  console.log(`\n✔ prepare complete — ${kept} pair(s) await adjudication.`);
  console.log(`  Read  : ${join(campaign, 'candidates.scoped.json')}`);
  console.log('  Judge : EVERY pair, under geo-claim-grouping references/adjudication-rubric.md');
  console.log(`  Write : decisions.json and brackets.json into ${campaign}`);
  console.log('  Then  : re-run this script with --stage finish');
}

// ── FINISH — existing edges, then the sink dry-run. Always stops there. ──
function finish() {
  const db = norm(opt('--db', state.prepare?.db || ''));
  if (!HEX32.test(db)) { console.error('stage finish needs --db <32hex>'); process.exit(2); }
  const missing = ['decisions.json', 'brackets.json'].filter((f) => !existsSync(join(campaign, f)));
  if (missing.length) { console.error(`missing ${missing.join(' and ')} in ${campaign} — adjudication has not been written yet`); process.exit(2); }

  const roster = join(campaign, 'roster.json');
  run('existing-edges', S('non-actionable', 'geo-claim-grouping-notion', 'scripts', 'existing-edges-from-geo.mjs'), ['--roster', roster]);
  run('sink:dry-run', S('non-actionable', 'geo-claim-grouping-notion', 'scripts', 'write-grouping-to-notion.mjs'), ['--db', db, '--campaign', campaign, '--roster', roster]);
  console.log('\n✔ dry-run complete, and NOT published.');
  console.log('  Read section 3 (what would change) and section 6 (needs your eyes) above.');
  console.log('  Publishing is the editor\'s call. This runner never passes --publish.');
}

try {
  if (stage === 'probe') await probe();
  else if (stage === 'mirror') mirror();
  else if (stage === 'prepare') prepare();
  else if (stage === 'finish') finish();
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
