import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHome } from "../src/home.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const HOOK_PATH = fileURLToPath(new URL("../hooks/findwright-first.mjs", import.meta.url));
const COMMAND = `node "${HOOK_PATH.replaceAll("\\", "/")}"`;
const MATCHER = "Grep|Glob|Bash|PowerShell";
const OUR_HOOK = { type: "command", command: COMMAND, timeout: 10 };

const dir = mkdtempSync(join(tmpdir(), "findwright-home-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function fileWith(name, text) {
  const file = join(dir, `${name}.json`);
  if (text !== undefined) writeFileSync(file, text);
  return file;
}
const envFor = (file) => ({ FINDWRIGHT_SETTINGS: file });
const readText = (file) => readFileSync(file, "utf8");
const readJson = (file) => JSON.parse(readText(file));

test("the hook script the command points at exists", () => {
  assert.ok(existsSync(HOOK_PATH));
});

test("status on a missing settings file reports no hook and creates nothing", () => {
  const file = fileWith("missing");
  assert.deepEqual(runHome("status", envFor(file)), {
    ok: true,
    json: { settings: file, hook: false, others: [] },
  });
  assert.equal(existsSync(file), false);
});

test("install-hook creates a missing settings file with the hook entry", () => {
  const file = fileWith("create");
  assert.deepEqual(runHome("install-hook", envFor(file)), {
    ok: true,
    json: { settings: file, installed: true, backup: null },
  });
  assert.deepEqual(readJson(file), {
    hooks: { PreToolUse: [{ matcher: MATCHER, hooks: [OUR_HOOK] }] },
  });
  assert.ok(readText(file).endsWith("}\n"));
});

test("install-hook is idempotent and leaves the file's bytes alone", () => {
  const file = fileWith("twice");
  runHome("install-hook", envFor(file));
  const before = readText(file);
  assert.deepEqual(runHome("install-hook", envFor(file)), {
    ok: true,
    json: { installed: false, already: true },
  });
  assert.equal(readText(file), before);
});

test("install-hook keeps other keys, hooks and entries, and backs the file up first", () => {
  const original = {
    model: "opus",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] },
        { matcher: MATCHER, hooks: [{ type: "command", command: "keep-me" }] },
      ],
    },
  };
  const text = JSON.stringify(original, null, 4);
  const file = fileWith("keep", text);
  assert.deepEqual(runHome("install-hook", envFor(file)), {
    ok: true,
    json: { settings: file, installed: true, backup: `${file}.bak` },
  });
  assert.equal(readText(`${file}.bak`), text);
  const expected = structuredClone(original);
  expected.hooks.PreToolUse[1].hooks.push(OUR_HOOK);
  assert.deepEqual(readJson(file), expected);
});

test("install-hook refuses a file that is not valid JSON and leaves it untouched", () => {
  const text = '{"model": "opus",';
  const file = fileWith("broken", text);
  const result = runHome("install-hook", envFor(file));
  assert.equal(result.ok, false);
  assert.match(result.json.error, /not valid JSON/);
  assert.equal(readText(file), text);
  assert.equal(existsSync(`${file}.bak`), false);
});

test("remove-hook takes out our hook and the entry it leaves empty", () => {
  const file = fileWith("remove-created");
  runHome("install-hook", envFor(file));
  assert.deepEqual(runHome("remove-hook", envFor(file)), {
    ok: true,
    json: { settings: file, removed: true, backup: `${file}.bak` },
  });
  assert.deepEqual(readJson(file), { hooks: { PreToolUse: [] } });
});

test("remove-hook keeps the other hooks in a shared matcher entry", () => {
  const original = {
    hooks: { PreToolUse: [{ matcher: MATCHER, hooks: [{ type: "command", command: "keep-me" }] }] },
  };
  const file = fileWith("remove-shared", JSON.stringify(original));
  runHome("install-hook", envFor(file));
  runHome("remove-hook", envFor(file));
  assert.deepEqual(readJson(file), original);
});

test("remove-hook without our hook changes nothing and creates nothing", () => {
  const text = '{"model": "x"}\n';
  const file = fileWith("none", text);
  assert.deepEqual(runHome("remove-hook", envFor(file)), {
    ok: true,
    json: { settings: file, removed: false, backup: null },
  });
  assert.equal(readText(file), text);
  const missing = fileWith("no-file");
  assert.equal(runHome("remove-hook", envFor(missing)).json.removed, false);
  assert.equal(existsSync(missing), false);
});

test("status lists other -first hook scripts, not ours and not other hooks", () => {
  const bindwright = {
    type: "command",
    command: "P:/Environment/python/python.exe",
    args: ["-I", "-c", "import runpy", "C:/Users/me/.claude/hooks/findwright-first.py"],
    timeout: 10,
  };
  const pushGuard = { type: "command", command: "python.exe", args: ["C:/x/push-guard.py"] };
  const pretool = [
    { matcher: "Grep|Glob|Bash", hooks: [bindwright] },
    { matcher: "Bash", hooks: [pushGuard] },
  ];
  const file = fileWith("others", JSON.stringify({ hooks: { PreToolUse: pretool } }));
  assert.deepEqual(runHome("status", envFor(file)).json, {
    settings: file,
    hook: false,
    others: ["findwright-first.py"],
  });
  runHome("install-hook", envFor(file));
  assert.deepEqual(runHome("status", envFor(file)).json, {
    settings: file,
    hook: true,
    others: ["findwright-first.py"],
  });
});

test("an unknown home action is refused with usage", () => {
  const result = runHome("bogus", envFor(fileWith("unknown")));
  assert.equal(result.ok, false);
  assert.match(result.json.error, /status/);
});

test("the CLI prints the status as one line of JSON", () => {
  const file = fileWith("cli");
  const result = spawnSync(process.execPath, [CLI, "home", "status"], {
    env: { ...process.env, FINDWRIGHT_SETTINGS: file },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { settings: file, hook: false, others: [] });
});
