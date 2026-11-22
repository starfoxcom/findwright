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
const OUTPUT_REDIRECT = /^&?>[>|]?(&[\d-]*)?/;
// `|&` pipes the error output too.
const PIPES = ["|", "|&"];
const SEARCH_TOOLS = ["grep", "rg", "ag", "ack", "ripgrep", "findstr"];
const SEARCH_PHRASES = ["git grep"];
// How each shell reads a word, and the unquoted characters the reading accounts for. Any other
// one (`<`, `#`, `$`, `!`, a glob or a bracket) can redirect input, end the command early or
// expand to file names. PowerShell takes a backslash as a plain character, and spreads `a,b`
// and `@name` into several arguments, so it reads neither `,` nor `@` as plain.
const DIALECTS = {
  Bash: { isBackslashEscape: true, plain: /^[\w\-./=:,+@%]/ },
  PowerShell: { isBackslashEscape: false, plain: /^[\w\-./=:+%\\]/ },
};
// The options git status and git log may take and still print no file's text or diff.
const STATUS_OPTIONS = new RegExp("^(-(?=.)[sbz]*(u(no|normal|all)?)?|--(short|branch|porcelain(=v[12])?"
  + "|untracked-files(=(no|normal|all))?|ignored(=\\w+)?|(no-)?ahead-behind|show-stash|no-renames))$");
const LOG_OPTIONS = new RegExp("^(-\\d+|-n\\d*|-s|-[iE]+|--(oneline|graph|all|branches|tags|first-parent"
  + "|(no-)?merges|reverse|abbrev-commit|follow|no-patch|name-only|name-status|stat|shortstat|numstat"
  + "|all-match|invert-grep|regexp-ignore-case|extended-regexp|(no-)?decorate(=\\w+)?)"
  + "|--(max-count|skip|format|pretty|date|grep|author|committer|since|until|after|before)=.*)$");
// Commands whose output is never a file's text (test runs, file lists, logs), so a search piped
// after them filters that output. Each allows any use (`true`), or names its subcommands, each
// with `true`, the actions it may take, or the pattern every option must match. Any other command
// or option may print a file (find through -exec, node -p, gh api, git log -p, gh pr diff).
const OUTPUT_SOURCES = {
  ls: true, dir: true, "get-childitem": true, gci: true, echo: true, ps: true, pytest: true,
  node: { "--test": /^--test(-[a-z-]+)?(=.*)?$/ },
  npm: { test: true, ls: true, outdated: true },
  gh: {
    run: ["list", "view"], pr: ["list", "view", "checks", "status"], issue: ["list", "view", "status"],
    release: ["list", "view"], workflow: ["list"],
  },
  git: {
    status: STATUS_OPTIONS, log: LOG_OPTIONS,
    "ls-files": true, branch: true, remote: true, tag: true, worktree: true,
  },
  cargo: { test: true }, go: { test: true }, dotnet: { test: true },
};
// Stages that reshape the output fed to them, taking options only, so any other word is a file
// they read. Scripted tools (sed, awk) can read files and are left out.
const RESHAPERS = ["sort", "uniq", "head", "tail", "cut", "wc"];
// The options a stage after the pipe may take and still read only its input, per tool:
// - flags: single letters that take no value.
// - values: letters whose value every version of the tool requires, so a value not glued to
//   the letter is the next word.
// - counts: letters whose number is optional in some version (ack and ag -A/-B/-C, BSD grep
//   -C), taken only with the digits glued on (`-C3`), since a bare one leaves the next word to
//   the pattern.
// - long, longValues: long options without a value, and those that require one (`=value` or
//   the next word).
// - longGlued: long options whose value is optional, taken only as `--name=value`.
// - isCountFlag: a bare count (`-20`) is a line count.
// Long options are matched whole, since GNU tools also take any unambiguous prefix. Any other
// option may name a file, walk folders or give the pattern (grep -r, -e and -f, ack -x, sort
// --files0-from), so the command stays a search.
const names = (list = "") => list.split(" ").filter(Boolean);
const stageOptions = ({
  flags = "", values = "", counts = "", isCountFlag = false, long, longValues, longGlued,
}) => ({
  flags, values, counts, isCountFlag,
  long: names(long), longValues: names(longValues), longGlued: names(longGlued),
});
const GREP_LONG = "ignore-case invert-match count line-number only-matching word-regexp"
  + " line-regexp extended-regexp fixed-strings perl-regexp basic-regexp quiet silent no-filename"
  + " with-filename files-with-matches files-without-match null-data byte-offset text color colour";
const RG = stageOptions({
  flags: "ivcnNowxFsSqHIlUaz", values: "mABCE",
  long: `${GREP_LONG} smart-case case-sensitive no-line-number no-heading heading column vimgrep`
    + " multiline trim",
  longValues: "max-count after-context before-context context encoding colors", longGlued: "color",
});
const LINES = { values: "nc", isCountFlag: true, long: "quiet silent verbose zero-terminated",
  longValues: "lines bytes" };
const STAGE_OPTIONS = {
  grep: stageOptions({
    flags: "ivcnowxEFGPqshHlLzab", values: "mAB", counts: "C", isCountFlag: true, long: GREP_LONG,
    longValues: "max-count after-context before-context", longGlued: "context color colour",
  }),
  rg: RG,
  ripgrep: RG,
  ack: stageOptions({
    flags: "ivcwhHlLoQIs", values: "m", counts: "ABC",
    long: "ignore-case invert-match count word-regexp no-filename with-filename files-with-matches"
      + " files-without-matches literal color colour nocolor nocolour",
    longValues: "max-count", longGlued: "after-context before-context context",
  }),
  ag: stageOptions({
    flags: "ivcwlLoQsS", values: "m", counts: "ABC",
    long: "ignore-case invert-match count word-regexp files-with-matches files-without-matches"
      + " only-matching literal case-sensitive smart-case color nocolor",
    longValues: "max-count", longGlued: "after before context",
  }),
  findstr: stageOptions({ flags: "ivnbelrx" }),
  sort: stageOptions({
    flags: "bdfghiMnRrsuVz", values: "kt",
    long: "ignore-leading-blanks dictionary-order ignore-case general-numeric-sort"
      + " human-numeric-sort ignore-nonprinting month-sort numeric-sort random-sort reverse stable"
      + " unique version-sort zero-terminated",
    longValues: "key field-separator",
  }),
  uniq: stageOptions({
    flags: "cdDiuz", values: "fsw",
    long: "count repeated all-repeated ignore-case unique zero-terminated",
    longValues: "skip-fields skip-chars check-chars",
  }),
  head: stageOptions({ ...LINES, flags: "qvz" }),
  tail: stageOptions({ ...LINES, flags: "qvzf" }),
  cut: stageOptions({
    flags: "sz", values: "bcdf", long: "complement only-delimited zero-terminated",
    longValues: "bytes characters delimiter fields output-delimiter",
  }),
  wc: stageOptions({ flags: "clmwL", long: "bytes chars lines words max-line-length" }),
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
// quote starts there, null when it never closes or expands inside double quotes (`$`, a
// backtick), which can run a command or yield several words (`"$@"`).
function readQuoted(command, at, dialect) {
  const quote = command[at];
  if (quote !== "'" && quote !== '"') return undefined;
  const escapes = quote === '"' && dialect.isBackslashEscape;
  let end = at + 1;
  while (end < command.length && command[end] !== quote) end += escapes && command[end] === "\\" ? 2 : 1;
  if (end >= command.length) return null;
  const text = command.slice(at + 1, end);
  if (quote === "'") return { text, end };
  if (/[$`]/.test(text)) return null;
  return { text: escapes ? text.replace(/\\(["\\])/g, "$1") : text, end };
}

// The command's words, operators and output redirections, read the way the dialect's shell
// reads quotes; null when it holds what cannot be read word by word: an unclosed quote, an
// expansion in double quotes, a backslash before a line break, or any unquoted character
// the dialect does not read as plain. A word spelled with a quote or a backslash says so, since
// a quoted string can be a command another shell runs.
function tokenize(command, dialect) {
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
    const quoted = readQuoted(command, at, dialect);
    if (quoted === null) return null;
    const operator = OPERATOR.exec(rest)?.[0];
    const redirect = quoted ? undefined : OUTPUT_REDIRECT.exec(rest)?.[0];
    if (quoted) {
      // PowerShell before 7.3 passes a quote inside an argument to a program unescaped, so the
      // program can split it into several arguments.
      const joinsQuote = quoted.text.includes('"') || /["']/.test(command[at - 1] ?? "");
      if (!dialect.isBackslashEscape && joinsQuote) return null;
      word = (word ?? "") + quoted.text;
      isQuoted = true;
      at = quoted.end;
    } else if (operator || redirect) {
      // Only an unquoted number glued to `>` names a file descriptor; `"2">out` and `2&>out`
      // pass the word 2.
      if (redirect?.startsWith(">") && !isQuoted && /^\d+$/.test(word ?? "")) word = null;
      endWord();
      tokens.push(operator ? { operator } : { redirect: !redirect.includes(">&") });
      at += (operator ?? redirect).length - 1;
    } else if (/\s/.test(rest[0])) {
      endWord();
    } else if (rest[0] === "\\" && dialect.isBackslashEscape) {
      if (rest.length < 2 || rest[1] === "\n") return null;
      word = (word ?? "") + rest[1];
      isQuoted = true;
      at++;
    } else if (dialect.plain.test(rest)) {
      word = (word ?? "") + rest[0];
    } else {
      return null;
    }
  }
  endWord();
  return tokens;
}

// Simple commands, each with its words and the operator before it; a redirection's target
// is dropped, since output written to a file is no file read. A target never crosses an
// operator.
function simpleCommands(tokens) {
  const commands = [{ operator: null, words: [] }];
  let dropsNextWord = false;
  for (const token of tokens) {
    if (token.operator) {
      commands.push({ operator: token.operator, words: [] });
      dropsNextWord = false;
    } else if ("redirect" in token) dropsNextWord = token.redirect;
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

// Whether `option` is one the stage allows, and whether it takes the next word as its value;
// null when the stage does not allow it. A value inside the option word has a strict shape
// (digits glued to a letter, a plain word after `=`): a shell can split a looser one in two,
// as PowerShell splits `-m9.\file` into `-m9` and `.\file`.
function readOption(options, option) {
  if (option.startsWith("--")) {
    const [name, value] = option.slice(2).split(/=(.*)/s);
    const takesValue = options.longValues.includes(name) || options.longGlued.includes(name);
    if (value !== undefined) return takesValue && /^[\w-]+$/.test(value) ? { takesNext: false } : null;
    if (options.long.includes(name)) return { takesNext: false };
    return options.longValues.includes(name) ? { takesNext: true } : null;
  }
  if (options.isCountFlag && /^-\d+$/.test(option)) return { takesNext: false };
  for (let at = 1; at < option.length; at++) {
    const isValue = options.values.includes(option[at]);
    if (isValue || options.counts.includes(option[at])) {
      const glued = option.slice(at + 1);
      if (isValue && glued === "") return { takesNext: true };
      return /^\d+$/.test(glued) ? { takesNext: false } : null;
    }
    if (!options.flags.includes(option[at])) return null;
  }
  return { takesNext: false };
}

// A stage's name and the words it takes as patterns or files; null when it is not a stage the
// hook knows, or takes an option its list does not allow. findstr's options start with `/`.
function readStage([tool = "", ...args]) {
  const name = tool.toLowerCase();
  if (!Object.hasOwn(STAGE_OPTIONS, name)) return null;
  const operands = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === "--") return { name, operands: [...operands, ...args.slice(at + 1)] };
    const slashOption = name === "findstr" && arg.startsWith("/");
    if (!slashOption && !(arg.startsWith("-") && arg !== "-")) {
      operands.push(arg);
      continue;
    }
    const option = readOption(STAGE_OPTIONS[name], slashOption ? `-${arg.slice(1).toLowerCase()}` : arg);
    if (!option || (slashOption && arg.length !== 2)) return null;
    if (option.takesNext) at++;
  }
  return { name, operands };
}

// A search reads only its input when its one operand is the pattern.
function isInputSearch(words) {
  const read = readStage(words);
  return read !== null && SEARCH_TOOLS.includes(read.name) && read.operands.length === 1;
}

function isReshaper(words) {
  const read = readStage(words);
  if (read && RESHAPERS.includes(read.name)) return read.operands.length === 0;
  return isInputSearch(words);
}

// A source passes when its command allows any use, or its subcommand is listed and what follows
// fits: an action the subcommand allows, or options, before any `--`, that its pattern accepts.
function isOutputSource([command = "", subcommand = "", ...rest]) {
  const name = command.toLowerCase();
  const uses = Object.hasOwn(OUTPUT_SOURCES, name) ? OUTPUT_SOURCES[name] : {};
  if (uses === true) return true;
  const use = subcommand.toLowerCase();
  const allowed = Object.hasOwn(uses, use) ? uses[use] : false;
  if (Array.isArray(allowed)) return allowed.includes(rest[0]);
  if (!(allowed instanceof RegExp)) return allowed;
  const end = rest.includes("--") ? rest.indexOf("--") : rest.length;
  return rest.slice(0, end).every((word) => !word.startsWith("-") || allowed.test(word));
}

// A search filters output, not code, when its plain `|` pipeline starts with a command that never
// prints a file's text, every stage between only reshapes that output, and the search reads only
// its input. git grep ignores its input.
function isOutputFilter(commands, index) {
  const stages = [];
  for (let at = index; PIPES.includes(commands[at].operator); at--) stages.unshift(commands[at - 1].words);
  const search = commands[index].words;
  if (stages.length === 0 || !isInputSearch(search)) return false;
  const [source, ...between] = stages;
  return isOutputSource(source) && between.every(isReshaper);
}

// Heuristic on purpose: a false positive only asks for a bypass marker, while a missed
// search silently skips the index. So the shell reading alone decides: a command passes only
// when it holds no quoted string that names a search, which another shell may run, and every
// command in it that runs a search filters output.
function isGrepLikeShell(command, dialect) {
  if (!namesSearch(command) && !SEARCH_WORD.test(command)) return false;
  const tokens = tokenize(command, dialect);
  if (!tokens || tokens.some(({ word, isQuoted }) => isQuoted && namesSearch(word))) return true;
  const commands = simpleCommands(tokens);
  return commands.some(({ words }, index) => runsSearch(words) && !isOutputFilter(commands, index));
}

function isShellSearch(payload) {
  const command = payload.tool_input?.command;
  if (typeof command !== "string") return false;
  if (hasBypassMarker(command)) return false;
  return isGrepLikeShell(command, DIALECTS[payload.tool_name]);
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
