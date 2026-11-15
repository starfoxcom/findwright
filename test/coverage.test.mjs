import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverage } from "../src/query.mjs";
import { openIndex, refresh } from "../src/store.mjs";

test("coverage lists a readable file named like the unreadable marker as bare, and leaves unreadable ones out", () => {
  const root = mkdtempSync(join(tmpdir(), "findwright-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "notes.binary"), "plain words\n");
  writeFileSync(join(root, "image.dat"), Buffer.from([0x89, 0x00, 0x01, 0x02]));
  execFileSync("git", ["add", "."], { cwd: root });
  const db = openIndex(root);
  refresh(db, root);
  assert.deepEqual(coverage(db).bare.map((file) => ({ ...file })), [{ path: "notes.binary", type: "binary" }]);
  db.close();
  rmSync(root, { recursive: true, force: true });
});
