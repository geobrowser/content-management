import {
  createGeoClient,
  createGeoWalletClient,
  GeoTestnetConfig,
  type GeoWalletClient,
  type Op,
} from "@geoprotocol/geo-sdk";
import dotenv from "dotenv";
import * as fs from "fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { ANCHORED_IMAGE_RELATION_TYPE_IDS } from "./constants.ts";

dotenv.config();

// Read once at load, after .env: a script that sets process.env.CONFIRM_DESTRUCTIVE
// in its own body can no longer switch the circuit breaker off. A speed bump, not a
// lock — a module imported earlier, or a CONFIRM_DESTRUCTIVE line in .env, still sets it.
const CONFIRM_DESTRUCTIVE_AT_START = process.env.CONFIRM_DESTRUCTIVE === "1";

// ─── Configuration ───────────────────────────────────────────────────────────
// 2026-07 infra migration: endpoints, chain id, and contract addresses all come
// from the SDK's network config — never hardcode them here. A `bun install`
// picks up URL changes with zero code edits.

export const NETWORK = GeoTestnetConfig;

export const geo = createGeoClient({ network: NETWORK });

// Geo wallet client (EIP-7702 smart account, gas-sponsored). Lazy singleton so
// read-only runs never touch the RPC.
let walletClientPromise: Promise<GeoWalletClient> | undefined;
export function getWalletClient(): Promise<GeoWalletClient> {
  if (!walletClientPromise) {
    const rawKey = process.env.GEO_PRIVATE_KEY ?? process.env.PK_SW;
    if (!rawKey) throw new Error(
      `GEO_PRIVATE_KEY not found in the environment. Checked GEO_PRIVATE_KEY and the legacy PK_SW. ` +
      `Make sure .env is in the folder you ran from (cwd: ${process.cwd()}) and that you passed --env-file=.env.`);
    // Accept the key with or without the 0x prefix, as geo-publish's script template does.
    const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
    walletClientPromise = createGeoWalletClient({
      signer: privateKeyToAccount(privateKey),
      network: NETWORK,
    });
  }
  return walletClientPromise;
}

export async function getWalletAddress(): Promise<`0x${string}`> {
  const client = await getWalletClient();
  if (!client.account) throw new Error("Geo wallet client has no account");
  return client.account.address;
}

// ─── GraphQL Helper ──────────────────────────────────────────────────────────

const API_URL = `${NETWORK.apiOrigin}/graphql`;

export async function gql(query: string, variables?: Record<string, any>, maxRetries = 50) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });

      // Retry on 5xx / 429
      if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
        const delay = Math.min(Math.pow(2, attempt - 1) * 1000, 16000);
        console.log(`  ⚠ API ${res.status}, retry ${attempt}/${maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`);
      }

      const json = await res.json();

      // Retry on GraphQL "Unexpected error"
      if (json.errors) {
        const msg = json.errors[0]?.message ?? 'Unknown';
        const isServerError = msg.includes('Unexpected error') || msg.includes('Internal');
        if (isServerError && attempt < maxRetries) {
          const delay = Math.min(Math.pow(2, attempt - 1) * 1000, 16000);
          console.log(`  ⚠ GraphQL: "${msg}", retry ${attempt}/${maxRetries} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
        // Deterministic GraphQL errors (bad query/filter) — retrying can't help.
        const gqlError: any = new Error(`GraphQL: ${msg}`);
        gqlError.nonRetryable = true;
        throw gqlError;
      }

      return json.data;
    } catch (error: any) {
      // Retry everything except deterministic GraphQL errors — the testnet API
      // 504s/stalls under load, so transient failures are the norm on long runs.
      if (!error?.nonRetryable && attempt < maxRetries) {
        const delay = Math.min(Math.pow(2, attempt - 1) * 1000, 16000);
        console.log(`  ⚠ ${error.message}, retry ${attempt}/${maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error('gql: exhausted all retries');
}

// ─── Membership Check ────────────────────────────────────────────────────────
// Returns the set of space IDs the caller can publish to (is editor or owner).

export async function getPublishableSpaceIds(spaceIds: string[]): Promise<Set<string>> {
  // v0.20 infra stores space addresses lowercase and the `is` filter is
  // case-sensitive — the wallet client returns a checksummed address, so lowercase it.
  const author = (await getWalletAddress()).toLowerCase();

  const personalSpaceData = await gql(`{
    spaces(filter: { address: { is: "${author}" } }) { id type }
  }`);
  const callerSpace = personalSpaceData.spaces?.find((s: any) => s.type === "PERSONAL");
  if (!callerSpace) throw new Error(`No personal space found for wallet ${author}.`);
  const callerSpaceId: string = callerSpace.id;

  const publishable = new Set<string>();
  for (const spaceId of spaceIds) {
    const spaceData = await gql(`{
      space(id: "${spaceId}") {
        type
        editorsList { memberSpaceId }
      }
    }`);
    if (!spaceData.space) continue;
    const { type: spaceType } = spaceData.space;
    if (spaceType === "PERSONAL") {
      if (spaceId === callerSpaceId) publishable.add(spaceId);
    } else {
      const editors: Array<{ memberSpaceId: string }> = spaceData.space.editorsList ?? [];
      if (editors.some(e => e.memberSpaceId === callerSpaceId)) publishable.add(spaceId);
    }
  }
  return publishable;
}

// ─── Space Info Helper ───────────────────────────────────────────────────────

export interface SpaceOwnerInfo {
  spaceId: string;
  spaceName: string;
  spaceType: 'PERSONAL' | 'DAO' | string;
  editors: Array<{ memberSpaceId: string; name: string }>;
}

export async function getSpaceOwnerInfo(spaceIds: string[]): Promise<SpaceOwnerInfo[]> {
  const results: SpaceOwnerInfo[] = [];
  for (const spaceId of spaceIds) {
    const spaceData = await gql(`{
      space(id: "${spaceId}") {
        type
        page { name }
        editorsList { memberSpaceId }
      }
    }`);
    if (!spaceData.space) continue;

    const { type: spaceType, page, editorsList } = spaceData.space;
    const spaceName = page?.name ?? spaceId;

    const editors: Array<{ memberSpaceId: string; name: string }> = [];
    if (spaceType !== 'PERSONAL' && editorsList?.length > 0) {
      for (const editor of editorsList) {
        const editorData = await gql(`{
          space(id: "${editor.memberSpaceId}") { page { name } }
        }`);
        editors.push({
          memberSpaceId: editor.memberSpaceId,
          name: editorData.space?.page?.name ?? editor.memberSpaceId,
        });
      }
    }

    results.push({ spaceId, spaceName, spaceType, editors });
  }
  return results;
}

// ─── Publishing Helper ───────────────────────────────────────────────────────
// Only DEMO_SPACE_ID is required — the space type & address are queried
// automatically from the API.  For DAO spaces the caller's member space is
// resolved by matching SW_ADDRESS against the DAO's members or editors list.

/**
 * Anchored (identity) entities of a space: its `page` (home) entity plus the
 * Image entities its Avatar (profile photo) and Cover relations point at.
 * A space wipe must exclude these by default — deleting them empties the space's
 * identity (the Aug-2026 personal-space wipe deleted the profile photo + space
 * description because no such guard existed). Returns lowercase-safe hex IDs.
 * Fail-CLOSED: on any query error this throws, so a caller that forgets to
 * handle it cannot silently proceed to delete anchored entities.
 */
export async function getAnchoredEntityIds(spaceId: string): Promise<Set<string>> {
  const anchored = new Set<string>();
  const spaceData = await gql(`{ space(id: "${spaceId}") { page { id } } }`);
  const pageId: string | undefined = spaceData?.space?.page?.id;
  if (!pageId) return anchored; // no home entity → nothing to anchor
  anchored.add(pageId);
  const pageData = await gql(`{
    entity(id: "${pageId}") { relationsList { typeId toEntityId } }
  }`);
  for (const r of pageData?.entity?.relationsList ?? []) {
    if (ANCHORED_IMAGE_RELATION_TYPE_IDS.has(r.typeId) && r.toEntityId) {
      anchored.add(r.toEntityId);
    }
  }
  return anchored;
}

export async function publishOps(ops: Op[], editName: string, input_space?: string): Promise<string | undefined> {
  let proposalId;
  let isEditor;
  let authorSpaceId;
  let spaceId = process.env.DEMO_SPACE_ID; 
  if (input_space) {
    spaceId = input_space
  }
  if (!spaceId) throw new Error("DEMO_SPACE_ID not set in .env");

  // ── Destructive-op circuit-breaker ─────────────────────────────────────────
  // Backstop against an improvised script mass-deleting a space (an agent wrote
  // its own delete loop and nuked a personal space). Deletion shows up as
  // `deleteRelation` + `updateEntity` with an `unset` array (and `deleteEntity`,
  // which the SDK does not emit yet but GRC-20 defines); a space wipe is
  // hundreds/thousands of these in one batch. Refuse a large destructive batch
  // unless the caller explicitly opts in. The geo-clean skill — which has its own
  // orphan check + human confirmation — sets CONFIRM_DESTRUCTIVE=1 after that
  // confirmation; a hand-written script won't, so it gets stopped here.
  const destructiveOps = ops.filter((o: any) =>
    o?.type === "deleteRelation" || o?.type === "deleteEntity" ||
    (o?.type === "updateEntity" && o?.unset?.length > 0)).length;
  const DESTRUCTIVE_LIMIT = 50; // ~25 entities; normal cleanups pass, a space-nuke does not
  if (destructiveOps > DESTRUCTIVE_LIMIT && !CONFIRM_DESTRUCTIVE_AT_START) {
    throw new Error(
      `SAFETY STOP: this publish would remove data from ~${destructiveOps} relations/values in space ${spaceId} — ` +
      `that is a bulk delete. Refusing to broadcast. Deletion must go through the geo-clean skill ` +
      `(orphan check + explicit confirmation). If you are certain this is intended, set CONFIRM_DESTRUCTIVE=1. ` +
      `Never mass-delete Geo data with a hand-written script.`);
  }

  const client = await getWalletClient();
  const account = client.account;
  if (!account) throw new Error("Geo wallet client has no account");
  // v0.20 infra stores space addresses lowercase and the `is` filter is
  // case-sensitive — the wallet client returns a checksummed address, so lowercase it.
  const author = account.address.toLowerCase();

  const personalSpaceData = await gql(`{
    spaces(filter: { address: { is: "${author}" } }) { id type }
  }`);

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

    const result = await geo.personalSpaces.publishEdit({
      name: editName,
      spaceId,
      ops,
      author: spaceId,
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

    const result = await geo.daoSpaces.proposeEdit({
      name: editName,
      ops,
      author: callerSpaceId,
      callerSpaceId: `0x${callerSpaceId}`,
      daoSpaceId: `0x${spaceId}`,
      // geo-sdk 0.20.2: daoSpaceAddress param removed — the target contract
      // (Space Registry) is resolved from the network config; result.to carries it.
      votingMode: isEditor ? "FAST" : "SLOW",
    });
    console.log("proposalId:", result.proposalId)
    proposalId = result.proposalId
    authorSpaceId = callerSpaceId
    console.log("CID:", result.cid);
    console.log("Edit ID:", result.editId);
    to = result.to;
    calldata = result.calldata;
    
  }

  
  const txHash = await client.sendTransaction({ account, chain: null, to, data: calldata });
  console.log("Transaction hash:", txHash);

  // Auto-vote disabled — propose only, let editors review before voting
  // if (proposalId && isEditor && authorSpaceId) {
  //   const v = geo.daoSpaces.voteProposal({
  //     authorSpaceId: authorSpaceId,
  //     spaceId: spaceId,
  //     proposalId: proposalId,
  //     vote: "YES",
  //   });
  //   const voteTx = await client.sendTransaction({ account, to: v.to, data: v.calldata });
  //   console.log("Vote transaction hash:", voteTx);
  // }
  // For DAO publishes, return the proposalId (used to build governance URLs:
  // https://www.geobrowser.io/space/{spaceId}/governance?proposalId={id-no-0x}).
  // For personal-space publishes, no proposal is created — fall back to txHash.
  return proposalId ?? txHash;
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

