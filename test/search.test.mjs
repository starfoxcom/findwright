import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { search, symbols } from "../src/query.mjs";

function index(files) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE symbols (path TEXT, name TEXT, kind TEXT, line INTEGER, end_line INTEGER);
    CREATE VIRTUAL TABLE body USING fts5(path UNINDEXED, text, tokenize = 'trigram');`);
  for (const [path, text] of Object.entries(files)) db.prepare("INSERT INTO body VALUES (?, ?)").run(path, text);
  return db;
}

test("a long line is searched at once, and ignoring case finds every spelling", () => {
  const db = index({ "big.txt": "fooError " + "a".repeat(2_000_000), "small.txt": "a FooError here" });
  const start = performance.now();
  assert.deepEqual(search(db, { patterns: [String.raw`\w+Error`] }).files.map((f) => f.path), ["big.txt", "small.txt"]);
  assert.deepEqual(search(db, { patterns: ["FOOERROR"], ignoreCase: true }).files.map((f) => f.path), ["big.txt", "small.txt"]);
  assert.ok(performance.now() - start < 3000, `took ${Math.round(performance.now() - start)} ms`);
});

test("a pattern that would stall stops at the search budget and says so", () => {
  const db = index({ "h.md": "a".repeat(40) + "!", "z.md": "plain" });
  const start = performance.now();
  const result = search(db, { patterns: ["(a+)+$"], ignoreCase: true });
  assert.equal(result.timedOut, true);
  assert.ok(performance.now() - start < 3000, `took ${Math.round(performance.now() - start)} ms`);
});

test("patterns the linear engine refuses still run: escapes under ignore-case, counts, back-references", () => {
  const db = index({ "a.txt": "Value 42 ABAB", "b.txt": "VALUE x", "c.txt": "sha 0123456789abcdef0123456789abcdef01234567" });
  const paths = (patterns, ignoreCase = false) => search(db, { patterns, ignoreCase }).files.map((f) => f.path);
  assert.deepEqual(paths([String.raw`value \d+`], true), ["a.txt"]);
  assert.deepEqual(paths([String.raw`VALUE \D`], true), ["b.txt"]);
  assert.deepEqual(paths([String.raw`\x41BAB`], true), ["a.txt"]);
  assert.deepEqual(paths([String.raw`[0-9a-f]{40}`]), ["c.txt"]);
  assert.deepEqual(paths([String.raw`(AB)\1`]), ["a.txt"]);
});

test("a symbol query cannot stall on a long name", () => {
  const db = index({});
  db.prepare("INSERT INTO symbols VALUES (?, ?, ?, ?, ?)").run("a.md", "a".repeat(40) + "!", "h1", 1, 1);
  db.prepare("INSERT INTO symbols VALUES (?, ?, ?, ?, ?)").run("b.md", "Refresh", "h1", 1, 1);
  const start = performance.now();
  assert.throws(() => symbols(db, { query: "(a+)+$" }), /stopped this symbol search/);
  assert.ok(performance.now() - start < 3000, `took ${Math.round(performance.now() - start)} ms`);
  assert.deepEqual(symbols(db, { query: "refresh" }).map((s) => s.path), ["b.md"]);
  assert.deepEqual(symbols(db, { query: "fresh(" }).map((s) => s.path), []);
});

test("a literal of one emoji and one other character still finds its files", () => {
  const db = index({ "a.md": "status 🔴 here", "b.md": "nothing" });
  assert.deepEqual(search(db, { patterns: ["🔴 "] }).files.map((f) => f.path), ["a.md"]);
  assert.deepEqual(search(db, { patterns: ["ab😀*c"] }).files.map((f) => f.path), []);
  const emoji = index({ "c.md": "xab😀cx" });
  assert.deepEqual(search(emoji, { patterns: ["ab😀*c"] }).files.map((f) => f.path), ["c.md"]);
});

test("a glob starting with ! leaves out the files it matches, in search and symbols alike", () => {
  const paths = ["CHANGELOG.md", "src/a.mjs", "src/b.md", "docs/c.md"];
  const db = index(Object.fromEntries(paths.map((path) => [path, "sendDue"])));
  for (const path of paths) {
    db.prepare("INSERT INTO symbols VALUES (?, ?, ?, ?, ?)").run(path, "sendDue", "function", 1, 1);
  }
  const rows = [
    ["a negated glob alone keeps every other file", ["!CHANGELOG.md"], ["docs/c.md", "src/a.mjs", "src/b.md"]],
    ["several negated globs leave out each", ["!CHANGELOG.md", "!docs/**"], ["src/a.mjs", "src/b.md"]],
    ["a negated glob beside a plain one narrows it", ["*.md", "!CHANGELOG.md"], ["docs/c.md", "src/b.md"]],
    ["a plain glob alone keeps only its files", ["src/**"], ["src/a.mjs", "src/b.md"]],
  ];
  for (const [name, globs, expected] of rows) {
    const searched = search(db, { patterns: ["sendDue"], globs }).files.map((f) => f.path);
    assert.deepEqual(searched, expected, `search: ${name}`);
    const named = symbols(db, { query: "sendDue", globs }).map((s) => s.path).sort();
    assert.deepEqual(named, expected, `symbols: ${name}`);
  }
});

test("a hit on a very long line returns a window around the match, and short lines stay whole", () => {
  const filler = '"key": "' + "x".repeat(170_000) + '", ';
  const db = index({
    "pristine.json": `{\n${filler}"version": "7.3.0", ${filler}\n}`,
    "short.md": "the version line",
  });
  const [long] = search(db, { patterns: ['"version":'], context: 1 }).files;
  const [hit] = long.hits;
  assert.ok(hit.text.length <= 402, `returned ${hit.text.length} chars`);
  assert.ok(hit.text.startsWith("…") && hit.text.endsWith("…"));
  assert.ok(hit.text.includes('"version": "7.3.0"'));
  assert.deepEqual(hit.context.map((c) => c.text), ["{", "}"]);
  const ignored = search(db, { patterns: ['"VERSION":'], ignoreCase: true }).files[0].hits[0];
  assert.ok(ignored.text.includes('"version": "7.3.0"'));
  const placed = [
    ["a pattern with no literal run", "\\d+\\.\\d+\\.\\d+"],
    ["a pattern whose shortest literal sits earlier on the line", '"\\w+": "7\\.3'],
  ];
  for (const [name, pattern] of placed) {
    const found = search(db, { patterns: [pattern] }).files[0].hits[0];
    assert.ok(found.text.includes("7.3.0"), `${name}: ${found.text.slice(0, 40)}`);
  }
  const plain = search(db, { patterns: ["version line"] }).files[0].hits[0];
  assert.equal(plain.text, "the version line");
});
