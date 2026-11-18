// FindWright's MCP server over stdio (JSON-RPC 2.0, one message per line), started by server.mjs.
// Every tool call first brings the index level with the working tree.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { checkOwnFolder, gitRoot, globFilter, hasRules, openIndex, readConfig, refresh } from "./store.mjs";
import { DEFAULT_GOAL, fellShort, history, sinceFit } from "./hits.mjs";
import { coverage, outline, search, symbols } from "./query.mjs";
import { find } from "./find.mjs";
import { meaningModel } from "./meaning.mjs";
import { failureToReport, sendDue } from "./counts.mjs";

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
    description: "Find symbols by name (a regex or a substring): whatever the project's rules name, such as functions, classes, headings, config keys, tests and text keys.",
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
    description: "What the index covers: files per type (extension), and the files no rule found a symbol in.",
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

const TYPE_NAMES = { string: "a string", number: "a number", boolean: "true or false", array: "a list of strings" };
const typeName = (schema) => TYPE_NAMES[schema.type];

function fitsType(value, schema) {
  if (schema.type === "array") return Array.isArray(value) && value.every((item) => typeof item === schema.items.type);
  if (schema.type === "number") return Number.isFinite(value);
  return typeof value === schema.type;
}

// Throws naming the argument when a call passes one the tool does not take, leaves out a required
// one or passes one of the wrong type, so a bad call never reaches the index. A null optional
// argument counts as left out.
function checkArguments(tool, schema, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${tool} takes its arguments as an object of named values.`);
  }
  const takes = Object.entries(schema.properties).map(([key, s]) => `\`${key}\` (${typeName(s)})`).join(", ");
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) {
      throw new Error(`${tool} has no argument \`${key}\`; it takes ${takes || "no arguments"}.`);
    }
  }
  for (const key of schema.required ?? []) {
    if (args[key] == null) throw new Error(`${tool} needs \`${key}\`, ${typeName(schema.properties[key])}.`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (value != null && !fitsType(value, schema.properties[key])) {
      throw new Error(`\`${key}\` in ${tool} must be ${typeName(schema.properties[key])}.`);
    }
  }
}

async function answer(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    const instructions = [process.env.FINDWRIGHT_HELPER_NOTICE, fitNotice(), countsNotice()]
      .filter(Boolean).join("\n") || undefined;
    return { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "findwright", version: VERSION }, ...(instructions && { instructions }) };
  }
  if (method === "tools/list") {
    return { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description,
      inputSchema: { ...t.inputSchema, additionalProperties: false } })) };
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (typeof name !== "string" || !Object.hasOwn(TOOLS, name)) {
      throw new Error(`No tool named ${name}; the tools are ${Object.keys(TOOLS).join(", ")}.`);
    }
    checkArguments(name, TOOLS[name].inputSchema, params.arguments ?? {});
    const args = Object.fromEntries(Object.entries(params.arguments ?? {}).filter(([, value]) => value != null));
    if (!root) throw new Error("FindWright works inside a git repository; this folder is not in one.");
    sendCountsIfDue();
    db ??= openIndex(root);
    refresh(db, root, readConfig(root));
    return await TOOLS[name].run(args);
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

// The session-start notice, once a day, while this repo's last counts send failed. The server's
// instructions are what a session reads at start, since the plugin ships no hooks.
function countsNotice() {
  if (!root) return undefined;
  let failedAt;
  try {
    failedAt = failureToReport(root);
  } catch {
    return undefined;
  }
  if (failedAt === null) return undefined;
  const day = new Date(failedAt).toLocaleDateString("en-CA");
  return `Tell the user in one line: this computer shares FindWright's usage counts, but this repo's last `
    + `send failed (${day}). The server tries again once a day; if this keeps showing, check the network.`;
}

// The session-start notice that sends the session to /findwright:fit: the repo has no rules yet,
// or its last few sessions since the config last changed all found the file less often than the goal.
function fitNotice() {
  if (!root) return undefined;
  try {
    // A cloned repo's .findwright/ is refused here too, before any of its files is read.
    checkOwnFolder(root);
    if (!hasRules(root)) {
      return "This repo has not been fitted for FindWright yet, so searches can miss its code by name. Before the first "
        + "search, run /findwright:fit, and tell the user in one line that it is fitting FindWright to the project.";
    }
    if (fellShort(sinceFit(root, history(root)), readConfig(root).goal ?? DEFAULT_GOAL)) {
      return "FindWright's last few sessions here found the file less often than the goal. Run /findwright:fit "
        + "to extend the rules where searches missed, and tell the user in one line why.";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

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
