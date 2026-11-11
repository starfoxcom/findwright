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
  assert.deepEqual(symbols(db, { query: "(a+)+$" }).map((s) => s.path), []);
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
