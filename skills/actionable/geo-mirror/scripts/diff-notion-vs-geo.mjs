#!/usr/bin/env node
// geo-mirror Part 2 — kept for existing prompts and docs.
// Forwards to plan-notion-changes.mjs, which works on ANY Notion table with a
// "Geo ID" column (not only the "Geo … — <space>" tables this script used to find).
//
// Usage (unchanged): node --env-file=.env diff-notion-vs-geo.mjs --parent <PAGE_ID> [--space <SPACE_ID>] [--out plan.json]
const argv = process.argv.slice(2).map((a) => (a === '--parent' ? '--page' : a));
process.argv = [process.argv[0], new URL('./plan-notion-changes.mjs', import.meta.url).pathname, ...argv];
await import('./plan-notion-changes.mjs');
