// PreToolUse hook: routes Grep, Glob and shell searches to FindWright when the
// folder sits inside a project that has an index. Advisory, not a security
// boundary. Any failure lets the call through, since a broken hook must not
// block every search in every project.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const BYPASS_MARKER = "FINDWRIGHT_BYPASS:";
const SHELL_TOOLS = ["Bash", "PowerShell"];
// Where a shell may start a command, read without regard to quotes: the quick check for whether a
// command names a search at all, and for a search inside a quoted command string (`bash -c "..."`).
const COMMAND_SPLITTERS = /\|\||&&|\||&|;|\n|\$\(|`|xargs |-exec /;
// Shell operators between simple commands, and an output redirection (`>`, `>>`, `&>`, `2>&1`).
const OPERATOR = /^(\|\||&&|\|&|\||;|\n|&(?!>))/;
const OUTPUT_REDIRECT = /^&?>>?(&[\d-]*)?/;
// `|&` pipes the error output too.
const PIPES = ["|", "|&"];
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
// Words that make an allowed source print a file's text or a diff after all: git log with a patch,
// a line range or combined diffs, and gh pr diff, a workflow's YAML or a downloaded asset.
const PRINTS_FILES = {
  git: /^(-[^-]*[puL]|-c$|--(patch|cc|remerge-diff|diff-merges|unified))/,
  gh: /^(diff|download|--yaml|-y)$/,
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

// The quoted text starting at `at` as the shell reads it, with where it ends; undefined when no
// quote starts there, null when it never closes or runs a command substitution.
function readQuoted(command, at) {
  const quote = command[at];
  if (quote !== "'" && quote !== '"') return undefined;
  let end = at + 1;
  while (end < command.length && command[end] !== quote) end += quote === '"' && command[end] === "\\" ? 2 : 1;
  if (end >= command.length) return null;
  const text = command.slice(at + 1, end);
  if (quote === "'") return { text, end };
  if (/\$\(|`/.test(text)) return null;
  return { text: text.replace(/\\(["\\$`])/g, "$1"), end };
}

// The command's words, operators and output redirections, read the way a POSIX shell reads
// quotes; null when it holds what cannot be read word by word: command substitution, a subshell,
// an unclosed quote, or an unquoted variable or glob, which can expand to file names. An input
// redirection stays a word, so it counts as a file. A word spelled with a quote or a backslash
// says so, since a quoted string can be a command another shell runs.
function tokenize(command) {
  const tokens = [];
  let word = null;
  let isQuoted = false;
  const endWord = () => {
    if (word !== null) tokens.push({ word, isQuoted });
    word = null;
    isQuoted = false;
  };
  for (let at = 0; at < command.length; at++) {
    const rest = command.slice(at);
    if (/^[$`()*?[{]/.test(rest)) return null;
    const quoted = readQuoted(command, at);
    if (quoted === null) return null;
    const operator = OPERATOR.exec(rest)?.[0];
    const redirect = quoted ? undefined : OUTPUT_REDIRECT.exec(rest)?.[0];
    if (quoted) {
      word = (word ?? "") + quoted.text;
      isQuoted = true;
      at = quoted.end;
    } else if (operator || redirect) {
      if (redirect && /^\d+$/.test(word ?? "")) word = null;
      endWord();
      tokens.push(operator ? { operator } : { redirect: !redirect.includes(">&") });
      at += (operator ?? redirect).length - 1;
    } else if (/\s/.test(rest[0])) {
      endWord();
    } else {
      word = (word ?? "") + (rest[0] === "\\" ? (rest[1] ?? "") : rest[0]);
      if (rest[0] === "\\") {
        isQuoted = true;
        at++;
      }
    }
  }
  endWord();
  return tokens;
}

// Simple commands, each with its words and the operator before it; a redirection's target
// is dropped, since output written to a file is no file read.
function simpleCommands(tokens) {
  const commands = [{ operator: null, words: [] }];
  let dropsNextWord = false;
  for (const token of tokens) {
    if (token.operator) commands.push({ operator: token.operator, words: [] });
    else if ("redirect" in token) dropsNextWord = token.redirect;
    else if (dropsNextWord) dropsNextWord = false;
    else commands.at(-1).words.push(token.word);
  }
  return commands;
}

function namesSearch(text) {
  return text.split(COMMAND_SPLITTERS).some((part) => startsWithSearchTool(part.trimStart()));
}

// A search tool's name as a whole word anywhere, so one behind `sudo`, `timeout 5` or `sh -c '`
// is read too; `--grep` and `grep.txt` are other words.
const SEARCH_WORD = new RegExp(`(^|[^\\w-])(${SEARCH_TOOLS.join("|")})(?![\\w.-])`, "i");

// A command runs a search when any of its words is a search tool, which also covers one run
// through another command (`xargs grep`, `sudo grep`, `find -exec grep`).
function runsSearch(words) {
  return words.some((word, at) => SEARCH_TOOLS.includes(word.toLowerCase())
    || (word === "git" && words[at + 1] === "grep"));
}

// A command's name, its arguments, and the arguments that are not options. Every word after
// `--` is a pattern or a file, however it starts.
function parseWords([tool = "", ...args]) {
  const name = tool.toLowerCase();
  const isOption = (arg) => arg.startsWith("-") || (name === "findstr" && arg.startsWith("/"));
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  const operands = [...args.slice(0, end).filter((arg) => !isOption(arg)), ...args.slice(end + 1)];
  return { name, args, operands };
}

// A search reads files, not its input, when it walks folders or names a file after its
// pattern: past the first word, or past none when an option gave the pattern.
function readsFiles(words) {
  const { name, args, operands } = parseWords(words);
  if (args.some((arg) => RECURSIVE_FLAGS[name]?.test(arg))) return true;
  return operands.length > (args.some((arg) => PATTERN_OPTION.test(arg)) ? 0 : 1);
}

// sort and wc --files0-from read the files a list names.
function isReshaper(words) {
  const { name, args, operands } = parseWords(words);
  if (args.some((arg) => arg.startsWith("--files0-from"))) return false;
  if (RESHAPERS.includes(name)) return operands.every((word) => /^\d+$/.test(word));
  return SEARCH_TOOLS.includes(name) && !readsFiles(words);
}

function isOutputSource([command = "", subcommand = "", ...rest]) {
  const name = command.toLowerCase();
  if ([subcommand, ...rest].some((word) => PRINTS_FILES[name]?.test(word))) return false;
  const uses = Object.hasOwn(OUTPUT_SOURCES, name) ? OUTPUT_SOURCES[name] : [];
  return uses === true || uses.includes(subcommand.toLowerCase());
}

// A search filters output, not code, when its plain `|` pipeline starts with a command that never
// prints a file's text, every stage between only reshapes that output, and the search reads only
// its input. git grep ignores its input.
function isOutputFilter(commands, index) {
  const stages = [];
  for (let at = index; PIPES.includes(commands[at].operator); at--) stages.unshift(commands[at - 1].words);
  const search = commands[index].words;
  if (stages.length === 0 || !SEARCH_TOOLS.includes(search[0].toLowerCase()) || readsFiles(search)) return false;
  const [source, ...between] = stages;
  return isOutputSource(source) && between.every(isReshaper);
}

// Heuristic on purpose: a false positive only asks for a bypass marker, while a missed
// search silently skips the index. So the shell reading alone decides: a command passes only
// when it holds no quoted string that names a search, which another shell may run, and every
// command in it that runs a search filters output.
function isGrepLikeShell(command) {
  if (!namesSearch(command) && !SEARCH_WORD.test(command)) return false;
  const tokens = tokenize(command);
  if (!tokens || tokens.some(({ word, isQuoted }) => isQuoted && namesSearch(word))) return true;
  const commands = simpleCommands(tokens);
  return commands.some(({ words }, index) => runsSearch(words) && !isOutputFilter(commands, index));
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
