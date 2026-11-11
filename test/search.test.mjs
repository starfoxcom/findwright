import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { search } from "../src/query.mjs";

function index(files) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE symbols (path TEXT, name TEXT, kind TEXT, line INTEGER, end_line INTEGER);
    CREATE VIRTUAL TABLE body USING fts5(path UNINDEXED, text, tokenize = 'trigram');`);
  for (const [path, text] of Object.entries(files)) db.prepare("INSERT INTO body VALUES (?, ?)").run(path, text);
  return db;
}

test("a long line is searched at once, and a pattern that needs backtracking says what it skipped", () => {
  const db = index({ "big.txt": "fooError " + "a".repeat(2_000_000), "small.txt": "a FooError here" });
  const start = performance.now();
  assert.deepEqual(search(db, { patterns: [String.raw`\w+Error`] }).files.map((f) => f.path), ["big.txt", "small.txt"]);
  const folded = search(db, { patterns: ["fooerror"], ignoreCase: true });
  assert.deepEqual(folded.files.map((f) => f.path), ["small.txt"]);
  assert.equal(folded.skippedLongLines, 1);
  assert.ok(performance.now() - start < 3000, `took ${Math.round(performance.now() - start)} ms`);
});

test("a literal of one emoji and one other character still finds its files", () => {
  const db = index({ "a.md": "status 🔴 here", "b.md": "nothing" });
  assert.deepEqual(search(db, { patterns: ["🔴 "] }).files.map((f) => f.path), ["a.md"]);
  assert.deepEqual(search(db, { patterns: ["ab😀*c"] }).files.map((f) => f.path), []);
  const emoji = index({ "c.md": "xab😀cx" });
  assert.deepEqual(search(emoji, { patterns: ["ab😀*c"] }).files.map((f) => f.path), ["c.md"]);
});
