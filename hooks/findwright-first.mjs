// PreToolUse hook: routes Grep, Glob and shell searches to FindWright when the
// folder sits inside a project that has an index. Advisory, not a security
// boundary. Any failure lets the call through, since a broken hook must not
// block every search in every project.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const BYPASS_MARKER = "FINDWRIGHT_BYPASS:";
const SHELL_TOOLS = ["Bash", "PowerShell"];
// Where a shell starts a new command, so a search after a pipe or inside $(...) is seen.
const COMMAND_SPLITTERS = ["|", "&&", "||", ";", "\n", "$(", "`", "xargs ", "-exec "];
const SEARCH_TOOLS = ["grep", "rg", "ag", "ack", "ripgrep", "findstr"];
const SEARCH_PHRASES = ["git grep"];
const BLOCK_EXIT_CODE = 2;

function findIndexFolder(start) {
  let folder = resolve(start);
  while (!existsSync(join(folder, ".findwright", "index.db"))) {
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return join(folder, ".findwright");
}

function nonEmptyString(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// A search counts when its working folder or its target path is inside an indexed project.
function searchFolders(payload) {
  const cwd = nonEmptyString(payload.cwd) ?? process.cwd();
  const folders = [cwd];
  const target = nonEmptyString(payload.tool_input?.path);
  if (target) folders.push(resolve(cwd, target));
  return folders;
}

function hasBypassMarker(command) {
  return command.split("\n").some((line) => {
    const marker = line.indexOf(BYPASS_MARKER);
    const hash = line.indexOf("#");
    return marker >= 0 && hash >= 0 && hash < marker;
  });
}

function startsWithSearchTool(token) {
  const isTool = SEARCH_TOOLS.some(
    (name) => token === name || token.startsWith(`${name} `) || token.startsWith(`${name}\t`),
  );
  const isPhrase = SEARCH_PHRASES.some(
    (phrase) => token === phrase || token.startsWith(`${phrase} `),
  );
  return isTool || isPhrase;
}

function splitOn(parts, splitter) {
  return parts.flatMap((part) => part.split(splitter));
}

// Heuristic on purpose: a false positive only asks for a bypass marker, while a missed
// search silently skips the index.
function isGrepLikeShell(command) {
  const chunks = COMMAND_SPLITTERS.reduce(splitOn, [command]);
  return chunks.some((chunk) => startsWithSearchTool(chunk.trimStart()));
}

function isShellSearch(payload) {
  const command = payload.tool_input?.command;
  if (typeof command !== "string") return false;
  if (hasBypassMarker(command)) return false;
  return isGrepLikeShell(command);
}

function isSearch(payload) {
  if (payload.tool_name === "Grep" || payload.tool_name === "Glob") return true;
  return SHELL_TOOLS.includes(payload.tool_name) && isShellSearch(payload);
}

function blockMessage(indexFolder) {
  return [
    `FindWright available at ${indexFolder}.`,
    "",
    "Code research must route through FindWright first, not Grep / Glob / raw grep / rg:",
    "  • find: a plain-English question or a name; the files that answer it, best first.",
    "  • search: regexes over every tracked file, with globs and context lines.",
    "  • symbols / outline: names by kind, and a file's symbols with line ranges.",
    "",
    "Fall back to Grep/Glob/raw grep ONLY when:",
    "  1. You've tried FindWright with 2+ keyword variants and got nothing usable.",
    "  2. You're searching non-code content (markdown, binaries, .gitignored).",
    "  3. FindWright's tools are missing from this session.",
    "",
    `Bypass (Bash or PowerShell only): include \`# ${BYPASS_MARKER} <reason>\` in the command.`,
    "The Grep and Glob tools have no bypass: run the same search with grep or rg in Bash,",
    "with the marker.",
  ].join("\n");
}

function blockReason(payload) {
  if (!isSearch(payload)) return null;
  const indexFolder = searchFolders(payload)
    .map((folder) => findIndexFolder(folder))
    .find(Boolean);
  return indexFolder ? blockMessage(indexFolder) : null;
}

// Returns the message to block with, or null to let the call through.
function decide(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return payload && typeof payload === "object" ? blockReason(payload) : null;
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  try {
    const reason = decide(await readStdin());
    if (reason) {
      process.stderr.write(`${reason}\n`);
      process.exitCode = BLOCK_EXIT_CODE;
    }
  } catch {
    // Fail open: the exit code stays 0 and the call goes ahead.
  }
}

await main();
