#!/usr/bin/env node
// FindWright's MCP server over stdio (JSON-RPC 2.0, one message per line).
// Every tool call first brings the index level with the working tree.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { gitRoot, globFilter, openIndex, readConfig, refresh } from "./store.mjs";
import { coverage, outline, search, symbols } from "./query.mjs";
import { find } from "./find.mjs";
import { meaningModel } from "./meaning.mjs";
import { sendDue } from "./counts.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// The repo the session runs in; outside a git repo every tool says so instead of indexing.
const root = process.env.FINDWRIGHT_ROOT ?? gitRoot();
// Opened on the first tool call, so a session that never searches leaves the repo untouched.
let db = null;

const text = (value) => ({ content: [{ type: "text", text: value }] });
const globs = { type: "array", items: { type: "string" }, description: "Path globs (`page/**`, `*.md`); any file when empty. A glob starting with `!` leaves out the files it matches (`!CHANGELOG.md`); with only `!` globs, every other file is kept." };

const TOOLS = {
  find: {
    description: "Find the files that answer a question or hold a name: plain words (`how the water flow map reaches the shader`), identifiers, or both. Ranks every indexed file by rare-word matches in names, paths and text, plus meaning. Start here for any \"where is X / how does Y work\" question; use `search` for exact text or a regex.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        globs,
        limit: { type: "number", description: "Most files to return (default 12)." },
      },
      required: ["query"],
    },
    run: async (args) => {
      const keep = globFilter(args.globs ?? []);
      const model = meaningModel(db);
      if (model.error) return { ...text(model.error), isError: true };
      const files = find(db, { query: args.query, keep, limit: args.limit ?? 12, model: model.ready, meaningWeight: 1 });
      const lines = files.map((f) => `${f.path}${f.symbol ? `   [${f.symbol}]` : ""}`);
      return text(lines.join("\n") || "No file matches.");
    },
  },
  search: {
    description: "Search every indexed file with JavaScript regexes, like grep -n. Each hit names the symbol around it (function, heading, YAML key). Use it for any text or code search: alternation, globs and context lines all work.",
    inputSchema: {
      type: "object",
      properties: {
        patterns: { type: "array", items: { type: "string" }, description: "Regexes; a line matching any of them is a hit." },
        globs,
        ignoreCase: { type: "boolean" },
        context: { type: "number", description: "Lines of context around each hit." },
        all: { type: "boolean", description: "Only files that match every pattern somewhere." },
        limit: { type: "number", description: "Most hits to return (default 200)." },
      },
      required: ["patterns"],
    },
    run: (args) => text(formatSearch(search(db, args))),
  },
  symbols: {
    description: "Find symbols by name (a regex or a substring): functions, classes, Markdown headings, YAML and JSON keys, and the project's own kinds (template placeholders, text keys).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, kind: { type: "string" }, globs, limit: { type: "number" } },
      required: ["query"],
    },
    run: (args) => text(symbols(db, args).map((s) => `${s.path}:${s.line}-${s.end_line}  ${s.kind} ${s.name}`).join("\n") || "No symbol matches."),
  },
  outline: {
    description: "A file's symbols with their line ranges, to read only the part you need.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: (args) => text(outline(db, args.path).map((s) => `${s.line}-${s.end_line}  ${s.kind} ${s.name}`).join("\n") || "No symbols in that file."),
  },
  coverage: {
    description: "What the index covers: files per kind, and the files no extractor found a symbol in.",
    inputSchema: { type: "object", properties: {} },
    run: () => text(JSON.stringify(coverage(db), null, 1)),
  },
};

function formatSearch(result) {
  const out = [];
  for (const file of result.files) {
    out.push(file.path);
    for (const h of file.hits) {
      for (const c of h.context.filter((c) => c.line < h.line)) out.push(`  ${c.line}- ${c.text}`);
      out.push(`  ${h.line}: ${h.text}${h.symbol ? `   [${h.symbol}]` : ""}`);
      for (const c of h.context.filter((c) => c.line > h.line)) out.push(`  ${c.line}- ${c.text}`);
    }
  }
  if (result.timedOut) out.push("(stopped after 2 s: this pattern is slow on the repo's text; narrow it or add globs)");
  else if (result.truncated) out.push("(more matches; narrow the search)");
  return out.join("\n") || "No matches.";
}

async function answer(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "findwright", version: VERSION } };
  }
  if (method === "tools/list") {
    return { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
  }
  if (method === "tools/call") {
    const tool = TOOLS[params.name];
    if (!tool) throw new Error(`No tool named ${params.name}`);
    if (!root) throw new Error("FindWright works inside a git repository; this folder is not in one.");
    sendCountsIfDue();
    db ??= openIndex(root);
    refresh(db, root, readConfig(root));
    return await tool.run(params.arguments ?? {});
  }
  if (id === undefined) return undefined;
  throw new Error(`Unknown method ${method}`);
}

let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  queue = queue.then(() => handle(line)).catch((error) => process.stderr.write(`findwright: ${error.message}\n`));
});

// A started send records its try within seconds; until then this pause keeps a second one from starting.
const SEND_PAUSE_MS = 60 * 60 * 1000;
let sendPausedUntil = 0;

// Tried at start and before every tool call, so a session open for days still sends once a day.
// The counts go out from a detached child, so a slow counter never delays an answer, and a counts
// file that cannot be read never stops the server.
function sendCountsIfDue() {
  if (!root || Date.now() < sendPausedUntil) return;
  try {
    if (!sendDue(root)) return;
  } catch {
    return;
  }
  sendPausedUntil = Date.now() + SEND_PAUSE_MS;
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, "counts", "send"],
    { cwd: root, detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {}); // a launch that fails leaves the answers unaffected
  child.unref();
}
sendCountsIfDue();

async function handle(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
    return;
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }) + "\n");
    return;
  }
  let reply;
  try {
    const result = await answer(message);
    if (message.id === undefined) return;
    reply = { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    if (message.id === undefined) return;
    reply = message.method === "tools/call"
      ? { jsonrpc: "2.0", id: message.id, result: { ...text(String(error.message)), isError: true } }
      : { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error.message) } };
  }
  process.stdout.write(JSON.stringify(reply) + "\n");
}
