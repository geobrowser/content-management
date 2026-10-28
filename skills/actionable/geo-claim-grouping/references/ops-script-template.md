# Ops-script template + decisions contract (Stage D)

The dated ops script is the ONLY thing this skill writes into `scripts/` — and only after `go`. It reads the adjudicated decisions at runtime and turns them into `createRelation` ops for the current step. Modeled on the proven `scripts/2026-08-13-claim-brackets.ts` (decisions-at-runtime, batched live re-verification, DRY_RUN guard, per-space publish tail + fix packages).

## Contents
- Which step emits what
- decisions schemas (step 1 / step 2)
- The annotated step-2 script template
- Batched live checks (the fast pattern)
- DRY_RUN / AUTHORIZED protocol
- Fix-package route + regeneration warning
- Artifacts + verification

## Which step emits what

| Step | Reads | Emits |
|---|---|---|
| **1 — Related grouping** | `decisions.json` (discovery verdicts) | mirrored `Related claims` `504e5776…` edges for every non-NOT-SIMILAR pair |
| **2 — bracket assignment** | `brackets.json` (strict re-adjudication) | per bracket: mirrored `Duplicate claims` `982866bf…` / `Similar claims` `e81750db…`; directional `Supporting arguments` `1dc6a843…` (supported → supporter); `Opposing arguments` `4e6ec5d1…` (mirrored if `mutual`, else rebutted → rebutter). `RELATED-ONLY` and `dedupSuppressed` rows emit nothing |
| **2b — Duplicate star linking** | `clusters.json` (wording-strict copy clusters) | mirrored `Duplicate claims` edges canonical ↔ each copy ONLY (star topology, HARD RULE 8 — never full mesh) |

**Deterministic ids are property-namespaced (HARD RULE 6):** edge id = `typeId.slice(0,8) + from.slice(0,12) + to.slice(0,12)`; relation-entity id = `typeId.slice(0,8) + to.slice(0,12) + from.slice(0,12)`. Pin BOTH — an unpinned `entityId` randomizes per run and breaks the byte-identical check. The pre-2026-08-12 un-prefixed scheme (`from16+to16`) is RETIRED — it occupies old published edges and collides across properties.

## decisions schemas

**Step 1 — `decisions.json`** (Stage B discovery verdicts; unchanged shape):

```json
{ "adjudicatedAt": "<ISO>", "params": { "direction": "both" },
  "decisions": [ { "pairKey": "<sortedA>|<sortedB>",
    "a": { "id": "<32hex>", "name": "…", "space": "<32hex>" }, "b": { "…": "…" },
    "verdict": "SIMILAR|DUPLICATE|SUPPORTS|OPPOSES|NOT-SIMILAR",
    "confidence": "high|medium", "reason": "…", "approved": true } ] }
```

**Step 2 — `brackets.json`** (strict re-adjudication; one row per Related-grouped pair):

```json
{ "adjudicatedAt": "<ISO>", "rows": [ {
    "pairKey": "…", "a": { "id": "…", "name": "…", "space": "…" }, "b": { "…": "…" },
    "bracket": "DUPLICATE|SIMILAR|SUPPORTS|OPPOSES|RELATED-ONLY",
    "supported": "a|b",            // SUPPORTS only: which side is the supported claim
    "mutual": true,                 // OPPOSES only: mutual debate positions → mirrored
    "rebutted": "a|b",             // OPPOSES one-sided only: which side is rebutted
    "dedupSuppressed": true,        // copy-collapse (HARD RULE 8): row emits NO edge…
    "representative": "<claimId>",  // …because this partner duplicates the representative
    "confidence": "high|medium", "reason": "…" } ] }
```

`brackets.json` is the campaign's source of truth: collapse decisions are recorded as `dedupSuppressed` + `representative` (rows are never deleted), and a reconcile script can diff live-vs-expected to delete edges whose rows were later suppressed.

## The annotated step-2 script template

```ts
/**
 * geo-claim-grouping · step-2 bracket assignment — <slug> (two-phase)
 * Reads scripts/<date>-<slug>/brackets.json at RUNTIME (HARD RULE 5).
 * Run: bun run scripts/<date>-claim-grouping-<slug>.ts
 */
import { Graph, type Op } from "@geoprotocol/geo-sdk";
import * as fs from "node:fs";
import { gql, publishOps, printOps, getPublishableSpaceIds } from "../src/functions.ts";

const DRY_RUN = true; // flip ONLY after `publish`, with: // AUTHORIZED <date>: editor replied publish
const PROPS: Record<string, string> = {
  DUPLICATE: "982866bf8ae94afe8cce8b805713e4af", SIMILAR: "e81750db3f09440cab9dd01808a43ccb",
  SUPPORTS: "1dc6a843458848198e7a6e672268f811", OPPOSES: "4e6ec5d14292498a84e5f607ca1a08ce",
};
const DIR = "scripts/<date>-<slug>";
const edgeId = (p: string, f: string, t: string) => p.slice(0, 8) + f.slice(0, 12) + t.slice(0, 12);
const relEntityId = (p: string, f: string, t: string) => p.slice(0, 8) + t.slice(0, 12) + f.slice(0, 12);
const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function main() {
  const rows = [...JSON.parse(fs.readFileSync(`${DIR}/brackets.json`, "utf8")).rows]
    .sort((x: any, y: any) => x.pairKey.localeCompare(y.pairKey)); // stable order → zero drift

  // expand rows into directed edges (RELATED-ONLY and dedupSuppressed emit nothing)
  const directed: { prop: string; from: string; to: string; space: string }[] = [];
  for (const r of rows) {
    const p = PROPS[r.bracket]; if (!p || r.dedupSuppressed) continue;
    const fwd = (x: any, y: any) => directed.push({ prop: p, from: x.id, to: y.id, space: x.space });
    if (r.bracket === "DUPLICATE" || r.bracket === "SIMILAR" || (r.bracket === "OPPOSES" && r.mutual)) { fwd(r.a, r.b); fwd(r.b, r.a); }
    else if (r.bracket === "SUPPORTS") { const s = r.supported === "b" ? r.b : r.a, o = r.supported === "b" ? r.a : r.b; fwd(s, o); }
    else { const reb = r.rebutted === "b" ? r.b : r.a, other = r.rebutted === "b" ? r.a : r.b; fwd(reb, other); }
  }

  // batched live checks — see next section
  const alive = new Set<string>();
  for (const ids of chunk([...new Set(directed.flatMap(d => [d.from, d.to]))], 40)) {
    const r = await gql(`query($ids: [UUID!]) { entities(filter: { id: { in: $ids } }, first: 100) { id spaceIds typeIds } }`, { ids });
    for (const e of r.entities ?? []) if ((e.spaceIds?.length ?? 0) > 0 && (e.typeIds?.length ?? 0) > 0) alive.add(e.id);
  }
  const existing = new Set<string>(); // SAME-direction only (HARD RULE 7) — mirrors are intentional
  for (const prop of [...new Set(Object.values(PROPS))]) {
    let after: string | null = null;
    for (let page = 0; page < 400; page++) {
      const r: any = await gql(`query($after: Cursor) { relationsConnection(filter: { typeId: { is: "${prop}" } }, first: 1000, after: $after) { nodes { fromEntityId toEntityId } pageInfo { hasNextPage endCursor } } }`, { after });
      for (const n of r.relationsConnection.nodes) existing.add(`${prop}|${n.fromEntityId}|${n.toEntityId}`);
      if (!r.relationsConnection.pageInfo.hasNextPage) break;
      after = r.relationsConnection.pageInfo.endCursor;
    }
  }
  const idTuple = new Map<string, any>();
  for (const ids of chunk(directed.map(d => edgeId(d.prop, d.from, d.to)), 200)) {
    const r = await gql(`query($ids: [UUID!]) { relationsConnection(filter: { id: { in: $ids } }, first: 500) { nodes { id typeId fromEntityId toEntityId } } }`, { ids });
    for (const n of r.relationsConnection.nodes) idTuple.set(n.id, n);
  }

  const opsBySpace: Record<string, Op[]> = {};
  const counts = { create: 0, skipGone: 0, skipExisting: 0, skipPublished: 0, escalate: 0 };
  for (const d of directed) {
    const id = edgeId(d.prop, d.from, d.to); const hit = idTuple.get(id);
    if (!alive.has(d.from) || !alive.has(d.to)) { counts.skipGone++; console.log(`[SKIP gone] ${d.from} -> ${d.to}`); }
    else if (existing.has(`${d.prop}|${d.from}|${d.to}`)) { counts.skipExisting++; console.log(`[SKIP existing] ${d.from} -> ${d.to}`); }
    else if (hit && hit.fromEntityId === d.from && hit.toEntityId === d.to && hit.typeId === d.prop) { counts.skipPublished++; console.log(`[SKIP already-published] ${id}`); }
    else if (hit) { counts.escalate++; console.log(`[ESCALATE collision] ${id} is ${hit.typeId}`); }
    else { counts.create++; (opsBySpace[d.space] ??= []).push(...Graph.createRelation({ id, fromEntity: d.from, toEntity: d.to, type: d.prop, entityId: relEntityId(d.prop, d.from, d.to) }).ops); console.log(`[CREATE] ${id}`); }
  }

  const spaces = Object.keys(opsBySpace).sort();
  for (const s of spaces) printOps(opsBySpace[s], DIR, `ops-${s}.json`);
  console.log(`counts: ${JSON.stringify(counts)}`);
  if (DRY_RUN) { console.log("DRY-RUN complete."); return; }
  if (counts.escalate > 0) throw new Error("unresolved collisions");
  const editorSpaces = new Set(await getPublishableSpaceIds(spaces)); // NOTE: takes the candidate array
  for (const s of spaces) {
    if (editorSpaces.has(s)) {
      const proposalId = await publishOps(opsBySpace[s], "<edit name>", s);
      console.log(`PUBLISHED ${s}: ${proposalId} — https://www.geobrowser.io/space/${s}/governance?proposalId=${String(proposalId ?? "").replace(/^0x/, "")}`);
    } else { /* fix package — see below */ }
  }
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
```

## Batched live checks (the fast pattern)

Never loop `gql` per pair (the 2026-08-04 pilot did; ~3 queries × pairs). Verified batch shapes:
- **Liveness**: `entities(filter: { id: { in: $ids } }, first: 100)` in chunks of 40; alive = `spaceIds` AND `typeIds` non-empty (`entity(id:)` never returns null).
- **Excluded-space guard (HARD RULE 12)**: the SAME liveness pull's `spaceIds` feeds a mandatory endpoint check — any edge whose endpoint is resident in the Podcasts space `b5a31f8182b042437ede0f84ee02f104` → `[SKIP excluded-space]`, never CREATE, regardless of what the decisions/brackets file says (editor directive 2026-08-21; the 195-edge unlink campaign removed the previously-published links). Add `const EXCLUDED_SPACE_IDS = new Set(["b5a31f8182b042437ede0f84ee02f104"]);` and check `spaceIds.some(...)` per endpoint before the existing-edge check.
- **Existing edges**: one paged pull per property, then set-membership — **SAME direction only**. The either-direction form silently suppresses intentional mirror directions on any rerun after the forward side is live (real incident 2026-08-13).
- **Id collisions**: `relationsConnection(filter: { id: { in: [...] } })` in chunks of 200 (verified live 2026-08-13) — replaces per-id `relation(id:)` loops.

## DRY_RUN / AUTHORIZED protocol

1. Born with `const DRY_RUN = true`; the skill runs it and posts the dry-run report.
2. Re-run before offering `publish` — byte-identical output required (zero drift). If anything in the campaign uses `Position.generateBetween`, PIN the generated positions into the data file first — the SDK jitters them per run.
3. After `publish`: `const DRY_RUN = false; // AUTHORIZED <date>: editor replied publish` and re-run.
4. `stop` → leave everything on disk, change nothing.

## Fix-package route + regeneration warning

From-spaces where the wallet lacks editorship → `scripts/fix-packages/<slug>/<date>/<space>/ops.json` + `report.txt` (naming the space's editors and warning that mirror directions of already-approved edges are INTENTIONAL — do not dedupe against them). Never force-publish.

⚠️ **Fix packages are overwritten by every publish run.** A delta rerun after a partial publish rewrites them with only the delta (real incident 2026-08-13). Regenerate complete packages from the decisions file (a dry-run with the same-direction check produces the full non-live set), or version the package directory per run.

## Artifacts + verification

| File | Written by | Content |
|---|---|---|
| `brackets.dryrun.json` (or `.publish`) | ops script | run record: per-edge action + counts |
| `ops-<spaceId>.json` | `printOps` | the raw ops |
| dry-run stdout | ops script | `[CREATE]/[SKIP …]/[ESCALATE]/[SUPPRESSED copy]` per edge |

Post-publish verification: re-pull each property's edges — every staged edge resolves and NOTHING unexpected exists (live-vs-decisions reconcile, the 2026-08-13 QA pattern); spot-check one claim's page renders the new relation; partner near-dup scan over targets returns zero flagged (copy-collapse held).
