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
//   name     the `name` group names the symbol; alternatives can use `name2`, `name3` and so on
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

const MAX_PATTERN = 300;
// A nested name past this is dropped with everything under it, which keeps deep nesting linear.
const MAX_NAME = 400;
// The searches after a rule's first on a line may read this many times the line's length in all:
// each can read to the end of the line, so this keeps matching linear in the file's size.
const REPEAT_READS = 32;
const OPEN_WITHIN = 3;
const MAX_SEPARATOR = 4;
// Most `outside` regions one rule may list; a rule past it is dropped, so a config cannot make
// one file's scan cost more than a few passes per rule.
const MAX_REGIONS = 8;
const END_WORDS = new Set(["line", "brace", "value", "indent", "next"]);

/** True for a plain JSON object: not null, not an array. */
export const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** The strings of a JSON array, or none when it is not one. */
export const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
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
    if (out.outside.length > MAX_REGIONS || out.outside.some((region) => !region)) return null;
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

/** How far a line is indented, in characters. */
export const indentOf = (line) => line.length - line.trimStart().length;

const isBlank = (line) => line.trim() === "";

// The last line a region opened on `start` covers: its `until` line, or for "indent" the line
// before the first filled line indented no deeper than the start (blank lines before it included).
function regionEnd(all, start, region) {
  const depth = indentOf(all[start]);
  for (let i = start + 1; i < all.length; i++) {
    if (region.until ? region.until.test(all[i]) : !isBlank(all[i]) && indentOf(all[i]) <= depth) {
      return region.until ? i : i - 1;
    }
  }
  return all.length - 1;
}

// Sets `mask` to `value` on every line the region covers. The search for the next start resumes
// after each region, so every line is read once per region.
function markRegion(all, region, mask, value) {
  for (let i = 0; i < all.length; i++) {
    if (region.first && i > 0) break;
    if (!region.start.test(all[i])) continue;
    const end = regionEnd(all, i, region);
    mask.fill(value, i + 1, end + 1);
    i = end;
  }
}

// Fills `mask`, one entry per line, with whether the rule may match there: inside its `inside`
// region (anywhere without one) and in none of its `outside` regions. One mask serves every rule
// of a file in turn, so memory stays one byte per line however many rules and regions there are.
function markAllowed(all, rule, mask) {
  mask.fill(rule.inside ? 0 : 1);
  if (rule.inside) markRegion(all, rule.inside, mask, 1);
  for (const region of rule.outside) markRegion(all, region, mask, 0);
}

// The `name` group, else the first of `name2`, `name3` ... that took part (one per alternative),
// else the whole match.
function nameOf(match) {
  const groups = match.groups ?? {};
  const key = Object.keys(groups).find((k) => /^name\d*$/.test(k) && groups[k] !== undefined);
  return key ? groups[key] : match[0];
}

function matchesOf(all, rule, taken, allowed) {
  markAllowed(all, rule, allowed);
  const found = [];
  for (let i = 0; i < all.length; i++) {
    if (!allowed[i] || taken?.has(i)) continue;
    let matched = false;
    let reads = REPEAT_READS * all[i].length;
    for (const m of all[i].matchAll(rule.pattern)) {
      const name = nameOf(m);
      const matchEnd = m.index + m[0].length;
      if (m[0] && !rule.except.has(name)) {
        matched = true;
        const indent = m.groups?.indent === undefined ? indentOf(all[i]) : m.index + m.groups.indent.length;
        found.push({ name, rule, line: i, col: m.index, matchEnd, indent, level: m.groups?.level?.length ?? 0 });
      }
      // The next search can read the rest of the line, so each one after the first spends it.
      reads -= all[i].length - matchEnd;
      if (reads < 0) break;
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

// Each code character of `text` from `from` as [index, character], up to a `//` comment. A string
// comes out once, as its opening quote, so nothing inside it counts as a bracket.
function* codeChars(text, from) {
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (ch === "/" && text[j + 1] === "/") return;
    yield [j, ch];
    if (ch === '"' || ch === "'" || ch === "`") j = stringEnd(text, j);
  }
}

// Open blocks keyed by the level that closes them, highest first, so a pass closes every block a
// line reaches in one step however the blocks were opened.
class OpenBlocks {
  #items = [];

  get size() {
    return this.#items.length;
  }

  add(key, symbol) {
    const items = this.#items;
    items.push([key, symbol]);
    for (let i = items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] >= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  // Removes and returns every symbol whose key is `level` or more.
  closeAt(level) {
    const closed = [];
    while (this.#items.length && this.#items[0][0] >= level) closed.push(this.#take());
    return closed;
  }

  // Removes and returns every symbol left.
  rest() {
    const left = this.#items.map(([, symbol]) => symbol);
    this.#items = [];
    return left;
  }

  #take() {
    const items = this.#items;
    const top = items[0][1];
    const last = items.pop();
    if (!items.length) return top;
    items[0] = last;
    for (let i = 0; ;) {
      let high = i;
      for (const child of [2 * i + 1, 2 * i + 2]) {
        if (child < items.length && items[child][0] > items[high][0]) high = child;
      }
      if (high === i) return top;
      [items[high], items[i]] = [items[i], items[high]];
      i = high;
    }
  }
}

// Ends every block of one rule in a single pass over the file, the way an editor pairs brackets:
// one walk with the blocks still open, never a scan per symbol. Each pass takes one rule's
// symbols in file order and leaves a symbol that opens no block at its own match.

// "brace": a symbol counts `{` and `}` from its match and closes at the end of the first line
// that leaves them balanced, so a `{}` inside a parameter list ends nothing; a `;` before its
// first `{` (`int f();`), or no `{` within three lines, means no block. `depth` counts every
// brace, so a symbol's own count is `depth` less the depth where it matched.
function braceEnds(all, symbols) {
  const open = new OpenBlocks();
  let waiting = [];
  let next = 0;
  let depth = 0;
  const arrive = (i, col) => {
    while (next < symbols.length && symbols[next].line === i && symbols[next].col <= col) {
      waiting.push({ symbol: symbols[next++], from: depth });
    }
  };
  for (let i = symbols[0]?.line ?? all.length; i < all.length; i++) {
    for (const [j, ch] of codeChars(all[i], 0)) {
      arrive(i, j);
      if (ch === ";") waiting = [];
      else if (ch === "}") depth--;
      else if (ch === "{") {
        for (const { symbol, from } of waiting) open.add(from, symbol);
        waiting = [];
        depth++;
      }
    }
    arrive(i, Infinity);
    for (const symbol of open.closeAt(depth)) symbol.end = [i, Infinity];
    waiting = waiting.filter(({ symbol }) => i < symbol.line + OPEN_WITHIN - 1);
    if (!open.size && !waiting.length) {
      if (next === symbols.length) return;
      i = symbols[next].line - 1;
    }
  }
  for (const symbol of open.rest()) symbol.end = [all.length - 1, Infinity];
}

// "value": the first thing after a symbol's match must be `{` or `[` (within three lines), and
// the block closes at that bracket's own closing bracket, so one-line JSON nests.
function valueEnds(all, symbols) {
  const brackets = [];
  let waiting = [];
  let next = 0;
  let live = 0;
  const arrive = (i, col) => {
    while (next < symbols.length && symbols[next].line === i && symbols[next].matchEnd <= col) {
      waiting.push(symbols[next++]);
    }
  };
  for (let i = symbols[0]?.line ?? all.length; i < all.length; i++) {
    for (const [j, ch] of codeChars(all[i], 0)) {
      arrive(i, j);
      if (!ch.trim()) continue;
      const opens = ch === "{" || ch === "[";
      if (opens) {
        brackets.push(waiting);
        live += waiting.length;
      }
      waiting = [];
      if ((ch === "}" || ch === "]") && brackets.length) {
        const closed = brackets.pop();
        for (const symbol of closed) symbol.end = [i, j];
        live -= closed.length;
      }
    }
    arrive(i, Infinity);
    waiting = waiting.filter((symbol) => i < symbol.line + OPEN_WITHIN - 1);
    if (!live && !waiting.length) {
      if (next === symbols.length) return;
      brackets.length = 0;
      i = symbols[next].line - 1;
    }
  }
  for (const symbol of brackets.flat()) symbol.end = [all.length - 1, Infinity];
}

// "indent": a block runs through the last filled line indented deeper than the symbol, past
// blank lines.
function indentEnds(all, symbols) {
  const open = new OpenBlocks();
  let next = 0;
  let lastFilled = -1;
  const close = (symbol) => { symbol.end = [Math.max(symbol.line, lastFilled), Infinity]; };
  for (let i = symbols[0]?.line ?? all.length; i < all.length; i++) {
    const filled = !isBlank(all[i]);
    if (filled) open.closeAt(indentOf(all[i])).forEach(close);
    while (next < symbols.length && symbols[next].line === i) open.add(symbols[next].indent, symbols[next++]);
    if (filled) lastFilled = i;
    if (!open.size) {
      if (next === symbols.length) return;
      i = symbols[next].line - 1;
    }
  }
  open.rest().forEach(close);
}

// { until }: every open block closes at the first later line the pattern matches.
function untilEnds(all, symbols, until) {
  let open = [];
  let next = 0;
  for (let i = symbols[0]?.line ?? all.length; i < all.length; i++) {
    if (open.length && until.test(all[i])) {
      for (const symbol of open) symbol.end = [i, Infinity];
      open = [];
    }
    while (next < symbols.length && symbols[next].line === i) open.push(symbols[next++]);
    if (!open.length) {
      if (next === symbols.length) return;
      i = symbols[next].line - 1;
    }
  }
  for (const symbol of open) symbol.end = [all.length - 1, Infinity];
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

// Sets `end` ([line, col], 0-based) on each of one rule's symbols, which come in file order.
function setEnds(all, rule, symbols) {
  for (const symbol of symbols) symbol.end = [symbol.line, symbol.matchEnd];
  if (rule.end === "next") closeAtNext(all, symbols);
  else if (rule.end === "brace") braceEnds(all, symbols);
  else if (rule.end === "value") valueEnds(all, symbols);
  else if (rule.end === "indent") indentEnds(all, symbols);
  else if (rule.until) untilEnds(all, symbols, rule.until);
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
  const all = text.split(/\r?\n/);
  const allowed = new Uint8Array(all.length);
  const claimed = new Map();
  const symbols = [];
  rules.forEach((rule, order) => {
    const normal = normalRule(rule);
    const compiled = normal && compile(normal, order);
    if (!compiled) return;
    if (compiled.group && !claimed.has(compiled.group)) claimed.set(compiled.group, new Set());
    const found = matchesOf(all, compiled, claimed.get(compiled.group), allowed);
    setEnds(all, compiled, found);
    for (const symbol of found) symbols.push(symbol);
  });
  return nestNames(symbols)
    .map((s) => ({ name: s.fullName, kind: s.rule.kind, line: s.line + 1, endLine: s.end[0] + 1 }));
}
