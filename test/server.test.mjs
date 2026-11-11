import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

test("a message that is not an object gets an error, and the next one is still answered", () => {
  const input = ["null", "[]", "7", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })].join("\n") + "\n";
  const run = spawnSync(process.execPath, [server], { input, encoding: "utf8", timeout: 10_000 });
  const replies = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(replies.slice(0, 3).map((r) => r.error?.code), [-32600, -32600, -32600]);
  assert.equal(replies[3].id, 1);
  assert.ok(replies[3].result.tools.length > 0);
});
