import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOwnFolder, globToRegExp, listFiles, normalConfig, openIndex, refresh } from "../src/store.mjs";

test("globs match paths the way their syntax says", () => {
  const cases = [
    ["*.md", "docs/a.md", true],
    ["*.md", "a.mdx", false],
    ["page/**", "page/a/b.js", true],
    ["page/*.js", "page/a/b.js", false],
    ["**/test/*.mjs", "test/x.mjs", true],
    ["a?.js", "ab.js", true],
  ];
  for (const [glob, path, expected] of cases) assert.equal(globToRegExp(glob).test(path), expected, `${glob} on ${path}`);
});

test("a hostile glob is matched at once", () => {
  const glob = Array(30).fill("**a").join("") + "**b";
  const start = performance.now();
  globToRegExp(glob).test("a".repeat(400));
  assert.ok(performance.now() - start < 200, `took ${Math.round(performance.now() - start)} ms`);
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), "findwright-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test("the .findwright folder must be FindWright's own", async (t) => {
  await t.test("a repo with no folder, or with only its config, passes", () => {
    const root = repo();
    checkOwnFolder(root);
    mkdirSync(join(root, ".findwright"));
    writeFileSync(join(root, ".findwright", "config.json"), "{}");
    execFileSync("git", ["add", ".findwright/config.json"], { cwd: root });
    checkOwnFolder(root);
    rmSync(root, { recursive: true, force: true });
  });
  await t.test("a .findwright that is a file is refused", () => {
    const root = repo();
    writeFileSync(join(root, ".findwright"), "x");
    assert.throws(() => checkOwnFolder(root), /not a plain folder/);
    rmSync(root, { recursive: true, force: true });
  });
  await t.test("a folder inside it is refused", () => {
    const root = repo();
    mkdirSync(join(root, ".findwright", "index.db"), { recursive: true });
    assert.throws(() => checkOwnFolder(root), /not a plain file/);
    rmSync(root, { recursive: true, force: true });
  });
  await t.test("an index the repo commits is refused", () => {
    const root = repo();
    mkdirSync(join(root, ".findwright"));
    writeFileSync(join(root, ".findwright", "index.db"), "");
    execFileSync("git", ["add", "-f", ".findwright/index.db"], { cwd: root });
    assert.throws(() => checkOwnFolder(root), /the repo commits/);
    rmSync(root, { recursive: true, force: true });
  });
});

test("a config of the wrong shape is read as far as it is right, never thrown on", () => {
  const cases = [
    ["null", null],
    ["a string include", { include: "src" }],
    ["an object include", { include: {} }],
    ["a string exclude", { exclude: "x" }],
    ["a number in exclude", { exclude: [5, "dist/**"] }],
    ["rules as an object", { rules: {} }],
    ["a null rule", { rules: [null, { pattern: "x", kind: "k" }] }],
    ["rule globs as a string", { rules: [{ pattern: "x", kind: "k", globs: "*.md" }] }],
    ["an object kind", { kinds: { "*.js": {} }, rules: [{ pattern: "x", kind: {} }] }],
    ["a goal out of range", { goal: 500 }],
  ];
  for (const [name, raw] of cases) {
    const config = normalConfig(raw);
    assert.ok(Array.isArray(config.include) && config.include.every((g) => typeof g === "string"), name);
    assert.ok(config.exclude.every((g) => typeof g === "string"), name);
    assert.ok(config.rules.every((r) => typeof r.kind === "string" && Array.isArray(r.globs)), name);
    assert.ok(Object.values(config.kinds).every((k) => typeof k === "string"), name);
    assert.ok(config.goal === undefined || (config.goal > 0 && config.goal <= 100), name);
  }
  assert.deepEqual(normalConfig({ exclude: [5, "dist/**"] }).exclude, ["dist/**"]);
});

test("an index committed under another case of the folder name is refused", () => {
  const root = repo();
  mkdirSync(join(root, ".findwright"));
  writeFileSync(join(root, ".findwright", "index.db"), "");
  execFileSync("git", ["add", "-f", ".findwright/index.db"], { cwd: root });
  execFileSync("git", ["mv", "-f", ".findwright/index.db", ".findwright/INDEX.db"], { cwd: root });
  assert.throws(() => checkOwnFolder(root), /the repo commits/);
  rmSync(root, { recursive: true, force: true });
});

test("an include that names one file, or uses only ?, takes that file in", () => {
  const root = repo();
  mkdirSync(join(root, "gen"));
  writeFileSync(join(root, "gen", "types.d.ts"), "x");
  writeFileSync(join(root, "gen", "file1.ts"), "x");
  writeFileSync(join(root, ".gitignore"), "gen/\n");
  const files = listFiles(root, normalConfig({ include: ["gen/types.d.ts", "gen/file?.ts"] }));
  assert.ok(files.includes("gen/types.d.ts") && files.includes("gen/file1.ts"), files.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("a new rule or kind in the config re-reads files that did not change", () => {
  const root = repo();
  writeFileSync(join(root, "schema.sql"), "CREATE TABLE projects (id TEXT);\n");
  const db = openIndex(root);
  const tables = () => db.prepare("SELECT name FROM symbols WHERE kind = 'table'").all().map((r) => r.name);
  refresh(db, root, normalConfig({}));
  assert.deepEqual(tables(), []);
  const rule = { globs: ["**/*.sql"], kind: "table", pattern: "^CREATE TABLE (?<name>\\w+)" };
  refresh(db, root, normalConfig({ rules: [rule] }));
  assert.deepEqual(tables(), ["projects"]);
  assert.equal(refresh(db, root, normalConfig({ rules: [rule] })).changed, 0, "an unchanged config re-reads nothing");
  db.close();
  rmSync(root, { recursive: true, force: true });
});
