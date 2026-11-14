import { test } from "node:test";
import assert from "node:assert/strict";
import { fromRules, normalRule } from "../src/rules.mjs";

const r = String.raw;
const names = (text, pattern) => fromRules(text, [{ pattern, kind: "rule" }]).map((s) => s.name);
const spans = (text, rules) => fromRules(text, rules).map((s) => [s.name, s.line, s.endLine]);

test("a rule names each match by its name group", () => {
  assert.deepEqual(names("#define FOX_WIN 1\n#define FOX_MAC 2", r`^#define\s+(?<name>\w+)`), ["FOX_WIN", "FOX_MAC"]);
  // Alternatives may each carry a `name` group.
  assert.deepEqual(names(`test("a b")\ntest('c')`, r`test\(\s*(?:'(?<name>[^']+)'|"(?<name>[^"]+)")`), ["a b", "c"]);
});

// Patterns a cloned repo could carry to hang a backtracking engine, on the line that triggers each.
const hostile = [
  ["alternation under a star", "(a|a)*$", "a".repeat(40) + "b"],
  ["overlapping alternation", "(a|aa)+b", "a".repeat(999)],
  ["nested quantifier", "(a+)+$", "a".repeat(999) + "!"],
  ["stacked stars", r`\d*\d*\d*\d*\d*\d*\d*\d*\d*\d*x`, "1".repeat(999)],
];

for (const [name, pattern, line] of hostile) {
  test(`a hostile rule finishes at once: ${name}`, () => {
    const start = performance.now();
    names(line, pattern);
    assert.ok(performance.now() - start < 200, `took ${performance.now() - start} ms`);
  });
}

test("a rule the linear engine cannot run is skipped", () => {
  assert.deepEqual(names("aa", r`(a)\1`), []);
  assert.deepEqual(names("xa", "(?=x)a"), []);
  assert.deepEqual(fromRules("a\nb", [{ pattern: "a", kind: "k", end: { until: r`(b)\1` } }]), []);
});

const FUNCTION = r`^\s*function\s+(?<name>\w+)`;
const JSON_KEY = r`"(?<name>(?:[^"\\]|\\.)*)"\s*:\s*`;
const YAML_KEY = r`^(?<indent>\s*(?:-\s+)?)(?<name>[\w.-]+):(?:\s|$)`;

const ends = [
  ["brace: runs to its closing brace, past braces in strings",
    'function f() {\n  const s = "}";\n}\nfunction g() {}', [{ pattern: FUNCTION, end: "brace" }],
    [["f", 1, 3], ["g", 4, 4]]],
  ["brace: a block that opens no brace within three lines is its own line",
    "function f()\n\n\n{\n}", [{ pattern: FUNCTION, end: "brace" }], [["f", 1, 1]]],
  ["brace: a block that never closes runs to the end",
    "function f() {\n  x", [{ pattern: FUNCTION, end: "brace" }], [["f", 1, 2]]],
  ["value: a key's object or array, and a scalar key is one line",
    '{\n  "a": {\n    "b": [1,\n      2]\n  },\n  "c": 3\n}', [{ pattern: JSON_KEY, end: "value" }],
    [["a", 2, 5], ["b", 3, 4], ["c", 6, 6]]],
  ["indent: runs while lines sit deeper, past blank lines",
    "def f():\n    x = 1\n\n    return x\ny = 2", [{ pattern: r`^def\s+(?<name>\w+)`, end: "indent" }], [["f", 1, 4]]],
  ["next: a heading runs to the next one of its level or higher",
    "# A\ntext\n## B\nmore\n# C\nend", [{ pattern: r`^(?<level>#+)\s+(?<name>.+)`, end: "next" }],
    [["A", 1, 4], ["B", 3, 4], ["C", 5, 6]]],
  ["until: runs to the first later line the pattern matches",
    "begin a\nx\nend\nbegin b", [{ pattern: r`^begin\s+(?<name>\w+)`, end: { until: "^end" } }],
    [["a", 1, 3], ["b", 4, 4]]],
];

for (const [name, text, rules, expected] of ends) {
  test(`a rule's block ends where its end says: ${name}`, () => {
    assert.deepEqual(spans(text, rules.map((rule) => ({ kind: "k", ...rule }))), expected);
  });
}

const nesting = [
  ["JSON keys by path, through arrays, on one line",
    '{"hooks": {"PreToolUse": [{"matcher": "Bash"}]}, "a.b": 1}',
    [{ pattern: JSON_KEY, end: "value", nest: true }],
    ["hooks", "hooks.PreToolUse", "hooks.PreToolUse.matcher", "a.b"]],
  ["YAML keys by path, list items included",
    "jobs:\n  review:\n    steps:\n      - run: x\n        with: y\n    env: z",
    [{ pattern: YAML_KEY, end: "indent", nest: true }],
    ["jobs", "jobs.review", "jobs.review.steps", "jobs.review.steps.run", "jobs.review.steps.with", "jobs.review.env"]],
  ["a separator of the rule's own, under another rule's symbol",
    "class Grid {\n  build() {\n  }\n}",
    [{ pattern: r`^class\s+(?<name>\w+)`, end: "brace", nest: true },
      { pattern: r`^\s+(?<name>\w+)\(\)\s*\{`, end: "brace", nest: "::" }],
    ["Grid", "Grid::build"]],
];

for (const [name, text, rules, expected] of nesting) {
  test(`a nesting rule names a symbol under the one that holds it: ${name}`, () => {
    assert.deepEqual(fromRules(text, rules.map((rule) => ({ kind: "k", ...rule }))).map((s) => s.name), expected);
  });
}

test("a nested name past the cap is dropped with everything under it", () => {
  const deep = Array.from({ length: 300 }, (_, i) => `${" ".repeat(i)}key${i}:`).join("\n");
  const start = performance.now();
  const found = fromRules(deep, [{ pattern: YAML_KEY, kind: "key", end: "indent", nest: true }]);
  assert.ok(performance.now() - start < 2000, `took ${Math.round(performance.now() - start)} ms`);
  assert.ok(found.length > 50 && found.length < 300);
  assert.ok(found.every((s) => s.name.length <= 400));
});

test("rules sharing a group: the first to match a line takes it", () => {
  const rules = [
    { pattern: r`^const\s+(?<name>\w+)\s*=\s*\(`, kind: "function", group: "decl" },
    { pattern: r`^const\s+(?<name>\w+)`, kind: "const", group: "decl" },
  ];
  assert.deepEqual(fromRules("const f = () => 1;\nconst N = 2;", rules).map((s) => [s.name, s.kind]),
    [["f", "function"], ["N", "const"]]);
});

test("a name the rule excepts is dropped", () => {
  const rule = { pattern: r`^\s+(?<name>\w+)\s*\(`, kind: "method", except: ["if"] };
  assert.deepEqual(fromRules("  if (x)\n  run()", [rule]).map((s) => s.name), ["run"]);
});

const regions = [
  ["outside a fenced block", "# A\n```\n# not\n```\n# B",
    { pattern: r`^#\s+(?<name>\w+)`, outside: [{ start: "^```", end: { until: "^```" } }] }, ["A", "B"]],
  ["inside front matter on line 1 only", "---\ntitle: x\n---\nkey: y\n---\nother: z\n---",
    { pattern: r`^(?<name>\w+):`, inside: { start: "^---$", end: { until: "^---$" }, first: true } }, ["title"]],
  ["outside a block that runs by indentation", "run: |\n  key: no\nnext: yes",
    { pattern: r`^\s*(?<name>\w+):`, outside: [{ start: r`:\s*\|\s*$`, end: "indent" }] }, ["run", "next"]],
];

for (const [name, text, rule, expected] of regions) {
  test(`a rule's regions limit where it matches: ${name}`, () => {
    assert.deepEqual(fromRules(text, [{ kind: "k", ...rule }]).map((s) => s.name), expected);
  });
}

test("blocks that never close cost no more than the scan budget", () => {
  const start = performance.now();
  fromRules("function f() {\n".repeat(140_000), [{ pattern: FUNCTION, kind: "function", end: "brace" }]);
  assert.ok(performance.now() - start < 3000, `took ${Math.round(performance.now() - start)} ms`);
});

test("a rule is read as far as it is right: a bad end is one line, a bad region drops the rule", () => {
  assert.equal(normalRule({ pattern: "x", kind: "k", end: "sideways" }).end, "line");
  assert.equal(normalRule({ pattern: "x", kind: "k", nest: true }).nest, ".");
  assert.equal(normalRule({ pattern: "x", kind: "k", nest: "------" }).nest, undefined);
  assert.equal(normalRule({ pattern: "x", kind: "k", inside: { start: "a" } }), null);
  assert.equal(normalRule({ pattern: "x", kind: "k", outside: [{ start: "a", end: "indent" }, "b"] }), null);
  assert.equal(normalRule({ pattern: "x" }), null);
});
