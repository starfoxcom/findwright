import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOwnFolder, globToRegExp } from "../src/store.mjs";

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
