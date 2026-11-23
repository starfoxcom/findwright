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
  ["ack searching the files its input lists is blocked", shell("git ls-files | ack -x foo"), true],
  ["a quoted number before a redirect is a pattern, not a descriptor",
    shell('ls | grep "2">out src/a.mjs'), true],
  ["a number before &> is an argument, not a descriptor", shell("ls | grep foo 2&>out"), true],
  ["a number too large for a descriptor is an argument", shell("ls | grep foo 99999999999>out"), true],
  [">& before a file name does not leave the file name as the source",
    shell("3>&1 >& echo cat src/a.mjs >&3 | grep foo"), true],
  ["a form feed, which Bash keeps inside a word, does not split an option from a file",
    shell("ls | sort -t\f src/a.mjs | grep foo"), true],
  ["a backslash joining two lines inside double quotes does not hide a search",
    shell('ls | grep x; bash -c "cat src/a.mjs | gr\\\nep foo"'), true],
  ["PowerShell: a piped search stays a search, since its word passing is not read",
    call("PowerShell", { command: "npm test | grep fail" }, indexed), true],
  ["a clobbering redirect does not hide the file after its target",
    shell("ls | grep foo >|out src/a.mjs"), true],
  ["a quoted expansion that yields several words is blocked",
    shell('set -- foo src/a.mjs; ls | grep "$@"'), true],
  ["an abbreviated long option, which GNU tools accept, is blocked", shell("ls | grep --recursi foo"), true],
  ["a count inside a flag cluster does not hide the flags after it", shell("ls | grep -2r foo"), true],
  ["grep after sort reading the files a list names, by an abbreviated option, is blocked",
    shell("ls | sort --files0=list | grep foo"), true],
  ["options that take the next word as their value are allowed",
    shell("npm test | cut -d ' ' -f 2 | sort -k 1 | uniq -c | grep -A 3 fail"), false],
  ["a context option whose number is optional does not take the pattern as its value",
    shell("ls | ag -C foo src"), true],
  ["a long context option whose number is optional does not take the pattern as its value",
    shell("git ls-files | ack --context foo src"), true],
  ["a letter glued after an optional count is not taken for its value",
    shell("git ls-files | ack -Cx foo"), true],
  ["ack --colour is a switch, not an option that takes the pattern",
    shell("git ls-files | ack --colour foo src"), true],
  ["a context count glued to its option is allowed", shell("npm test | ag -C3 fail"), false],
  ["findstr after a pipe stays a search, since its options are not read",
    shell("ls | findstr foo"), true],
  ["grep after a sed script, which can read files, is blocked",
    shell("npm test | sed 'r src/a.mjs' | grep foo"), true],
  ["a quoted alternation does not hide the file after it",
    shell('ls | grep -E "foo|bar" src/a.mjs'), true],
  ["a quoted ; does not end the search before its file", shell('ls | grep "a;b" src/a.mjs'), true],
  ["an unquoted variable, which can expand to a file, is blocked", shell("ls | grep $PATTERN"), true],
  ["an unquoted glob, which can expand to files, is blocked", shell("ls | grep foo*"), true],
  ["a search inside a quoted command string is blocked",
    shell('npm test | bash -c "cat src/a.mjs | grep foo"'), true],
  ["an escaped search name cannot stand in for one hidden in a quoted command string",
    shell('ls | \\grep x; npm test | bash -c "cat a.mjs | grep foo"'), true],
  ["a redirection before a search name cannot stand in for one in a quoted command string",
    shell('ls | >out grep x; npm test | bash -c "cat a.mjs | grep foo"'), true],
  ["grep after git log printing a file's lines is blocked", shell("git log -L 1,99:src/a.mjs | grep foo"), true],
  ["grep after gh pr diff is blocked", shell("gh pr diff 5 | grep foo"), true],
  ["an input redirection glued to the pattern is blocked", shell("ls | grep foo<src/a.mjs"), true],
  ["grep after git log with a short unified diff flag is blocked", shell("git log -U0 | grep foo"), true],
  ["grep after git status printing the staged diff is blocked", shell("git status -v | grep foo"), true],
  ["grep filtering a one-line commit list is allowed", shell("git log --oneline -n 20 | grep fix"), false],
  ["a lone & in a commit message does not start a search", shell('git commit -m "docs: sed & grep tips"'),
    false],
  ["grep behind sudo is blocked", shell("sudo -u root grep -rn foo ."), true],
  ["rg behind timeout and its duration is blocked", shell("timeout -s KILL 5 rg foo"), true],
  ["grep behind a setting and env is blocked", shell("LC_ALL=C env -i grep -rn foo ."), true],
  ["grep inside a command string a shell runs is blocked", shell("sh -c 'grep -rn foo .'"), true],
  ["grep run by eval is blocked", shell("eval 'grep -rn foo .'"), true],
  ["grep after a lone & is blocked", shell("sleep 1 & grep -rn foo ."), true],
  ["grep after |& fed by a file is blocked", shell("cat src/a.mjs |& grep foo"), true],
  ["a command that names a search tool as its argument is allowed", shell("which rg && man grep"), false],
  ["a wrapper running another command that names a search is allowed",
    shell("sudo apt install ripgrep"), false],
  ["a command the reading cannot follow that only mentions grep is allowed",
    shell('git commit -m "fix: let grep filter $OUTPUT"'), false],
  ["grep after a pipe that carries the error output too is allowed", shell("npm test |& grep fail"), false],
  ["grep after head with a line count is allowed", shell("npm test | head -n 50 | grep fail"), false],
  ["grep after a reshaper that reads a file is blocked", shell("ls | sort src/a.mjs | grep foo"), true],
  ["grep after a file read through a chained pipe is blocked",
    shell("cat src/a.mjs | sort | grep foo"), true],
  ["grep after git show of a file is blocked", shell("git show HEAD:src/a.mjs | grep foo"), true],
  ["grep -R after a pipe is blocked", shell("ls | grep -R foo"), true],
  ["rg naming a folder after a pipe is blocked", shell("echo x | rg foo src/"), true],
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
