#!/usr/bin/env node
/**
 * notion-read.mjs — read-only Notion helper for the Geo work mirror.
 *
 * Run with the token loaded from .env (never pass it on the command line):
 *   node --env-file=.env scripts/notion-read.mjs <command> [args]
 *
 * Commands
 *   whoami                       confirm the token works; print integration + workspace
 *   search <query> [--limit N]   search pages/databases shared with the integration
 *   inventory                    every page + database the integration can see, grouped
 *   page <id> [--depth N]        render a page's block tree (default depth 1)
 *   props <id>                   a page's properties (use for database rows)
 *   schema <db-id>               a database's property schema
 *   rows <db-id> [--limit N] [--props "A,B"]   rows of a database
 *
 * Read-only by construction: this file only ever issues GET and the two
 * read-only POSTs (/search, /databases/:id/query). It never writes.
 */

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error(
    "NOTION_TOKEN not found in the environment.\n" +
      `Run with:  node --env-file=.env scripts/notion-read.mjs ${process.argv.slice(2).join(" ")}\n` +
      `(cwd: ${process.cwd()})`
  );
  process.exit(1);
}

const NOTION_VERSION = "2022-06-28";
const BASE = "https://api.notion.com/v1/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Paced, retrying API call. Notion's limit is ~3 req/s. */
async function api(path, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await sleep(340);
    if (res.ok) return res.json();
    if ([429, 500, 502, 503].includes(res.status) && attempt < 4) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    const detail = await res.text();
    return { _error: res.status, _detail: detail.slice(0, 300) };
  }
}

const clean = (id) => String(id).replace(/-/g, "");
const rt = (arr) => (arr ?? []).map((x) => x.plain_text ?? "").join("");

function titleOf(obj) {
  if (obj?.object === "database") return rt(obj.title);
  for (const v of Object.values(obj?.properties ?? {})) {
    if (v.type === "title") return rt(v.title);
  }
  return "(untitled)";
}

/** Flatten one property value to a readable string. */
function propValue(v) {
  switch (v.type) {
    case "title": return rt(v.title);
    case "rich_text": return rt(v.rich_text);
    case "select": return v.select?.name ?? "";
    case "multi_select": return v.multi_select.map((x) => x.name).join(", ");
    case "status": return v.status?.name ?? "";
    case "number": return v.number ?? "";
    case "checkbox": return String(v.checkbox);
    case "url": return v.url ?? "";
    case "email": return v.email ?? "";
    case "date": return v.date ? [v.date.start, v.date.end].filter(Boolean).join(" → ") : "";
    case "people": return v.people.map((p) => p.name ?? p.id).join(", ");
    case "relation": return `${v.relation.length} linked`;
    case "rollup": return JSON.stringify(v.rollup).slice(0, 120);
    case "formula": return String(v.formula?.string ?? v.formula?.number ?? "");
    case "created_time": return v.created_time;
    case "last_edited_time": return v.last_edited_time;
    default: return `(${v.type})`;
  }
}

async function allChildren(blockId) {
  const out = [];
  let cursor;
  for (;;) {
    const q = `blocks/${clean(blockId)}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const d = await api(q);
    if (d._error) return out;
    out.push(...(d.results ?? []));
    if (!d.has_more) return out;
    cursor = d.next_cursor;
  }
}

async function renderBlocks(blockId, depth, maxDepth, lines, seen) {
  if (depth > maxDepth) return;
  for (const b of await allChildren(blockId)) {
    const t = b.type;
    const c = b[t] ?? {};
    const pad = "  ".repeat(depth);
    const text = rt(c.rich_text);

    if (t === "child_page") {
      lines.push(`${pad}[PAGE] ${c.title}   id=${clean(b.id)}`);
      if (!seen.has(b.id)) {
        seen.add(b.id);
        await renderBlocks(b.id, depth + 1, maxDepth, lines, seen);
      }
      continue;
    }
    if (t === "child_database") {
      lines.push(`${pad}[DB] ${c.title}   id=${clean(b.id)}`);
      continue;
    }

    if (t.startsWith("heading_")) lines.push(`${pad}${"#".repeat(Number(t.slice(-1)))} ${text}`);
    else if (t === "paragraph") { if (text.trim()) lines.push(pad + text); }
    else if (t === "bulleted_list_item" || t === "numbered_list_item") lines.push(`${pad}- ${text}`);
    else if (t === "to_do") lines.push(`${pad}- [${c.checked ? "x" : " "}] ${text}`);
    else if (t === "callout") lines.push(`${pad}> [!] ${text}`);
    else if (t === "quote") lines.push(`${pad}> ${text}`);
    else if (t === "toggle") lines.push(`${pad}> ${text}`);
    else if (t === "code") lines.push(`${pad}\`\`\`${c.language ?? ""}\n${pad}${text}\n${pad}\`\`\``);
    else if (t === "divider") lines.push(`${pad}---`);
    else if (t === "table_row") lines.push(`${pad}| ${(c.cells ?? []).map(rt).join(" | ")} |`);
    else if (t === "bookmark" || t === "embed" || t === "link_preview") lines.push(`${pad}[link] ${c.url ?? ""}`);
    else if (t === "link_to_page") lines.push(`${pad}[link→] id=${clean(c.page_id ?? c.database_id ?? "")}`);
    else if (text.trim()) lines.push(`${pad}[${t}] ${text}`);

    if (b.has_children && t !== "child_page" && t !== "child_database") {
      await renderBlocks(b.id, depth + 1, maxDepth, lines, seen);
    }
  }
}

async function searchAll(query, cap = Infinity) {
  const items = [];
  let cursor;
  for (;;) {
    const body = { page_size: 100 };
    if (query) body.query = query;
    if (cursor) body.start_cursor = cursor;
    const d = await api("search", body);
    if (d._error) { console.error("search failed:", d); break; }
    items.push(...d.results);
    if (!d.has_more || items.length >= cap) break;
    cursor = d.next_cursor;
  }
  return items;
}

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case "whoami": {
    const d = await api("users/me");
    if (d._error) { console.error(`HTTP ${d._error}`, d._detail); process.exit(1); }
    console.log(`ok — integration "${d.name}" (${d.type}) · workspace "${d.bot?.owner?.workspace ? d.bot.workspace_name : "?"}"`);
    break;
  }

  case "search": {
    const limit = Number(flag("limit", 25));
    const items = await searchAll(arg, limit);
    for (const o of items.slice(0, limit)) {
      console.log(`${o.object.padEnd(8)} ${clean(o.id)}  ${titleOf(o).slice(0, 70)}`);
    }
    console.log(`\n${Math.min(items.length, limit)} shown of ${items.length} matched`);
    break;
  }

  case "inventory": {
    const items = await searchAll(undefined);
    const dbs = items.filter((i) => i.object === "database");
    const pages = items.filter((i) => i.object === "page");
    const rowCount = new Map();
    for (const p of pages) {
      if (p.parent?.type === "database_id") {
        const k = clean(p.parent.database_id);
        rowCount.set(k, (rowCount.get(k) ?? 0) + 1);
      }
    }
    console.log(`TOTAL VISIBLE: ${items.length}  (${dbs.length} databases, ${pages.length} pages)\n`);
    console.log("=== DATABASES (visible rows) ===");
    for (const d of dbs.sort((a, b) => (rowCount.get(clean(b.id)) ?? 0) - (rowCount.get(clean(a.id)) ?? 0))) {
      console.log(`  ${String(rowCount.get(clean(d.id)) ?? 0).padStart(5)}  ${titleOf(d)}   id=${clean(d.id)}`);
    }
    console.log("\n=== PAGES NOT INSIDE A DATABASE ===");
    for (const p of pages.filter((x) => x.parent?.type !== "database_id")) {
      console.log(`  ${clean(p.id)}  ${titleOf(p).slice(0, 70)}`);
    }
    break;
  }

  case "page": {
    const d = await api(`pages/${clean(arg)}`);
    if (d._error) { console.error(`HTTP ${d._error} — not shared with the integration, or wrong id.`); process.exit(1); }
    const lines = [`# ${titleOf(d)}   (id=${clean(arg)})`, `last_edited: ${d.last_edited_time}`, ""];
    await renderBlocks(arg, 0, Number(flag("depth", 1)), lines, new Set());
    console.log(lines.join("\n"));
    break;
  }

  case "props": {
    const d = await api(`pages/${clean(arg)}`);
    if (d._error) { console.error(`HTTP ${d._error}`, d._detail); process.exit(1); }
    console.log(`# ${titleOf(d)}   (id=${clean(arg)})`);
    console.log(`parent: ${JSON.stringify(d.parent)}`);
    console.log(`last_edited: ${d.last_edited_time}\n`);
    for (const [k, v] of Object.entries(d.properties)) {
      const val = propValue(v);
      if (val !== "") console.log(`${k}: ${val}`);
    }
    break;
  }

  case "schema": {
    const d = await api(`databases/${clean(arg)}`);
    if (d._error) { console.error(`HTTP ${d._error}`, d._detail); process.exit(1); }
    console.log(`# ${rt(d.title)}   (id=${clean(arg)})`);
    console.log(`${Object.keys(d.properties).length} properties\n`);
    for (const [k, v] of Object.entries(d.properties).sort()) {
      const extra =
        v.type === "select" || v.type === "status" || v.type === "multi_select"
          ? `  [${(v[v.type].options ?? []).map((o) => o.name).join(" | ")}]`
          : "";
      console.log(`  ${k.padEnd(28)} ${v.type}${extra}`);
    }
    break;
  }

  case "rows": {
    const limit = Number(flag("limit", 20));
    const only = flag("props", null)?.split(",").map((s) => s.trim());
    let cursor;
    let shown = 0;
    for (;;) {
      const body = { page_size: Math.min(100, limit - shown) };
      if (cursor) body.start_cursor = cursor;
      const d = await api(`databases/${clean(arg)}/query`, body);
      if (d._error) { console.error(`HTTP ${d._error}`, d._detail); process.exit(1); }
      for (const row of d.results) {
        const fields = Object.entries(row.properties)
          .filter(([k, v]) => (only ? only.includes(k) : v.type === "title" || propValue(v) !== ""))
          .map(([k, v]) => `${k}=${propValue(v)}`)
          .join("  |  ");
        console.log(`${clean(row.id)}  ${fields}`);
        shown++;
      }
      if (!d.has_more || shown >= limit) {
        console.log(`\n${shown} rows shown${d.has_more ? " (more available)" : ""}`);
        break;
      }
      cursor = d.next_cursor;
    }
    break;
  }

  default:
    console.log(
      "usage: node --env-file=.env scripts/notion-read.mjs <command>\n\n" +
        "  whoami\n  search <query> [--limit N]\n  inventory\n  page <id> [--depth N]\n" +
        "  props <id>\n  schema <db-id>\n  rows <db-id> [--limit N] [--props \"A,B\"]"
    );
}
