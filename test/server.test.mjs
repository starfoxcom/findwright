import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
