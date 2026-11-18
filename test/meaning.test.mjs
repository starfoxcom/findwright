import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meaningModel } from "../src/meaning.mjs";
import { writeInPlace } from "../src/embed.mjs";

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

test("a model write leaves no part file, whether it fails or a stopped download left one", () => {
  const folder = mkdtempSync(join(tmpdir(), "findwright-models-"));
  const stale = join(folder, "model.safetensors.part");
  writeFileSync(stale, "half");
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(stale, hourAgo, hourAgo);
  writeInPlace(join(folder, "model.safetensors"), Buffer.from("model"));
  assert.deepEqual(readdirSync(folder), ["model.safetensors"], "the stopped download's part is cleared");

  const blocked = join(folder, "tokenizer.json");
  mkdirSync(join(blocked, "inside"), { recursive: true });
  assert.throws(() => writeInPlace(blocked, Buffer.from("tokens")));
  const parts = readdirSync(folder).filter((name) => name.endsWith(".part"));
  assert.deepEqual(parts, [], "a failed rename removes its part");
  rmSync(folder, { recursive: true, force: true });
});
