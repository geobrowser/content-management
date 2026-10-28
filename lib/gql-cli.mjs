#!/usr/bin/env bun
// gql-cli.mjs — run a GraphQL query against the Geo testnet API from the shell.
// Usage:
//   bun lib/gql-cli.mjs '<query>' ['<json variables>']
//   bun lib/gql-cli.mjs '{ entities(typeId: "7ed45f2bc48b419e8e4664d5ff680b0d", first: 3) { id name } }'
//   bun lib/gql-cli.mjs 'query($id: UUID!) { entity(id: $id) { name spaceIds } }' '{"id":"..."}'
import { query } from "./gql.mjs";

const [q, varsJson] = process.argv.slice(2);
if (!q) {
  console.error("usage: bun gql-cli.mjs '<query>' ['<json vars>']");
  process.exit(2);
}
let vars;
if (varsJson !== undefined) {
  try {
    vars = JSON.parse(varsJson);
  } catch (e) {
    console.error(`invalid variables JSON: ${e.message}`);
    process.exit(2);
  }
}
try {
  console.log(JSON.stringify(await query(q, vars), null, 2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
