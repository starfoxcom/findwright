import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { canRun } from "../src/rules.mjs";

const folder = new URL("../plugin/skills/fit/reference/", import.meta.url);

test("every reference rule set says what it covers, and each of its rules can run", () => {
  const files = readdirSync(folder).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const set = JSON.parse(readFileSync(new URL(file, folder), "utf8"));
    assert.equal(typeof set.description, "string", file);
    assert.ok(Array.isArray(set.rules) && set.rules.length, file);
    set.rules.forEach((rule, i) => {
      assert.ok(canRun(rule), `${file} rule ${i} cannot run`);
      assert.ok(Array.isArray(rule.globs) && rule.globs.length, `${file} rule ${i} names no files`);
    });
  }
});
