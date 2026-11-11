import { test } from "node:test";
import assert from "node:assert/strict";
import { fromRules } from "../src/extract.mjs";

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
