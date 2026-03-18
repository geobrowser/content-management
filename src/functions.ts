import {
  daoSpace,
  getSmartAccountWalletClient,
  personalSpace,
  type Op,
} from "@geoprotocol/geo-sdk";
import dotenv from "dotenv";
import * as fs from "fs";
import path from "node:path";

dotenv.config();

// ─── Configuration ───────────────────────────────────────────────────────────

const TESTNET_RPC_URL = "https://rpc-geo-test-zc16z3tcvf.t.conduit.xyz";

// ─── GraphQL Helper ──────────────────────────────────────────────────────────

const API_URL = "https://testnet-api.geobrowser.io/graphql";

export async function gql(query: string, variables?: Record<string, any>) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.errors) {
    console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
    throw new Error(`GraphQL: ${json.errors[0].message}`);
  }
  return json.data;
}

// ─── Publishing Helper ───────────────────────────────────────────────────────
// Only DEMO_SPACE_ID is required — the space type & address are queried
// automatically from the API.  For DAO spaces the caller's member space is
// resolved by matching SW_ADDRESS against the DAO's members or editors list.

export async function publishOps(ops: Op[], editName: string, input_space?: string): Promise<string | undefined> {
  let proposalId;
  let isEditor;
  let authorSpaceId;
  let spaceId = process.env.DEMO_SPACE_ID; 
  if (input_space) {
    spaceId = input_space
  }
  if (!spaceId) throw new Error("DEMO_SPACE_ID not set in .env");

  const privateKey = process.env.PK_SW as `0x${string}`;
  if (!privateKey) throw new Error("PK_SW not set in .env");

  const client = await getSmartAccountWalletClient({
    privateKey: privateKey,
    rpcUrl: TESTNET_RPC_URL,
  });
  const author = client.account.address

  const personalSpaceData = await gql(`{
    spaces(filter: { address: { is: "${author}" } }) { id type }
  }`);
  
  if (!author)
    throw new Error("Smart Wallet address not found from private key.");

  console.log(`\nQuerying space ${spaceId} from the API...`);

  const spaceData = await gql(`{
    space(id: "${spaceId}") {
      type
      address
      membersList { memberSpaceId }
      editorsList { memberSpaceId }
    }
  }`);

  if (!spaceData.space) throw new Error(`Space ${spaceId} not found`);

  const { type: spaceType, address: daoAddress } = spaceData.space;
  console.log(`  Space type: ${spaceType}  address: ${daoAddress}`);
  console.log(`Publishing ${ops.length} operations...`);

  let to: `0x${string}`;
  let calldata: `0x${string}`;

  // Resolve the caller's personal space
  const callerSpace = personalSpaceData.spaces?.find(
    (s: any) => s.type === "PERSONAL",
  );
  if (!callerSpace) {
    throw new Error(
      `No personal space found for wallet ${author}. ` +
        `Make sure this wallet has a personal space on the Geo testnet.`,
    );
  }
  const callerSpaceId: string = callerSpace.id;

  if (spaceType === "PERSONAL") {
    // Verify this is the caller's own personal space
    if (spaceId !== callerSpaceId) {
      console.warn(`⚠ Skipping publish to space ${spaceId} — it is a personal space that does not belong to you (your space: ${callerSpaceId}).`);
      return undefined;
    }

    const result = await personalSpace.publishEdit({
      name: editName,
      spaceId,
      ops,
      author: spaceId,
      network: "TESTNET",
    });
    console.log("CID:", result.cid);
    console.log("Edit ID:", result.editId);
    to = result.to;
    calldata = result.calldata;
  } else {
    console.log(`  Caller personal space: ${callerSpaceId}`);

    // Verify the caller's personal space is a member or editor of the DAO
    const members: Array<{ memberSpaceId: string }> =
      spaceData.space.membersList;
    const editors: Array<{ memberSpaceId: string }> =
      spaceData.space.editorsList;
    const allCandidates = [...members, ...editors];
    const isMemberOrEditor = allCandidates.some(
      (m) => m.memberSpaceId === callerSpaceId,
    );
    isEditor = editors.some(
      (e) => e.memberSpaceId === callerSpaceId,
    );

    if (!isMemberOrEditor) {
      console.warn(
        `⚠ Skipping publish to DAO space ${spaceId} — you are not a member or editor (your space: ${callerSpaceId}).`,
      );
      return undefined;
    }

    const result = await daoSpace.proposeEdit({
      name: editName,
      ops,
      author: callerSpaceId,
      network: "TESTNET",
      callerSpaceId: `0x${callerSpaceId}` as `0x${string}`,
      daoSpaceId: `0x${spaceId}` as `0x${string}`,
      daoSpaceAddress: daoAddress as `0x${string}`,
    });
    console.log("proposalId:", result.proposalId)
    proposalId = result.proposalId
    authorSpaceId = callerSpaceId
    console.log("CID:", result.cid);
    console.log("Edit ID:", result.editId);
    to = result.to;
    calldata = result.calldata;
    
  }

  
  const txHash = await client.sendTransaction({ to, data: calldata });
  console.log("Transaction hash:", txHash);

  if (proposalId && isEditor && authorSpaceId) {
    const result = daoSpace.voteProposal({
      authorSpaceId: authorSpaceId,
      spaceId: spaceId,
      proposalId: proposalId,
      vote: "YES"
    })
    to = result.to;
    calldata = result.calldata;
    const txHash = await client.sendTransaction({ to, data: calldata });
    console.log("Vote transaction hash:", txHash);
  }
  return txHash;
}

// ─── printOps ────────────────────────────────────────────────────────────────
// Serializes ops to a JSON file, converting UUID byte arrays to hex strings.

function isUuidByteArray(obj: any): boolean {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj))
    return false;
  const keys = Object.keys(obj);
  if (keys.length !== 16) return false;
  for (let i = 0; i < 16; i++) {
    if (!(String(i) in obj) || typeof obj[String(i)] !== "number") return false;
  }
  return true;
}

function uuidBytesToString(obj: any): string {
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += obj[String(i)].toString(16).padStart(2, "0");
  }
  return hex;
}

function convertUuidBytes(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") {
    if (
      typeof obj === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        obj,
      )
    ) {
      return obj.replace(/-/g, "");
    }
    return obj;
  }
  if (isUuidByteArray(obj)) {
    return uuidBytesToString(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(convertUuidBytes);
  }
  const result: any = {};
  for (const key of Object.keys(obj)) {
    result[key] = convertUuidBytes(obj[key]);
  }
  return result;
}

export function printOps(ops: any, outputDir: string, fn: string) {
  console.log("NUMBER OF OPS: ", ops.length);

  if (ops.length > 0) {
    const convertedOps = convertUuidBytes(ops);
    const outputText = JSON.stringify(convertedOps, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2);
    const filePath = path.join(outputDir, fn);
    fs.writeFileSync(filePath, outputText);
    console.log(`OPS PRINTED to ${fn}`);
  } else {
    console.log("NO OPS TO PRINT");
  }
}

