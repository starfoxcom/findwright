import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalConfig } from "../src/store.mjs";
import { tryRules } from "../src/trial.mjs";

test("a trial says what each kind finds, which matched files stay bare, and which rules cannot run", () => {
  const root = mkdtempSync(join(tmpdir(), "findwright-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "a.sql"), "CREATE TABLE users (id INT);\nCREATE TABLE posts (id INT);\n");
  writeFileSync(join(root, "b.sql"), "-- nothing here\n");
  writeFileSync(join(root, "notes.md"), "CREATE TABLE ignored\n");
  const rules = [
    { globs: ["**/*.sql"], kind: "table", pattern: String.raw`^CREATE TABLE (?<name>\w+)` },
    { globs: ["**/*.sql"], kind: "view", pattern: String.raw`(a)\1` },
    // A glob that is not a string matches nothing, as it would in a saved config.
    { globs: [null, 1], kind: "stray", pattern: "CREATE" },
  ];
  const result = tryRules(root, rules, normalConfig({}));
  assert.equal(result.files, 2);
  assert.equal(result.kinds.stray, undefined);
  assert.deepEqual(result.bareFiles, ["b.sql"]);
  assert.deepEqual(result.kinds.table.samples, ["users  a.sql:1-1", "posts  a.sql:2-2"]);
  assert.deepEqual(result.skipped.map((s) => s.rule), [1]);
  rmSync(root, { recursive: true, force: true });
});
