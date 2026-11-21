// PreToolUse hook: routes Grep, Glob and shell searches to FindWright when the
// folder sits inside a project that has an index. Advisory, not a security
// boundary. Any failure lets the call through, since a broken hook must not
// block every search in every project.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const BYPASS_MARKER = "FINDWRIGHT_BYPASS:";
const SHELL_TOOLS = ["Bash", "PowerShell"];
// Where a shell starts a new command, so a search after a pipe or inside $(...) is seen.
// The capture group keeps each splitter, so a chunk knows what came before it. A lone `&` runs
// a command in the background; the `&` of a redirection such as `2>&1` or `&>` splits nothing.
const COMMAND_SPLITTERS = /(\|\||&&|(?<![<>&])&(?![&>])|\||;|\n|\$\(|`|xargs |-exec )/;
const SEARCH_TOOLS = ["grep", "rg", "ag", "ack", "ripgrep", "findstr"];
const SEARCH_PHRASES = ["git grep"];
// Commands whose output is never a file's text (test runs, file lists, logs), so a search
// piped after them filters that output: `true` for any use, or the second words that keep it so.
// Any other command may print a file (find through -exec, node -p, gh api, a make target).
const OUTPUT_SOURCES = {
  ls: true, dir: true, "get-childitem": true, gci: true, echo: true, ps: true, pytest: true,
  node: ["--test"], npm: ["test", "ls", "outdated"], gh: ["run", "pr", "issue", "release", "workflow"],
  git: ["status", "log", "ls-files", "branch", "remote", "tag", "worktree"],
  cargo: ["test"], go: ["test"], dotnet: ["test"],
};
// Stages that reshape the output fed to them. They take options and counts only, so any other
// word is a file they read instead. Scripted tools (sed, awk) can read files and are left out.
const RESHAPERS = ["sort", "uniq", "head", "tail", "cut", "wc"];
// Options that give the pattern, so every word left is a file: grep and rg -e/-f/--regexp/--file,
// findstr /c: and /g:.
const PATTERN_OPTION = /^-[a-zA-Z]*[ef]|^--(regexp|file)|^\/[cCgG]:/;
// Flags that make a search walk folders, or read a list of files, instead of reading its input.
const RECURSIVE_FLAGS = {
  grep: /^-[a-z]*r|^--(dereference-)?recursive$|^-d$|^--directories/i,
  findstr: /^\/(s|f:)/i,
};
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

// A search reads files, not its input, when it walks folders or names a file after its
// pattern: past the first word, or past none when an option gave the pattern or script.
// Quoted text, including a quote a `|` inside it cut short, and redirections are not file names.
function readsFiles(chunk) {
  const { name, args, operands } = parseStage(chunk);
  if (args.some((arg) => RECURSIVE_FLAGS[name]?.test(arg))) return true;
  return operands.length > (args.some((arg) => PATTERN_OPTION.test(arg)) ? 0 : 1);
}

// A stage's command name, its text with quotes and redirections taken out, its words, and the
// words that are not options.
function parseStage(stage) {
  const plain = stage.replace(/"[^"]*("|$)|'[^']*('|$)/g, "''").replace(/\s\d?>>?\s*\S+/g, "");
  const [tool, ...args] = plain.trim().split(/\s+/);
  const name = tool.toLowerCase();
  const isOption = (arg) => arg.startsWith("-") || (name === "findstr" && arg.startsWith("/"));
  // Every word after `--` is a pattern or a file, however it starts.
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  const operands = [...args.slice(0, end).filter((arg) => !isOption(arg)), ...args.slice(end + 1)];
  return { name, plain, args, operands };
}

// A stage inside a group or subshell may not be what feeds the pipe: `(cat a; echo) | grep`.
const isGrouped = (stage) => /[(){}]/.test(parseStage(stage).plain);

// sort and wc --files0-from read the files a list names.
function isReshaper(stage) {
  const { name, args, operands } = parseStage(stage);
  if (args.some((arg) => arg.startsWith("--files0-from"))) return false;
  if (RESHAPERS.includes(name)) return operands.every((word) => /^\d+$/.test(word));
  return SEARCH_TOOLS.includes(name) && !readsFiles(stage);
}

// The stages of the plain `|` pipeline that feeds the chunk at `index`, first stage first.
function feedingStages(parts, index) {
  const stages = [];
  for (let at = index; parts[at - 1] === "|"; at -= 2) stages.unshift(parts[at - 2]);
  return stages;
}

function isOutputSource(stage) {
  const [command, subcommand] = stage.trim().toLowerCase().split(/\s+/);
  const uses = Object.hasOwn(OUTPUT_SOURCES, command) ? OUTPUT_SOURCES[command] : [];
  return uses === true || uses.includes(subcommand);
}

// A search filters output, not code, when its pipeline starts with a command that never prints
// a file's text, every stage between only reshapes that output, and the search reads only its
// input. git grep ignores its input.
function isOutputFilter(chunk, stages) {
  if (stages.length === 0 || readsFiles(chunk)) return false;
  if (SEARCH_PHRASES.some((phrase) => chunk.startsWith(phrase))) return false;
  if (stages.some(isGrouped)) return false;
  const [source, ...between] = stages;
  return isOutputSource(source) && between.every(isReshaper);
}

// Heuristic on purpose: a false positive only asks for a bypass marker, while a missed
// search silently skips the index.
function isGrepLikeShell(command) {
  const parts = command.split(COMMAND_SPLITTERS);
  for (let index = 0; index < parts.length; index += 2) {
    const chunk = parts[index].trimStart();
    if (!startsWithSearchTool(chunk)) continue;
    if (!isOutputFilter(chunk, feedingStages(parts, index))) return true;
  }
  return false;
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
