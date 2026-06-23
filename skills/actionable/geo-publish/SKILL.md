---
name: geo-publish
description: Publish entities and relations to the Geo knowledge graph via the GRC-20 SDK. Runs mandatory safeguards (semantic-duplicate check + schema check + two-phase dry-run/confirm) before any write. Use when creating, updating, or deleting entities and relations. Triggers on "publish", "create entity", "add person", "add to geo", "add to my space", "submit proposal", "create relation", "update entity", "delete entity".
metadata:
  author: geobrowser
  version: 0.3.0
---

# Geo Knowledge Graph — Publishing

Create, update, and delete entities and relations in Geo using `@geoprotocol/geo-sdk`. Portable (works in any local-execution agent: Claude Code, Codex CLI/Desktop, Claude cowork). **Browser-only assistants cannot publish** — they have no local runtime; send them to `geo-query` for reads.

Every write passes three mandatory safeguards FIRST: **semantic-duplicate check**, **schema check**, and **two-phase dry-run → explicit confirm**. These are not optional.

## Prerequisites

1. **Runtime**: Node 20.6+ or Bun (both support `--env-file`).
2. **SDK available**: either the `content-management` repo cloned with `bun install` run (`node_modules/@geoprotocol/geo-sdk` exists), or the skill's own `node_modules`.
3. **Wallet key** in an env file at the project root — `GEO_PRIVATE_KEY=0x...` in `.env.geo-publish` (preferred), or the repo's existing `PK_SW=0x...` in `.env`. Scripts read **`GEO_PRIVATE_KEY` first, then fall back to `PK_SW`**, so repo users need no second file. Export the key from <https://www.geobrowser.io/export-wallet>.

**Never put the key in the transcript.** Do NOT `cat`/`grep` the value, do NOT `export` it in-session, do NOT ask the user to paste it. If no key file exists, ask the user to create one themselves in their editor (one line, e.g. `GEO_PRIVATE_KEY=0x...`) and reply "done". You may create a `.env.geo-publish.example` placeholder and add the filename to `.gitignore` for them. To check it's configured without reading it:
```bash
test -f .env.geo-publish && grep -q '^GEO_PRIVATE_KEY=' .env.geo-publish && echo ok || (test -f .env && grep -q '^PK_SW=' .env && echo ok)
```

## HARD RULES (failure = bug)

1. Before any `Write` to a script or any `bun run`/`node`, you MUST post the **Discovery + Gates + Plan** block (template below) and wait for the user to reply **"go"**.
2. The duplicate search is **name-only, across ALL types and ALL spaces**. Never filter by the type you're about to create — "Bitcoin" the Project is a duplicate concern of "Bitcoin" the Token.
3. "Looks straightforward" is NOT a reason to skip the template. Always post it.
4. **Two-phase execution:** `go` authorizes the dry-run only. Publishing needs a *second* explicit `publish`.
   - After `go`: write the script with `DRY_RUN = true`, run the dry-run yourself, show the op count + a sample.
   - Then ask: *"Output looks right? Type **publish** to publish to Geo, or **stop** to discard."*
   - On `publish`: flip `DRY_RUN = false`, re-run, surface the tx hash + verify URL.
   - On `stop`: leave the script on disk, change nothing on Geo.
   - Never auto-publish on `go`.
5. **Never delete without explicit consent.** A delete or unset requires the user to type `publish` after seeing exactly what will be removed (entity name, backlink count, orphan count).

## Required output template (post BEFORE writing any script)

````
## Discovery
**Schema** — Type: <name> (`<id>`); Properties: <name> (`<id>`, dataType=…), …; Relation types: <name> (`<id>`), …

**Duplicate candidates** — name-only, ALL types, ALL spaces:
| Name | ID | Type | Space |
|---|---|---|---|
| … | … | … | … |
(or "no candidates found")

**Current state** (updates only): <values + relations, or "n/a — create only">
**Off-schema delta**: <properties/relations NOT on the type schema, or "none">

## Gates
- **Gate 1 (semantic-duplicate)**: PASS | FIRE — <reason/hits>
- **Gate 2 (schema-violation)**: PASS | FIRE — <reason/off-schema list>
If either FIRES, STOP, run the gate dialog, wait for the user.

## Plan (only if gates PASS or waived)
- Target space: <id> (personal | DAO)
- Ops: createEntity=<n>, createRelation=<n>, updateEntity=<n>, deleteRelation=<n>
- Script: `scripts/<YYYY-MM-DD>-<slug>.ts` (written AFTER "go")

Reply **"go"** to authorize writing + dry-running the script.
````

## Gate dialogs

**Gate 1 — semantic-duplicate fires:**
> Found an existing entity that may already mean this: **{name}** (`{id}`), type **{type}**, space **{space}**.
> - **Use existing** → skip the create, reuse this ID downstream.
> - **Publish anyway** → confirm it's NOT a duplicate and I'll proceed.

**Gate 2 — schema-violation fires:**
> You're adding **{property}** (`{id}`) to a **{type}**, but it isn't on **{type}**'s schema.
> - **Add to schema first** → I'll generate a schema-update op.
> - **Publish anyway** → it lands but won't render in the UI.
> - **Skip the property** → drop it from this publish.

## Discovery — how to produce the four outputs

GraphQL against `https://testnet-api.geobrowser.io/graphql` (no auth). Delegate to `geo-query` if loaded.

**Schema** (type ID + property/relation IDs from a known instance):
```graphql
{ entities(first:1, filter:{ name:{ includesInsensitive:"<known instance>" } }) {
    id name types { type { id name } }
    values(first:50){ property{ id name } text }
    relations(first:50){ id type{ id name } toEntity{ id name } } } }
```
Property IDs from `values[].property.id`; relation IDs from `relations[].type.id`. **Don't guess IDs.**

**Duplicate candidates** (name-only, all types, all spaces):
```graphql
{ entities(first:20, filter:{ name:{ includesInsensitive:"<name>" } }) { id name types { type { name } } } }
```

**Current state** (updates only — by entity ID): same shape as schema query, fetch the target entity.

**Off-schema delta**: compare every planned property/relation against the discovered schema; anything missing → Gate 2.

## Generate, dry-run, publish (only after "go")

1. **Write** `scripts/<YYYY-MM-DD>-<slug>.ts` with `DRY_RUN = true` (template below).
2. **Run** it yourself: `node --env-file=.env.geo-publish scripts/<file>.ts` (or `--env-file=.env` for repo/PK_SW users; or `bun run` with `--env-file`). Prints ops, touches nothing.
3. **Surface** op count + first-op sample + path, then the publish/stop prompt.
4. On `publish`: set `DRY_RUN = false`, re-run, report tx hash + `https://www.geobrowser.io/space/<spaceId>/<entityId>`.

Self-contained script template (portable — direct SDK, no repo helpers required):

```typescript
import { Graph, personalSpace, getSmartAccountWalletClient, SystemIds, type Op } from '@geoprotocol/geo-sdk';

const DRY_RUN = true;

// Key: GEO_PRIVATE_KEY preferred, PK_SW fallback. Normalize 0x prefix.
const raw = process.env.GEO_PRIVATE_KEY ?? process.env.PK_SW;
if (!raw) throw new Error('No key. Set GEO_PRIVATE_KEY in .env.geo-publish (or PK_SW in .env).');
const privateKey = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
const SPACE = process.env.DEMO_SPACE_ID!;        // target = your personal space

const allOps: Op[] = [];
const { id: entityId, ops } = Graph.createEntity({
  name: 'Hedy Lamarr',                        // NO trailing period
  description: 'Austrian-American inventor.',  // MUST end with a period
  types: ['7ed45f2bc48b419e8e4664d5ff680b0d'], // Person
  values: [],
});
allOps.push(...ops);

console.log(`${allOps.length} ops; entity ${entityId}`);
if (DRY_RUN) { console.log('DRY_RUN — set false to publish.'); }
else {
  const wallet = await getSmartAccountWalletClient({ privateKey });
  const { to, calldata, editId } = await personalSpace.publishEdit({
    name: 'Add Hedy Lamarr', spaceId: SPACE, ops: allOps, author: SPACE, network: 'TESTNET',
  });
  const tx = await wallet.sendTransaction({ account: wallet.account, to, data: calldata });
  console.log('editId', editId, 'tx', tx);
}
```

(Repo users may instead import `publishOps`/`printOps` from `../src/functions.js` — that path uses `PK_SW`/`DEMO_SPACE_ID` and handles personal-vs-DAO automatically.)

## Entity rules

- Names **must NOT** end with a period. Descriptions **MUST** end with a period.
- Dates: `type: 'date'`, `YYYY-MM-DD`. Datetimes: `type: 'datetime'`, ISO `…Z`.
- URLs publish as `type: 'text'` even for URL-renderable properties (SDK rejects `type: 'url'`).
- **Collect ALL ops into one array, publish ONCE.** Never publish in a loop.
- Relations: set `toSpace` if the target is in a different space. Use deterministic IDs (`from.slice(0,16)+to.slice(0,16)`) for relation entities so reruns are idempotent.

## Personal vs DAO spaces

| | Personal | DAO |
|---|---|---|
| Publish | instant (`personalSpace.publishEdit`) | proposal + vote (`daoSpace.proposeEdit`) |
| Access | your wallet only | must be an editor |

## What this skill does NOT do

- Print or store private keys.
- Auto-publish on `go` (publish needs a second explicit `publish`).
- Delete/unset without explicit `publish` after showing the impact.
- Skip Discovery / Gates / Plan to "save time".
- Publish from a browser-only assistant (no local runtime).

## More

- `geo-query` — discovery/reads. `geo-orchestrate` — multi-step intent → this skill.
- Schema spec: `knowledge-graph-ontology.md`. SDK: `@geoprotocol/geo-sdk`.
