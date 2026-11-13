// Registers the FindWright search hook in Claude Code's settings.json. The file is
// edited as JSON so every other key and hook keeps its content. A file that is not
// valid JSON is refused, never rewritten, because rewriting it would lose the user's
// settings.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MATCHER = "Grep|Glob|Bash|PowerShell";
const HOOK_PATH = fileURLToPath(new URL("../hooks/findwright-first.mjs", import.meta.url));
// A quoted command string, because `args` is not a hook field the docs promise.
const COMMAND = `node "${HOOK_PATH.replaceAll("\\", "/")}"`;
const OUR_HOOK = { type: "command", command: COMMAND, timeout: 10 };
const SCRIPT_NAME = /[\w.-]+-first\.(?:py|mjs)(?!\w)/g;
const ACTIONS = new Map([
  ["status", statusOf],
  ["install-hook", installHook],
  ["remove-hook", removeHook],
]);

export function settingsPath(env = process.env, home = homedir()) {
  if (env.FINDWRIGHT_SETTINGS) return env.FINDWRIGHT_SETTINGS;
  return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json");
}

// Returns { ok, json }: json is printed as the one line of output, ok false means exit 1.
export function runHome(action, env = process.env) {
  const run = ACTIONS.get(action);
  if (!run) return failure("usage: findwright home status | install-hook | remove-hook");
  return run(settingsPath(env));
}

function success(json) {
  return { ok: true, json };
}

function failure(message) {
  return { ok: false, json: { error: message } };
}

function statusOf(file) {
  const read = readSettings(file);
  if (read.error) return failure(read.error);
  return success({
    settings: file,
    hook: hasOurHook(read.settings),
    others: otherScripts(read.settings),
  });
}

function installHook(file) {
  const read = readSettings(file);
  if (read.error) return failure(read.error);
  if (hasOurHook(read.settings)) return success({ installed: false, already: true });
  const backup = read.exists ? backUp(file) : null;
  addOurHook(read.settings);
  writeSettings(file, read.settings);
  return success({ settings: file, installed: true, backup });
}

function removeHook(file) {
  const read = readSettings(file);
  if (read.error) return failure(read.error);
  if (!hasOurHook(read.settings)) return success({ settings: file, removed: false, backup: null });
  const backup = backUp(file);
  removeOurHook(read.settings);
  writeSettings(file, read.settings);
  return success({ settings: file, removed: true, backup });
}

// A missing file reads as empty settings; invalid JSON or a wrong shape is an error.
function readSettings(file) {
  if (!existsSync(file)) return { exists: false, settings: {} };
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    return { error: `${file} is not valid JSON (${error.message}); left unchanged` };
  }
  const problem = shapeProblem(settings);
  if (problem) return { error: `${file} ${problem}; left unchanged` };
  return { exists: true, settings };
}

function shapeProblem(settings) {
  if (!isObject(settings)) return "is not a JSON object";
  if (settings.hooks === undefined) return null;
  if (!isObject(settings.hooks)) return "has a hooks value that is not an object";
  const pretool = settings.hooks.PreToolUse;
  if (pretool !== undefined && !Array.isArray(pretool)) {
    return "has a hooks.PreToolUse that is not a list";
  }
  return null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pretoolEntries(settings) {
  return settings.hooks?.PreToolUse ?? [];
}

function hooksOf(entry) {
  return Array.isArray(entry?.hooks) ? entry.hooks : [];
}

function allPretoolHooks(settings) {
  return pretoolEntries(settings).flatMap(hooksOf);
}

function isOurs(hook) {
  return hook?.command === COMMAND;
}

function hasOurHook(settings) {
  return allPretoolHooks(settings).some(isOurs);
}

// Other hook scripts named like a -first hook (Bindwright's findwright-first.py, for one).
function otherScripts(settings) {
  const names = new Set();
  for (const hook of allPretoolHooks(settings)) {
    if (isOurs(hook)) continue;
    for (const name of hookText(hook).match(SCRIPT_NAME) ?? []) names.add(name);
  }
  return [...names];
}

function hookText(hook) {
  const args = Array.isArray(hook?.args) ? hook.args : [];
  return [hook?.command, ...args].filter((part) => typeof part === "string").join(" ");
}

// The hook gets an entry of its own, so installing never edits an entry someone else wrote.
function addOurHook(settings) {
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  settings.hooks.PreToolUse.push({ matcher: MATCHER, hooks: [OUR_HOOK] });
}

function isOurEntry(entry) {
  const hooks = hooksOf(entry);
  return entry?.matcher === MATCHER && hooks.length === 1 && isOurs(hooks[0])
    && Object.keys(entry).length === 2;
}

// Deletes only the entry install wrote. Our hook moved into another entry by hand leaves that
// entry in place, keys and all, with only our hook taken out.
function removeOurHook(settings) {
  const kept = [];
  for (const entry of pretoolEntries(settings)) {
    if (isOurEntry(entry)) continue;
    const hooks = hooksOf(entry);
    const rest = hooks.filter((hook) => !isOurs(hook));
    kept.push(rest.length === hooks.length ? entry : { ...entry, hooks: rest });
  }
  settings.hooks.PreToolUse = kept;
}

function backUp(file) {
  const backup = `${file}.bak`;
  copyFileSync(file, backup);
  return backup;
}

function writeSettings(file, settings) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}
