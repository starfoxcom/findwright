// PreToolUse hook: routes Grep, Glob and shell searches to FindWright when the
// folder sits inside a project that has an index. Advisory, not a security
// boundary. Any failure lets the call through, since a broken hook must not
// block every search in every project.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const BYPASS_MARKER = "FINDWRIGHT_BYPASS:";
const SHELL_TOOLS = ["Bash", "PowerShell"];
// Where a shell may start a command, read without regard to quotes: the check that decides
// whether a command is a search at all, which the shell reading may only relax.
const COMMAND_SPLITTERS = ["|", "&&", "||", ";", "\n", "$(", "`", "xargs ", "-exec "];
// A quoted command string another shell runs (`bash -c "..."`) can also start one after a lone `&`.
const STRING_SPLITTERS = /\|\||&&|\||&|;|\n|\$\(|`|xargs |-exec /;
// Shell operators between simple commands, and an output redirection (`>`, `>>`, `>|`, `&>`,
// `&>>`, `2>&1`).
const OPERATOR = /^(\|\||&&|\|&|\||;|\n|&(?!>))/;
const OUTPUT_REDIRECT = /^&?>[>|]?(&[\d-]*)?/;
// `>&` copies a descriptor only before a number or `-` that ends the word. Before any other word
// Bash sends both outputs to a file of that name, so the reading takes only the copy.
const DUPLICATE = /^>&(\d+-?|-)(?![^ \t\n;&|])/;
// `|&` pipes the error output too.
const PIPES = ["|", "|&"];
const SEARCH_TOOLS = ["grep", "rg", "ag", "ack", "ripgrep", "findstr"];
const SEARCH_PHRASES = ["git grep"];
// The unquoted characters the Bash reading accounts for. Any other one (`<`, `#`, `$`, `!`, a glob
// or a bracket) can redirect input, end the command early or expand to file names.
const PLAIN = /^[\w\-./=:,+@%]/;
// Only Bash commands are read word by word. How PowerShell passes words to a program depends on
// its version and its argument-passing mode, which the command text does not show, so every
// PowerShell command that names a search stays a search.
const READ_TOOLS = ["Bash"];
// The options git status and git log may take and still print no file's text or diff.
const STATUS_OPTIONS = new RegExp("^(-(?=.)[sbz]*(u(no|normal|all)?)?|--(short|branch|porcelain(=v[12])?"
  + "|untracked-files(=(no|normal|all))?|ignored(=\\w+)?|(no-)?ahead-behind|show-stash|no-renames))$");
const LOG_OPTIONS = new RegExp("^(-\\d+|-n\\d*|-s|-[iE]+|--(oneline|graph|all|branches|tags|first-parent"
  + "|(no-)?merges|reverse|abbrev-commit|follow|no-patch|name-only|name-status|stat|shortstat|numstat"
  + "|all-match|invert-grep|regexp-ignore-case|extended-regexp|(no-)?decorate(=\\w+)?)"
  + "|--(max-count|skip|format|pretty|date|grep|author|committer|since|until|after|before)=.*)$");
// Each entry takes the words after a command's name and says whether that use never prints a
// file's text.
const always = () => true;
const subcommands = (table) => ([subcommand = "", ...rest]) => {
  const use = subcommand.toLowerCase();
  return Object.hasOwn(table, use) && table[use](rest);
};
const actions = (list) => ([action = ""]) => list.includes(action);
const optionsMatch = (pattern) => (rest) => {
  const end = rest.includes("--") ? rest.indexOf("--") : rest.length;
  return rest.slice(0, end).every((word) => !word.startsWith("-") || pattern.test(word));
};
// A program file run as the first word after an interpreter's name, with nothing before it, so no
// inline code, no preloaded module and no program read from the pipe. What the program prints is
// its own output.
const runsFile = (extension) => ([script = ""]) => extension.test(script) && /^[\w./\\]/.test(script);
const PYTHON_FILE = runsFile(/\.py$/i);
// A package script named plainly after `run`, with no option word before a `--`: npm reads such
// words as its own settings (`--node-options` preloads a module), and only what follows `--`
// reaches the script.
const runsPackageScript = ([name = "", ...rest]) => /^\w[\w:.-]*$/.test(name)
  && optionsMatch(/(?!)/)(rest);
const GIT_SUBCOMMANDS = subcommands({
  status: optionsMatch(STATUS_OPTIONS), log: optionsMatch(LOG_OPTIONS),
  ...Object.fromEntries("ls-files branch remote tag worktree push fetch pull".split(" ")
    .map((name) => [name, always])),
});
// git's own options that may come before a listed subcommand: `-C <folder>`, `--no-pager` and
// `-P`. Any other one, `-c` above all, which can define an alias on the spot, leaves the use
// unknown.
function gitUse(rest) {
  let at = 0;
  while (rest[at]?.startsWith("-")) {
    if (rest[at] === "-C") at += 2;
    else if (rest[at] === "--no-pager" || rest[at] === "-P") at += 1;
    else return false;
  }
  return GIT_SUBCOMMANDS(rest.slice(at));
}
const NODE_FILE = runsFile(/\.[cm]?js$/i);
const NODE_TEST_RUN = subcommands({ "--test": optionsMatch(/^--test(-[a-z-]+)?(=.*)?$/) });
// Commands whose output is never a file's text, so a search piped after them filters that output:
// listings, test runs, a program file run by its interpreter, a package script, and the git, gh
// and claude uses that print no file's text. A test run or a script can print lines of code in
// its own messages; that is the program's output, not a file the session reads through it. Any
// other command, use or option may print a file (cat, sed, find -exec, node -e, git show,
// git log -p, gh pr diff), so a search after it stays a search.
const OUTPUT_SOURCES = {
  ls: always, dir: always, echo: always, ps: always, pytest: always,
  node: (rest) => NODE_FILE(rest) || NODE_TEST_RUN(rest),
  python: PYTHON_FILE, python3: PYTHON_FILE, py: PYTHON_FILE,
  npm: subcommands({ run: runsPackageScript, test: always, ls: always, outdated: always }),
  pnpm: subcommands({ run: runsPackageScript }),
  cargo: subcommands({ test: always }), go: subcommands({ test: always }),
  dotnet: subcommands({ test: always }),
  git: gitUse,
  gh: subcommands({
    run: actions(["list", "view"]), pr: actions(["list", "view", "checks", "status"]),
    issue: actions(["list", "view", "status"]), release: actions(["list", "view"]),
    workflow: actions(["list"]),
  }),
  claude: subcommands({ plugin: actions(["list"]), mcp: actions(["list", "get"]) }),
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

const GLOB_WILDCARDS = "*?[{";
const hasWildcard = (segment) => [...segment].some((character) => GLOB_WILDCARDS.includes(character));

// The folders of an absolute Glob pattern before its first wildcard segment. A bare drive
// such as "C:" keeps its separator, since Windows reads "C:" as the working folder on C.
function globBase(payload) {
  const pattern = payload.tool_name === "Glob" ? nonEmptyString(payload.tool_input?.pattern) : undefined;
  if (!pattern || !isAbsolute(pattern)) return undefined;
  const segments = pattern.split(/[\\/]/);
  const wildcard = segments.findIndex(hasWildcard);
  const base = segments.slice(0, wildcard < 0 ? -1 : wildcard).join("/");
  return /^[A-Za-z]:$/.test(base) ? `${base}/` : base || "/";
}

// Where a search runs: the place a Grep or Glob call names, since it searches only there, and
// the working folder otherwise. A Glob with an absolute pattern searches from that pattern's
// folders whatever its path says. A search counts when that place is inside an indexed project.
function searchFolder(payload) {
  const cwd = nonEmptyString(payload.cwd) ?? process.cwd();
  const target = globBase(payload) ?? nonEmptyString(payload.tool_input?.path);
  return target ? resolve(cwd, target) : cwd;
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
// quote starts there, null when it never closes, may expand inside double quotes (a backtick, or
// a `$` anywhere but last, since each shell adds its own expansions, such as zsh's `"$=name"`),
// which can run a command or yield several words (`"$@"`), or joins two lines with a backslash,
// which Bash removes. A `$` right before the closing quote, such as a regex's end anchor
// (`"^remote: *$"`), stays literal in every shell.
function readQuoted(command, at) {
  const quote = command[at];
  if (quote !== "'" && quote !== '"') return undefined;
  const escapes = quote === '"';
  let end = at + 1;
  while (end < command.length && command[end] !== quote) end += escapes && command[end] === "\\" ? 2 : 1;
  if (end >= command.length) return null;
  const text = command.slice(at + 1, end);
  if (quote === "'") return { text, end };
  if (/`|\$(?!$)|\\\n/.test(text)) return null;
  return { text: text.replace(/\\(["\\])/g, "$1"), end };
}

// Characters a reader can take for a word break or miss while Bash keeps them in a word: control
// characters and Unicode spaces, other than space, tab and newline.
const UNREAD_CHARACTER = /(?![ \t\n])[\p{Cc}\p{Cf}\p{Z}]/u;

// The command's words, operators and output redirections, read the way Bash reads quotes; null
// when it holds what cannot be read word by word: an unclosed quote, an expansion in double
// quotes, a backslash before a line break, an unread character anywhere, or any unquoted
// character the reading does not account for. A word spelled with a quote or a backslash says
// so, since a quoted string can be a command another shell runs.
function tokenize(command) {
  if (UNREAD_CHARACTER.test(command)) return null;
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
    const quoted = readQuoted(command, at);
    if (quoted === null) return null;
    const operator = OPERATOR.exec(rest)?.[0];
    const redirect = quoted ? undefined : OUTPUT_REDIRECT.exec(rest)?.[0];
    if (quoted) {
      word = (word ?? "") + quoted.text;
      isQuoted = true;
      at = quoted.end;
    } else if (operator || redirect) {
      // An unquoted digit glued to `>` names a file descriptor. Any other word stays one: Bash
      // passes `"2">out`, `2&>out` and a number too large for a descriptor as an argument, and a
      // longer descriptor only counts a word too many.
      if (redirect?.includes(">&") && !DUPLICATE.test(rest)) return null;
      if (redirect?.startsWith(">") && !isQuoted && /^\d$/.test(word ?? "")) word = null;
      endWord();
      tokens.push(operator ? { operator } : { redirect: !redirect.includes(">&") });
      at += (operator ?? redirect).length - 1;
    } else if (rest[0] === " " || rest[0] === "\t") {
      endWord();
    } else if (rest[0] === "\\") {
      if (rest.length < 2 || rest[1] === "\n") return null;
      word = (word ?? "") + rest[1];
      isQuoted = true;
      at++;
    } else if (PLAIN.test(rest)) {
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

function splitOn(parts, splitter) {
  return parts.flatMap((part) => part.split(splitter));
}

function startsSearch(command) {
  return COMMAND_SPLITTERS.reduce(splitOn, [command]).some((part) => startsWithSearchTool(part.trimStart()));
}

function namesSearch(text) {
  return text.split(STRING_SPLITTERS).some((part) => startsWithSearchTool(part.trimStart()));
}

// Whether a command could name a search tool at all, before the reading spends time on it.
const MAYBE_SEARCH = new RegExp(SEARCH_TOOLS.join("|"), "i");

// A command runs a search when any of its words is a search tool, which also covers one run
// through another command (`xargs grep`, `find -exec grep`).
function runsSearch(words) {
  return words.some((word, at) => SEARCH_TOOLS.includes(word.toLowerCase())
    || (word === "git" && words[at + 1] === "grep"));
}

// Whether `option` is one the stage allows, and whether it takes the next word as its value;
// null when the stage does not allow it. A value inside the option word has a strict shape
// (digits glued to a letter, a plain word after `=`), since a tool may read a looser one as
// more options, as ack reads `-Cx` as `-C` and `-x`.
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
// hook knows, or takes an option its list does not allow.
function readStage([tool = "", ...args]) {
  const name = tool.toLowerCase();
  if (!Object.hasOwn(STAGE_OPTIONS, name)) return null;
  const operands = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === "--") return { name, operands: [...operands, ...args.slice(at + 1)] };
    if (!(arg.startsWith("-") && arg !== "-")) {
      operands.push(arg);
      continue;
    }
    const option = readOption(STAGE_OPTIONS[name], arg);
    if (!option) return null;
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

// A source passes when OUTPUT_SOURCES lists its command and says that use never prints a file.
function isOutputSource([command = "", ...rest]) {
  const name = command.toLowerCase();
  return Object.hasOwn(OUTPUT_SOURCES, name) && OUTPUT_SOURCES[name](rest);
}

// A search filters output, not code, when its `|` or `|&` pipeline starts with a command that never
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

// Commands that run the command after their own words, each with its options that take the next
// word as their value. Leading `NAME=value` words are settings, and timeout's first other word is
// its duration.
const WRAPPERS = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t"], nice: ["-n"],
  timeout: ["-s", "-k"], env: ["-u", "-C", "-S"], nohup: [], time: ["-f", "-o"], stdbuf: [],
  exec: ["-a"],
};
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh"];

// The command a simple command runs once its settings and wrappers are taken off.
function unwrap(words) {
  let at = 0;
  while (/^\w+=/.test(words[at] ?? "")) at++;
  while (Object.hasOwn(WRAPPERS, words[at])) {
    const [wrapper, values] = [words[at], WRAPPERS[words[at]]];
    at++;
    while (at < words.length && (words[at].startsWith("-") || /^\w+=/.test(words[at]))) {
      if (words[at] === "--") { at++; break; }
      at += values.includes(words[at]) ? 2 : 1;
    }
    if (wrapper === "timeout") at++;
  }
  return words.slice(at);
}

// A search behind a wrapper (`sudo grep`, `timeout 5 rg`), in the string a shell runs with `-c`,
// or in what `eval` runs.
function runsWrappedSearch(words) {
  const [name = "", ...rest] = unwrap(words);
  if (runsSearch([name, rest[0] ?? ""].slice(0, name === "git" ? 2 : 1))) return true;
  if (name === "eval") return namesSearch(rest.join(" "));
  const script = rest.findIndex((word) => /^-[a-z]*c$/.test(word));
  return SHELLS.includes(name) && script >= 0 && namesSearch(rest[script + 1] ?? "");
}

// Heuristic on purpose: a false positive only asks for a bypass marker, while a missed
// search silently skips the index. A command is a search when a shell command in it starts with
// a search tool. The shell reading only lets one of those through: when it reads every word, the
// command holds no quoted string that names a search, which another shell may run, and every
// command in it that runs a search filters output. A command it cannot read keeps that first
// answer. A command the reading can follow is also a search when one of its commands runs one
// behind a wrapper, through a shell's `-c` or `eval`, or after a lone `&`.
function isGrepLikeShell(command, isRead) {
  const tokens = isRead && MAYBE_SEARCH.test(command) ? tokenize(command) : null;
  const isFirstAnswer = startsSearch(command);
  if (!tokens) return isFirstAnswer;
  if (isFirstAnswer && tokens.some(({ word, isQuoted }) => isQuoted && namesSearch(word))) return true;
  const runs = isFirstAnswer ? runsSearch : runsWrappedSearch;
  const commands = simpleCommands(tokens);
  return commands.some(({ words }, index) => runs(words) && !isOutputFilter(commands, index));
}

function isShellSearch(payload) {
  const command = payload.tool_input?.command;
  if (typeof command !== "string") return false;
  if (hasBypassMarker(command)) return false;
  return isGrepLikeShell(command, READ_TOOLS.includes(payload.tool_name));
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
  const indexFolder = findIndexFolder(searchFolder(payload));
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
