import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recordSession, sinceFit, transcriptsOf } from "../src/hits.mjs";

const short = (n, fields) => ({ session: `s${n}`, scored: 10, hits: 5, misses: [], ...fields });

function repoFittedAt(when) {
  const root = mkdtempSync(join(tmpdir(), "findwright-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, ".findwright"));
  const config = join(root, ".findwright", "config.json");
  writeFileSync(config, JSON.stringify({ rules: [] }));
  utimesSync(config, when, when);
  return root;
}

test("transcripts are read from Claude Code's config folder when CLAUDE_CONFIG_DIR names one", () => {
  const config = mkdtempSync(join(tmpdir(), "findwright-config-"));
  const root = mkdtempSync(join(tmpdir(), "findwright-"));
  const folder = join(config, "projects", resolve(root).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "session.jsonl"), "");
  const saved = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    FINDWRIGHT_TRANSCRIPTS: process.env.FINDWRIGHT_TRANSCRIPTS,
  };
  process.env.CLAUDE_CONFIG_DIR = config;
  delete process.env.FINDWRIGHT_TRANSCRIPTS;
  try {
    assert.deepEqual(transcriptsOf(root), [join(folder, "session.jsonl")]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("only sessions recorded since the config last changed count, by their time or an older line's date", () => {
  const root = repoFittedAt(new Date("2026-06-15T12:00:00Z"));
  const kept = sinceFit(root, [
    short(1, { at: "2026-06-15T13:00:00.000Z" }),
    short(2, { at: "2026-06-15T11:00:00.000Z" }),
    short(3, { date: "2026-06-16" }),
    short(4, { date: "2026-06-15" }),
    short(5, {}),
  ]).map((session) => session.session);
  assert.deepEqual(kept, ["s1", "s3"]);
  rmSync(root, { recursive: true, force: true });
});

test("closing a session after a fit does not report the short sessions from before it", () => {
  const root = repoFittedAt(new Date());
  writeFileSync(join(root, ".findwright", "hits.jsonl"),
    [1, 2, 3].map((n) => `${JSON.stringify(short(n, { at: "2020-01-01T00:00:00.000Z" }))}\n`).join(""));
  const transcript = join(root, "session.jsonl");
  writeFileSync(transcript, "");
  assert.equal(recordSession(root, { transcript }).assess, false);
  rmSync(root, { recursive: true, force: true });
});
