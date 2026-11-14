import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

test("a session started after a failed counts send is told once a day", () => {
  const home = mkdtempSync(join(tmpdir(), "findwright-home-"));
  const repo = mkdtempSync(join(tmpdir(), "findwright-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const project = { id: "a".repeat(32), kind: "game", lastTry: Date.now(), failedAt: Date.now() };
  writeFileSync(join(home, "counts.json"), JSON.stringify({ asked: true, share: true,
    projects: { [realpathSync.native(repo)]: project } }));
  const start = () => {
    const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`;
    const run = spawnSync(process.execPath, [server],
      { input, encoding: "utf8", timeout: 10_000, env: { ...env, FINDWRIGHT_HOME: home, FINDWRIGHT_ROOT: repo } });
    return JSON.parse(run.stdout.trim()).result.instructions;
  };
  assert.match(start(), /last send failed/);
  assert.equal(start(), undefined, "a second session the same day");
});
