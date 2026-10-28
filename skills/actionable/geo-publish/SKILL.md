---
name: geo-publish
description: Publish entities and relations to the Geo knowledge graph via the GRC-20 SDK. Runs mandatory safeguards (ontology/correct-type check via ontology-advisor + semantic-duplicate check + schema check + type-required check + two-phase dry-run/confirm) before any write. Use when creating or updating entities and relations; entity deletes, merges and clean-ups go to geo-clean. Triggers on "publish", "create entity", "add person", "add to geo", "add to my space", "submit proposal", "create relation", "update entity".
metadata:
  author: geobrowser
  version: 0.12.1
---

# Geo Knowledge Graph — Publishing

Create and update entities and relations in Geo using `@geoprotocol/geo-sdk`. **Deleting an entity, merging, or any bulk removal goes through `geo-clean`**, which runs an orphan check and a human confirmation first. Portable (works in any local-execution agent: Claude Code, Codex CLI/Desktop, Claude cowork). **Browser-only assistants cannot publish** — they have no local runtime; send them to `geo-query` for reads.

Every write passes mandatory safeguards FIRST: an **ontology / correct-type check** (consult `ontology-advisor` for the *right* type + expected properties), **semantic-duplicate check**, **schema check**, **type-required check**, and **two-phase dry-run → explicit confirm**. These are not optional.

## Prerequisites

1. **Runtime**: Node 20.6+ or Bun (both support `--env-file`). **For the publish step, prefer Node** — Bun's `fetch` has hit a bug reaching the API host (`api-testnet.geobrowser.io`) in some environments, stalling the publish on "socket closed / retrying" while `curl` and Node's `fetch` reach the same host fine. If a dry-run works but `bun run` stalls on network during publish, re-run with `node --env-file=.env scripts/<file>.ts` — it's a Bun fetch quirk, not an outage.
2. **SDK available**: either the `geo-skills` repo cloned with `bun install` run (`node_modules/@geoprotocol/geo-sdk` exists), or the skill's own `node_modules`. **Post-migration (v20 contracts) this must be `@geoprotocol/geo-sdk` v0.20+** — 0.19.x and earlier publish to the retired contracts and their edits silently go nowhere after the grace window.
3. **Wallet key** in **`.env` at the project root** — `GEO_PRIVATE_KEY=0x...` (this is exactly what the setup guide creates, alongside `DEMO_SPACE_ID=`). Scripts read `GEO_PRIVATE_KEY`, fall back to the legacy `PK_SW`, and also accept a separate `.env.geo-publish` if present. Export the key from <https://www.geobrowser.io/export-wallet>.

**Never put the key in the transcript.** Do NOT read/print the value, do NOT `export` it in-session, do NOT ask the user to paste it.

**Check for the FILE, never its contents** — reading `.env` (`cat`/`grep`) is routinely refused by the permission classifier as secret-access, and a refusal looks identical to "no key", which is what produces false "you have no private key" alarms:
```bash
ls -a .env .env.geo-publish 2>/dev/null | grep -q . && echo "env file present" || echo "no .env here — cwd is $(pwd)"
```
(The `| grep -q .` matters: `ls` exits non-zero when *any* argument is missing, so `ls a b || echo missing` prints "missing" even when `a` exists — the same false-negative shape as the old `grep -qs` bug.)

**Interpreting the result — this is a soft check, not a gate:**
- `env file present` → **treat the key as configured. Proceed. Say nothing about it.**
- Nothing listed → you are probably in the wrong directory (the output prints `cwd`). Check the repo root before concluding anything.
- Command blocked/refused → **that is NOT evidence of a missing key. Proceed.**

**HARD: never ask the user about the private key more than once per session, and never at the publish gate.** If the user has said the key is set — at any point, in any wording — that is authoritative and final; do not re-verify, do not re-ask, do not mention it again. The authoritative check is the publish itself: if the key were genuinely absent, the script fails immediately with an explicit `GEO_PRIVATE_KEY not found…` error naming the cwd. A false "missing key" prompt costs the editor real time and trust; a genuinely missing key costs one clear error message. **Bias hard toward proceeding.**

Only if a publish has *actually failed* with that error: ask the user to add one line themselves in their editor — `GEO_PRIVATE_KEY=0x...` in `.env` at the project root — and reply "done".

4. **Network egress (sandboxed environments only).** Reads and the dry-run only need `api-testnet.geobrowser.io`. **Publishing needs three more hosts** and is commonly blocked when an allowlist was set up for reads only (or pre-migration):
   - `api-testnet.geobrowser.io` — IPFS upload of the edit (happens *before* the transaction; a reads-only or old `testnet-api` allowlist misses it)
   - `rpc-geo-testnet-irdc0cgb0w.t.conduit.xyz` — transaction RPC (chain 55516)
   - `rpc.zerodev.app` — gas sponsorship

   These come from the SDK's `GeoTestnetConfig` (re-check after SDK bumps). **Symptom:** dry-run succeeds, then `publish` fails at the IPFS/broadcast step with nothing written — that's a missing egress host, an **org-admin / environment setting**, not something the script can fix. If it can't be allowlisted, hand the finished script to the user to run on their own machine (full network + `bun install`).

## HARD RULES (failure = bug)

1. Before any `Write` to a script or any `bun run`/`node`, you MUST post the **Discovery + Gates + Plan** block (template below) and wait for the user to reply **"go"**.
2. The duplicate search is **name-only, across ALL types and ALL spaces**. Never filter by the type you're about to create — "Bitcoin" the Project is a duplicate concern of "Bitcoin" the Token.
3. "Looks straightforward" is NOT a reason to skip the template. Always post it.
4. **Two-phase execution:** `go` authorizes the dry-run only. Publishing needs a *second* explicit `publish`.
   - After `go`: write the script with `DRY_RUN = true`, run the dry-run yourself, and report it in the mandatory **[Dry-run report](#dry-run-report--mandatory-format)** table format — never a prose summary or a bare op count.
   - Then ask: *"Output looks right? Type **publish** to publish to Geo, or **stop** to discard."*
   - On `publish`: flip `DRY_RUN = false`, re-run, surface the tx hash + verify URL.
   - On `stop`: leave the script on disk, change nothing on Geo.
   - Never auto-publish on `go`.
   - **Never re-open environment/setup questions at the `go` or `publish` gate** — not the private key, not `.env`, not the SDK. Those belong to Prerequisites, are checked once, and a blocked/unreadable check is not evidence of a problem. On `publish`, run it: the script's own error is the authoritative answer. (Real failure mode: the agent reached the gate and announced "you don't have a private key set up" on a machine where it *was* set up, because the `.env` check had been refused by the permission classifier.)
5. **Removals happen only inside an update; entity deletes go to geo-clean.** This skill may remove values or relations as part of an update (`unset`, `deleteRelation`), and only after the user types `publish` having seen exactly what will be removed. Deleting an entity, merging, or any bulk removal is out of scope: stop and route to **geo-clean**.
6. **Publishing from a dataset: the script READS THE DATA FILE AT RUNTIME — never transcribe rows into the script as constants.** See [Bulk / dataset publishing](#bulk--dataset-publishing--data-goes-in-the-file-not-the-script). Baking rows into the script blows the token budget and times out on large datasets, and risks the model fabricating values (especially URLs) as it copies.
7. **Properties on a relation go on the relation ENTITY id, NEVER the relation id.** A relation has two different IDs. Knowledge (values/name/types) written to the relation's own `id` is silently lost — the write "succeeds" and shows in the proposal, but renders nowhere. See [Relations — entity id vs relation id](#relations--entity-id-vs-relation-id-critical). This is not optional; getting it wrong mis-published ~1000 rows in production.
8. **EVERY value's `type` must match the property's declared `dataTypeName` — check all of them against the mapping table, not just dates.** The discovery query already returns `dataTypeName` per property, so this is a zero-extra-queries table lookup (see [Data-type mapping](#data-type-mapping-datatypename--sdk-value-type)). ANY mismatch publishes but silently doesn't render (datetime-as-date is just the classic case). Mismatches → Gate 2.
9. **Test ONE before any bulk publish.** Publish a single row first, open it on geobrowser.io, and confirm every field actually renders (not just "the API returned success"). Only then run the batch. Both failure modes above are *silent* — API/proposal say OK while the data is lost — so visual confirmation of one row is the only real check.
10. **Every entity this publish CREATES must carry at least one type — nothing ships typeless.** Any type is acceptable; none is not ("I cannot publish Elon Musk and not type it Person; I cannot publish a claim without type Claim"). The check covers **every** created entity, not just the headline one: relation targets minted inline (a Source created to cite a claim), entities looped from CSV rows, block entities (those are typed by construction and pass automatically). A typeless create → **Gate 4**. Two carve-outs: (a) **updating** an entity that already exists typeless on Geo → WARN and propose adding a type in the same publish, don't block the repair; (b) a dataset with no Types column → resolve types **with the editor** before generating any ops — never invent them silently. Untyped entities are the #1 data-quality defect on Geo; the platform is expected to reject them eventually, so don't publish what tomorrow's Geo would bounce.
11. **Consult `ontology-advisor` for the CORRECT type before proposing — not just *a* type (Gate 0 ≠ Gate 4).** Before the Discovery block, determine each created entity's correct type + expected properties by consulting **ontology-advisor** — read its bundled `ONTOLOGY.md` modelling reference, or invoke the skill when the modelling is genuinely ambiguous/novel. Getting *a* type satisfies Gate 4; getting the *right* type satisfies **Gate 0**. This is what stops "publish this x.com link" becoming a bare **`Post`** (no text/author/topics) instead of a **`Tweet`**. Don't rely on a perfect prompt — read the ontology and show the proposed type in the dry-run. → **Gate 0**. (For a pasted URL, **inject mode** already applies the correct type via the injector; Gate 0 confirms it.)

## Required output template (post BEFORE writing any script)

````
## Discovery
**Type (per ontology-advisor)** — <content kind → correct type> (`<typeId>`); expected properties: <list>. <flag if the naive type would be wrong, e.g. x.com link → **Tweet** not **Post**>
**Schema** — Type: <name> (`<id>`); Properties: <name> (`<id>`, dataType=…), …; Relation types: <name> (`<id>`), …

**Duplicate candidates** — name-only, ALL types, ALL spaces:
| Name | ID | Type | Space |
|---|---|---|---|
| … | … | … | … |
(or "no candidates found")

**Current state** (updates only): <values + relations, or "n/a — create only">
**Off-schema delta**: <properties/relations NOT on the type schema, or "none">

## Gates
- **Gate 0 (ontology / correct-type)**: PASS | FIRE — <the type is the CORRECT one for this content per ontology-advisor (x.com → Tweet not Post; reddit → Post; news article → Article; person bio → Person), AND the type's expected properties are present (Tweet: text/Author/Topics; Article: Web URL/Publish datetime/Publisher). List any wrong-type or missing expected-property.>
- **Gate 1 (semantic-duplicate)**: PASS | FIRE — <reason/hits>
- **Gate 2 (schema-violation)**: PASS | FIRE — <off-schema list AND every planned value checked against the dataType mapping table; list any mismatch (e.g. datetime-as-date, Checkbox-as-text, Relation-as-value)>
- **Gate 3 (relation-target)**: PASS | FIRE — <any value targeting a relation `id` instead of the relation `entityId`; see Relations section>
- **Gate 4 (type-required)**: PASS | FIRE — <EVERY created entity (incl. inline relation targets and per-row creates) carries ≥1 type in this publish; list any typeless creates WITH a proposed type each; warn-list any typeless existing entities being updated>
If any FIRES, STOP, run the gate dialog, wait for the user.

## Plan (only if gates PASS or waived)
- Target space: <id> (personal | DAO)
- Ops: createEntity=<n>, createRelation=<n>, updateEntity=<n>, deleteRelation=<n>
- Script: `scripts/<YYYY-MM-DD>-<slug>.ts` (written AFTER "go")

Reply **"go"** to authorize writing + dry-running the script.
````

## Gate dialogs

**Gate 0 — ontology / correct-type fires:**
> Per `ontology-advisor`, this content should be **{correct type}** (`{id}`), not **{naive type}** — {reason, e.g. "an x.com link is a **Tweet**, which carries the post text, Author and Topics; a bare **Post** drops all of them"}. Expected properties for a {correct type}: {list}; missing from the plan: {list}.
> - **Use the correct type** → I'll model it as **{correct type}** with the expected properties. For a URL, prefer **inject mode** — the injector types + enriches it automatically (text/author/topics).
> - **Keep {naive type}** → confirm you really want this shape; it will under-render (this is exactly the ~50-Tweets-as-Posts defect).

**Gate 1 — semantic-duplicate fires:**
> Found an existing entity that may already mean this: **{name}** (`{id}`), type **{type}**, space **{space}**.
> - **Use existing** → skip the create, reuse this ID downstream.
> - **Publish anyway** → confirm it's NOT a duplicate and I'll proceed.

**Gate 2 — schema-violation fires** (missing property OR wrong data type):
> **{property}** (`{id}`) on a **{type}**: {it isn't on {type}'s schema | the schema declares it as **{schemaType}** but you're publishing it as **{yourType}** (e.g. datetime-vs-date)}.
> - **Fix the type** → I'll set the value's `type` to **{schemaType}** and reformat the value.
> - **Add to schema first** → I'll generate a schema-update op (missing-property case).
> - **Publish anyway** → it lands but won't render in the UI.
> - **Skip the property** → drop it from this publish.

**Gate 3 — relation-target fires:**
> This value targets a **relation id** (`{relationId}`), which can't hold properties — knowledge must go on the relation **entity id**.
> - **Fix the target** → I'll {put it in `createRelation`'s `entityValues` | resolve the relation's `entityId` and target that} instead.
> - (There is no "publish anyway" — writing to a relation id silently loses the data.)

**Gate 4 — type-required fires:**
> **{n} entities in this plan would publish without a type:** {list}.
> Suggested types (from this space's schema / the ontology): {name} → **{proposed type}**, …
> - **Apply suggested types** → I'll add the Types edges to the plan.
> - **Set types yourself** → tell me the type per entity (any type works; none doesn't).
> - (There is no "publish anyway" — typeless entities are the graph's #1 quality defect and the platform is expected to reject them.)
>
> *Warn-only variant (existing entity):* updating **{name}** (`{id}`), which is already on Geo **without a type** — recommend adding one in this publish. Proceeding either way.

## Discovery — how to produce the outputs

**Type (consult `ontology-advisor`) — do this FIRST, before choosing the type.** For the content being published, determine the CORRECT type + its expected properties from **ontology-advisor** — read its bundled `ONTOLOGY.md` modelling reference, or invoke the `ontology-advisor` skill when the modelling is genuinely ambiguous/novel. Don't depend on a perfect prompt — let the ontology pick the type. The classic misses it catches:
- an **x.com / twitter.com** link → **`Tweet`** (carries the post text, **Author**, **Topics**), **not** a bare **`Post`**;
- a **reddit** link → **`Post`**; a **news article** → **`Article`** (Web URL, Publish datetime, Publisher); a **wikipedia/bio** → **`Person`**.

Put the result in the Discovery block's **Type (per ontology-advisor)** line and check it in **Gate 0**; surface the chosen type + expected properties in the dry-run so the editor sees "this will be a Tweet with text/author/topics" before publishing. **For a pasted URL, use inject mode** (`lib/inject.ts`) — the injector applies the correct type + enrichment automatically, and Gate 0 just confirms it; the ontology consult is the safety net for hand-built entities and anything the injector doesn't cover.

GraphQL against `https://api-testnet.geobrowser.io/graphql` (no auth). Delegate to `geo-query` if loaded.

**Schema** (type ID + property/relation IDs + property dataTypes from a known instance):
```graphql
{ entities(first:1, filter:{ name:{ includesInsensitive:"<known instance>" } }) {
    id name types { id name }
    values(first:50){ nodes{ property{ id name dataTypeName } text } }
    relations(first:50){ nodes{ id entityId type{ id name } toEntity{ id name } } } } }
```
Property IDs from `values.nodes[].property.id`; **the property's declared type from `values.nodes[].property.dataTypeName`** (e.g. `Text`, `Time`/datetime, `Number`) — match your SDK value `type` to it (Gate 2). Relation type IDs from `relations.nodes[].type.id`. Each relation exposes **both `id` (the edge) and `entityId` (the relation entity, where its properties live)** — target `entityId` for relation values (Gate 3). **Don't guess IDs.** (`values`/`relations` are connections — the `nodes{}` wrapper is required.)

**Duplicate candidates** (name-only, all types, all spaces) — one query, the name passed as a variable (`{"name": "<name>"}`) so quotes in it are safe:
```graphql
query Dupes($name: String!) {
  exact: entities(first:100, filter:{ name:{ isInsensitive:$name } }) { id name types { id name } spaceIds }
  exactCount: entitiesConnection(filter:{ name:{ isInsensitive:$name } }) { totalCount }
  similar: entities(first:20, filter:{ name:{ includesInsensitive:$name } }) { id name types { id name } }
}
```
List **every** `exact` hit in the Duplicate candidates table, and say so if `exactCount` is over 100. Space, Proposal and block-type hits (e.g. Data block) are not duplicates. `similar` is only a sample — mostly claims that mention the name — so scan it for variants of the name, but never use it in place of `exact`: its first 20 hits for "Bitcoin" contain none of the 11 exact matches.

**Current state** (updates only — by entity ID): same shape as schema query, fetch the target entity.

**Off-schema delta**: compare every planned property/relation against the discovered schema; anything missing → Gate 2.

## Generate, dry-run, publish (only after "go")

1. **Write** `scripts/<YYYY-MM-DD>-<slug>.ts` with `DRY_RUN = true` (template below).
2. **Run** it yourself: `node --env-file=.env.geo-publish scripts/<file>.ts` (or `--env-file=.env` for repo/PK_SW users; or `bun run` with `--env-file`). Prints ops, touches nothing.
3. **Report** using the **Dry-run report** format below — not a prose summary. The script's own output MUST also list every created entity as `Creating: <name> [<type>, …]` so type coverage is visible (see the Gate-4 helper below).
4. On `publish`: set `DRY_RUN = false`, re-run, report tx hash + `https://www.geobrowser.io/space/<spaceId>/<entityId>`.

### Dry-run report — MANDATORY format

The dry-run is the **human gate**. An editor must be able to spot a mistake in ~30 seconds by scanning it. Prose summaries hide errors and get rubber-stamped, so report in **tables**, always in this order. Keep every section even when empty (write "none") — a missing section reads as "nothing to check", which is exactly the failure this format prevents.

````
## Dry-run — {N} entities → {space name} ({personal · instant | DAO · proposal + vote})

**1. What gets written**
| # | Name | Type | Op | New/Existing |
|---|---|---|---|---|
| 1 | {name} | {type} | create / update / delete | new |

**2. Values** — every value being written, with the data-type check visible
| Entity | Property | Value (truncate ~60 chars) | Schema type | Writing as | OK? |
|---|---|---|---|---|---|
| {name} | Birth date | 1926-11-03 | Date | date | ✅ |

**3. Relations**
| From | Relation | → To | Target | toSpace |
|---|---|---|---|---|
| {name} | Roles | President | exists `f06e1cee…` | `d6960829…` |

**4. Gates**
| Gate | Result | Detail |
|---|---|---|
| 0 ontology/type | ✅ PASS | x.com link → Tweet (not Post) |
| 1 duplicate | ✅ PASS | 0 exact hits for "{name}" (`exactCount` 0), all types/spaces |
| 2 schema/data-type | ✅ PASS | 5/5 values match declared types |
| 3 relation-target | ✅ PASS | no values on relation ids |
| 4 type-required | ✅ PASS | 1/1 created entities typed |

**5. Totals**
| createEntity | createRelation | updateEntity | deleteRelation | total ops |
|---|---|---|---|---|
| 1 | 3 | 0 | 0 | 4 |

**6. ⚠ Needs your eyes** — anything you could NOT verify, guessed, or dropped
- {e.g. "Article name derived from the URL slug — outlet blocks bots, real headline unverified"}
- {e.g. "Website property skipped — no verified URL found; not guessing one"}
- {e.g. "Publish datetime missing on entity #9 — source gave only 'May 2025'"}
- (or: "none — every value came from a source I read")

Nothing has been written. Type **publish** to publish, or **stop** to discard.
````

**Section 6 is the point of the whole report.** Every silent-failure class we've hit — a slug-derived headline, a fabricated URL, a dropped field, a waived duplicate, a cross-space write — is invisible in an op count and obvious in one line of plain English. **Never leave it empty to look clean**: if you inferred, guessed, truncated, skipped, or couldn't verify something, it goes there. An editor approving a publish is trusting this section.

**Scale by size, not by skipping:** for a bulk publish, sections 1–3 show the **first 3 rows + the totals**, plus **every** row that is unusual (missing a field, a new relation target, a duplicate hit) — never a silent sample that hides the outliers. Say explicitly how many rows are not shown.

Self-contained script template (portable — direct SDK, no repo helpers required):

```typescript
// SDK v0.20+ (post-migration): explicit client + network config; string network
// IDs and getSmartAccountWalletClient are GONE.
import {
  Graph, createGeoClient, createGeoWalletClient,
  GeoTestnetConfig, SystemIds, type Op,
} from '@geoprotocol/geo-sdk';
import { privateKeyToAccount } from 'viem/accounts';

const DRY_RUN = true;

// Key: GEO_PRIVATE_KEY preferred, PK_SW fallback. Normalize 0x prefix.
const raw = process.env.GEO_PRIVATE_KEY ?? process.env.PK_SW;
if (!raw) throw new Error('No key. Set GEO_PRIVATE_KEY in .env.geo-publish (or PK_SW in .env).');
const privateKey = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
const SPACE = process.env.DEMO_SPACE_ID!;        // target = your personal space

// Network: endpoints + chain id (55516) + contract addresses ALL come from the SDK's
// GeoTestnetConfig — never hardcode them (the announced vanity URLs aren't all live yet;
// `bun install` picks up final URLs automatically). Repo users can import NETWORK/geo
// from ../src/functions.js instead of re-deriving here.
const geo = createGeoClient({ network: GeoTestnetConfig });

const allOps: Op[] = [];

// Gate 4 (type-required) — create EVERY entity through this wrapper; a typeless create throws.
const created: { id: string; name: string; types: string[] }[] = [];
function createTypedEntity(params: Parameters<typeof Graph.createEntity>[0]) {
  if (!params.types?.length)
    throw new Error(`GATE 4: "${params.name ?? '(unnamed)'}" would publish without a type.`);
  const r = Graph.createEntity(params);
  created.push({ id: r.id, name: params.name ?? '(unnamed)', types: params.types });
  return r;
}

const { id: entityId, ops } = createTypedEntity({
  name: 'Hedy Lamarr',                        // NO trailing period
  description: 'Austrian-American inventor.',  // MUST end with a period
  types: ['7ed45f2bc48b419e8e4664d5ff680b0d'], // Person
  values: [],
});
allOps.push(...ops);

for (const c of created) console.log(`Creating: ${c.name} [${c.types.join(', ')}]`);
console.log(`${allOps.length} ops; entity ${entityId}`);
if (DRY_RUN) { console.log('DRY_RUN — set false to publish.'); }
else {
  const wallet = await createGeoWalletClient({ signer: privateKeyToAccount(privateKey), network: GeoTestnetConfig });
  const { to, calldata, editId } = await geo.personalSpaces.publishEdit({
    name: 'Add Hedy Lamarr', spaceId: SPACE, ops: allOps, author: SPACE,   // no network param — the client carries it
  });
  const tx = await wallet.sendTransaction({ account: wallet.account, to, data: calldata });
  console.log('editId', editId, 'tx', tx);
}
```

(Repo users may instead import `publishOps`/`printOps` from `../src/functions.js` — that path uses `PK_SW`/`DEMO_SPACE_ID` and handles personal-vs-DAO automatically.)

### Gate-4 helper — mandatory in every generated script

The script template above defines `createTypedEntity` — route **every** entity creation through it (headline entities, inline relation targets, per-row creates). It makes a typeless create impossible at runtime — the belt behind the Gate-4 suspenders — and feeds the dry-run type listing (`Creating: <name> [<type>]`).

Block entities pass automatically (the block recipes always set their types; recipe snippets in this doc show raw `Graph.createEntity` for brevity, and each carries `types` inline). In a **generated script**, a raw create that bypasses the wrapper is a review defect.

## Bulk / dataset publishing — data goes in the file, not the script

**Spreadsheet source? Convert to CSV first — the publish path reads CSV/JSON, not `.xlsx`/`.xls`/Sheets/Notion.** You publish from the `geo-skills` repo, so the converter is right there:
```bash
node src/xlsx-to-csv.cjs <file.xlsx>      # → <file>.csv  (uses `xlsx`; already installed via bun install)
```
Then publish that CSV. (No repo handy, or one quick file? Export to CSV by hand — Excel: Save As → CSV · Google Sheets: Download → CSV · Notion database: Export → CSV, since Notion only exports PDF/HTML/CSV.) Either way, **keep every column header verbatim** — headers are the schema-mapping keys.

When the source is a **dataset** (a CSV/JSON of many rows — podcasts, people, books…), the generated script must **read and parse that file at runtime** and build ops by looping the rows. **Do NOT transcribe the rows into the script as a `const data = [ … ]` array.**

**Types come first (Gate 4):** if the dataset has no Types column and no single agreed type, STOP and resolve the type(s) with the editor before generating ops — per-row from a column, or one confirmed constant for the whole file. Never invent types, and never let a row through without one.

Why this is a hard rule (it caused a real publish outage):
- **It doesn't scale / times out.** Embedding rows makes the model spend the whole run *copying data* into the file instead of writing logic. On a large dataset it hits the output-token limit ("file too large", "spent too long reading") and **never publishes**.
- **It hallucinates.** Asking a model to copy hundreds of values — especially URLs — risks fabricated or corrupted values getting published.
- **It's not reusable.** Data-as-constants means a new script per dataset; reading the file means swap the file and rerun.

The script holds only the **ontology (type/property/relation IDs) + the row→ops mapping**. The data stays in the file:

```typescript
import { Graph, createGeoClient, createGeoWalletClient, GeoTestnetConfig, type Op } from '@geoprotocol/geo-sdk';  // v0.20 client — createGeoClient({ network: GeoTestnetConfig }) as in the script template
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';   // or JSON.parse for a .json dataset

const DRY_RUN = true;
const DATA = process.argv[2] ?? 'data.csv';            // path passed at runtime
const rows = parse(readFileSync(DATA, 'utf8'), { columns: true, skip_empty_lines: true });

const PODCAST_TYPE = '4c81561d1f9541319cdddd20ab831ba2';  // ontology lives in the script
const HOSTS_REL    = 'c72d9abbbca84e86b7e8b71e91d2b37e';  // — IDs only, never the data

const allOps: Op[] = [];
for (const row of rows) {                               // build ops from the FILE, at runtime
  const { id, ops } = createTypedEntity({ name: row.name, description: row.description, types: [PODCAST_TYPE], values: [] }); // wrapper from the script template (Gate 4)
  allOps.push(...ops);
  // …createRelation(HOSTS_REL) per host, etc.
}
console.log(`${rows.length} rows → ${allOps.length} ops`);
if (!DRY_RUN) { /* publish allOps once (see template above) */ }
```

Run the dry-run against the real file: `node --env-file=.env.geo-publish scripts/<file>.ts data.csv`. If the dataset is very large, **chunk the rows** (publish in batches of N) rather than embedding more data. The two-phase `go` → `publish` flow is unchanged.

## Relations — entity id vs relation id (critical)

**In Geo, entities and relations are separate spheres; their IDs are NOT interchangeable.** A single relation carries several IDs — and getting them confused silently corrupts data at scale.

A relation (GraphQL `Relation`) has:
- **`id`** — the relation edge's own unique identifier ("the relation id"). Identifies the edge. **It is NOT an entity and CANNOT hold properties.**
- **`entityId`** — the **relation entity**: a real entity attached to the edge. **This is where any name / values / types on the relation live.**
- plus `fromEntityId`, `toEntityId`, `typeId`, `spaceId`.

**The failure mode (real, ~1000 rows):** writing values to the relation's `id` — e.g. `updateEntity({ id: <relationId>, values })`. The op is valid, the API returns success, and the proposal screen shows the property "set" — but it renders **nowhere**, because a relation id is not an entity. Silent loss.

**Do it right:**

- **Creating a relation WITH data** — put the data in `createRelation`'s `entity*` params. They attach to the relation entity (`entityId`), auto-generated or one you pass:
  ```ts
  const { id, ops } = Graph.createRelation({
    fromEntity, toEntity, type,               // the edge
    entityId,                                  // optional; the relation ENTITY (generate + keep it)
    entityName: 'Listen on Apple Podcasts',    // name/values/types land on entityId, NOT on id
    entityValues: [{ property: URL_PROP, type: 'text', value }],
    entityTypes: [SOME_TYPE],
  });
  ```
  Never follow a `createRelation` with a separate `updateEntity` that targets the relation's `id`.
- **Updating a relation's data later** — resolve its **relation entity id** first, then update THAT:
  ```graphql
  { entity(id:"<from>"){ relations(first:50){ nodes{ id entityId type{ id name } toEntity{ id name } } } } }
  ```
  Use the relation's **`entityId`** in `updateEntity({ id: entityId, values })`. Never the relation `id`.
- **Discovery must surface both.** When a relation carries (or will carry) data, show the plan's `relation id` AND `relation entity id` so it's unambiguous which one the values target.
- **Cleaning up a past mistake:** for each affected relation, query its `entityId`, delete the values wrongly written on the relation `id`, and re-write them on the `entityId`.

## Entity rules

- **At least one type, always** (HARD RULE 10 / Gate 4). An entity without a type is invisible to schemas, queries and cleanup — the bare minimum for anything on Geo is a type.
- Names **must NOT** end with a period. Descriptions **MUST** end with a period.
- **Which value `type` a property wants is decided by its schema, not by how the value looks** — read `dataTypeName` from discovery and map it (table below). A mismatched value publishes but never renders.

## Data-type mapping (dataTypeName → SDK value type)

Every dataTypeName in the live API, mapped to the SDK value `type` (zero extra queries — `dataTypeName` comes back in the discovery query; this check is a table lookup over your planned values):

| `dataTypeName` (API) | SDK value `type` | Value format |
|---|---|---|
| `Text` | `text` | any string — **URLs too** (no url type) |
| `Date` | `date` | `YYYY-MM-DD` |
| `Datetime` | `datetime` | ISO `…Z` (the classic trap: setting it as `date` silently doesn't render) |
| `Time` | `time` | time string |
| `Checkbox` | `boolean` | `true`/`false` — NOT `text` |
| `Integer` | `integer` | whole number |
| `Float` | `float` | number |
| `Decimal` | `decimal` | number string |
| `Point` | `point` | coordinates |
| `Schedule` | `schedule` | schedule value |
| `Relation` | **NOT a value** | must be `Graph.createRelation` (with `entity*` params for its data) — never a `values[]` entry |
| *(null / unknown)* | — | flag it (Gate 2); inspect a live instance, don't guess |
- URLs publish as `type: 'text'` even for URL-renderable properties (SDK rejects `type: 'url'`).
- **Collect ALL ops into one array, publish ONCE.** Never publish in a loop.
- Relations: set `toSpace` if the target is in a different space. For reruns to be idempotent, pin both ids with the typed scheme from geo-claim-grouping (its hard rule 6): edge `id` = `typeId.slice(0,8) + from.slice(0,12) + to.slice(0,12)`, relation `entityId` = `typeId.slice(0,8) + to.slice(0,12) + from.slice(0,12)`. The type prefix keeps two relation types between the same pair apart; the old untyped scheme (`from16+to16`) gave them the same relation entity, so their values landed on one entity. It is retired, but never regenerate ids for relations already published, and finish an in-flight campaign with the scheme it started with — a rerun under new ids creates a second relation.

## Publishing page blocks (text, media, data, tabs)

Pages carry **blocks** — the narrative/media/data content above an entity's properties. Every block is its own entity attached to the host via the **Blocks** relation `beaba5cba67741a8b35377030613fc70`, ordered by the relation's **`position`** (a fractional-index string). Blocks render on ANY entity (Topic, Claim, Page, …), not just `Page`. Verified live 2026-07-14 (canvas `b91409f702544bd989619de38f835dbe`); every op shape below was published and confirmed rendering.

**Order blocks with `Position`:** `import { Position } from '@geoprotocol/geo-sdk'` → `let pos = null; pos = Position.generateBetween(pos, null)` per block, pass as the Blocks relation's `position`. To move a block later: `Graph.updateRelation({ id: <blocksRelationEdgeId>, position: Position.generateBetween(before, after) })`.

### Well-known block IDs

| Thing | ID |
|---|---|
| Blocks relation | `beaba5cba67741a8b35377030613fc70` |
| Text block type · Markdown-content prop | `76474f2f00894e77a0410b39fb17d0bf` · `e3e363d1dd294ccb8e6ff3b76d99bc33` |
| Data block type | `b8803a8665de412bbb357e0c84adf473` |
| Data source type rel → Collection · Query source | `1f69cc9880d444abad493df6a7b15ee4` → `1295037a5d9c4d09b27c5502654b9177` · `3b069b04adbe4728917d1283fd4ac27e` |
| Collection item rel · Filter val · Sort val | `a99f9ce12ffa4dac8c61f6310d46064a` · `14a46854bfd14b1882152785c2dab9f3` · `46afd0486bb5434e81adab6c7ad1204d` |
| View prop · Properties(columns) prop | `1907fd1c81114a3ca378b1f353425b65` · `01412f8381894ab1836565c7fd358cc1` |
| Views: Table · List · Gallery · Bulleted | `cba271cef7c140339047614d174c69f1` · `7d497dba09c249b8968f716bcf520473` · `ccb70fc917f04a54b86e3b4d20cc7130` · `0aaac6f7c916403eaf6d2e086dc92ada` |
| Image type · Video type · IPFS-URL prop | `ba4e41460010499da0a3caaa7f579d0e` · `d7a4817c9795405b93e212df759c43f8` · `8a743832c0944a62b6650c3cc2f9c7bc` |
| Cover rel · Avatar rel | `34f535072e6b42c5a84443981a77cfa2` · `1155befffad549b7a2e0da4777b8792c` |
| Page type · Tabs prop | `480e3fc267f3499385fbacdf4ddeaa6b` · `4d9cba1c4766469881cd3273891a018b` |
| Ranking block type · Aggregation-restriction rel · Editors-and-members | `150db6defe2344f0805afa57502e2c32` · `1e4caa2de3314efa8ac24e8d9d3e9fe9` · `10a7b10390f94a728087935052ffaa69` |

### Text blocks — and everything that lives inside markdown

`TextBlock.make({ fromId, text, position })` returns the ops for the block entity + its Blocks relation in one call (`import { TextBlock } from '@geoprotocol/geo-sdk'`). The `text` is **markdown**, and several "block types" the UI slash-menu shows are really just markdown inside a text block:

```ts
import { TextBlock, Position } from '@geoprotocol/geo-sdk';
let pos = null;
const push = (text) => { pos = Position.generateBetween(pos, null); ops.push(...TextBlock.make({ fromId: HOST, text, position: pos })); };

push("## Heading\n\nIntro line.\n\n- bullet one\n- bullet two");          // headings + bullets
push("See [CoinDesk](https://www.coindesk.com) for context.");            // web link (clickable)
push("This mentions [Bitcoin](graph://2f8238b2f4c899fb23b4a2f8aabd996c)."); // INLINE ENTITY MENTION — navigates in-app
push("```json\n{ \"a\": 1 }\n```");                                        // CODE BLOCK (fenced markdown; no Code block type exists)
push("Inline $E=mc^2$ and display $$R=\\frac{a}{b}$$");                    // FORMULA (LaTeX; no Formula block type exists)
```

- **Inline entity mention** = a markdown link whose href is `graph://<entityId>` — renders as a mention and navigates to that entity in the app. This is the only way to reference an entity inside prose; it is documented nowhere else.
- **Code and Formula are NOT block types.** The UI "Code block" / "Formula" menu items store fenced-code / `$…$`-`$$…$$` LaTeX markdown inside a normal text block. Publish them the same way.

### Media blocks

**Image block:** `Graph.createImage({ url, name, network: 'TESTNET' })` is **async** — it fetches the URL, uploads to IPFS, and returns `{ id, cid, dimensions, ops }`. Attach the returned entity via a Blocks relation.
```ts
const img = await Graph.createImage({ url, name: 'caption', network: 'TESTNET' });
ops.push(...img.ops, ...Graph.createRelation({ fromEntity: HOST, toEntity: img.id, type: BLOCKS, position: nextPos() }).ops);
```
> **⚠ VALIDATE THE SOURCE URL FIRST.** `createImage` does `fetch(url)` with **no `response.ok`/content-type check** — if the source 400/403s (e.g. Wikimedia blocks bots, hotlink protection), the SDK silently uploads the **HTML error page as the image**; it publishes fine and only breaks at render. **Tell:** the resulting image entity has **no Width/Height** (`imageSize()` failed). Guard: pre-fetch and check `res.ok` + `content-type: image/*`, or download validated bytes and pass a Blob via `Ipfs.uploadImage({ blob }, 'TESTNET', true)` (returns `{ cid, dimensions }`) — refuse to publish if `dimensions` is missing. Prefer UA-friendly CDNs (pbs.twimg.com, assets.coingecko.com) over Wikimedia. (Core-team item: SDK should throw on bad fetch.)

**Cover / Avatar:** same `createImage`, then a **Cover** (`34f5…`) or **Avatar** (`1155…`) relation from the host — not a Blocks relation.

**Video block:** no SDK helper. Hand-roll the entity and attach via Blocks:
```ts
const vid = Graph.createEntity({ name: 'caption', types: ['d7a4817c9795405b93e212df759c43f8'],
  values: [{ property: '8a743832c0944a62b6650c3cc2f9c7bc', type: 'text', value: mp4Url }] });
```
> **⚠ mp4 only.** Video blocks render a raw `<video>` tag: a direct `.mp4` plays; a **YouTube/Vimeo/external embed URL is a dead block**. No embed support today (core-team item).

### Data blocks — collection, query, ranking

A **Data block** is `Graph.createEntity({ name, types: [DATA_BLOCK] })` + a **Data source type** relation choosing its kind. **View and Columns live on the Blocks-relation ENTITY id, not on the block** (the same entity-id-vs-edge-id trap as Gate 3) — capture it by hex-decoding the relation op's `entity` field:

```ts
function blockRel(host, blockId, position) {
  const rel = Graph.createRelation({ fromEntity: host, toEntity: blockId, type: BLOCKS, position });
  ops.push(...rel.ops);
  return Buffer.from(rel.ops[0].entity).toString('hex');   // ← the Blocks-relation entity id (View/Columns target)
}
```

**Collection block** (hand-picked rows, your order):
```ts
const b = Graph.createEntity({ name: '🧪 My picks', types: [DATA_BLOCK] }); ops.push(...b.ops);
ops.push(...Graph.createRelation({ fromEntity: b.id, toEntity: COLLECTION_SOURCE, type: DATA_SRC }).ops);
const relEnt = blockRel(HOST, b.id, nextPos());
ops.push(...Graph.createRelation({ fromEntity: relEnt, toEntity: LIST_VIEW, type: VIEW }).ops);        // view (default Table if omitted)
ops.push(...Graph.createRelation({ fromEntity: relEnt, toEntity: DESCRIPTION_PROP, type: COLUMNS }).ops); // a shown column
let ip = null;                                                                                          // ROW ORDER = item positions
for (const id of ITEMS) { ip = Position.generateBetween(ip, null);
  ops.push(...Graph.createRelation({ fromEntity: b.id, toEntity: id, type: COLLECTION_ITEM, position: ip, toSpace: crossSpace(id) }).ops); }
```
Row order follows the Collection-item **positions** (not name, not createdAt). Cross-space items render fine — set `toSpace`. Collections render **9 items per page**.

**Query block** (live, filtered, sorted): same, but Data-source → Query source and two **text values** on the block:
```ts
const filter = JSON.stringify({ spaceId: { in: [SPACE] }, filter: { [TYPES_PROP]: { is: TYPE_ID }, [REL_PROP]: { is: TARGET_ID } } });
const sort   = JSON.stringify({ sort_by: PUBLISH_DATE_PROP, sort_direction: 'descending' });
const b = Graph.createEntity({ name: '📰 Latest', types: [DATA_BLOCK],
  values: [{ property: FILTER, type: 'text', value: filter }, { property: SORT, type: 'text', value: sort }] });
ops.push(...b.ops, ...Graph.createRelation({ fromEntity: b.id, toEntity: QUERY_SOURCE, type: DATA_SRC }).ops);
blockRel(HOST, b.id, nextPos());
```

**Ranking block** (reader-submitted rankings): a dedicated type `150db6de…` (NOT a Data block), a `Filter` value (same prop as query blocks), and an **Aggregation restriction** relation:
```ts
const r = Graph.createEntity({ name: '🏆 Ranking', types: ['150db6defe2344f0805afa57502e2c32'],
  values: [{ property: FILTER, type: 'text', value: filter }] }); ops.push(...r.ops);
ops.push(...Graph.createRelation({ fromEntity: r.id, toEntity: '10a7b10390f94a728087935052ffaa69', type: '1e4caa2de3314efa8ac24e8d9d3e9fe9' }).ops); // Editors-and-members
blockRel(HOST, r.id, nextPos());
```

**Switch a view later:** delete the old View relation + create the new one (a fresh block has no View rel → default Table).

### Tabs

A tab is a **Page** entity (`480e3fc2…`) linked from the host via the **Tabs** property `4d9cba1c…`; the tab's own blocks attach to the **Page**, not the host. The default Overview tab is implicit.
```ts
const page = Graph.createEntity({ name: 'News', types: ['480e3fc267f3499385fbacdf4ddeaa6b'] }); ops.push(...page.ops);
ops.push(...Graph.createRelation({ fromEntity: HOST, toEntity: page.id, type: '4d9cba1c4766469881cd3273891a018b', position: nextPos() }).ops);
// then build blocks with fromId = page.id
```

### ⚠ Block idempotency — re-publishing duplicates blocks

`TextBlock.make` / `DataBlock.make` / `createEntity` **mint a fresh id every call**, so re-running the same publish creates a SECOND copy of every block (verified: 5 text blocks → 10). There is no platform dedup. If a block publish must be re-runnable, pass **deterministic ids** (e.g. `id` derived from `HOST + a stable slug`) to `createEntity`/`createRelation` so a rerun is a no-op. (Note: `TextBlock.make` doesn't accept an id — build the text block by hand with `createEntity({ id, types:[TEXT_BLOCK], values:[{property: MARKDOWN, type:'text', value}] })` + a deterministic Blocks relation when you need idempotency.)

### Reading block order back (verification)

The rendered order follows the SDK/UI ASCII fractional-index order. **Caveat:** GraphQL `orderBy: POSITION_ASC` collates positions **case-insensitively** and can disagree with the UI (a `Zz…` position renders first but sorts last via the API). When you verify order over the API, sort client-side with `Position.compare`, don't trust `POSITION_ASC` for mixed-case positions. (Core-team item.)

## Personal vs DAO spaces

| | Personal | DAO |
|---|---|---|
| Publish | instant (`geo.personalSpaces.publishEdit`) | **proposal + YES vote** (`geo.daoSpaces.proposeEdit` → `voteProposal`) |
| Access | your wallet only | must be an editor of the DAO |

**DAO publish is a two-call flow — a FAST proposal still needs a YES vote to execute** (it does NOT auto-execute). v0.20: proposal methods are flattened onto `daoSpaces` (`voteProposal` / `executeProposal` — no `.proposals.` namespace):
```ts
// geo from the same createGeoClient({ network: GeoTestnetConfig }) setup as the script template
const wallet = await createGeoWalletClient({ signer: privateKeyToAccount(privateKey), network: GeoTestnetConfig });
const { proposalId, to, calldata } = await geo.daoSpaces.proposeEdit({
  name: 'edit name', ops, author: AUTHOR,                    // AUTHOR = your person/space id (hex, no 0x)
  daoSpaceAddress: DAO_ADDR,                                 // 0x… contract address of the space
  callerSpaceId: `0x${AUTHOR}`, daoSpaceId: `0x${SPACE}`,    // both bytes16, 0x-prefixed
  votingMode: 'FAST',                                        // no network param — the client carries it
});
await wallet.sendTransaction({ to, data: calldata });
const pid = String(proposalId).startsWith('0x') ? proposalId : `0x${proposalId}`;
const v = geo.daoSpaces.voteProposal({ authorSpaceId: `0x${AUTHOR}`, spaceId: `0x${SPACE}`, proposalId: pid, vote: 'YES' });
await wallet.sendTransaction({ to: v.to, data: v.calldata });
```
**Voting settings (if your script touches governance):** `slowPathPercentageThreshold` → `partialPercentageSupportThreshold`, `fastPathFlatThreshold` → `flatSupportThreshold`, plus three NEW required fields: `universalPercentageSupportThreshold`, `disableFastPathAccessForNewMembers`, `executionGracePeriodInDays`. Governance flows need real testing post-migration — don't assume.
After publishing, poll the indexer (`tooling/scripts/wait-for-index.sh <id>`) before verifying — reads lag the write by seconds.

### SDK gotchas (block/publish scripts)

- **`Graph.deleteEntity` is async AND requires `spaceId`** — unique among op builders (`await Graph.deleteEntity({ id, spaceId })`). Every other builder is sync and space-less. Entity deletes belong to geo-clean, not this skill.
- **`TextBlock.make` / `DataBlock.make` return `Op[]` only** — no created id. Generate the id yourself first (`import { Id } from '@geoprotocol/geo-sdk'`… or build the block via `createEntity`) when you need to reference the block (views/columns/idempotency).
- `createImage` / `Ipfs.uploadImage` are async (network I/O); the rest of `Graph.*` are sync.

## Inject mode — publish from a pasted URL

When the editor **pastes a URL instead of giving entity fields** ("publish this tweet", "add this article", a bare x.com / news / reddit / wikipedia link), don't hand-build the entity. The **injector** (news-worker) fetches and structures the link and returns a ready GRC-20 Edit; you decode it to ops and publish through the SAME gated path as everything else. The injector writes **nothing** on-chain — only your publish step does.

**Config** (in `.env`, gitignored): `INJECT_BASE_URL` + `INJECT_API_KEY`. Staging/testing: `INJECT_BASE_URL=https://news-worker-production.up.railway.app` (cron-disabled box, safe to spam). Never point at `news-worker.up.railway.app` — that's the live production cron worker. (Production auth will move to Privy; the API key is testing-only.) On a sandboxed surface (cowork/claude.ai) the `INJECT_BASE_URL` host must be added to the network allowlist.

**Flow:**
1. **Detect type** from the URL, or pass it: `tweet` (x.com), `post` (reddit), `person` (wikipedia/linkedin), else `news-story-single` (any article — the worker auto-discovers more sources). `detectInjectType()` does this.
2. **Inject + poll + decode** with the helper — the worker `space` here is EXTRACTION context (`crypto|ai|world-affairs|health`), **not** the publish target:
   ```ts
   import { injectAndDecode } from '../lib/inject.ts';
   import { publishOps } from '../src/functions.ts';
   const r = await injectAndDecode(url, { space: 'world-affairs',
     onPoll: (i, s) => process.stdout.write(`\r  poll ${i}: ${s}   `) });
   ```
   Jobs take ~60–120 s; the helper polls automatically. It throws on `failed`/timeout.
3. **Inspect `r.errors` even on success** (stage failures don't always fail the job) and show the editor `r.preview` (headline, summary, sources, topics, entities, coverUrl) — this is the review surface.
4. **Run Gate 1 (semantic-duplicate)** on `r.name` with the Duplicate candidates query above — same as any publish. (The worker also has its own on-chain dedup and rejects repeat URLs with "Curate rejected…" in `r.errors`; re-inject a repeat only with `gates: { bypassExactDedup: true }`.) Emit the Gates block and wait for **`go`**, then **`publish`** as usual.
5. **Publish** the decoded ops to the editor's space — routes personal-vs-DAO and applies the circuit-breaker automatically:
   ```ts
   const tx = await publishOps(r.ops, r.name, /* publish-space-id or omit → DEMO_SPACE_ID */);
   ```

Run on **Node, not Bun** (`node --env-file=.env scripts/<file>.ts`) — Bun's fetch hits a bug on the geo API host that `publishOps` calls. `scripts/inject-publish-example.ts` is a worked end-to-end example.

## What this skill does NOT do

- Print or store private keys.
- Auto-publish on `go` (publish needs a second explicit `publish`).
- Delete entities, merge, or bulk-remove — that is geo-clean.
- Remove values or relations without explicit `publish` after showing them.
- Skip Discovery / Gates / Plan to "save time".
- Publish from a browser-only assistant (no local runtime).

## More

- `geo-query` — discovery/reads. `geo-clean` — entity deletes, merges, clean-up. `geo-orchestrate` — multi-step intent → this skill.
- Schema spec: `knowledge-graph-ontology.md`. SDK: `@geoprotocol/geo-sdk`.
