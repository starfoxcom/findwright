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

test("every search runs in linear time, ignoring case included", () => {
  const db = index({ "big.txt": "fooError " + "a".repeat(2_000_000), "small.txt": "a FooError here", "h.md": "a".repeat(40) + "!" });
  const start = performance.now();
  assert.deepEqual(search(db, { patterns: [String.raw`\w+Error`] }).files.map((f) => f.path), ["big.txt", "small.txt"]);
  assert.deepEqual(search(db, { patterns: ["FOOERROR"], ignoreCase: true }).files.map((f) => f.path), ["big.txt", "small.txt"]);
  assert.deepEqual(search(db, { patterns: ["(a+)+$"], ignoreCase: true }).files.map((f) => f.path), ["big.txt"]);
  assert.ok(performance.now() - start < 3000, `took ${Math.round(performance.now() - start)} ms`);
});

test("ignoring case keeps what an escape means", () => {
  const db = index({ "a.txt": "Value 42", "b.txt": "VALUE x" });
  assert.deepEqual(search(db, { patterns: [String.raw`value \d+`], ignoreCase: true }).files.map((f) => f.path), ["a.txt"]);
  assert.deepEqual(search(db, { patterns: [String.raw`VALUE \D`], ignoreCase: true }).files.map((f) => f.path), ["b.txt"]);
});

test("a pattern the linear engine cannot run is refused with a reason", () => {
  const db = index({ "a.txt": "abab" });
  assert.throws(() => search(db, { patterns: [String.raw`(ab)\1`] }), /linear time/);
});

test("a symbol query cannot stall on a long name", () => {
  const db = index({});
  db.prepare("INSERT INTO symbols VALUES (?, ?, ?, ?, ?)").run("a.md", "a".repeat(40) + "!", "h1", 1, 1);
  db.prepare("INSERT INTO symbols VALUES (?, ?, ?, ?, ?)").run("b.md", "Refresh", "h1", 1, 1);
  const start = performance.now();
  assert.deepEqual(symbols(db, { query: "(a+)+$" }).map((s) => s.path), []);
  assert.deepEqual(symbols(db, { query: "refresh" }).map((s) => s.path), ["b.md"]);
  assert.deepEqual(symbols(db, { query: "fresh(" }).map((s) => s.path), []);
  assert.ok(performance.now() - start < 200, `took ${Math.round(performance.now() - start)} ms`);
});

test("a literal of one emoji and one other character still finds its files", () => {
  const db = index({ "a.md": "status 🔴 here", "b.md": "nothing" });
  assert.deepEqual(search(db, { patterns: ["🔴 "] }).files.map((f) => f.path), ["a.md"]);
  assert.deepEqual(search(db, { patterns: ["ab😀*c"] }).files.map((f) => f.path), []);
  const emoji = index({ "c.md": "xab😀cx" });
  assert.deepEqual(search(emoji, { patterns: ["ab😀*c"] }).files.map((f) => f.path), ["c.md"]);
});
