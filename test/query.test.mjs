import { test } from "node:test";
import assert from "node:assert/strict";
import { requiredLiterals } from "../src/query.mjs";

// Every literal returned must appear in every match: the shortlist drops files without it.
const cases = [
  ["plain word", "refresh", ["refresh"]],
  ["escaped symbol joins the run", String.raw`a\.b`, ["a.b"]],
  ["word boundary is no text", String.raw`\bfoo\b`, ["foo"]],
  ["unicode escape is no text", "caf" + String.fromCharCode(92) + "u00e9", ["caf"]],
  ["braced unicode escape is no text", String.raw`caf\u{e9}x`, ["caf", "x"]],
  ["hex escape is no text", String.raw`\x41bc`, ["bc"]],
  ["control escape is no text", String.raw`\cMab`, ["ab"]],
  ["named back-reference is no text", String.raw`(?<t>ab)\k<t>`, ["ab"]],
  ["unicode property is no text", String.raw`\p{Lu}name`, ["name"]],
  ["numbered back-reference is no text", String.raw`(ab)\12`, ["ab"]],
  ["escaped bracket stays inside the class", String.raw`[\]abc]`, []],
  ["class then text", String.raw`[\]x]yz`, ["yz"]],
  ["optional last char is dropped", "colou?r", ["colo", "r"]],
  ["alternation group is skipped", "a(bc|de)f", ["a", "f"]],
  ["unclosed class ends the scan", "ab[cd", ["ab"]],
  ["trailing backslash", "ab\\", ["ab"]],
];

for (const [name, pattern, expected] of cases) {
  test(`requiredLiterals: ${name}`, () => {
    assert.deepEqual([...requiredLiterals(pattern)].sort(), [...expected].sort());
  });
}
