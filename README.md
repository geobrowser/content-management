# Geo skills

Skills and tooling for working with the [Geo knowledge graph](https://geobrowser.io). This repo is the single install source: clone it once and you get every skill plus the entity-management toolkit, all pointed at the current network (`api-testnet.geobrowser.io`).

**If you are an AI agent reading this: this README is your setup runbook.** Follow it top to bottom. It tells you exactly what you can do yourself and what only your human can do.

> **Any agent, any vendor.** Claude, Codex/GPT, Gemini, or anything else — the rules in this repo apply to all of them. `CLAUDE.md` happens to be the file Claude Code loads automatically; **its contents are not Claude-specific**. If you are a different agent, read [`CLAUDE.md`](CLAUDE.md) as well — it carries the skill-routing table and the hard rules (never write to Geo by hand, never improvise a delete, never touch the private key). Nothing in this repo assumes a particular model or harness.

---

## The security contract (agents: read first)

- **Never ask for, accept, or write the user's private key.** Not into `.env`, not anywhere. If the user pastes a key into the chat, tell them to treat it as compromised. Exporting the wallet again returns the same key, so it cannot be rotated: they stop publishing with it, warn co-editors to vote NO on anything unexpected, create a new Geo account, and ask co-editors to add the new identity to their spaces and remove the old one.
- You may verify the key file *exists* (command below). You may never read or print its contents.
- Read-only skills need no keys, but most scripts in this folder load `.env` when they run. Only publishing needs the key; the human fills it in by hand and keeps it there only while publishing (step 2 below).

## Quick start

### 1. Clone and install (agent can do this)

```bash
git clone https://github.com/geo-explorers/geo-skills.git
cd geo-skills
bun install
cp -n .env.example .env
```

Requirements: `git`, [`bun`](https://bun.sh). Read-only usage works with nothing else.

### 2. Set up the signing key (HUMAN ONLY — skip for read-only skills)

You, the human, in your own terminal or text editor. Not the assistant.

1. Export your key at <https://www.geobrowser.io/export-wallet>. Click **Copy key** (not the wallet-address copy button; they are different values).
2. Open `.env` and fill in the two values yourself:
   - `GEO_PRIVATE_KEY` = the key you copied (canonical name; older scripts also accept the legacy `PK_SW`)
   - `DEMO_SPACE_ID` = your personal space id, the long hex string in `geobrowser.io/space/<this part>`
3. Save. `.env` and every other `.env.*` file except `.env.example` are git-ignored and stay on your machine.

**Keep the key in `.env` only while you publish.** Lookups, press reviews, mirrors and claim grouping never need it, and those are the sessions that read untrusted text from Geo, Notion and the web. If the key isn't in `.env`, an injected instruction in one of them has nothing to steal. Paste it at the start of a publishing session; when you're done, put the placeholder from `.env.example` back (`"0x<private_key>"`).

Anyone (agent included) can verify the setup without exposing the key:

```bash
test -f .env && grep -qE '^(GEO_PRIVATE_KEY|PK_SW)=' .env && echo ok || echo "missing: fill in .env"
```

### 3. Put the skills where your assistant looks (agent can do this)

Skills live in `skills/actionable/` (they write to Geo, need the key) and `skills/non-actionable/` (read-only, no key).

| Platform | How to install |
|---|---|
| **Claude Code** | Copy or symlink the skill folders you want into `~/.claude/skills/` (or the project's `.claude/skills/`), e.g. `ln -s "$(pwd)"/skills/non-actionable/geo-query ~/.claude/skills/geo-query`. New sessions pick them up automatically. |
| **Claude Desktop / Cowork** | Click **Work in project or file** and select this cloned folder. Human step first: in **Settings → Capabilities → Code execution and file creation**, add `api-testnet.geobrowser.io` to the allowed list. |
| **Codex** | Copy each skill folder into `~/.codex/skills/<skill-name>/`. Human steps: add the network domain to `~/.codex/config.toml` (block below) and restart Codex. |

Codex `~/.codex/config.toml`:

```toml
default_permissions = "workspace"

[permissions.workspace.network]
enabled = true
mode = "limited"

[permissions.workspace.network.domains]
"api-testnet.geobrowser.io" = "allow"
```

Steps an agent can never do for you: the Claude Desktop allowlist, the Codex config + restart, and the key export. Everything else is fair game.

### 4. Try it

```
Using the geo-query skill: is there an entity for "Ethereum" on Geo? Show its types and spaces.
```

A tidy answer means you are set up. If the assistant improvises instead, name the skill explicitly.

## Skills index

| Skill | What it does | Class | Key needed |
|---|---|---|---|
| [geo-query](skills/non-actionable/geo-query) | Query the graph via GraphQL: lookups, search by type, relations, schema | read-only | no |
| [ontology-advisor](skills/non-actionable/ontology-advisor) | Modeling advice: reuse vs new types, properties, duplicates | read-only | no |
| [geo-press-review](skills/non-actionable/geo-press-review) | Compare press coverage against Geo, recommend what to publish | read-only | no |
| [geo-describe](skills/non-actionable/geo-describe) | Verified, original entity descriptions at scale (emits drafts) | read-only | no |
| [image-banner-recompose](skills/non-actionable/image-banner-recompose) | Recompose any image into a Geo banner | utility | no |
| [daily-report](skills/non-actionable/daily-report) | Internal editor routine (Notion daily update) | internal | no |
| [geo-claim-grouping-notion](skills/non-actionable/geo-claim-grouping-notion) | Claim-grouping proposals written into a Notion Claims mirror as review columns (no Geo writes) | internal | no |
| [geo-publish](skills/actionable/geo-publish) | Create/update entities and relations, safeguarded, dry-run gated | actionable | yes |
| [geo-orchestrate](skills/actionable/geo-orchestrate) | Natural-language intent to query plan + publish plan + script | actionable | yes |
| [geo-clean](skills/actionable/geo-clean) | Merge duplicates, delete orphans, move entities, fix types | actionable | yes |
| [geo-discovery](skills/actionable/geo-discovery) | Gap-discovery passes over a space (pre-pivot, kept for reference) | actionable | yes |

Which skills are vetted right now lives on the [Agents Hub space](https://www.geobrowser.io/space/ddfd01098a71083119eb130a01a6d4c5): skills tagged **confirmed** there are the ones the skills team vouches for. Each Hub skill page carries its usage guide.

Every write to Geo is a proposal that goes through space governance: skills dry-run first, show you the plan, and publish only on your explicit go.

---

## Agents

A **skill** is a capability (any agent can load and follow one). An **agent** is a configured worker that uses skills. The agents, their operating contract for the Agents flow Notion teamspace, and the tracker ids live in [geo-explorers/geo-agents](https://github.com/geo-explorers/geo-agents). That repository carries a copy of these skills pinned to one release of this library, and checks the copy against a lock file at the start of every run.

---

## Shared code reference (engineering)

The functions below live in `src/entity_ops.ts` and are what the **geo-clean** skill uses for deletes, ID changes, moves and merges. **Do not call them by hand:** every delete, merge or move goes through geo-clean, which runs the orphan check, the dry run and the human confirmation first (hard rule 3 in `CLAUDE.md`).

### 1. Delete Entity

Delete an entity and all its properties/relations from a space. Optionally performs recursive orphan cleanup for entities that become unreferenced.

```ts
const ops = await deleteEntity({
  entityId: 'ENTITY_ID',
  spaceId: 'SPACE_ID',
  // dryRun: false,          // publish (default: preview)
  // skipOrphanCleanup: true, // skip recursive orphan deletion
});
```

### 2. Change Entity ID

Move an entity to a new ID within the same space. Recreates all properties, relations, and backlinks under the new ID, then deletes the old one.

```ts
const ops = await changeEntityId({
  oldEntityId: 'OLD_ENTITY_ID',
  newEntityId: 'NEW_ENTITY_ID',
  spaceId: 'SPACE_ID',
  // dryRun: false,
});
```

### 3. Change Space

Move an entity from one space to another, keeping the same entity ID. Recreates all data in the destination space and cleans up the source.

```ts
const { createOps, deleteOps } = await changeSpace({
  entityId: 'ENTITY_ID',
  fromSpaceId: 'FROM_SPACE_ID',
  toSpaceId: 'TO_SPACE_ID',
  // dryRun: false,
});
```

### 4. Merge Entities

Merge one or more secondary entities into a main entity. Handles both same-space and cross-space merges. If the main entity is a Property type, automatically migrates property references across all accessible spaces.

**Same-space merge logic:**
- Auto-selects the main entity among same-space candidates by backlink count, then by property+relation count
- Value properties on the main entity remain unchanged
- Missing value properties from secondaries are added to the main entity
- Non-duplicate relations from secondaries are appended to the main entity
- Duplicate relation detection checks both exact entity ID matches and "soft duplicates" (same name + type on the target entity)
- Backlinks pointing to secondaries are redirected to the main entity
- Secondary entities are deleted after merging

**Cross-space merge logic:**
- Multiple secondaries in the same foreign space are merged within that space first
- Each remaining foreign secondary is moved to the main entity's ID via `changeEntityId`

**Ops batching:** All operations accept an optional `opsBatch` parameter (`Map<string, Op[]>`) to accumulate ops across multiple merges and publish once per space at the end.

```ts
const ops = await mergeEntities({
  mainEntityId: 'MAIN_ENTITY_ID',
  mainSpaceId: 'MAIN_SPACE_ID',
  secondaries: [
    { entityId: 'SECONDARY_1', spaceId: 'SPACE_A' },
    { entityId: 'SECONDARY_2', spaceId: 'SPACE_B' },
  ],
  // dryRun: false,
  // addPropertiesToMain: false, // skip copying properties/relations from secondaries
});
```

## Project Structure

```
CLAUDE.md                   # Skill routing + hard rules — applies to ANY agent, not just Claude
MAINTAINERS.md              # What belongs here, how to change a skill, how to cut a release
MD-FILES.md                 # Manifest of every .md file in this repo
skills/
  actionable/               # Skills that write to Geo (need GEO_PRIVATE_KEY)
  non-actionable/           # Read-only skills (no key)
  SKILL-VERSIONS.json       # Approved fingerprint of every skill, checked by CI
skill-dev/                  # Linter, manifest tools, local install script
lib/gql.mjs                 # Canonical zero-dependency GraphQL client
src/
  entity_ops.ts             # Core operation logic (delete, move, merge, migrate), used by geo-clean
  constants.ts              # Ontology IDs (types, properties, data types, views)
  functions.ts              # Shared helpers (GraphQL client, publishing, ops serialization)
scripts/                    # Shared scripts that skills call
validate_migration.ts       # Post-merge verification, used by geo-clean
knowledge-graph-ontology.md # Full ontology specification
```

## References

- [GRC-20 Serialization Spec](https://github.com/geobrowser/grc-20/blob/main/spec.md)
- [Knowledge Graph Ontology](knowledge-graph-ontology.md)
- [Agents Hub space](https://www.geobrowser.io/space/ddfd01098a71083119eb130a01a6d4c5) — the on-Geo skill registry (confirmed tags + usage guides)
