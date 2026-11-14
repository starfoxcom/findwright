// Symbol extractors: each takes a file's text and returns its symbols as
// { name, kind, line, endLine } with 1-based, inclusive line numbers. They read
// structure from the text alone (headings, keys, declarations), so a file that
// does not parse still yields what can be read from it. Every pattern runs on the
// linear-time engine, and lines past MAX_LINE (minified or generated text, never a
// declaration) are read as blank, so no file can make extraction slow.

import { linear } from "./linear.mjs";

const MAX_LINE = 1000;
const lines = (text) => text.split(/\r?\n/).map((line) => (line.length > MAX_LINE ? "" : line));

// The last line of a block that starts at `start` and runs while `isInside` holds.
function blockEnd(all, start, isInside) {
  let end = start;
  for (let i = start + 1; i < all.length; i++) {
    if (all[i].trim() === "") continue;
    if (!isInside(all[i])) break;
    end = i;
  }
  return end + 1;
}

const indentOf = (line) => line.length - line.trimStart().length;

const FRONT_MATTER_KEY = linear(/^([A-Za-z][\w-]*):/);
const FENCE = linear(/^\s*(```|~~~)/);
const HEADING = linear(/^(#{1,6})\s+(.+?)\s*#*\s*$/);

// Markdown: headings outside code fences, each running to the next heading of
// the same or a higher level; front-matter keys at the top.
export function markdown(text) {
  const all = lines(text);
  const found = [];
  let fence = null;
  let start = 0;
  if (all[0]?.trim() === "---") {
    for (let i = 1; i < all.length && all[i].trim() !== "---"; i++) {
      const key = FRONT_MATTER_KEY.exec(all[i]);
      if (key) found.push({ name: key[1], kind: "front-matter", line: i + 1, endLine: i + 1 });
      start = i + 1;
    }
  }
  const open = [];
  for (let i = start; i < all.length; i++) {
    const fenceMark = FENCE.exec(all[i]);
    if (fenceMark) fence = fence === fenceMark[1] ? null : (fence ?? fenceMark[1]);
    const heading = !fence && HEADING.exec(all[i]);
    if (!heading) continue;
    const level = heading[1].length;
    while (open.length && open.at(-1).level >= level) open.pop().symbol.endLine = i;
    const symbol = { name: heading[2], kind: `h${level}`, line: i + 1, endLine: all.length };
    open.push({ level, symbol });
    found.push(symbol);
  }
  return found;
}

const YAML_ITEM = linear(/^(\s*)-\s+name:\s*["']?(.+?)["']?\s*$/);
const YAML_KEY = linear(/^(\s*)(?:-\s+)?["']?([\w.$/@-]+)["']?\s*:(?:\s|$)(.*)$/);
const BLOCK_SCALAR = linear(/^[|>][-+]?\s*$/);

// YAML: every mapping key, named by its path (`jobs.review.steps`), plus each
// list item's `name:`. Block scalars (`|`, `>`) are skipped as text.
export function yaml(text) {
  const all = lines(text);
  const found = [];
  const path = [];
  let scalarIndent = -1;
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    if (scalarIndent >= 0 && indent > scalarIndent) continue;
    scalarIndent = -1;
    const item = YAML_ITEM.exec(line);
    if (item) {
      found.push({ name: item[2], kind: "item", line: i + 1, endLine: blockEnd(all, i, (l) => indentOf(l) > indent) });
    }
    const key = YAML_KEY.exec(line);
    if (!key) continue;
    const depth = key[1].length + (line.trimStart().startsWith("- ") ? 2 : 0);
    while (path.length && path.at(-1).depth >= depth) path.pop();
    path.push({ depth, name: key[2] });
    const name = path.map((p) => p.name).join(".");
    found.push({ name, kind: "key", line: i + 1, endLine: blockEnd(all, i, (l) => indentOf(l) > indent) });
    if (BLOCK_SCALAR.test(key[3].trim())) scalarIndent = indent;
  }
  return found;
}

const MAX_KEY_PATH = 400;

// JSON: object keys by path (`hooks.PreToolUse`), read token by token so a
// one-line file and a file that does not parse (a template with placeholders)
// both yield their keys. A key's block runs to the bracket that closes its value.
// Each open bracket holds its full path, so a key costs its own length; a key
// whose path passes MAX_KEY_PATH is skipped with everything under it, which keeps
// deep nesting linear.
export function json(text) {
  const found = [];
  const stack = [];
  let line = 1;
  let pending = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") line++;
    else if (ch === '"') {
      const end = stringEnd(text, i);
      const after = /^\s*:/.exec(text.slice(end + 1, end + 40));
      if (after) pending = key(parentPath(stack), text.slice(i, end + 1), line, found);
      i = end;
    } else if (ch === "{" || ch === "[") {
      stack.push(pending ?? { path: parentPath(stack), symbol: null });
      pending = null;
    } else if (ch === "}" || ch === "]") {
      const frame = stack.pop();
      if (frame?.symbol) frame.symbol.endLine = line;
    } else if (ch === ",") pending = null;
  }
  return found;
}

// Records a key under `parent` (null once a path is too long) and returns the
// frame its value's bracket opens.
// The path keys under the innermost open bracket take: "" at the top, null when too long.
const parentPath = (stack) => (stack.length ? stack.at(-1).path : "");

function key(parent, quoted, line, found) {
  if (parent === null || quoted.length > MAX_KEY_PATH) return { path: null, symbol: null };
  const name = parent ? `${parent}.${unquote(quoted)}` : unquote(quoted);
  if (name.length > MAX_KEY_PATH) return { path: null, symbol: null };
  const symbol = { name, kind: "key", line, endLine: line };
  found.push(symbol);
  return { path: name, symbol };
}

function unquote(quoted) {
  try {
    return JSON.parse(quoted);
  } catch {
    return quoted.slice(1, -1);
  }
}

function stringEnd(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"' || text[i] === "\n") return i;
  }
  return text.length - 1;
}

// The braces of a line outside its strings and its `//` comment: +1 per `{`, -1 per `}`, and whether it opened one.
function braceCount(line) {
  let delta = 0;
  let opened = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === '"' || ch === "'" || ch === "`") {
      while (++i < line.length && line[i] !== ch) if (line[i] === "\\") i++;
    } else if (ch === "{") { delta++; opened = true; } else if (ch === "}") delta--;
  }
  return { delta, opened };
}

// Most lines one file's brace blocks may scan in all: past it a block ends on its first line,
// so a file of blocks that never close costs no more than this.
const BRACE_SCAN_LINES = 200_000;
const braceBudget = () => ({ left: BRACE_SCAN_LINES });

// The line where the brace block opened on `start` closes; the start line itself when it opens none.
function braceEnd(all, start, budget) {
  let depth = 0;
  let opened = false;
  for (let i = start; i < all.length; i++) {
    if (--budget.left < 0) return start + 1;
    const count = braceCount(all[i]);
    depth += count.delta;
    opened ||= count.opened;
    if (opened && depth <= 0) return i + 1;
    if (!opened && i > start + 2) return start + 1;
  }
  return all.length;
}

const firstGroup = (m) => m[1];

const JS_RULES = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, "function"],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "const"],
  [/^\s+(?:static\s+|async\s+|get\s+|set\s+|private\s+|public\s+|protected\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/, "method"],
  [/^\s*on\(\s*['"]([\w.]+)['"]/, "hook"],
  [/^\s*test\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/, "test", (m) => m[1] ?? m[2] ?? m[3]],
].map(([pattern, kind, nameOf = firstGroup]) => [linear(pattern), kind, nameOf]);

const RESERVED = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else"]);

// JavaScript and TypeScript: declarations, methods, engine hooks and tests.
export function javascript(text) {
  const all = lines(text);
  const found = [];
  const budget = braceBudget();
  for (let i = 0; i < all.length; i++) {
    for (const [rule, kind, nameOf] of JS_RULES) {
      const match = rule.exec(all[i]);
      if (!match || RESERVED.has(nameOf(match))) continue;
      found.push({ name: nameOf(match), kind, line: i + 1, endLine: braceEnd(all, i, budget) });
      break;
    }
  }
  return found;
}

const PY_DEF = linear(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
const PY_CONST = linear(/^([A-Z_][A-Z0-9_]*)\s*=/);

// Python: classes, functions and methods by indentation, plus module-level names.
export function python(text) {
  const all = lines(text);
  const found = [];
  for (let i = 0; i < all.length; i++) {
    const def = PY_DEF.exec(all[i]);
    const name = PY_CONST.exec(all[i]);
    if (def) {
      const indent = def[1].length;
      const kind = def[2] === "class" ? "class" : indent ? "method" : "function";
      found.push({ name: def[3], kind, line: i + 1, endLine: blockEnd(all, i, (l) => indentOf(l) > indent) });
    } else if (name) {
      found.push({ name: name[1], kind: "const", line: i + 1, endLine: i + 1 });
    }
  }
  return found;
}

const CSS_RULE = linear(/^\s*([^{}/@][^{}]*?)\s*\{/);
const CSS_PROPERTY = linear(/^\s*(--[\w-]+)\s*:/);

// CSS: rule selectors and custom properties.
export function css(text) {
  const all = lines(text);
  const found = [];
  const budget = braceBudget();
  for (let i = 0; i < all.length; i++) {
    const rule = CSS_RULE.exec(all[i]);
    const prop = CSS_PROPERTY.exec(all[i]);
    if (rule) found.push({ name: rule[1], kind: "selector", line: i + 1, endLine: braceEnd(all, i, budget) });
    if (prop) found.push({ name: prop[1], kind: "property", line: i + 1, endLine: i + 1 });
  }
  return found;
}

const HTML_ID = linear(/\bid="([^"]+)"/g);
const HTML_TEXT_KEY = linear(/\bdata-i18n(?:-[\w-]+)?="([^"]+)"/g);

// HTML: element ids and text keys (`data-i18n`).
export function html(text) {
  const all = lines(text);
  const found = [];
  for (let i = 0; i < all.length; i++) {
    for (const m of all[i].matchAll(HTML_ID)) found.push({ name: m[1], kind: "id", line: i + 1, endLine: i + 1 });
    for (const m of all[i].matchAll(HTML_TEXT_KEY)) {
      found.push({ name: m[1], kind: "text-key", line: i + 1, endLine: i + 1 });
    }
  }
  return found;
}

const SHELL_FUNCTION = linear(/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/);

// Shell: function definitions.
export function shell(text) {
  const all = lines(text);
  const found = [];
  const budget = braceBudget();
  for (let i = 0; i < all.length; i++) {
    const fn = SHELL_FUNCTION.exec(all[i]);
    if (fn) found.push({ name: fn[1], kind: "function", line: i + 1, endLine: braceEnd(all, i, budget) });
  }
  return found;
}

export const EXTRACTORS = { markdown, yaml, json, javascript, python, css, html, shell };
