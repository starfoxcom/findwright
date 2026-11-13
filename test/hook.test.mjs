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
