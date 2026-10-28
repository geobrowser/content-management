// Worked end-to-end example of geo-publish "inject mode":
//   paste a URL  →  injectAndDecode() (inject + poll + decode)  →  publishOps().
// The injector writes NOTHING on-chain; only the final publishOps() does.
//
// Run (Node, NOT Bun — Bun's fetch hits a bug on the geo API host):
//   node --env-file=.env scripts/inject-publish-example.ts \
//     "<url>" [inject-type] [inject-space] [publish-space-id] [--publish]
//
// Defaults: type=host-detected, inject-space=world-affairs, publish=DEMO_SPACE_ID.
// Without --publish it stops after the decode: nothing is published.
import { injectAndDecode, type InjectType } from '../lib/inject.ts';
import { publishOps } from '../src/functions.ts';

const PUBLISH = process.argv.includes('--publish');
const args = process.argv.slice(2).filter((a) => a !== '--publish');
const url = args[0] ?? 'https://x.com/ralexdc/status/2089173991395094750?s=20';
const type = args[1] as InjectType | undefined; // omit → host-detected
const injectSpace = args[2] ?? 'world-affairs';
const publishSpace = args[3]; // undefined → publishOps defaults to DEMO_SPACE_ID

async function main() {
  console.log(`\n[1/2] inject + decode  ${url}`);
  const r = await injectAndDecode(url, {
    space: injectSpace,
    type,
    onPoll: (i, s) => process.stdout.write(`\r      poll ${i}: ${s}   `),
  });
  console.log(`\n      name: ${r.name}`);
  console.log(`      ops:  ${r.opCount}`);
  if (r.errors.length) console.warn(`      ⚠ stage errors: ${JSON.stringify(r.errors)}`);

  // NOTE: a real skill run would emit the Gates block (Gate 1 dup-check on r.name)
  // and wait for "go" here. This example publishes only when run with --publish.
  if (!PUBLISH) {
    console.log(`[2/2] preview only — re-run with --publish to publish ${r.opCount} ops to ${publishSpace ?? 'DEMO_SPACE_ID'}.`);
    return;
  }
  console.log(`[2/2] publishOps → ${publishSpace ?? 'DEMO_SPACE_ID'}`);
  const tx = await publishOps(r.ops as any, r.name, publishSpace);
  if (!tx) { console.log('      publishOps skipped (space not yours) — nothing published.'); return; }
  console.log(`\n✅ published. tx/proposal: ${tx}`);
  console.log(`   view: https://www.geobrowser.io/space/${publishSpace ?? process.env.DEMO_SPACE_ID}`);
}

main().catch((e) => { console.error('\n❌', e?.message ?? e); process.exit(1); });
