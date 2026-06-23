// build_dashboard.mjs — build ONCE per space the live "knowledge gaps" dashboard:
// a Topic + 6 live-query tables (Missing / Thin / Outdated / Duplicates / Trending / Themes)
// that filter the datasets space by Gap-finding type + status=Proposed.
//
// IDEMPOTENT + SHARED: the tables are LIVE queries, so ANY operator's findings published to
// the datasets space appear automatically — a new operator does NOT rebuild. By default this
// script REUSES an existing dashboard (prints its URL and exits); pass --force to build your own.
//
//   NODE_PATH=<geo-publish-skill>/node_modules \
//   bun --env-file=.env.geo-publish run build_dashboard.mjs \
//       --space <host-space> --datasets <datasets-space> --author <your-personal-space> \
//       [--title "Knowledge gaps"] [--dry-run] [--force]
import fs from "node:fs";
import { Graph, TextBlock, Position, daoSpace, personalSpace, getSmartAccountWalletClient } from "@geoprotocol/geo-sdk";

const ENDPOINT = "https://testnet-api.geobrowser.io/graphql";
const TOPIC_TYPE = "5ef5a5860f274d8e8f6c59ae5b3e89e2", DATA_BLOCK_TYPE = "b8803a8665de412bbb357e0c84adf473";
const FILTER_PROP = "14a46854bfd14b1882152785c2dab9f3", DS_TYPE_REL = "1f69cc9880d444abad493df6a7b15ee4";
const QUERY_DS = "3b069b04adbe4728917d1283fd4ac27e", BLOCKS_REL = "beaba5cba67741a8b35377030613fc70";
const GAP_FINDING = "1e621514688144938249bc5fc0aef8be";
const K_TYPES = "8f151ba4de204e3c9cb499ddf96f48f1", K_GAPTYPE = "90432d30096b4c9c920b96e22622cdeb";
const K_STATUS = "6dc322401db14c8e9bb54d1ef239912b", K_TAGS = "257090341ba5406f94e4d4af90042fba";
const PROPOSED = "2795b01ed2b54817a2d31c0b63f395c5", THEME_TAG = "c902fef91b1f42cd98adb4eac2879d91";
const M = { Coverage: "a7081e2f58134b2abbc4f132cbff5897", Depth: "29ec11ef50284f86a74956ce81ffb406",
  Structural: "e086119c22384295b84bb09f1fccec4e", Freshness: "ae4814fdf9764ee2b623625aa503bdd6",
  Trending: "51309f673e1a4163804fe2b82752d7be" };

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const HOST = opt("--space");                         // where the Topic lives
const DS = opt("--datasets", HOST);                  // where Gap findings live (queried)
const TITLE = opt("--title", "Knowledge gaps");
const AUTHOR = opt("--author", process.env.AUTHOR_SPACE);
const DRY = has("--dry-run"), FORCE = has("--force");
if (!HOST) throw new Error("--space (host space) required");

async function gql(query) {
  const r = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors)); return j.data;
}
const esc = (s) => s.replace(/"/g, '\\"');

// ---- idempotency: reuse an existing dashboard unless --force ----
const existing = ((await gql(`{ entitiesConnection(typeId:"${TOPIC_TYPE}", spaceId:"${HOST}", first:5, filter:{name:{isInsensitive:"${esc(TITLE)}"}}){ nodes { id name } } }`)).entitiesConnection || {}).nodes || [];
if (existing.length && !FORCE) {
  const id = existing[0].id;
  console.log(`Dashboard already exists — REUSE it (publish findings to ${DS} and they appear here):`);
  console.log(`  https://www.geobrowser.io/space/${HOST}/${id}`);
  console.log(`(pass --force to build a separate one anyway.)`);
  process.exit(0);
}

// ---- build: Topic + intro + 6 live tables ----
const gapFilter = (m) => JSON.stringify({ spaceId: { in: [DS] }, filter: { [K_TYPES]: { is: GAP_FINDING }, [K_GAPTYPE]: { is: m }, [K_STATUS]: { is: PROPOSED } } });
const themesFilter = JSON.stringify({ spaceId: { in: [DS] }, filter: { [K_TYPES]: { is: GAP_FINDING }, [K_TAGS]: { is: THEME_TAG }, [K_STATUS]: { is: PROPOSED } } });
const TABLES = [
  { name: "Missing from Geo", filter: gapFilter(M.Coverage) },
  { name: "Thin — needs enrichment", filter: gapFilter(M.Depth) },
  { name: "Outdated — needs updating", filter: gapFilter(M.Freshness) },
  { name: "Duplicates & mistypes", filter: gapFilter(M.Structural) },
  { name: "Trending now", filter: gapFilter(M.Trending) },
  { name: "Themes — topics to build or develop", filter: themesFilter },
];

const ops = [];
const { id: topicId, ops: tOps } = Graph.createEntity({ name: TITLE, types: [TOPIC_TYPE],
  description: `Open knowledge gaps surfaced by the gap-detection workflow, grouped by gap type and limited to findings still Proposed. Live tables querying datasets space ${DS}.` });
ops.push(...tOps);
let pos = Position.generateBetween(null, null);
ops.push(...TextBlock.make({ fromId: topicId, text: "Live tables of open Gap findings, grouped by gap type. Each queries the datasets space and shows only findings with status Proposed — any operator's newly-published findings appear here automatically.", position: pos }));
const blocks = [];
for (const t of TABLES) {
  const { id: blockId, ops: bOps } = Graph.createEntity({ name: t.name, types: [DATA_BLOCK_TYPE], values: [{ property: FILTER_PROP, type: "text", value: t.filter }] });
  ops.push(...bOps);
  ops.push(...Graph.createRelation({ fromEntity: blockId, toEntity: QUERY_DS, type: DS_TYPE_REL }).ops);
  pos = Position.generateBetween(pos, null);
  ops.push(...Graph.createRelation({ fromEntity: topicId, toEntity: blockId, type: BLOCKS_REL, position: pos }).ops);
  blocks.push({ name: t.name, id: blockId });
}
console.log(`Built dashboard "${TITLE}" in ${HOST}: Topic ${topicId} + ${blocks.length} tables (${ops.length} ops)`);

if (DRY) { console.log("DRY_RUN — not submitting."); process.exit(0); }
if (!AUTHOR) throw new Error("--author (your personal space id from whoami.mjs) required to submit");
const raw = process.env.GEO_PRIVATE_KEY; if (!raw) throw new Error("GEO_PRIVATE_KEY not set.");
const wallet = await getSmartAccountWalletClient({ privateKey: raw.startsWith("0x") ? raw : `0x${raw}` });
const sp = (await gql(`{ space(id:"${HOST}"){ type address } }`)).space || {};
let res;
if (sp.type === "DAO") {
  const prop = await daoSpace.proposeEdit({ name: `${TITLE} — dashboard`, ops, author: AUTHOR, daoSpaceAddress: sp.address, callerSpaceId: `0x${AUTHOR}`, daoSpaceId: `0x${HOST}`, votingMode: "FAST", network: "TESTNET" });
  const ptx = await wallet.sendTransaction({ to: prop.to, data: prop.calldata });
  const vote = await daoSpace.voteProposal({ authorSpaceId: `0x${AUTHOR}`, spaceId: `0x${HOST}`, proposalId: prop.proposalId, vote: "YES" });
  const vtx = await wallet.sendTransaction({ to: vote.to, data: vote.calldata });
  res = { topicId, blocks, proposalId: prop.proposalId, proposeTx: ptx, voteTx: vtx };
} else {
  const ed = await personalSpace.publishEdit({ name: `${TITLE} — dashboard`, ops, author: AUTHOR, spaceId: `0x${HOST}`, network: "TESTNET" });
  res = { topicId, blocks, tx: await wallet.sendTransaction({ to: ed.to, data: ed.calldata }) };
}
fs.writeFileSync("dashboard.json", JSON.stringify(res, null, 1));
console.log(`DONE — https://www.geobrowser.io/space/${HOST}/${topicId}`);
