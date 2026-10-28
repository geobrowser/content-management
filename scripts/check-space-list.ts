/**
 * Space-List Reconciliation (read-only diagnostic)
 * ================================================
 *
 * Fixes the root cause of "duplicate detection only finds dupes after pushing
 * several times": the finder scans the HARDCODED `SPACES` list in
 * src/constants.ts, and that list has DRIFTED from the spaces that actually
 * exist on Geo. A renamed or re-IDed space means the finder silently scans the
 * wrong place (or nothing) and never sees the duplicates living there.
 *
 * This script:
 *   1. Pulls the LIVE list of spaces from the API.
 *   2. Reconciles each entry in constants.ts `SPACES` against it:
 *        - id still exists?   (id drift)
 *        - name still matches? (rename drift — e.g. "Geo Education" → "Geo Documentation")
 *   3. Flags live spaces whose NAME matches a constants entry but whose ID is
 *      different — i.e. the canonical space moved to a new ID.
 *   4. Prints a ready-to-paste corrected SPACES array.
 *
 * It WRITES NOTHING. No wallet, no .env. Pure diagnostic.
 *
 * Run:  bun run scripts/check-space-list.ts
 *       bun run scripts/check-space-list.ts --all   # also dump all named DAO spaces
 */

import { gql } from '../src/functions.js';
import { SPACES } from '../src/constants.js';

interface LiveSpace { id: string; type: string; name: string | null; }

// ─── Fetch every space (paginated) ──────────────────────────────────────────
async function fetchAllSpaces(): Promise<LiveSpace[]> {
  const all: LiveSpace[] = [];
  let offset = 0;
  const PAGE = 500;
  while (true) {
    const data = await gql(`{
      spaces(first: ${PAGE}, offset: ${offset}) {
        id type page { name }
      }
    }`);
    const page = data.spaces ?? [];
    for (const s of page) all.push({ id: s.id, type: s.type, name: s.page?.name ?? null });
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

function norm(s: string | null): string {
  return (s ?? '').trim().toLowerCase();
}

async function main() {
  const showAll = process.argv.includes('--all');

  console.log('Fetching live space list from the API...');
  const live = await fetchAllSpaces();
  const byId = new Map(live.map(s => [s.id, s]));
  console.log(`  ${live.length} spaces total (${live.filter(s => s.type !== 'PERSONAL').length} non-personal).\n`);

  // Index live non-personal spaces by normalized name (a name can map to many)
  const liveByName = new Map<string, LiveSpace[]>();
  for (const s of live) {
    if (s.type === 'PERSONAL' || !s.name) continue;
    const k = norm(s.name);
    (liveByName.get(k) ?? liveByName.set(k, []).get(k)!).push(s);
  }

  console.log('='.repeat(78));
  console.log('RECONCILING constants.ts SPACES against live data');
  console.log('='.repeat(78) + '\n');

  let drift = 0;
  const corrected: { name: string; id: string }[] = [];

  for (const entry of SPACES) {
    const liveMatch = byId.get(entry.id);

    if (!liveMatch) {
      drift++;
      console.log(`❌ ${entry.name.padEnd(16)} id=${entry.id}`);
      console.log(`     → id NOT FOUND on Geo. The space was deleted or re-IDed.`);
      // Try to find a live space with the same name
      const sameName = liveByName.get(norm(entry.name)) ?? [];
      if (sameName.length) {
        console.log(`     → live space(s) named "${entry.name}": ${sameName.map(s => s.id).join(', ')}`);
        corrected.push({ name: entry.name, id: sameName[0].id });
      } else {
        corrected.push(entry); // keep as-is, flagged
      }
      console.log('');
      continue;
    }

    if (norm(liveMatch.name) !== norm(entry.name)) {
      drift++;
      console.log(`⚠  ${entry.name.padEnd(16)} id=${entry.id}`);
      console.log(`     → id still exists but is now named "${liveMatch.name}" (was "${entry.name}").`);
      // Is the OLD name now a DIFFERENT id? (the canonical space moved)
      const sameName = (liveByName.get(norm(entry.name)) ?? []).filter(s => s.id !== entry.id);
      if (sameName.length) {
        console.log(`     → a DIFFERENT live space is now named "${entry.name}": ${sameName.map(s => s.id).join(', ')}`);
        console.log(`     → the finder is scanning the WRONG space. Likely wants id=${sameName[0].id}.`);
        corrected.push({ name: entry.name, id: sameName[0].id });
      } else {
        corrected.push({ name: liveMatch.name ?? entry.name, id: entry.id });
      }
      console.log('');
      continue;
    }

    // OK
    console.log(`✓  ${entry.name.padEnd(16)} id=${entry.id}`);
    corrected.push(entry);
  }

  console.log(`\n${drift === 0 ? '✅ No drift — constants.ts is in sync.' : `⚠ ${drift} drifted entr${drift === 1 ? 'y' : 'ies'} above.`}\n`);

  if (drift > 0) {
    console.log('─'.repeat(78));
    console.log('Suggested corrected SPACES array (review before pasting into src/constants.ts):');
    console.log('─'.repeat(78));
    console.log('export const SPACES = [');
    for (const s of corrected) {
      console.log(`  { name: '${s.name.replace(/'/g, "\\'")}',`.padEnd(34) + ` id: '${s.id}' },`);
    }
    console.log('];\n');
    console.log('NOTE: this only matches by name. Confirm each corrected ID is the canonical');
    console.log('space you intend to scan — there are duplicate-named DAO spaces on Geo.\n');
  }

  if (showAll) {
    console.log('─'.repeat(78));
    console.log('All named non-personal (DAO) spaces — candidates to add to the scan list:');
    console.log('─'.repeat(78));
    const named = live.filter(s => s.type !== 'PERSONAL' && s.name).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    for (const s of named) console.log(`  ${(s.name ?? '').padEnd(40)} ${s.id}`);
    console.log(`\n  ${named.length} named DAO spaces. Most are test/personal — curate before scanning.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
