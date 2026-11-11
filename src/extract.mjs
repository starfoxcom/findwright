// Symbol extractors: each takes a file's text and returns its symbols as
// { name, kind, line, endLine } with 1-based, inclusive line numbers. They read
// structure from the text alone (headings, keys, declarations), so a file that
// does not parse still yields what can be read from it.

import v8 from "node:v8";

const lines = (text) => text.split(/\r?\n/);

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

// Markdown: headings outside code fences, each running to the next heading of
// the same or a higher level; front-matter keys at the top.
export function markdown(text) {
  const all = lines(text);
  const found = [];
  let fence = null;
  let start = 0;
  if (all[0]?.trim() === "---") {
    for (let i = 1; i < all.length && all[i].trim() !== "---"; i++) {
      const key = /^([A-Za-z][\w-]*):/.exec(all[i]);
      if (key) found.push({ name: key[1], kind: "front-matter", line: i + 1, endLine: i + 1 });
      start = i + 1;
    }
  }
  const open = [];
  for (let i = start; i < all.length; i++) {
    const fenceMark = /^\s*(```|~~~)/.exec(all[i]);
    if (fenceMark) fence = fence === fenceMark[1] ? null : (fence ?? fenceMark[1]);
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(all[i]);
    if (!heading) continue;
    const level = heading[1].length;
    while (open.length && open.at(-1).level >= level) open.pop().symbol.endLine = i;
    const symbol = { name: heading[2], kind: `h${level}`, line: i + 1, endLine: all.length };
    open.push({ level, symbol });
    found.push(symbol);
  }
  return found;
}

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
    const item = /^(\s*)-\s+name:\s*["']?(.+?)["']?\s*$/.exec(line);
    if (item) {
      found.push({ name: item[2], kind: "item", line: i + 1, endLine: blockEnd(all, i, (l) => indentOf(l) > indent) });
    }
    const key = /^(\s*)(?:-\s+)?["']?([\w.$/@-]+)["']?\s*:(?:\s|$)(.*)$/.exec(line);
    if (!key) continue;
    const depth = key[1].length + (line.trimStart().startsWith("- ") ? 2 : 0);
    while (path.length && path.at(-1).depth >= depth) path.pop();
    path.push({ depth, name: key[2] });
    const name = path.map((p) => p.name).join(".");
    found.push({ name, kind: "key", line: i + 1, endLine: blockEnd(all, i, (l) => indentOf(l) > indent) });
    if (/^[|>][-+]?\s*$/.test(key[3].trim())) scalarIndent = indent;
  }
  return found;
}

// JSON: object keys by path (`hooks.PreToolUse`), read token by token so a
// one-line file and a file that does not parse (a template with placeholders)
// both yield their keys. A key's block runs to the bracket that closes its value.
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
      if (after) {
        const path = [...stack.map((s) => s.key).filter(Boolean), unquote(text.slice(i, end + 1))];
        pending = { name: path.join("."), kind: "key", line, endLine: line };
        found.push(pending);
      }
      i = end;
    } else if (ch === "{" || ch === "[") {
      stack.push({ key: pending ? pending.name.split(".").at(-1) : null, symbol: pending });
      pending = null;
    } else if (ch === "}" || ch === "]") {
      const frame = stack.pop();
      if (frame?.symbol) frame.symbol.endLine = line;
    } else if (ch === ",") pending = null;
  }
  return found;
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

// The line where the brace block opened on `start` closes, counting braces
// outside strings and comments; the start line itself when it opens none.
function braceEnd(all, start) {
  let depth = 0;
  let opened = false;
  for (let i = start; i < all.length; i++) {
    const code = all[i].replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "''");
    for (const ch of code) {
      if (ch === "{") { depth++; opened = true; }
      if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return i + 1;
    if (!opened && i > start + 2) return start + 1;
  }
  return all.length;
}

const JS_RULES = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, "function"],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "const"],
  [/^\s+(?:static\s+|async\s+|get\s+|set\s+|private\s+|public\s+|protected\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/, "method"],
  [/^\s*on\(\s*['"]([\w.]+)['"]/, "hook"],
  [/^\s*test\(\s*(['"`])(.+?)\1/, "test", 2],
];

const RESERVED = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else"]);

// JavaScript and TypeScript: declarations, methods, engine hooks and tests.
export function javascript(text) {
  const all = lines(text);
  const found = [];
  for (let i = 0; i < all.length; i++) {
    for (const [rule, kind, group = 1] of JS_RULES) {
      const match = rule.exec(all[i]);
      if (!match || RESERVED.has(match[group])) continue;
      found.push({ name: match[group], kind, line: i + 1, endLine: braceEnd(all, i) });
      break;
    }
  }
  return found;
}

// Python: classes, functions and methods by indentation, plus module-level names.
export function python(text) {
  const all = lines(text);
  const found = [];
  for (let i = 0; i < all.length; i++) {
    const def = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(all[i]);
    const name = /^([A-Z_][A-Z0-9_]*)\s*=/.exec(all[i]);
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

// CSS: rule selectors and custom properties.
export function css(text) {
  const all = lines(text);
  const found = [];
  for (let i = 0; i < all.length; i++) {
    const rule = /^\s*([^{}/@][^{}]*?)\s*\{/.exec(all[i]);
    const prop = /^\s*(--[\w-]+)\s*:/.exec(all[i]);
    if (rule) found.push({ name: rule[1], kind: "selector", line: i + 1, endLine: braceEnd(all, i) });
    if (prop) found.push({ name: prop[1], kind: "property", line: i + 1, endLine: i + 1 });
  }
  return found;
}

// HTML: element ids, text keys (`data-i18n`) and headings.
export function html(text) {
  const all = lines(text);
  const found = [];
  for (let i = 0; i < all.length; i++) {
    for (const m of all[i].matchAll(/\bid="([^"]+)"/g)) found.push({ name: m[1], kind: "id", line: i + 1, endLine: i + 1 });
    for (const m of all[i].matchAll(/\bdata-i18n(?:-[\w-]+)?="([^"]+)"/g)) {
      found.push({ name: m[1], kind: "text-key", line: i + 1, endLine: i + 1 });
    }
  }
  return found;
}

// Shell: function definitions.
export function shell(text) {
  const all = lines(text);
  const found = [];
  for (let i = 0; i < all.length; i++) {
    const fn = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/.exec(all[i]);
    if (fn) found.push({ name: fn[1], kind: "function", line: i + 1, endLine: braceEnd(all, i) });
  }
  return found;
}

export const EXTRACTORS = { markdown, yaml, json, javascript, python, css, html, shell };

// Symbols from the project's own pattern rules: each rule's regex runs on every
// line of the files its globs match, and its `name` group (or the whole match) names the symbol.
// A rule comes from the repo's own config, so a cloned repo can carry a hostile one.
// Rules run on V8's linear-time engine (the `l` flag, the same guarantee RE2 and
// ripgrep give): no pattern can backtrack, so none can hang the index. A pattern
// that engine cannot run (back-references, lookarounds) is skipped, and so is
// every rule if the engine is missing.
v8.setFlagsFromString("--enable-experimental-regexp-engine");
const MAX_RULE_LINE = 400;

function rulePattern(source) {
  if (typeof source !== "string" || source.length > 300) return null;
  try {
    return new RegExp(source, "gl");
  } catch {
    return null;
  }
}

export function fromRules(text, rules) {
  const all = lines(text);
  const found = [];
  for (const rule of rules) {
    const pattern = rulePattern(rule.pattern);
    if (!pattern) continue;
    for (let i = 0; i < all.length; i++) {
      if (all[i].length > MAX_RULE_LINE) continue;
      for (const m of all[i].matchAll(pattern)) {
        found.push({ name: m.groups?.name ?? m[0], kind: rule.kind, line: i + 1, endLine: i + 1 });
      }
    }
  }
  return found;
}
