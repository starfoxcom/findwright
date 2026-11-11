import { test } from "node:test";
import assert from "node:assert/strict";
import { css, fromRules, javascript, markdown, yaml } from "../src/extract.mjs";

const names = (text, pattern) => fromRules(text, [{ pattern, kind: "rule" }]).map((s) => s.name);

test("a rule names each match by its name group", () => {
  assert.deepEqual(names("#define FOX_WIN 1\n#define FOX_MAC 2", String.raw`^#define\s+(?<name>\w+)`), ["FOX_WIN", "FOX_MAC"]);
});

// Patterns a cloned repo could carry to hang a backtracking engine, on the line that triggers each.
const hostile = [
  ["alternation under a star", "(a|a)*$", "a".repeat(40) + "b"],
  ["overlapping alternation", "(a|aa)+b", "a".repeat(399)],
  ["nested quantifier", "(a+)+$", "a".repeat(399) + "!"],
  ["stacked stars", String.raw`\d*\d*\d*\d*\d*\d*\d*\d*\d*\d*x`, "1".repeat(399)],
];

for (const [name, pattern, line] of hostile) {
  test(`a hostile rule finishes at once: ${name}`, () => {
    const start = performance.now();
    names(line, pattern);
    assert.ok(performance.now() - start < 200, `took ${performance.now() - start} ms`);
  });
}

test("a rule the linear engine cannot run is skipped", () => {
  assert.deepEqual(names("aa", String.raw`(a)\1`), []);
  assert.deepEqual(names("xa", "(?=x)a"), []);
});

// Ordinary files whose one long line would hang a backtracking engine: no config needed.
const longLines = [
  ["markdown heading", markdown, "# a" + " ".repeat(20000) + "b"],
  ["css selector", css, "a" + " ".repeat(20000)],
  ["yaml item", yaml, "- name: a" + " ".repeat(20000) + "b"],
  ["many blocks that never close", javascript, "function f() {\n".repeat(140000)],
];

for (const [name, extract, text] of longLines) {
  test(`a hostile file is read at once: ${name}`, () => {
    const start = performance.now();
    extract(text);
    assert.ok(performance.now() - start < 2000, `took ${Math.round(performance.now() - start)} ms`);
  });
}

test("the built-in extractors still name what they find", () => {
  assert.deepEqual(markdown("# Title ##\n## Part").map((s) => s.name), ["Title", "Part"]);
  assert.deepEqual(javascript("test('reads a file', () => {\n});").map((s) => [s.name, s.endLine]), [["reads a file", 2]]);
  // A brace inside a string opens no block; a declaration looks two lines ahead for its own.
  assert.deepEqual(javascript('const s = "{";\n\n\n\nfunction g() {\n}').map((s) => [s.name, s.endLine]), [["s", 1], ["g", 6]]);
});
