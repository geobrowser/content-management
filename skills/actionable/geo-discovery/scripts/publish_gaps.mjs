// publish_gaps.mjs — generalized Stage-6 publisher. Works on ANY space.
//
// Reuses ONE shared Gap-finding ontology (constants below — same IDs in every datasets
// space). The target datasets space is the only per-space input; its DAO address + type
// are RESOLVED AT RUNTIME (so a new space like health needs zero publish-side config —
// just a DATASETS_SPACE mapping in space_profile.py + editor rights).
//
//   NODE_PATH=<geo-publish-skill>/node_modules \
//   bun --env-file=.env.geo-publish run publish_gaps.mjs \
//       --findings drafts.json --author <your-personal-space> [--space <datasets-id>] \
//       [--dry-run] [--no-vote]
//
// Inputs (drafts.json): { target_space?, publish_date, discoverer, findings: [ {name,
//   description, recommended_action, gap_types:[...], gap_status?, subject?, suggested_type?,
//   sources:[...], topics?:[...], tags?:[...] } ] }
// Key: GEO_PRIVATE_KEY in .env.geo-publish (the var the geo-publish CLIs read).
// Author: your personal space id — get it from geo-publish bin/whoami.mjs, pass via --author.
import fs from "node:fs";
import { Graph, daoSpace, personalSpace, getSmartAccountWalletClient } from "@geoprotocol/geo-sdk";

const ENDPOINT = "https://testnet-api.geobrowser.io/graphql";

// ---- shared Gap-finding ontology (fixed across all datasets spaces — reused by ID) ----
const ONT = {
  gap_finding_type: "1e621514688144938249bc5fc0aef8be",
  props: {
    name: "5b064102b0f14e529dad989a7696309e", description: "9b1f76ff9711404c861e59dc3fa7d037",
    publish_date: "94e43fe8faf241009eb887ab4f999723", sources: "49c5d5e1679a4dbdbfd33f618f227c94",
    topics: "806d52bc27e94c9193c057978b093351", tags: "257090341ba5406f94e4d4af90042fba",
    discoverer: "2a9abcaa7fae4f29a6d0124ed5bd1018", gap_types: "90432d30096b4c9c920b96e22622cdeb",
    gap_status: "6dc322401db14c8e9bb54d1ef239912b", gap_finding_subject: "ce1623ae023748faa8e63a3caab68608",
    suggested_type: "b9297d240dd84010a87e332b9bab062b", recommended_action: "275dbe3feae64036b9bdbe356ed1a1d1",
  },
  gap_type_members: { Coverage: "a7081e2f58134b2abbc4f132cbff5897", Depth: "29ec11ef50284f86a74956ce81ffb406",
    Freshness: "ae4814fdf9764ee2b623625aa503bdd6", Structural: "e086119c22384295b84bb09f1fccec4e",
    Trending: "51309f673e1a4163804fe2b82752d7be" },
  gap_status: { Proposed: "2795b01ed2b54817a2d31c0b63f395c5", Accepted: "8b865b9a4d924b65aa5b460d08b8fb1e",
    Deferred: "1dabf61fff0e425eafef313b9e2bdf97", Rejected: "751c179149c64224a7418785c50b500b",
    Ingested: "967fe9e38e1b4ba9918f8134a6fb28f4" },
};

// ---- args ----
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const FINDINGS = opt("--findings", "drafts.json");
const AUTHOR = opt("--author", process.env.AUTHOR_SPACE);
const DRY = has("--dry-run");
const NO_VOTE = has("--no-vote");

const data = JSON.parse(fs.readFileSync(FINDINGS, "utf8"));
const TARGET = opt("--space", data.target_space);
if (!TARGET) throw new Error("no target datasets space (--space or drafts.target_space)");
if (!AUTHOR && !DRY) throw new Error("no --author (your personal space id from whoami.mjs)");

async function gql(query) {
  const r = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// ---- build ops from the findings (shared schema) ----
const allOps = [], created = [];
for (const f of data.findings) {
  const values = [{ property: ONT.props.recommended_action, type: "text", value: f.recommended_action || "" }];
  if (data.publish_date) values.push({ property: ONT.props.publish_date, type: "datetime", value: `${data.publish_date}T00:00:00Z` });
  const { id: gapId, ops } = Graph.createEntity({ name: f.name, description: f.description || "", types: [ONT.gap_finding_type], values });
  allOps.push(...ops);
  const rel = (toEntity, type, extra) => { if (toEntity) allOps.push(...Graph.createRelation({ fromEntity: gapId, toEntity, type, ...(extra || {}) }).ops); };
  for (const gt of (f.gap_types || [])) rel(ONT.gap_type_members[gt], ONT.props.gap_types);
  rel(ONT.gap_status[f.gap_status || "Proposed"], ONT.props.gap_status);
  if (data.discoverer) rel(data.discoverer, ONT.props.discoverer);
  if (f.subject) rel(f.subject, ONT.props.gap_finding_subject);
  if (f.suggested_type) rel(f.suggested_type, ONT.props.suggested_type);   // a type ENTITY id
  for (const s of (f.sources || [])) rel(s, ONT.props.sources);
  for (const t of (f.topics || [])) rel(t, ONT.props.topics);
  for (const tag of (f.tags || [])) rel(tag, ONT.props.tags);
  created.push({ name: f.name, id: gapId, gap_types: f.gap_types });
}
console.log(`Built ${allOps.length} ops across ${created.length} Gap findings → target ${TARGET}`);

// ---- resolve the target space's publish path at runtime (DAO vs personal) ----
const sp = (await gql(`{ space(id:"${TARGET}"){ type address } }`)).space || {};
console.log(`target space type=${sp.type} address=${sp.address || "(none)"}`);

if (DRY) { fs.writeFileSync("published.json", JSON.stringify({ target: TARGET, dryRun: true, created }, null, 1)); console.log("DRY_RUN — not submitting."); process.exit(0); }

const raw = process.env.GEO_PRIVATE_KEY;
if (!raw) throw new Error("GEO_PRIVATE_KEY not set (create .env.geo-publish).");
const privateKey = raw.startsWith("0x") ? raw : `0x${raw}`;
const wallet = await getSmartAccountWalletClient({ privateKey });

let out;
if (sp.type === "DAO") {
  const prop = await daoSpace.proposeEdit({ name: `Discovery — ${created.length} Gap findings`, ops: allOps,
    author: AUTHOR, daoSpaceAddress: sp.address, callerSpaceId: `0x${AUTHOR}`, daoSpaceId: `0x${TARGET}`,
    votingMode: "FAST", network: "TESTNET" });
  const proposeTx = await wallet.sendTransaction({ to: prop.to, data: prop.calldata });
  console.log("proposalId:", prop.proposalId, "propose tx:", proposeTx);
  out = { target: TARGET, proposalId: prop.proposalId, editId: prop.editId, proposeTx, created };
  if (NO_VOTE) { console.log("--no-vote: proposed but NOT voted (won't index) — throwaway-proposal test."); }
  else {
    const vote = await daoSpace.voteProposal({ authorSpaceId: `0x${AUTHOR}`, spaceId: `0x${TARGET}`, proposalId: prop.proposalId, vote: "YES" });
    out.voteTx = await wallet.sendTransaction({ to: vote.to, data: vote.calldata });
    console.log("vote tx:", out.voteTx);
  }
} else {
  // personal (non-DAO) space — single publishEdit
  const ed = await personalSpace.publishEdit({ name: `Discovery — ${created.length} Gap findings`, ops: allOps, author: AUTHOR, spaceId: `0x${TARGET}`, network: "TESTNET" });
  out = { target: TARGET, editId: ed.editId, tx: await wallet.sendTransaction({ to: ed.to, data: ed.calldata }), created };
  console.log("publishEdit tx:", out.tx);
}
fs.writeFileSync("published.json", JSON.stringify(out, null, 1));
console.log("DONE — wrote published.json");
