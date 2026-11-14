import { test } from "node:test";
import assert from "node:assert/strict";
import { css, javascript, json, markdown, yaml } from "../src/extract.mjs";

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

test("JSON keys are named by path, and deep nesting stays fast with names capped", () => {
  const keys = json('{"hooks": {"PreToolUse": [{"matcher": "Bash"}]}, "a.b": 1}').map((s) => s.name);
  assert.deepEqual(keys, ["hooks", "hooks.PreToolUse", "hooks.PreToolUse.matcher", "a.b"]);
  const deep = '{"a":'.repeat(60_000) + "1" + "}".repeat(60_000);
  const start = performance.now();
  const found = json(deep);
  assert.ok(performance.now() - start < 2000, `took ${Math.round(performance.now() - start)} ms`);
  assert.equal(found.length, 200);
  assert.ok(found.every((s) => s.name.length <= 400));
});
