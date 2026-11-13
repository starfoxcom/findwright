import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meaningModel } from "../src/meaning.mjs";

// Find must not quietly rank by words when the model setup installs is missing.
test("without the model, find gets an error naming setup", (t) => {
  const empty = mkdtempSync(join(tmpdir(), "findwright-models-"));
  const saved = process.env.FINDWRIGHT_MODELS;
  t.after(() => {
    if (saved === undefined) delete process.env.FINDWRIGHT_MODELS;
    else process.env.FINDWRIGHT_MODELS = saved;
    rmSync(empty, { recursive: true, force: true });
  });
  process.env.FINDWRIGHT_MODELS = empty;
  const missing = meaningModel(null);
  assert.match(missing.error, /not installed/);
  assert.match(missing.error, /\/findwright:setup/);
  assert.equal(missing.ready, undefined);
});
