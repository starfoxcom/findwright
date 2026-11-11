// Queries over the index: regex search with the enclosing symbol of each hit,
// symbol lookup, a file's outline, and the coverage report.

import { globToRegExp } from "./store.mjs";
import vm from "node:vm";
import { linearRegExp } from "./linear.mjs";

// A session pattern runs on the linear engine when it can, which never backtracks. One that engine
// refuses (ignoring case, back-references, lookarounds, counts above 16) runs on the full engine inside a
// vm script with a deadline, so a pattern that would stall on the repo's text stops when one search's
// budget runs out instead of hanging the server.
const SEARCH_BUDGET_MS = 2000;
const SCAN = new vm.Script("(() => { const out = []; for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push(i); return out; })()");

/** Thrown when a search's time budget runs out. */
export class TimeUp extends Error {}

export const searchBudget = (ms = SEARCH_BUDGET_MS) => ({ until: Date.now() + ms });

export function sessionPattern(source, ignoreCase = false) {
  const linear = ignoreCase ? null : linearRegExp(source);
  if (linear) return { matchLines: (lines) => lines.flatMap((line, i) => (linear.test(line) ? [i] : [])) };
  const context = vm.createContext({ re: new RegExp(source, ignoreCase ? "i" : ""), lines: [] });
  return {
    matchLines(lines, budget) {
      const left = budget.until - Date.now();
      if (left <= 0) throw new TimeUp();
      context.lines = lines;
      try {
        return [...SCAN.runInContext(context, { timeout: left })];
      } catch (error) {
        if (error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new TimeUp();
        throw error;
      }
    },
  };
}

// The literal runs every match of a regex branch must contain, longest first;
// used only to shortlist files, so missing a run is safe and inventing one is not.
export function requiredLiterals(source) {
  const runs = [];
  let run = "";
  const flush = () => { if (run) runs.push(run); run = ""; };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") {
      flush();
      const prefix = /^\((?:\?(?:<[^>=!]+>|<?[=!]|:))?/.exec(source.slice(i))[0];
      const end = groupEnd(source, i);
      const inner = source.slice(i + prefix.length, end);
      const isOptional = /^[?*]|^\{0/.test(source.slice(end + 1));
      const isUnknownForm = prefix === "(" && source[i + 1] === "?";
      // A lookaround's text is not part of the match, an optional group or one with several
      // branches holds no text every match must contain, and a `(?` form not read here (inline
      // modifiers such as `(?i:...)`) may change what its text matches: each is skipped whole.
      if (/[=!]$/.test(prefix) || isOptional || isUnknownForm || branches(inner).length > 1) i = end;
      else i += prefix.length - 1;
    } else if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) break;
      // An escaped symbol is that symbol; a letter or digit escape (`\d`, `é`,
      // `\k<name>`) is no literal text, so the run ends and its operand is skipped whole.
      if (/\W/.test(next)) { run += next; i++; }
      else { flush(); i = escapeEnd(source, i + 1); }
    } else if ("*?{".includes(ch)) {
      run = [...run].slice(0, -1).join("");
      flush();
      if (ch === "{") i = closing(source, "}", i);
    } else if (ch === "+") flush();
    else if (".^$()[]|".includes(ch)) {
      flush();
      if (ch === "[") i = classEnd(source, i + 1);
    } else run += ch;
  }
  flush();
  return runs.sort((a, b) => b.length - a.length);
}

// Where `mark` next appears from `from`, or the end when it never does, so an
// unclosed `{`, `<` or `[` ends the scan instead of restarting it.
const closing = (source, mark, from) => {
  const at = source.indexOf(mark, from);
  return at < 0 ? source.length : at;
};

// The `]` that closes the class whose body starts at `from`, past escaped ones.
function classEnd(source, from) {
  for (let i = from; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "]") return i;
  }
  return source.length;
}

// The last character of the escape whose letter or digit sits at `at`:
// `é` and `\u{e9}`, `\x41`, `\cM`, `\k<name>`, `\p{Lu}`, `\12`.
function escapeEnd(source, at) {
  const letter = source[at];
  const run = (test, most) => {
    let end = at;
    while (end - at < most && test.test(source[end + 1] ?? "")) end++;
    return end;
  };
  if ("upP".includes(letter) && source[at + 1] === "{") return closing(source, "}", at + 1);
  if (letter === "u") return run(/[0-9A-Fa-f]/, 4);
  if (letter === "x") return run(/[0-9A-Fa-f]/, 2);
  if (letter === "c") return Math.min(at + 1, source.length - 1);
  if (letter === "k" && source[at + 1] === "<") return closing(source, ">", at + 1);
  if (/\d/.test(letter)) return run(/\d/, Infinity);
  return at;
}

// The index of the `)` that closes the group opened at `start`.
function groupEnd(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "[") i = classEnd(source, i + 1);
    else if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return i;
  }
  return source.length;
}

// The top-level branches of a pattern: `a|b(c|d)` is `a` and `b(c|d)`.
export function branches(source) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") i++;
    else if (ch === "[") i = classEnd(source, i + 1);
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "|" && depth === 0) { out.push(source.slice(start, i)); start = i + 1; }
  }
  out.push(source.slice(start));
  return out;
}

const ftsQuote = (text) => `"${text.replaceAll('"', '""')}"`;

// The files that can hold a match of every pattern given: the trigram table
// answers for each branch's longest literal; a branch without one leaves every file in.
function shortlist(db, patterns) {
  let all = null;
  const ask = db.prepare("SELECT path FROM body WHERE body MATCH ?");
  for (const pattern of patterns) {
    const terms = [];
    for (const branch of branches(pattern)) {
      const [longest] = requiredLiterals(branch);
      // The trigram table counts characters, not UTF-16 units.
      if (!longest || [...longest].length < 3 || !longest.isWellFormed()) return null;
      terms.push(ftsQuote(longest));
    }
    const paths = new Set(ask.all(`text : (${terms.join(" OR ")})`).map((r) => r.path));
    all = all ? new Set([...all].filter((p) => paths.has(p))) : paths;
  }
  return all;
}

// The union of shortlists; null (every file) when any of them is.
const unionOf = (lists) => (lists.some((l) => l === null) ? null : new Set(lists.flatMap((l) => [...l])));

function enclosing(db, path, line) {
  return db.prepare(
    "SELECT name, kind FROM symbols WHERE path = ? AND line <= ? AND end_line >= ? AND end_line > line ORDER BY line DESC LIMIT 1",
  ).get(path, line, line);
}

// Lines matching any of `patterns` (JavaScript regexes) in files matching `globs`.
// With several patterns and `all`, a file must match each of them somewhere.
export function search(db, { patterns, globs = [], ignoreCase = false, context = 0, limit = 200, all = false }) {
  const regexes = patterns.map((p) => sessionPattern(p, ignoreCase));
  const candidates = all ? shortlist(db, patterns) : unionOf(patterns.map((p) => shortlist(db, [p])));
  const globRes = globs.map(globToRegExp);
  const rows = candidates
    ? db.prepare("SELECT path, text FROM body").all().filter((r) => candidates.has(r.path))
    : db.prepare("SELECT path, text FROM body").all();
  const out = [];
  let hits = 0;
  const budget = searchBudget();
  try {
    for (const { path, text } of rows.sort((a, b) => a.path.localeCompare(b.path))) {
      if (globRes.length && !globRes.some((g) => g.test(path))) continue;
      const lines = text.split(/\r?\n/);
      const perPattern = regexes.map((re) => re.matchLines(lines, budget));
      if (all && perPattern.some((found) => found.length === 0)) continue;
      const matched = [...new Set(perPattern.flat())].sort((a, b) => a - b);
      if (!matched.length) continue;
      out.push({ path, hits: matched.map((i) => hit(db, path, lines, i, context)) });
      hits += matched.length;
      if (hits >= limit) break;
    }
  } catch (error) {
    if (!(error instanceof TimeUp)) throw error;
    return { files: out, truncated: true, timedOut: true };
  }
  return { files: out, truncated: hits >= limit };
}

function hit(db, path, lines, i, context) {
  const around = [];
  for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
    if (j !== i) around.push({ line: j + 1, text: lines[j] });
  }
  const symbol = enclosing(db, path, i + 1);
  return { line: i + 1, text: lines[i], symbol: symbol ? `${symbol.kind} ${symbol.name}` : null, context: around };
}

// Symbols whose name matches `query` (a regex, or a substring when it is not one).
export function symbols(db, { query, kind, globs = [], limit = 50 }) {
  let re;
  try { re = sessionPattern(query, true); } catch { re = sessionPattern(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), true); }
  const globRes = globs.map(globToRegExp);
  const rows = db.prepare("SELECT path, name, kind, line, end_line FROM symbols").all()
    .filter((r) => (!kind || r.kind === kind) && (!globRes.length || globRes.some((g) => g.test(r.path))));
  let named;
  try {
    named = new Set(re.matchLines(rows.map((r) => r.name), searchBudget()));
  } catch (error) {
    if (!(error instanceof TimeUp)) throw error;
    // A cut-off scan is not an answer: say so instead of reporting no match.
    throw new Error("FindWright stopped this symbol search after 2 s: the pattern is slow on this repo's names; narrow it.");
  }
  const found = rows.filter((_, i) => named.has(i));
  // Exact names first, then shorter names, so `search` finds `search` before `searchAll`.
  const rank = (r) => (r.name.toLowerCase() === query.toLowerCase() ? 0 : 1) * 1e6 + r.name.length;
  return found.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

export function outline(db, path) {
  return db.prepare("SELECT name, kind, line, end_line FROM symbols WHERE path = ? ORDER BY line").all(path);
}

// What the index covers: files per kind, and how many of them yielded no symbol.
export function coverage(db) {
  const rows = db.prepare("SELECT kind, COUNT(*) AS files, SUM(symbols = 0) AS bare FROM files GROUP BY kind ORDER BY files DESC").all();
  const bare = db.prepare("SELECT path, kind FROM files WHERE symbols = 0 AND kind != 'binary' ORDER BY path").all();
  return { kinds: rows, bare };
}
