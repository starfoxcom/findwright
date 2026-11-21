import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/findwright-first.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "findwright-hook-"));
const indexed = join(root, "indexed");
const plain = join(root, "plain");
mkdirSync(join(indexed, ".findwright"), { recursive: true });
writeFileSync(join(indexed, ".findwright", "index.db"), "");
mkdirSync(plain, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

function run(stdin) {
  const result = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8" });
  return { code: result.status, stderr: result.stderr };
}

const call = (toolName, toolInput, cwd) =>
  JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd });
const shell = (command, cwd = indexed) => call("Bash", { command }, cwd);

const deepInside = join(indexed, "src", "deep");
const ROWS = [
  ["Grep in an indexed folder is blocked", call("Grep", { pattern: "foo" }, indexed), true],
  ["Glob in an indexed folder is blocked", call("Glob", { pattern: "*.mjs" }, indexed), true],
  ["Grep in a folder with no index is allowed", call("Grep", { pattern: "foo" }, plain), false],
  ["Grep with an indexed target path is blocked from outside",
    call("Grep", { pattern: "foo", path: indexed }, plain), true],
  ["Grep below the index root is blocked", call("Grep", { pattern: "foo" }, deepInside), true],
  ["grep -rn in an indexed folder is blocked", shell("grep -rn foo ."), true],
  ["rg after a pipe is blocked", shell("cat notes.txt | rg foo"), true],
  ["grep filtering test output is allowed",
    shell('git status --short && node --test | grep -E "^ok (pass|fail)"'), false],
  ["grep filtering a file list is allowed", shell("ls hooks | grep -v agent-"), false],
  ["grep filtering a CI log is allowed", shell("gh run view 5 --log-failed | grep error"), false],
  ["grep filtering output with a quoted pattern and a redirect is allowed",
    shell('npm test 2>&1 | grep -v "skip me" > out.txt'), false],
  ["grep after head of a file is blocked", shell("head -50 src/a.mjs | grep foo"), true],
  ["grep after output reshaped by tail is allowed", shell("npm test | tail -20 | grep fail"), false],
  ["grep after node printing a file is blocked",
    shell("node -p \"require('fs').readFileSync('src/a.mjs', 'utf8')\" | grep foo"), true],
  ["grep naming a file after a pattern given by --regexp is blocked",
    shell("ls | grep --regexp=foo src/a.mjs"), true],
  ["grep fed by a file behind a background ls is blocked",
    shell("ls & cat src/a.mjs | grep foo"), true],
  ["grep fed by a group that printed a file is blocked",
    shell("(cat src/a.mjs; echo done) | grep foo"), true],
  ["grep naming a file after -- is blocked", shell("ls | grep -- -foo src/a.mjs"), true],
  ["findstr searching the files a list names is blocked",
    call("PowerShell", { command: "dir | findstr /f:list.txt foo" }, indexed), true],
  ["grep after sort reading a list of files is blocked",
    shell("ls | sort --files0-from=list | grep foo"), true],
  ["grep after a sed script, which can read files, is blocked",
    shell("npm test | sed 'r src/a.mjs' | grep foo"), true],
  ["grep after head with a line count is allowed", shell("npm test | head -n 50 | grep fail"), false],
  ["grep after a reshaper that reads a file is blocked", shell("ls | sort src/a.mjs | grep foo"), true],
  ["grep after find printing files through -execdir is blocked",
    shell("find . -name '*.mjs' -execdir cat {} + | grep foo"), true],
  ["grep after a file read through a chained pipe is blocked",
    shell("cat src/a.mjs | sort | grep foo"), true],
  ["grep after sed printing a file is blocked", shell("sed -n '1,200p' src/a.mjs | grep foo"), true],
  ["grep after git show of a file is blocked", shell("git show HEAD:src/a.mjs | grep foo"), true],
  ["a recursive grep after a pipe is blocked", shell("git ls-files | grep -rn foo src"), true],
  ["grep -R after a pipe is blocked", shell("ls | grep -R foo"), true],
  ["rg naming a folder after a pipe is blocked", shell("echo x | rg foo src/"), true],
  ["findstr /s after a pipe is blocked",
    call("PowerShell", { command: "dir | findstr /s foo" }, indexed), true],
  ["git grep after a pipe is blocked", shell("echo x | git grep -efoo"), true],
  ["grep from xargs is blocked", shell("git ls-files | xargs grep foo"), true],
  ["git grep is blocked", shell("git grep foo"), true],
  ["findstr in PowerShell is blocked",
    call("PowerShell", { command: "findstr foo a.txt" }, indexed), true],
  ["ls is allowed", shell("ls"), false],
  ["grep outside an indexed folder is allowed", shell("grep -rn foo .", plain), false],
  ["the bypass marker lets grep through",
    shell("grep -rn foo . # FINDWRIGHT_BYPASS: markdown only"), false],
  ["a Read call is never blocked",
    call("Read", { file_path: join(indexed, "a.mjs") }, indexed), false],
  ["a non-string command fails open", call("Bash", { command: 5 }, indexed), false],
  ["malformed JSON fails open", "{not json", false],
  ["empty stdin fails open", "", false],
  ["a non-object payload fails open", "42", false],
];

for (const [name, stdin, blocked] of ROWS) {
  test(name, () => {
    const { code, stderr } = run(stdin);
    assert.equal(code, blocked ? 2 : 0);
    assert.equal(stderr.includes("FindWright available at"), blocked);
  });
}
