// Symbols from a project's own pattern rules, the rules `.findwright/config.json` carries.
//
// A rule is { globs, kind, pattern } plus optional structure:
//   end      where the symbol's block ends:
//              "line"   (default) the match's own line
//              "brace"  the `}` closing the first `{` at or after the match, within three lines
//              "value"  the bracket closing the `{` or `[` right after the match (a JSON value)
//              "indent" the last line indented deeper than the match (an `indent` group sets the depth)
//              "next"   the line before the rule's next match whose `level` group is no longer
//              { until: <regex> }  the first later line the regex matches
//   nest     true (or a separator, "." by default): the symbol is named under the innermost
//            nesting symbol whose block holds it (`jobs.review.steps`), and can hold others
//   group    rules sharing a group claim lines: the first rule in the list to match a line takes it
//   except   names to drop (`if`, `for` for a method pattern)
//   inside   a region the rule matches only within; outside: regions it never matches in.
//            A region is { start: <regex>, end: "indent" | { until: <regex> }, first?: true } and
//            covers the lines after its start line through its end; `first` holds only on line 1.
//
// Every pattern runs on the linear-time engine, since a cloned repo can carry a hostile config,
// and a rule whose pattern that engine cannot run (back-references, lookarounds) is skipped.

import { linearRegExp } from "./linear.mjs";

// Each line is read up to this length: a declaration starts near the line's start, and a
// minified or generated line costs no more than an ordinary one.
const MAX_LINE = 1000;
const MAX_PATTERN = 300;
// A nested name past this is dropped with everything under it, which keeps deep nesting linear.
const MAX_NAME = 400;
// Most lines one file's brace and value blocks may scan in all; past it a block ends on its first line.
const SCAN_LINES = 200_000;
const OPEN_WITHIN = 3;
const MAX_SEPARATOR = 4;
const END_WORDS = new Set(["line", "brace", "value", "indent", "next"]);

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
const isPattern = (value) => typeof value === "string" && value.length <= MAX_PATTERN;

const normalUntil = (end) => (isObject(end) && isPattern(end.until) ? { until: end.until } : null);
const normalEnd = (end) => (END_WORDS.has(end) ? end : normalUntil(end) ?? "line");

// A region as the code reads it, or null when it is malformed.
function normalRegion(region) {
  if (!isObject(region) || !isPattern(region.start)) return null;
  const end = region.end === "indent" ? "indent" : normalUntil(region.end);
  return end ? { start: region.start, end, first: region.first === true } : null;
}

/** A config rule as the code reads it, or null when it cannot be read. A malformed region drops the
 * whole rule, since matching without it would name what the rule means to leave out. */
export function normalRule(rule) {
  if (!isObject(rule) || typeof rule.pattern !== "string" || typeof rule.kind !== "string") return null;
  const globs = Array.isArray(rule.globs) ? strings(rule.globs) : ["**"];
  const out = { pattern: rule.pattern, kind: rule.kind, globs, end: normalEnd(rule.end) };
  const separator = typeof rule.nest === "string" && rule.nest.length <= MAX_SEPARATOR ? rule.nest : "";
  if (rule.nest === true || separator) out.nest = separator || ".";
  if (typeof rule.group === "string") out.group = rule.group;
  if (Array.isArray(rule.except)) out.except = strings(rule.except);
  if (rule.inside !== undefined) {
    out.inside = normalRegion(rule.inside);
    if (!out.inside) return null;
  }
  if (rule.outside !== undefined) {
    out.outside = (Array.isArray(rule.outside) ? rule.outside : [rule.outside]).map(normalRegion);
    if (out.outside.some((region) => !region)) return null;
  }
  return out;
}

const compileRegion = (region) => {
  const start = linearRegExp(region.start);
  const until = region.end.until === undefined ? null : linearRegExp(region.end.until);
  return start && (until || region.end === "indent") ? { start, until, first: region.first } : null;
};

// The rule with its patterns compiled, or null when the linear engine cannot run one of them.
function compile(rule, order) {
  const pattern = isPattern(rule.pattern) ? linearRegExp(rule.pattern, "g") : null;
  const until = rule.end.until === undefined ? null : linearRegExp(rule.end.until);
  const inside = rule.inside ? compileRegion(rule.inside) : null;
  const outside = (rule.outside ?? []).map(compileRegion);
  const unreadable = (rule.end.until !== undefined && !until) || (rule.inside && !inside) || outside.includes(null);
  if (!pattern || unreadable) return null;
  return { ...rule, order, pattern, until, inside, outside, except: new Set(rule.except ?? []) };
}

const indentOf = (line) => line.length - line.trimStart().length;

// The last line (0-based) of the block that starts on `start` and runs while `isInside` holds; blank lines run on.
function blockEnd(all, start, isInside) {
  let end = start;
  for (let i = start + 1; i < all.length; i++) {
    if (all[i].trim() === "") continue;
    if (!isInside(all[i])) break;
    end = i;
  }
  return end;
}

// The last line a region opened on `start` covers.
function regionEnd(all, start, region) {
  if (!region.until) return blockEnd(all, start, (line) => indentOf(line) > indentOf(all[start]));
  for (let i = start + 1; i < all.length; i++) if (region.until.test(all[i])) return i;
  return all.length - 1;
}

// Per line, whether it lies in one of the regions.
function regionLines(all, region) {
  const covered = new Array(all.length).fill(false);
  for (let i = 0; i < all.length; i++) {
    if (region.first && i > 0) break;
    if (!region.start.test(all[i])) continue;
    const end = regionEnd(all, i, region);
    for (let j = i + 1; j <= end; j++) covered[j] = true;
    i = end;
  }
  return covered;
}

// Per line, whether the rule may match there.
function allowedLines(all, rule) {
  const inside = rule.inside ? regionLines(all, rule.inside) : null;
  const outside = rule.outside.map((region) => regionLines(all, region));
  return all.map((_, i) => (!inside || inside[i]) && !outside.some((covered) => covered[i]));
}

function matchesOf(all, rule, taken) {
  const allowed = allowedLines(all, rule);
  const found = [];
  for (let i = 0; i < all.length; i++) {
    if (!allowed[i] || taken?.has(i)) continue;
    let matched = false;
    for (const m of all[i].matchAll(rule.pattern)) {
      const name = m.groups?.name ?? m[0];
      if (!m[0] || rule.except.has(name)) continue;
      matched = true;
      const indent = m.groups?.indent === undefined ? indentOf(all[i]) : m.index + m.groups.indent.length;
      const level = m.groups?.level?.length ?? 0;
      found.push({ name, rule, line: i, col: m.index, matchEnd: m.index + m[0].length, indent, level });
    }
    if (matched) taken?.add(i);
  }
  return found;
}

// Skips the string that opens at `start` on `text`; returns the index of its closing quote.
function stringEnd(text, start) {
  let i = start + 1;
  while (i < text.length && text[i] !== text[start]) i += text[i] === "\\" ? 2 : 1;
  return i;
}

const OPENERS = { brace: "{", value: "{[" };
const CLOSERS = { brace: "}", value: "}]" };

// Where the block a symbol opens closes, as [line, col], or null when it opens none in reach.
// "value" needs `{` or `[` as the first thing after the match and closes at its bracket, so
// one-line JSON nests. "brace" counts `{` and `}` from the match's start and closes at the end
// of the first line that leaves them balanced, so a `{}` inside a parameter list ends nothing;
// a `;` before the first `{` ends the statement with no block.
function bracketEnd(all, symbol, mode, budget) {
  let depth = 0;
  let opened = false;
  for (let i = symbol.line; i < all.length; i++) {
    if (--budget.left < 0) return null;
    const text = all[i];
    for (let j = i === symbol.line ? (mode === "value" ? symbol.matchEnd : symbol.col) : 0; j < text.length; j++) {
      const ch = text[j];
      if (mode === "value" && !opened && ch.trim() && !OPENERS.value.includes(ch)) return null;
      // A statement that ends before its first brace (`int f();`, `const n = 1;`) opens no block.
      if (mode === "brace" && !opened && ch === ";") return null;
      if (ch === "/" && text[j + 1] === "/") break;
      if (ch === '"' || ch === "'" || ch === "`") j = stringEnd(text, j);
      else if (OPENERS[mode].includes(ch)) { depth++; opened = true; }
      else if (CLOSERS[mode].includes(ch)) depth--;
      if (mode === "value" && opened && depth === 0) return [i, j];
    }
    if (opened && depth <= 0) return [i, Infinity];
    if (!opened && i >= symbol.line + OPEN_WITHIN - 1) return null;
  }
  return opened ? [all.length - 1, Infinity] : null;
}

// Closes each "next" block at the line before the rule's next match of the same or a lower level.
function closeAtNext(all, symbols) {
  const open = [];
  for (const symbol of symbols) {
    while (open.length && open.at(-1).level >= symbol.level) {
      const closed = open.pop();
      closed.end = [Math.max(closed.line, symbol.line - 1), Infinity];
    }
    open.push(symbol);
  }
  for (const symbol of open) symbol.end = [all.length - 1, Infinity];
}

function untilEnd(all, symbol, until, budget) {
  for (let i = symbol.line + 1; i < all.length; i++) {
    if (--budget.left < 0) return [symbol.line, Infinity];
    if (until.test(all[i])) return [i, Infinity];
  }
  return [all.length - 1, Infinity];
}

// Sets `end` ([line, col], 0-based) on each of one rule's symbols.
function setEnds(all, rule, symbols, budget) {
  if (rule.end === "next") return closeAtNext(all, symbols);
  for (const symbol of symbols) {
    const own = [symbol.line, symbol.matchEnd];
    if (rule.end === "brace" || rule.end === "value") symbol.end = bracketEnd(all, symbol, rule.end, budget) ?? own;
    else if (rule.end === "indent") {
      symbol.end = [blockEnd(all, symbol.line, (line) => indentOf(line) > symbol.indent), Infinity];
    }
    else if (rule.until) symbol.end = untilEnd(all, symbol, rule.until, budget);
    else symbol.end = own;
  }
}

const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

// Names each nesting rule's symbol under the innermost nesting symbol whose block holds its start.
function nestNames(symbols) {
  symbols.sort((a, b) => a.line - b.line || a.col - b.col || a.rule.order - b.rule.order);
  const open = [];
  const kept = [];
  for (const symbol of symbols) {
    const start = [symbol.line, symbol.col];
    while (open.length && !before(start, open.at(-1).end)) open.pop();
    if (symbol.rule.nest) {
      const parent = open.at(-1);
      const name = parent ? `${parent.fullName}${symbol.rule.nest}${symbol.name}` : symbol.name;
      symbol.fullName = parent?.fullName === null || name.length > MAX_NAME ? null : name;
      open.push(symbol);
    } else symbol.fullName = symbol.name;
    if (symbol.fullName !== null) kept.push(symbol);
  }
  return kept;
}

/** The symbols `rules` name in `text`, each { name, kind, line, endLine } with 1-based, inclusive lines. */
export function fromRules(text, rules) {
  const all = text.split(/\r?\n/).map((line) => line.slice(0, MAX_LINE));
  const budget = { left: SCAN_LINES };
  const claimed = new Map();
  const symbols = [];
  rules.forEach((rule, order) => {
    const normal = normalRule(rule);
    const compiled = normal && compile(normal, order);
    if (!compiled) return;
    if (compiled.group && !claimed.has(compiled.group)) claimed.set(compiled.group, new Set());
    const found = matchesOf(all, compiled, claimed.get(compiled.group));
    setEnds(all, compiled, found, budget);
    for (const symbol of found) symbols.push(symbol);
  });
  return nestNames(symbols)
    .map((s) => ({ name: s.fullName, kind: s.rule.kind, line: s.line + 1, endLine: s.end[0] + 1 }));
}
