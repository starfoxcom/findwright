import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meaningModel } from "../src/meaning.mjs";

// Find must not quietly rank by words when the model setup installs is missing.
test("without the model, find gets an error naming setup; with meaning off, no model and no error", (t) => {
  const empty = mkdtempSync(join(tmpdir(), "findwright-models-"));
  const saved = { models: process.env.FINDWRIGHT_MODELS, meaning: process.env.FINDWRIGHT_MEANING };
  t.after(() => {
    for (const [key, value] of [["FINDWRIGHT_MODELS", saved.models], ["FINDWRIGHT_MEANING", saved.meaning]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(empty, { recursive: true, force: true });
  });
  process.env.FINDWRIGHT_MODELS = empty;
  delete process.env.FINDWRIGHT_MEANING;
  const missing = meaningModel(null);
  assert.match(missing.error, /not installed/);
  assert.match(missing.error, /\/findwright:setup/);
  assert.equal(missing.ready, undefined);
  process.env.FINDWRIGHT_MEANING = "off";
  assert.deepEqual(meaningModel(null), { ready: null });
});
