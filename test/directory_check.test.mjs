import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { problemsIn } from "../tools/directory_check.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../tools/directory_check.mjs");
const PNG = Buffer.from("89504e470d0a1a0a0000000d", "hex");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
const MESSAGE_CLEAN = "Meets the directory's rules for organizations that are not Verified";
const made = [];

// `files` maps a path to text or bytes.
function problemsOf(files) {
  const entries = Object.entries(files).map(([path, data]) => [path, Buffer.from(data)]);
  return problemsIn(new Map(entries));
}

function folderWith(files) {
  const root = mkdtempSync(join(tmpdir(), "findwright-dircheck-"));
  made.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

test("package manager files are refused by name, in any folder", () => {
  assert.deepEqual(problemsOf({ "package.json": "{}" }), [
    "package.json is a package manager's file",
  ]);
  assert.deepEqual(problemsOf({ "sub/yarn.lock": "" }), [
    "sub/yarn.lock is a package manager's file",
  ]);
});

test("hook and local server declarations are refused", () => {
  assert.deepEqual(problemsOf({ "hooks/hooks.json": "{}" }), [
    "hooks/hooks.json declares hooks or a local server",
  ]);
  assert.deepEqual(problemsOf({ ".mcp.json": "{}" }), [
    ".mcp.json declares hooks or a local server",
  ]);
});

test("an image must start with the magic of its extension", () => {
  assert.deepEqual(problemsOf({ "icon.png": "not a png" }), [
    "icon.png is not the image its name says",
  ]);
  assert.deepEqual(problemsOf({ "pic.webp": "RIFF" }), [
    "pic.webp is not the image its name says",
  ]);
  assert.deepEqual(problemsOf({ "icon.png": PNG, "pic.webp": WEBP }), []);
});

test("a text file must be UTF-8", () => {
  const notUtf8 = Buffer.from([0xff, 0xfe, 0x41]);
  assert.deepEqual(problemsOf({ "README.md": notUtf8 }), ["README.md is not UTF-8"]);
});

test("a text file must not hold a NUL byte", () => {
  assert.deepEqual(problemsOf({ "notes.md": "a\0b" }), ["notes.md holds a NUL byte"]);
});

test("a text file must not start with a shebang, with or without a byte order mark", () => {
  assert.deepEqual(problemsOf({ "run.txt": "#!/bin/sh\n" }), ["run.txt starts with #!"]);
  assert.deepEqual(problemsOf({ "run.txt": "﻿#!/bin/sh\n" }), ["run.txt starts with #!"]);
});

test("a skill, agent or command may use only the allowed frontmatter keys", () => {
  const allowed = "---\nname: x\ndescription: \"d: e\"\nargument-hint: \"<a>\"\n---\nBody\n";
  const refused = "---\nname: x\nallowed-tools: Bash\n---\nBody\n";
  assert.deepEqual(problemsOf({ "skills/x/SKILL.md": allowed }), []);
  assert.deepEqual(problemsOf({ "skills/x/SKILL.md": refused }), [
    "skills/x/SKILL.md has frontmatter keys the directory refuses: allowed-tools",
  ]);
  assert.deepEqual(problemsOf({ "commands/c.md": refused }), [
    "commands/c.md has frontmatter keys the directory refuses: allowed-tools",
  ]);
});

const ONLY_PLAIN = "(frontmatter not in the one-line key: value form)";

test("frontmatter the check cannot read plainly fails closed", () => {
  const rows = {
    "behind a byte order mark": ["﻿---\nname: x\nallowed-tools: Bash\n---\n", "allowed-tools"],
    "indented keys": ["---\n  name: x\n  allowed-tools: Bash\n---\n", ONLY_PLAIN],
    "a plain key, then indented ones": ["---\nname: x\n  allowed-tools: Bash\n---\n", ONLY_PLAIN],
    "a block scalar": ["---\nname: x\ndescription: >\n  text\n---\n", ONLY_PLAIN],
    "no keys": ["---\njust text\n---\n", ONLY_PLAIN],
    "spaces after the opener": ["--- \nname: x\nallowed-tools: Bash\n---\n", ONLY_PLAIN],
    "a form feed after the opener": ["---\f\nname: x\nallowed-tools: Bash\n---\n", ONLY_PLAIN],
    "a line starting ---": ["---\nname: x\n---: y\nallowed-tools: Bash\n---\n", ONLY_PLAIN],
    "a next-line character": ["---\nname: x\u0085allowed-tools: Bash\n---\n", ONLY_PLAIN],
    "an unquoted value with a colon": ["---\nname: x\ndescription: a: b\n---\n", ONLY_PLAIN],
    "a quoted value JSON refuses": ["---\nname: \"x\\q\"\n---\n", ONLY_PLAIN],
  };
  for (const [name, [text, reported]] of Object.entries(rows)) {
    assert.deepEqual(problemsOf({ "skills/x/SKILL.md": text }), [
      `skills/x/SKILL.md has frontmatter keys the directory refuses: ${reported}`,
    ], name);
  }
});

test("a plugin manifest may not declare code or servers", () => {
  const path = ".claude-plugin/plugin.json";
  assert.deepEqual(problemsOf({ [path]: '{"name":"x","mcpServers":{}}' }), [
    "plugin.json declares mcpServers",
  ]);
  assert.deepEqual(problemsOf({ [path]: '{"hooks":{},"modules":[]}' }), [
    "plugin.json declares hooks, modules",
  ]);
  assert.deepEqual(problemsOf({ [path]: '{"name":"x"}' }), []);
  assert.deepEqual(problemsOf({ [path]: "{" }), [`${path} is not valid JSON`]);
});

test("a file of any other kind is refused", () => {
  assert.deepEqual(problemsOf({ "tool.exe": "MZ" }), [
    "tool.exe is not Markdown, text, JSON, YAML or an allowed image",
  ]);
});

test("a clean plugin passes", () => {
  const clean = {
    "README.md": "# Plugin\n",
    LICENSE: "MIT\n",
    "icon.png": PNG,
    ".claude-plugin/plugin.json": '{"name":"findwright","version":"9.9.9"}\n',
    "skills/x/SKILL.md": "---\nname: x\ndescription: d\n---\nBody\n",
    "helper.json": "{}\n",
  };
  assert.deepEqual(problemsOf(clean), []);
});

test("the command prints each problem and exits 1, or passes a clean folder", () => {
  const cleanDir = folderWith({ "README.md": "# x\n" });
  const clean = spawnSync(process.execPath, [SCRIPT, cleanDir], { encoding: "utf8" });
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout.trim(), MESSAGE_CLEAN);

  const badDir = folderWith({ "package.json": "{}" });
  const bad = spawnSync(process.execPath, [SCRIPT, badDir], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout.trim(), "package.json is a package manager's file");
});

test("a line pairing a web address or network command with a credential or a variable is refused", () => {
  const rows = {
    "a variable beside curl": ["curl -o \"$HOME/x\" \"<url>\"", true],
    "a credential word beside a link": ["take out tokens, then open https://example.com", true],
    "a plugin root beside a link": ["see https://nodejs.org; fix: ${CLAUDE_PLUGIN_ROOT}/x", true],
    "a link alone": ["open https://example.com/issues/new", false],
    "a variable alone": ["delete $HOME/.findwright/helper", false],
    "the two on separate lines": ["curl -o \"<home>/x\" \"<url>\"\ndelete $HOME/x", false],
  };
  for (const [name, [text, refused]] of Object.entries(rows)) {
    const found = problemsOf({ "skills/x/SKILL.md": text });
    assert.equal(found.length, refused ? 1 : 0, name);
    if (refused) assert.match(found[0], /^skills\/x\/SKILL\.md:1 puts a web address/, name);
  }
});
