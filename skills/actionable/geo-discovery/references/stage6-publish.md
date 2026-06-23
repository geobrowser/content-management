# Stage 6 — DAO publish mechanics & gotchas

Stage 6 writes `Gap finding` entities to a **DAO** space. The generic `geo-publish` SKILL.md
covers the happy path but is **wrong or silent** on several points that will fail a run without
any error. Follow THIS file for Stage 6; use `geo-publish` only for the SDK primitives.

## Target (worked example — the AI space run)
- Gap findings live in the **AI datasets** DAO space `941964642f4d3e70ef48f54a3915277d` — NOT the
  AI space (`41e851610e13a19441c4d980f2f2ce6b`) where the workflow entity itself lives.
- DAO contract address: `0x076257176BD51aCcdD81b417f9509Ba3023C2F66`.
- `author` / `callerSpaceId` = the operator's **personal space** (must be an editor of the target
  DAO). Discover yours by running geo-publish's `bin/whoami.mjs`.
- The `Gap finding` / `Gap type` / `Gap status` types must already exist in the target space.
  On a brand-new space, publish that ontology first. Schema + live IDs: `references/discovery-schema.md`.

## Runtime
- Run scripts with **bun** — the operator's `node` may predate `--env-file`:
  ```bash
  NODE_PATH=<geo-publish-skill-dir>/node_modules \
    bun --env-file=.env.geo-publish run <script>.mjs
  ```
- Key file `.env.geo-publish` at the project root holding `GEO_PRIVATE_KEY=0x…` — the variable the
  shipped geo-publish CLIs (`bin/whoami.mjs`, `bin/publish-entity.mjs`) read, so any ad-hoc publish
  script you write should read the same name. Never have the operator paste the key into chat; ask
  them to create the file in their editor and reply "done".

## The propose + vote sequence (FAST does NOT auto-execute)
1. **Propose:**
   ```js
   const { proposalId, editId, cid, to, calldata } = await daoSpace.proposeEdit({
     name, ops,
     author:        MOH_PERSONAL,            // your personal space id (hex, no 0x)
     daoSpaceAddress: DAO_ADDRESS,           // 0x… contract address
     callerSpaceId: `0x${MOH_PERSONAL}`,
     daoSpaceId:    `0x${TARGET_SPACE}`,     // bytes16 hex
     votingMode: "FAST", network: "TESTNET",
   });
   ```
2. **Submit — a printed `proposalId` is NOT a submitted proposal.** You MUST send the transaction
   proposeEdit hands back, or nothing reaches the chain:
   ```js
   const tx = await wallet.sendTransaction({ to, data: calldata });
   ```
3. **Vote — FAST does not auto-execute** (the geo-publish doc claims it does; it's wrong here).
   Cast a YES vote and the entities index within seconds:
   ```js
   const vote = await daoSpace.voteProposal({
     authorSpaceId: `0x${MOH_PERSONAL}`,
     spaceId:       `0x${TARGET_SPACE}`,
     proposalId, vote: "YES",
   });
   await wallet.sendTransaction({ to: vote.to, data: vote.calldata }); // the vote is also a tx
   ```
   ⚠ This signature **differs** from the geo-publish SKILL.md, which passes `daoSpaceAddress` /
   `network` / `vote` — that form throws `ensure0xPrefix … undefined`. Use `authorSpaceId` +
   `spaceId` only (both bytes16 `0x`-hex); no `daoSpaceAddress`, no `network`.

## SDK value gotchas
- `Graph.createEntity` value `type: "url"` is **NOT supported** in this SDK build — use
  `type: "text"` for URL / Website (TEXT) properties.
- Date / TIME values: when you read them back via GraphQL they come in the `datetime` (or `date`)
  field, **NOT** `text` — reading `text` shows `null` and looks "missing" when it's actually set.
- `TextBlock.make(...)` returns `Op[]` **directly** (not `{ ops }`) — spread it straight into your
  ops array.
- Always set the `Publish date` on each Gap finding (= the discovery date).

## Verifying after publish (don't trust stale per-entity fields)
The per-entity `entity(id){ relations / backlinks }` connection returns **stale-empty** for
freshly-written entities (minutes later, even pre-existing relations vanish). Verify via the
authoritative filter-backed forms instead:
- `relations(filter:{ fromEntityId:{is}, typeId:{is} }){ id toEntityId }` (also yields edge ids for deletes)
- `entities(filter:{ relations:{ some:{ typeId, toEntityId } } })` for existence checks
- `proposals(filter:{ id:{ in:[...] } })` — the root `proposal(id:)` field returns null for real proposals.
