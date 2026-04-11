//Note: we are having issues where some stuff is getting published to the wrong spaces...
//Need to query all spaces and find all types that have properties relations pointing to blank entities
//Need to output those

//If I am deleting a relation, I also need to delete the relation entity
//Orphaned entity should have no relation pointing to it as an entity or to entity

import { gql, publishOps, printOps, getPublishableSpaceIds, getSpaceOwnerInfo } from './src/functions.js';
import { TYPES, DATA_TYPE_PROPERTY, DATA_TYPE_TO_SDK, SPACES } from './src/constants.js';
import { mergeEntities, type OpsBatch, type EntityData, type BacklinkRecord, ENTITY_INLINE_FIELDS, parseInlineEntity } from './src/entity_ops.js';
import * as fs from 'fs';
import path from 'node:path';

// ─── Configuration ──────────────────────────────────────────────────────────
// Finds duplicate Type and Property entities and merges them automatically.
// Property duplicates with data type mismatches are SKIPPED (logged as warnings).
// Run with: bun run 03_merge_duplicates.ts

const DRY_RUN = true; // Set to false to actually publish merges

const spaceRank = new Map(SPACES.map((s, i) => [s.id, i]));
const spaceName = new Map(SPACES.map(s => [s.id, s.name]));

// ─── Types ──────────────────────────────────────────────────────────────────

interface EntityHit {
  id: string;
  name: string;
  spaceId: string;
  dataType?: string | null;
}

interface DuplicateGroup {
  name: string;
  main: EntityHit;
  secondaries: EntityHit[];
  hasDataTypeMismatch: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchEntitiesOfType(typeId: string, spaceId: string): Promise<EntityHit[]> {
  const hits: EntityHit[] = [];
  let cursor: string | null = null;

  while (true) {
    const afterClause = cursor ? `after: "${cursor}"` : '';
    const data = await gql(`{
      entitiesConnection(
        spaceId: "${spaceId}"
        typeId: "${typeId}"
        first: 500
        ${afterClause}
      ) {
        edges { node { id name } }
        pageInfo { hasNextPage endCursor }
      }
    }`);

    const conn = data.entitiesConnection;
    for (const edge of conn?.edges ?? []) {
      const name = (edge.node.name ?? '').trim();
      if (!name) continue;
      hits.push({ id: edge.node.id, name, spaceId });
    }

    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return hits;
}

const knownSpaceIds = new Set(SPACES.map(s => s.id));

async function countBacklinks(entityId: string): Promise<{ total: number; external: number }> {
  const data = await gql(`{
    relations(filter: {
      toEntityId: { is: "${entityId}" }
    }) {
      id
      fromEntity {
        spaceIds
      }
    }
  }`);
  const rels = data.relations ?? [];
  let external = 0;
  for (const rel of rels) {
    const spaceIds: string[] = rel.fromEntity?.spaceIds ?? [];
    // If the entity only exists in spaces we don't control, it's external
    const allExternal = spaceIds.length > 0 && spaceIds.every((s: string) => !knownSpaceIds.has(s));
    if (allExternal) external++;
  }
  return { total: rels.length, external };
}

async function countExternalPropertyUsages(propertyId: string): Promise<{ total: number; external: number }> {
  const data = await gql(`{
    values(filter: { propertyId: { is: "${propertyId}" } }) {
      spaceId
    }
    relations(filter: { typeId: { is: "${propertyId}" } }) {
      fromEntity {
        spaceIds
      }
    }
  }`);

  const spaceHits = new Set<string>();
  const externalSpaceHits = new Set<string>();

  // Count value usages by space
  for (const v of data.values ?? []) {
    if (v.spaceId) {
      spaceHits.add(v.spaceId);
      if (!knownSpaceIds.has(v.spaceId)) externalSpaceHits.add(v.spaceId);
    }
  }

  // Count relation usages by the fromEntity's spaces
  for (const rel of data.relations ?? []) {
    for (const sid of rel.fromEntity?.spaceIds ?? []) {
      spaceHits.add(sid);
      if (!knownSpaceIds.has(sid)) externalSpaceHits.add(sid);
    }
  }

  const totalUsages = (data.values ?? []).length + (data.relations ?? []).length;
  let externalUsages = 0;
  for (const v of data.values ?? []) {
    if (v.spaceId && !knownSpaceIds.has(v.spaceId)) externalUsages++;
  }
  for (const rel of data.relations ?? []) {
    const sids: string[] = rel.fromEntity?.spaceIds ?? [];
    if (sids.length > 0 && sids.every((s: string) => !knownSpaceIds.has(s))) externalUsages++;
  }

  return { total: totalUsages, external: externalUsages };
}

async function findDuplicates(label: string, typeId: string): Promise<DuplicateGroup[]> {
  console.log(`\nSearching for duplicate ${label} entities across ${SPACES.length} spaces...\n`);

  const allHits: EntityHit[] = [];
  const spaceResults = await Promise.all(
    SPACES.map(async space => {
      const hits = await fetchEntitiesOfType(typeId, space.id);
      return { space, hits };
    })
  );
  for (const { space, hits } of spaceResults) {
    console.log(`  ${space.name}: ${hits.length} ${label} entities`);
    allHits.push(...hits);
  }

  console.log(`  Total: ${allHits.length}`);

  // Group by lowercase name
  const byName = new Map<string, EntityHit[]>();
  for (const hit of allHits) {
    const key = hit.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(hit);
    byName.set(key, list);
  }

  // Deduplicate: same entity ID across multiple spaces
  for (const [key, hits] of byName) {
    const uniqueById = new Map<string, EntityHit>();
    for (const hit of hits) {
      const existing = uniqueById.get(hit.id);
      if (!existing || (spaceRank.get(hit.spaceId) ?? 999) < (spaceRank.get(existing.spaceId) ?? 999)) {
        uniqueById.set(hit.id, hit);
      }
    }
    byName.set(key, [...uniqueById.values()]);
  }

  // Filter to groups with 2+ distinct entity IDs
  const duplicateEntries = [...byName.entries()]
    .filter(([, hits]) => hits.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));

  // Collect all duplicate entity IDs for bulk querying
  const allDuplicateIds = duplicateEntries.flatMap(([, hits]) => hits.map(h => h.id));
  const uniqueDuplicateIds = [...new Set(allDuplicateIds)];

  console.log(`  ${duplicateEntries.length} duplicate groups, ${uniqueDuplicateIds.length} unique entities to analyze`);

  // ── Bulk fetch: backlinks and property data types in as few queries as possible ──

  // Bulk fetch all backlinks pointing to any duplicate entity (paginated)
  const backlinkCounts = new Map<string, { total: number; external: number }>();
  // Initialize all to zero
  for (const id of uniqueDuplicateIds) backlinkCounts.set(id, { total: 0, external: 0 });

  const BULK_PAGE = 500;
  for (let i = 0; i < uniqueDuplicateIds.length; i += BULK_PAGE) {
    const idBatch = uniqueDuplicateIds.slice(i, i + BULK_PAGE);
    const filterIds = idBatch.map(id => `"${id}"`).join(', ');

    if (typeId === TYPES.property) {
      // For properties: count values and relations using this property ID
      let valCursor: string | null = null;
      let relCursor: string | null = null;
      let valDone = false;
      let relDone = false;

      while (!valDone || !relDone) {
        const parts: string[] = [];
        if (!valDone) {
          const afterClause = valCursor ? `after: "${valCursor}"` : '';
          parts.push(`valConn: valuesConnection(filter: { propertyId: { in: [${filterIds}] } }, first: ${BULK_PAGE}, ${afterClause}) {
            edges { node { propertyId spaceId } }
            pageInfo { hasNextPage endCursor }
          }`);
        }
        if (!relDone) {
          const afterClause = relCursor ? `after: "${relCursor}"` : '';
          parts.push(`relConn: relationsConnection(filter: { typeId: { in: [${filterIds}] } }, first: ${BULK_PAGE}, ${afterClause}) {
            edges { node { typeId fromEntity { spaceIds } } }
            pageInfo { hasNextPage endCursor }
          }`);
        }
        const data = await gql(`{ ${parts.join('\n')} }`);

        if (!valDone) {
          const conn = data.valConn;
          for (const edge of conn?.edges ?? []) {
            const v = edge.node;
            const counts = backlinkCounts.get(v.propertyId)!;
            counts.total++;
            if (v.spaceId && !knownSpaceIds.has(v.spaceId)) counts.external++;
          }
          if (!conn?.pageInfo?.hasNextPage) valDone = true;
          else valCursor = conn.pageInfo.endCursor;
        }
        if (!relDone) {
          const conn = data.relConn;
          for (const edge of conn?.edges ?? []) {
            const rel = edge.node;
            const counts = backlinkCounts.get(rel.typeId)!;
            counts.total++;
            const sids: string[] = rel.fromEntity?.spaceIds ?? [];
            if (sids.length > 0 && sids.every((s: string) => !knownSpaceIds.has(s))) counts.external++;
          }
          if (!conn?.pageInfo?.hasNextPage) relDone = true;
          else relCursor = conn.pageInfo.endCursor;
        }
      }
    } else {
      // For non-property types: count backlinks (relations pointing TO each entity)
      let cursor: string | null = null;
      while (true) {
        const afterClause = cursor ? `after: "${cursor}"` : '';
        const data = await gql(`{
          relationsConnection(filter: { toEntityId: { in: [${filterIds}] } }, first: ${BULK_PAGE}, ${afterClause}) {
            edges { node { toEntityId fromEntity { spaceIds } } }
            pageInfo { hasNextPage endCursor }
          }
        }`);

        const conn = data.relationsConnection;
        for (const edge of conn?.edges ?? []) {
          const rel = edge.node;
          const counts = backlinkCounts.get(rel.toEntityId);
          if (!counts) continue;
          counts.total++;
          const sids: string[] = rel.fromEntity?.spaceIds ?? [];
          if (sids.length > 0 && sids.every((s: string) => !knownSpaceIds.has(s))) counts.external++;
        }

        if (!conn?.pageInfo?.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
      }
    }
  }

  console.log(`  Bulk backlink/usage fetch complete.`);

  // Bulk fetch data types for property entities
  const dataTypeMap = new Map<string, string | null>();
  if (typeId === TYPES.property) {
    for (let i = 0; i < uniqueDuplicateIds.length; i += BULK_PAGE) {
      const idBatch = uniqueDuplicateIds.slice(i, i + BULK_PAGE);
      const filterIds = idBatch.map(id => `"${id}"`).join(', ');
      const data = await gql(`{
        relations(filter: {
          fromEntityId: { in: [${filterIds}] }
          typeId: { is: "${DATA_TYPE_PROPERTY}" }
        }) {
          fromEntityId
          toEntityId
          toEntity { name }
        }
      }`);
      for (const rel of data.relations ?? []) {
        const mapped = DATA_TYPE_TO_SDK[rel.toEntityId];
        if (mapped) {
          dataTypeMap.set(rel.fromEntityId, mapped);
        } else {
          const name = rel.toEntity?.name;
          dataTypeMap.set(rel.fromEntityId, name ? name.toLowerCase() : null);
        }
      }
    }
    // Entities with no Data Type relation are relation-only
    for (const id of uniqueDuplicateIds) {
      if (!dataTypeMap.has(id)) dataTypeMap.set(id, null);
    }
    console.log(`  Bulk data type fetch complete.`);
  }

  // ── Build groups using the pre-fetched data (no more per-entity queries) ──

  const groups: DuplicateGroup[] = [];

  for (const [, hits] of duplicateEntries) {
    // Attach data types from bulk lookup
    if (typeId === TYPES.property) {
      for (const h of hits) h.dataType = dataTypeMap.get(h.id) ?? null;
    }

    // Determine main entity using pre-fetched counts
    const counts = hits.map(h => ({
      hit: h,
      ...(backlinkCounts.get(h.id) ?? { total: 0, external: 0 }),
    }));
    counts.sort((a, b) =>
      b.external - a.external
      || (spaceRank.get(a.hit.spaceId) ?? 999) - (spaceRank.get(b.hit.spaceId) ?? 999)
      || b.total - a.total
    );

    const mainEntity = counts[0].hit;
    const usageLabel = typeId === TYPES.property ? 'ext usages' : 'ext backlinks';
    console.log(`  Main selection: ${counts.map(c => `${c.hit.id}=${c.external} ${usageLabel}/${c.total} total (${spaceName.get(c.hit.spaceId)})`).join(', ')}`);

    const secondaries = hits.filter(h => h !== mainEntity);

    let hasDataTypeMismatch = false;
    if (typeId === TYPES.property) {
      const dataTypes = new Set(hits.map(h => h.dataType ?? 'relation'));
      hasDataTypeMismatch = dataTypes.size > 1;
    }

    groups.push({ name: hits[0].name, main: mainEntity, secondaries, hasDataTypeMismatch });
  }

  return groups;
}

// ─── Fix Package Export ─────────────────────────────────────────────────────

function exportMergeFixPackage(
  spaceId: string,
  name: string,
  ops: import('@geoprotocol/geo-sdk').Op[],
  merges: Array<{ name: string; label: string; main: EntityHit; secondaries: EntityHit[] }>,
) {
  const dirName = name.replace(/\s+/g, '_');
  const dir = path.join('output', 'fix_entities', dirName);
  fs.mkdirSync(dir, { recursive: true });

  // 1. Write ops JSON
  printOps(ops, dir, 'ops.json');

  // 2. Write report
  const report: string[] = [
    `Fix Package: ${name}`,
    `Space ID: ${spaceId}`,
    `Generated: ${new Date().toISOString()}`,
    `Total ops: ${ops.length}`,
    '',
    '═'.repeat(70),
    'What this fixes:',
    '═'.repeat(70),
    '',
  ];
  for (const m of merges) {
    report.push(`  Merge "${m.name}" [${m.label}]`);
    report.push(`    Main:      entityId=${m.main.id}  space=${spaceName.get(m.main.spaceId) ?? m.main.spaceId}`);
    for (const sec of m.secondaries) {
      report.push(`    Secondary: entityId=${sec.id}  space=${spaceName.get(sec.spaceId) ?? sec.spaceId}`);
    }
    report.push('');
  }
  fs.writeFileSync(path.join(dir, 'report.txt'), report.join('\n'));

  // 3. Write README
  const readme = `# Fix Package: ${name}

This folder contains a set of pre-generated operations to merge duplicate
entities in the **${name}** space (\`${spaceId}\`).

## Contents

| File | Description |
|------|-------------|
| \`README.md\` | This file |
| \`report.txt\` | Detailed list of every merge being performed |
| \`ops.json\` | The raw operations to publish (${ops.length} ops) |
| \`publish.ts\` | A self-contained script that publishes the ops on-chain |

## Prerequisites

- [Bun](https://bun.sh) installed
- You must be an **editor** of the ${name} space
- A smart wallet private key (\`PK_SW\`) with access to that space

## How to run

1. Clone or copy the \`content_management\` project (this folder relies on its
   \`node_modules\` for the Geo SDK).

2. Install dependencies from the project root if you haven't already:
   \`\`\`
   bun install
   \`\`\`

3. Create a \`.env\` file in the project root (or add to an existing one) with
   your smart wallet private key:
   \`\`\`
   PK_SW=0xYOUR_PRIVATE_KEY_HERE
   \`\`\`

4. Run the publish script:
   \`\`\`
   bun run output/fix_entities/${dirName}/publish.ts
   \`\`\`

5. The script will:
   - Load the ops from \`ops.json\`
   - Detect your space membership and editor status
   - Submit a proposal to the DAO (or publish directly for personal spaces)
   - If you are an editor, it will also auto-vote YES to approve the proposal

## What gets fixed

See \`report.txt\` for the full list. In summary: **${merges.length}** merge(s)
across **${ops.length}** operations.

## Questions?

If something goes wrong, check that:
- Your \`PK_SW\` is correct and the associated wallet is an editor of this space
- You have run \`bun install\` from the project root
- The Geo testnet API is reachable (\`https://testnet-api.geobrowser.io/graphql\`)
`;
  fs.writeFileSync(path.join(dir, 'README.md'), readme);

  // 4. Write standalone publish script
  const script = `#!/usr/bin/env bun
/**
 * Fix Package Publisher — ${name}
 * Space ID: ${spaceId}
 *
 * This script publishes pre-generated merge ops to the "${name}" space.
 * You must be an editor of this space to run it.
 */
import { daoSpace, getSmartAccountWalletClient, personalSpace, type Op } from '@geoprotocol/geo-sdk';
import dotenv from 'dotenv';
import * as fs from 'fs';
import path from 'node:path';

dotenv.config();

const TESTNET_RPC_URL = 'https://rpc-geo-test-zc16z3tcvf.t.conduit.xyz';
const SPACE_ID = '${spaceId}';
const SPACE_NAME = '${name}';

async function gql(query: string, variables?: Record<string, any>) {
  const res = await fetch('https://testnet-api.geobrowser.io/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(\`API error: \${res.status} \${res.statusText}\\n\${body}\`);
  }
  const json = await res.json();
  if (json.errors) {
    console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    throw new Error(\`GraphQL: \${json.errors[0].message}\`);
  }
  return json.data;
}

async function main() {
  const privateKey = process.env.PK_SW as \`0x\${string}\`;
  if (!privateKey) throw new Error('PK_SW not set in .env');

  // Load ops and restore UUID hex strings to Uint8Array(16)
  const opsPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'ops.json');
  const raw = JSON.parse(fs.readFileSync(opsPath, 'utf-8'));
  const hexToBytes = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  };
  const restoreUuids = (obj: any): any => {
    if (typeof obj === 'string' && /^[0-9a-f]{32}$/i.test(obj)) return hexToBytes(obj);
    if (Array.isArray(obj)) return obj.map(restoreUuids);
    if (obj && typeof obj === 'object') {
      const out: any = {};
      for (const [k, v] of Object.entries(obj)) out[k] = restoreUuids(v);
      return out;
    }
    return obj;
  };
  const ops: Op[] = restoreUuids(raw);
  console.log(\`Loaded \${ops.length} ops for space "\${SPACE_NAME}" (\${SPACE_ID})\`);

  const client = await getSmartAccountWalletClient({ privateKey, rpcUrl: TESTNET_RPC_URL });
  const author = client.account.address;

  const personalSpaceData = await gql(\`{ spaces(filter: { address: { is: "\${author}" } }) { id type } }\`);
  const callerSpace = personalSpaceData.spaces?.find((s: any) => s.type === 'PERSONAL');
  if (!callerSpace) throw new Error(\`No personal space found for wallet \${author}.\`);
  const callerSpaceId: string = callerSpace.id;

  const spaceData = await gql(\`{
    space(id: "\${SPACE_ID}") { type address editorsList { memberSpaceId } }
  }\`);
  if (!spaceData.space) throw new Error(\`Space \${SPACE_ID} not found\`);

  const { type: spaceType, address: daoAddress } = spaceData.space;
  console.log(\`Space type: \${spaceType}\`);

  let to: \`0x\${string}\`;
  let calldata: \`0x\${string}\`;

  if (spaceType === 'PERSONAL') {
    if (SPACE_ID !== callerSpaceId) throw new Error('This is not your personal space.');
    const result = await personalSpace.publishEdit({
      name: 'Batch merge duplicates',
      spaceId: SPACE_ID,
      ops,
      author: SPACE_ID,
      network: 'TESTNET',
    });
    console.log('CID:', result.cid);
    console.log('Edit ID:', result.editId);
    to = result.to;
    calldata = result.calldata;
  } else {
    const editors: Array<{ memberSpaceId: string }> = spaceData.space.editorsList ?? [];
    const isEditor = editors.some((e: any) => e.memberSpaceId === callerSpaceId);
    console.log(\`Caller space: \${callerSpaceId}, is editor: \${isEditor}\`);

    const result = await daoSpace.proposeEdit({
      name: 'Batch merge duplicates',
      ops,
      author: callerSpaceId,
      network: 'TESTNET',
      callerSpaceId: \`0x\${callerSpaceId}\` as \`0x\${string}\`,
      daoSpaceId: \`0x\${SPACE_ID}\` as \`0x\${string}\`,
      daoSpaceAddress: daoAddress as \`0x\${string}\`,
    });
    console.log('Proposal ID:', result.proposalId);
    console.log('CID:', result.cid);
    console.log('Edit ID:', result.editId);
    to = result.to;
    calldata = result.calldata;

    const txHash = await client.sendTransaction({ to, data: calldata });
    console.log('Proposal TX:', txHash);

    if (isEditor) {
      const voteResult = daoSpace.voteProposal({
        authorSpaceId: callerSpaceId,
        spaceId: SPACE_ID,
        proposalId: result.proposalId,
        vote: 'YES',
      });
      const voteTx = await client.sendTransaction({ to: voteResult.to, data: voteResult.calldata });
      console.log('Vote TX:', voteTx);
    }

    console.log('\\nDone!');
    return;
  }

  const txHash = await client.sendTransaction({ to, data: calldata });
  console.log('TX:', txHash);
  console.log('\\nDone!');
}

main().catch(console.error);
`;
  fs.writeFileSync(path.join(dir, 'publish.ts'), script);
}

// ─── Assignment Summary ─────────────────────────────────────────────────────

function generateAssignmentSummary(
  outputDir: string,
  spaceInfos: import('./src/functions.js').SpaceOwnerInfo[],
  opsCountBySpace: Map<string, number>,
) {
  const byPerson = new Map<string, Array<{ spaceId: string; spaceName: string; opsCount: number; folderName: string }>>();

  for (const info of spaceInfos) {
    const opsCount = opsCountBySpace.get(info.spaceId) ?? 0;
    const folderName = (spaceName.get(info.spaceId) ?? info.spaceId).replace(/\s+/g, '_');

    if (info.spaceType === 'PERSONAL') {
      const personName = info.spaceName;
      const list = byPerson.get(personName) ?? [];
      list.push({ spaceId: info.spaceId, spaceName: info.spaceName, opsCount, folderName });
      byPerson.set(personName, list);
    } else {
      for (const editor of info.editors) {
        const list = byPerson.get(editor.name) ?? [];
        list.push({ spaceId: info.spaceId, spaceName: info.spaceName, opsCount, folderName });
        byPerson.set(editor.name, list);
      }
      if (info.editors.length === 0) {
        const list = byPerson.get('(no editors found)') ?? [];
        list.push({ spaceId: info.spaceId, spaceName: info.spaceName, opsCount, folderName });
        byPerson.set('(no editors found)', list);
      }
    }
  }

  const sortedPeople = [...byPerson.entries()].sort(([a], [b]) => a.localeCompare(b));

  let assignmentsSection = '';
  for (const [personName, spaces] of sortedPeople) {
    assignmentsSection += `### ${personName}\n\n`;
    for (const s of spaces) {
      assignmentsSection += `- **${s.spaceName}** — ${s.opsCount} operations to apply\n`;
      assignmentsSection += `  - Space ID: \`${s.spaceId}\`\n`;
      assignmentsSection += `  - Run this command in your terminal:\n`;
      assignmentsSection += `    \`\`\`\n`;
      assignmentsSection += `    bun run output/${outputDir}/${s.folderName}/publish.ts\n`;
      assignmentsSection += `    \`\`\`\n`;
    }
    assignmentsSection += '\n';
  }

  const md = `# Fix Assignments

> Generated: ${new Date().toISOString()}

Some spaces in the Geo knowledge graph have duplicate entities that need to be merged. Because we don't have editor access to every space, we've generated ready-to-run fix packages. Each person listed below has one or more spaces that need attention.

---

## Quick Start (for everyone)

If you've never used a terminal or code editor before, follow these steps carefully. If you get stuck, ask for help in the team chat.

### 1. Install the tools

You need two things installed on your computer:

- **Bun** (a JavaScript runtime) — install it by opening your terminal and pasting this command:
  \`\`\`
  curl -fsSL https://bun.sh/install | bash
  \`\`\`
  Then close and reopen your terminal so the \`bun\` command is available.

- **A code editor** (optional but helpful) — [VS Code](https://code.visualstudio.com/) is free and works on Mac, Windows, and Linux. You can also just use your terminal directly.

### 2. Get the project

Clone the repository (or ask someone to share the project folder with you):
\`\`\`
git clone <REPO_URL>
cd content_management
\`\`\`

If you received the project as a zip file, unzip it and open a terminal in the \`content_management\` folder.

### 3. Install dependencies

Run this once from the \`content_management\` folder:
\`\`\`
bun install
\`\`\`

### 4. Set up your private key

Create a file called \`.env\` in the \`content_management\` folder (or edit it if it already exists) and add your smart wallet private key:
\`\`\`
PK_SW=0xYOUR_PRIVATE_KEY_HERE
\`\`\`

> **Where do I find my private key?** Go to [geobrowser.io/export-wallet](https://www.geobrowser.io/export-wallet) (make sure you are logged in). Click **Export wallet**, then click **Copy key**. Paste it after \`PK_SW=\`. Keep this key secret — don't share it with anyone.

### 5. Run your fix script

Find your name in the list below, then run the command shown for each of your spaces. For example:
\`\`\`
bun run output/${outputDir}/<your_folder>/publish.ts
\`\`\`

The script will submit a proposal (or publish directly if you are an editor). You should see a "Done!" message when it finishes.

---

## Assignments

${assignmentsSection}---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| \`bun: command not found\` | Close and reopen your terminal after installing Bun, or run \`source ~/.bashrc\` |
| \`PK_SW not set in .env\` | Make sure you created the \`.env\` file in the \`content_management\` folder (not a subfolder) |
| \`No personal space found\` | Your private key may be wrong — double-check it in Geo browser Settings |
| \`You are not a member or editor\` | You need editor access to the space — ask the space owner to add you |
| \`API error: 400\` | The Geo testnet API may be temporarily down — wait a few minutes and try again |
`;

  const outDir = path.join('output', outputDir);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ASSIGNMENTS.md'), md);
  console.log(`  Assignment summary written to output/${outputDir}/ASSIGNMENTS.md`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '*** DRY RUN — no changes will be published ***\n' : '*** LIVE RUN — merges will be published ***\n');

  const categories = [
    //{ label: 'Type', typeId: TYPES.type },
    //{ label: 'Property', typeId: TYPES.property },
    //{ label: 'Role', typeId: TYPES.role },
    //{ label: 'Skill', typeId: TYPES.skill },
    { label: 'Topic', typeId: TYPES.topic },
    //{ label: 'Claim', typeId: TYPES.claim },
    //{ label: 'Person', typeId: TYPES.person },
    //{ label: 'Podcast', typeId: TYPES.podcast },
    //{ label: 'Episode', typeId: TYPES.episode },
    //{ label: 'Exercise', typeId: TYPES.exercise },
    //{ label: 'Muscle group', typeId: TYPES.muscle_group },
    //{ label: 'Training category', typeId: TYPES.training_category },
    //{ label: 'Excercise equipment', typeId: TYPES.excercise_equipment },
  ];

  let mergedCount = 0;
  let skippedCount = 0;
  const opsBatch: OpsBatch = new Map();

  // Report tracking
  const reportMerged: Array<{ name: string; label: string; main: EntityHit; secondaries: EntityHit[] }> = [];
  const reportSkipped: Array<{ name: string; label: string; main: { hit: EntityHit; usages: number }; secondaries: Array<{ hit: EntityHit; usages: number }>; reason: string }> = [];
  const reportErrors: Array<{ name: string; label: string; main: EntityHit; secondaries: EntityHit[]; error: string }> = [];

  for (const { label, typeId } of categories) {
    const groups = await findDuplicates(label, typeId);

    if (groups.length === 0) {
      console.log(`  No duplicate ${label} names found.\n`);
      continue;
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`${label} — ${groups.length} duplicate name(s)`);
    console.log(`${'='.repeat(80)}\n`);

    // ── Bulk prefetch all entity data for merge candidates ──
    const allEntityIds = new Set<string>();
    for (const group of groups) {
      allEntityIds.add(group.main.id);
      for (const sec of group.secondaries) allEntityIds.add(sec.id);
    }

    const entityDataCache = new Map<string, EntityData>();
    const backlinksCache = new Map<string, BacklinkRecord[]>();
    const BULK = 500;
    const entityIdList = [...allEntityIds];

    console.log(`Bulk-prefetching ${entityIdList.length} entities for ${groups.length} merge groups...`);
    for (let i = 0; i < entityIdList.length; i += BULK) {
      const batch = entityIdList.slice(i, i + BULK);
      const filterIds = batch.map(id => `"${id}"`).join(', ');
      const data = await gql(`{
        entities(filter: { id: { in: [${filterIds}] } }) {
          ${ENTITY_INLINE_FIELDS}
        }
      }`);

      for (const e of (data.entities ?? [])) {
        const { relations, backlinks, values } = parseInlineEntity(e);
        entityDataCache.set(e.id, { values, relations });
        backlinksCache.set(e.id, backlinks);
      }
    }

    // Also prefetch relation targets (entities referenced by the candidates)
    const relationTargetIds = new Set<string>();
    for (const [, ed] of entityDataCache) {
      for (const r of ed.relations) {
        if (!entityDataCache.has(r.toEntityId)) relationTargetIds.add(r.toEntityId);
      }
    }

    if (relationTargetIds.size > 0) {
      const targetIdList = [...relationTargetIds];
      console.log(`Bulk-prefetching ${targetIdList.length} relation targets...`);
      for (let i = 0; i < targetIdList.length; i += BULK) {
        const batch = targetIdList.slice(i, i + BULK);
        const filterIds = batch.map(id => `"${id}"`).join(', ');
        const data = await gql(`{
          entities(filter: { id: { in: [${filterIds}] } }) {
            ${ENTITY_INLINE_FIELDS}
          }
        }`);

        for (const e of (data.entities ?? [])) {
          const { relations, backlinks, values } = parseInlineEntity(e);
          if (!entityDataCache.has(e.id)) entityDataCache.set(e.id, { values, relations });
          if (!backlinksCache.has(e.id)) backlinksCache.set(e.id, backlinks);
        }
      }
    }

    console.log(`Prefetch complete: ${entityDataCache.size} entities, ${backlinksCache.size} backlink entries\n`);

    for (const group of groups) {
      const dtLabel = (h: EntityHit) =>
        typeId === TYPES.property ? `  dataType=${h.dataType ?? 'relation'}` : '';

      // Skip property duplicates with data type mismatch — but only if
      // at least one secondary actually has usages (values/relations).
      // If no secondary has usages, the mismatch doesn't matter.
      if (group.hasDataTypeMismatch) {
        const secondaryUsages = await Promise.all(
          group.secondaries.map(async sec => ({
            sec,
            usages: (await countExternalPropertyUsages(sec.id)).total + (await countBacklinks(sec.id)).total,
          }))
        );
        const mainUsages = (await countExternalPropertyUsages(group.main.id)).total + (await countBacklinks(group.main.id)).total;
        const anySecondaryHasUsages = secondaryUsages.some(s => s.usages > 0);

        if (anySecondaryHasUsages && mainUsages > 0) {
          // Both sides have usages — can't safely merge
          console.log(`SKIPPED "${group.name}" — DATA TYPE MISMATCH`);
          console.log(`  Main:       entityId=${group.main.id}  spaceId=${group.main.spaceId} (${spaceName.get(group.main.spaceId)})${dtLabel(group.main)}  usages=${mainUsages}`);
          for (const su of secondaryUsages) {
            console.log(`  Secondary:  entityId=${su.sec.id}  spaceId=${su.sec.spaceId} (${spaceName.get(su.sec.spaceId)})${dtLabel(su.sec)}  usages=${su.usages}`);
          }
          console.log();
          reportSkipped.push({
            name: group.name,
            label,
            main: { hit: group.main, usages: mainUsages },
            secondaries: secondaryUsages.map(su => ({ hit: su.sec, usages: su.usages })),
            reason: 'Data type mismatch',
          });
          skippedCount++;
          continue;
        }

        if (anySecondaryHasUsages && mainUsages === 0) {
          // Main has no usages — swap to the most-used secondary
          secondaryUsages.sort((a, b) => b.usages - a.usages);
          const newMain = secondaryUsages[0].sec;
          const newSecondaries = [group.main, ...secondaryUsages.slice(1).map(su => su.sec)];
          console.log(`  Data type mismatch but main has 0 usages — swapping main to ${newMain.id} (${spaceName.get(newMain.spaceId)}) with ${secondaryUsages[0].usages} usages`);
          group.main = newMain;
          group.secondaries = newSecondaries;
        } else {
          console.log(`  Data type mismatch but no secondary has usages — proceeding with merge.`);
        }
      }

      console.log(`MERGING "${group.name}"`);
      console.log(`  Main:       entityId=${group.main.id}  spaceId=${group.main.spaceId} (${spaceName.get(group.main.spaceId)})${dtLabel(group.main)}`);
      for (const sec of group.secondaries) {
        console.log(`  Secondary:  entityId=${sec.id}  spaceId=${sec.spaceId} (${spaceName.get(sec.spaceId)})${dtLabel(sec)}`);
      }

      try {
        // Always pass dryRun: false so ops accumulate into opsBatch.
        // Actual publish vs dry-run is controlled at the script level below.
        await mergeEntities({
          mainEntityId: group.main.id,
          mainSpaceId: group.main.spaceId,
          secondaries: group.secondaries.map(s => ({ entityId: s.id, spaceId: s.spaceId })),
          dryRun: false,
          opsBatch,
          entityDataCache,
          backlinksCache,
          ...(group.hasDataTypeMismatch ? { addPropertiesToMain: false } : {}),
        });
        reportMerged.push({ name: group.name, label, main: group.main, secondaries: group.secondaries });
        mergedCount++;
        console.log(`  Done.\n`);
      } catch (err: any) {
        console.error(`  ERROR merging "${group.name}": ${err.message}\n`);
        reportErrors.push({ name: group.name, label, main: group.main, secondaries: group.secondaries, error: err.message });
        skippedCount++;
      }
    }
  }

  // Publish or export fix packages per space
  const exportedSpaceIds: string[] = [];
  const exportedSpaceOps = new Map<string, number>();
  {
    const spaceIdsWithOps = [...opsBatch.keys()].filter(id => (opsBatch.get(id)?.length ?? 0) > 0);
    const publishable = await getPublishableSpaceIds(spaceIdsWithOps);

    let totalOps = 0;
    for (const [spaceId, ops] of opsBatch) {
      if (ops.length === 0) continue;
      totalOps += ops.length;
      const name = spaceName.get(spaceId) ?? spaceId;

      // Always export fix packages for spaces we can't publish to
      if (!publishable.has(spaceId)) {
        console.log(`\n${name}: ${ops.length} ops — NO EDITOR ACCESS, exporting fix package...`);
        exportedSpaceIds.push(spaceId);
        exportedSpaceOps.set(spaceId, ops.length);
        exportMergeFixPackage(spaceId, name, ops, reportMerged.filter(m =>
          m.main.spaceId === spaceId || m.secondaries.some(s => s.spaceId === spaceId)
        ));
        console.log(`  Exported to output/fix_entities/${name.replace(/\s+/g, '_')}/`);
      } else if (DRY_RUN) {
        console.log(`\n${name}: ${ops.length} ops (dry run)`);
      } else {
        console.log(`\nPublishing ${ops.length} ops to space ${name}...`);
        await publishOps(ops, `Batch merge duplicates`, spaceId);
      }
    }
    console.log(`\n${DRY_RUN ? 'Generated' : 'Published'} ${totalOps} total ops across ${opsBatch.size} space(s).`);

    // Generate assignment summary for exported fix packages
    if (exportedSpaceIds.length > 0) {
      console.log(`\nGenerating fix assignment summary...`);
      const spaceInfos = await getSpaceOwnerInfo(exportedSpaceIds);
      generateAssignmentSummary('fix_entities', spaceInfos, exportedSpaceOps);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Write ops dump (grouped by space)
  // ═══════════════════════════════════════════════════════════════════════════
  const opsLines: string[] = [];
  let totalOpsCount = 0;
  for (const [spaceId, ops] of opsBatch) {
    if (ops.length === 0) continue;
    totalOpsCount += ops.length;
    opsLines.push(`${'='.repeat(80)}`);
    opsLines.push(`Space: ${spaceName.get(spaceId) ?? 'unknown'} (${spaceId})`);
    opsLines.push(`Ops count: ${ops.length}`);
    opsLines.push(`${'='.repeat(80)}`);
    opsLines.push(JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2));
    opsLines.push('');
  }
  if (totalOpsCount > 0) {
    opsLines.unshift(`Total ops: ${totalOpsCount} across ${opsBatch.size} space(s)\n`);
    fs.writeFileSync('merge_duplicates_ops.txt', opsLines.join('\n'));
    console.log(`\nOps written to merge_duplicates_ops.txt (${totalOpsCount} ops across ${opsBatch.size} space(s))`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Write report
  // ═══════════════════════════════════════════════════════════════════════════
  const lines: string[] = [];
  const entityLine = (h: EntityHit) =>
    `    entityId=${h.id}  spaceId=${h.spaceId} (${spaceName.get(h.spaceId)})${h.dataType ? `  dataType=${h.dataType}` : ''}`;

  lines.push('SUCCESSFULLY MERGED');
  lines.push('='.repeat(80));
  if (reportMerged.length === 0) {
    lines.push('  (none)');
  } else {
    for (const m of reportMerged) {
      lines.push(`  "${m.name}" [${m.label}]`);
      lines.push(`    Main:      ${entityLine(m.main).trim()}`);
      for (const sec of m.secondaries) {
        lines.push(`    Secondary: ${entityLine(sec).trim()}`);
      }
    }
  }

  lines.push('');
  lines.push('SKIPPED (data type mismatch)');
  lines.push('='.repeat(80));
  if (reportSkipped.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of reportSkipped) {
      lines.push(`  "${s.name}" [${s.label}]  — ${s.reason}`);
      lines.push(`    Main:      ${entityLine(s.main.hit).trim()}  usages=${s.main.usages}`);
      for (const sec of s.secondaries) {
        lines.push(`    Secondary: ${entityLine(sec.hit).trim()}  usages=${sec.usages}`);
      }
    }
  }

  lines.push('');
  lines.push('ERRORS');
  lines.push('='.repeat(80));
  if (reportErrors.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of reportErrors) {
      lines.push(`  "${e.name}" [${e.label}]  — ${e.error}`);
      lines.push(`    Main:      ${entityLine(e.main).trim()}`);
      for (const sec of e.secondaries) {
        lines.push(`    Secondary: ${entityLine(sec).trim()}`);
      }
    }
  }

  lines.push('');
  lines.push('SUMMARY');
  lines.push('='.repeat(80));
  lines.push(`  Merged:  ${reportMerged.length}`);
  lines.push(`  Skipped: ${reportSkipped.length}`);
  lines.push(`  Errors:  ${reportErrors.length}`);
  lines.push(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const reportText = lines.join('\n');
  fs.writeFileSync('merge_duplicates_report.txt', reportText);
  console.log(`\nReport written to merge_duplicates_report.txt`);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Summary: ${mergedCount} merged, ${skippedCount} skipped${DRY_RUN ? ' (dry run)' : ''}`);
  console.log(`${'='.repeat(80)}`);
}

main().catch(console.error);
