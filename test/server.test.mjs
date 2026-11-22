import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
// An empty FindWright home, so the counts read as off and the server never sends for real.
const env = { ...process.env, FINDWRIGHT_HOME: mkdtempSync(join(tmpdir(), "findwright-home-")) };

test("a message that is not an object gets an error, and the next one is still answered", () => {
  const input = ["null", "[]", "7", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })].join("\n") + "\n";
  const run = spawnSync(process.execPath, [server], { input, encoding: "utf8", timeout: 10_000, env });
  const replies = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(replies.slice(0, 3).map((r) => r.error?.code), [-32600, -32600, -32600]);
  assert.equal(replies[3].id, 1);
  assert.ok(replies[3].result.tools.length > 0);
});

test("the server starts and answers with sharing on and a project folder that does not exist", () => {
  const home = mkdtempSync(join(tmpdir(), "findwright-home-"));
  writeFileSync(join(home, "counts.json"), JSON.stringify({ asked: true, share: true, projects: {} }));
  const missingRoot = join(home, "no-such-repo");
  const input = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n";
  const run = spawnSync(process.execPath, [server],
    { input, encoding: "utf8", timeout: 10_000, env: { ...env, FINDWRIGHT_HOME: home, FINDWRIGHT_ROOT: missingRoot } });
  assert.equal(JSON.parse(run.stdout.trim()).id, 1);
});

test("a server open past the day's wait tries the counts send again on its next tool call", async () => {
  const home = mkdtempSync(join(tmpdir(), "findwright-home-"));
  const repo = mkdtempSync(join(tmpdir(), "findwright-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const stateFile = join(home, "counts.json");
  const writeLastTry = (lastTry) => writeFileSync(stateFile, JSON.stringify({ asked: true, share: true,
    projects: { [realpathSync.native(repo)]: { id: "a".repeat(32), kind: "game", lastTry } } }));
  const lastTry = () => Object.values(JSON.parse(readFileSync(stateFile, "utf8")).projects)[0].lastTry;
  writeLastTry(Date.now());
  const child = spawn(process.execPath, [server], { env: { ...env, FINDWRIGHT_HOME: home,
    FINDWRIGHT_ROOT: repo, FINDWRIGHT_TRANSCRIPTS: mkdtempSync(join(tmpdir(), "findwright-transcripts-")),
    FINDWRIGHT_COUNTER_URL: "http://127.0.0.1:1" } });
  const lines = createInterface({ input: child.stdout });
  const request = async (id, method, params) => {
    const reply = once(lines, "line");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return JSON.parse((await reply)[0]);
  };
  try {
    await request(1, "tools/list");
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    writeLastTry(dayAgo);
    assert.equal((await request(2, "tools/call", { name: "coverage", arguments: {} })).id, 2);
    for (let waited = 0; lastTry() === dayAgo && waited < 10_000; waited += 100) await sleep(100);
    assert.ok(lastTry() > dayAgo, "the tool call started a send, which records its try");
  } finally {
    child.stdin.end();
  }
});

// A git repo, with `.findwright/config.json` holding `config` when one is given.
function fittedRepo(config) {
  const repo = mkdtempSync(join(tmpdir(), "findwright-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  if (config) {
    mkdirSync(join(repo, ".findwright"));
    writeFileSync(join(repo, ".findwright", "config.json"), JSON.stringify(config));
  }
  return repo;
}

function instructionsAt(repo, home = env.FINDWRIGHT_HOME) {
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`;
  const run = spawnSync(process.execPath, [server],
    { input, encoding: "utf8", timeout: 10_000, env: { ...env, FINDWRIGHT_HOME: home, FINDWRIGHT_ROOT: repo } });
  return JSON.parse(run.stdout.trim()).result.instructions;
}

test("a session is sent to /findwright:fit when the repo has no rules, or its last sessions fell short", () => {
  assert.match(instructionsAt(fittedRepo()), /findwright:fit/, "no config");
  assert.equal(instructionsAt(fittedRepo({ rules: [] })), undefined, "fitted with no rules");
  const short = fittedRepo({ rules: [], goal: 90 });
  const log = (at) => writeFileSync(join(short, ".findwright", "hits.jsonl"), [1, 2, 3]
    .map((n) => JSON.stringify({ session: `s${n}`, at, scored: 10, hits: 5, misses: [] }) + "\n").join(""));
  log(new Date(Date.now() + 60_000).toISOString());
  assert.match(instructionsAt(short), /less often than the goal/, "three sessions at 50%");
  log("2020-01-01T00:00:00.000Z");
  assert.equal(instructionsAt(short), undefined, "the same sessions, then a fit saved after them");
  const refused = fittedRepo();
  mkdirSync(join(refused, ".findwright", "linked"), { recursive: true });
  assert.equal(instructionsAt(refused), undefined, "a .findwright folder holding more than plain files");
});

// Each call's answer, sent in order to a server running in `repo`.
function callTools(repo, calls) {
  const input = calls.map(([name, args], i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call",
    params: { name, arguments: args } })).join("\n") + "\n";
  const run = spawnSync(process.execPath, [server],
    { input, encoding: "utf8", timeout: 30_000, env: { ...env, FINDWRIGHT_ROOT: repo } });
  return run.stdout.trim().split("\n").map((line) => JSON.parse(line).result);
}

test("a call with a bad argument names it and never opens the index", () => {
  const cases = [
    ["an argument the tool does not take", "outline", { file: "a.js" },
      /outline has no argument `file`; it takes `path` \(a string\)/],
    ["a missing required argument", "outline", {}, /outline needs `path`, a string/],
    ["a null required argument", "find", { query: null }, /find needs `query`, a string/],
    ["a string where a list belongs", "search", { patterns: "x" }, /`patterns` in search must be a list of strings/],
    ["a list holding a number", "search", { patterns: ["x", 1] }, /`patterns` in search must be a list of strings/],
    ["a number given as text", "symbols", { query: "x", limit: "3" }, /`limit` in symbols must be a number/],
    ["arguments that are not an object", "coverage", [], /coverage takes its arguments as an object/],
    ["a tool name the object inherits", "constructor", {}, /No tool named constructor/],
  ];
  const repo = fittedRepo({ rules: [] });
  const answers = callTools(repo, cases.map(([, name, args]) => [name, args]));
  cases.forEach(([label, , , message], i) => {
    assert.equal(answers[i].isError, true, label);
    assert.match(answers[i].content[0].text, message, label);
  });
  assert.deepEqual(readdirSync(join(repo, ".findwright")), ["config.json"], "no index was built");
  const [nullOptional] = callTools(repo, [["symbols", { query: "x", kind: null, globs: null }]]);
  assert.equal(nullOptional.isError, undefined, "a null optional argument counts as left out");
});

test("a server whose helper was replaced under it says so in every answer", async () => {
  const copy = mkdtempSync(join(tmpdir(), "findwright-helper-"));
  cpSync(fileURLToPath(new URL("../src", import.meta.url)), join(copy, "src"), { recursive: true });
  const packageFile = join(copy, "package.json");
  writeFileSync(packageFile, JSON.stringify({ name: "findwright", version: "2.0.0", type: "module" }));
  const child = spawn(process.execPath, [join(copy, "src", "server.mjs")],
    { env: { ...env, FINDWRIGHT_ROOT: fittedRepo({ rules: [] }) } });
  const lines = createInterface({ input: child.stdout });
  const firstText = async (id) => {
    const reply = once(lines, "line");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "coverage", arguments: {} } })}\n`);
    return JSON.parse((await reply)[0]).result.content[0].text;
  };
  try {
    assert.doesNotMatch(await firstText(1), /reconnect/, "the copy on disk is the one running");
    writeFileSync(packageFile, JSON.stringify({ name: "findwright", version: "2.1.0", type: "module" }));
    assert.match(await firstText(2), /FindWright 2\.1\.0 is installed, but this session's server still runs 2\.0\.0/);
  } finally {
    child.stdin.end();
  }
});

test("a session started after a failed counts send is told once a day", () => {
  const home = mkdtempSync(join(tmpdir(), "findwright-home-"));
  const repo = fittedRepo({ rules: [] });
  const project = { id: "a".repeat(32), kind: "game", lastTry: Date.now(), failedAt: Date.now() };
  writeFileSync(join(home, "counts.json"), JSON.stringify({ asked: true, share: true,
    projects: { [realpathSync.native(repo)]: project } }));
  assert.match(instructionsAt(repo, home), /last send failed/);
  assert.equal(instructionsAt(repo, home), undefined, "a second session the same day");
});

test("a follow the last session's server ran is reported once at the next session start", () => {
  const home = mkdtempSync(join(tmpdir(), "findwright-home-"));
  writeFileSync(join(home, "follow.json"), JSON.stringify({ from: "2.1.0", to: "2.2.0" }));
  const repo = fittedRepo({ rules: [] });
  assert.match(instructionsAt(repo, home), /helper updated itself from 2\.1\.0 to 2\.2\.0/);
  assert.equal(instructionsAt(repo, home), undefined, "the second session start says nothing more");
});
