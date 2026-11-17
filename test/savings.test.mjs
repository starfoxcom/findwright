import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSession } from "../src/hits.mjs";
import { costOf, priceOf } from "../src/prices.mjs";

const MILLION = 1_000_000;
const opus = "claude-opus-5-5";
const haiku = "claude-haiku-5-5";

// A transcript from steps: [response id, model, tool name, input, result text, input tokens or a
// whole usage object].
function transcript(file, steps, { sidechain = false, effort = "high" } = {}) {
  const rows = steps.flatMap(([id, model, name, input, result, tokens], i) => {
    const call = { type: "tool_use", id: `call-${id}`, name, input };
    const usage = typeof tokens === "object" ? tokens : { input_tokens: tokens, output_tokens: 0 };
    const assistant = {
      type: "assistant", isSidechain: sidechain, perTurnEffort: effort, timestamp: new Date(i * 1000).toISOString(),
      message: { id, model, content: [call], usage },
    };
    const answer = { type: "tool_result", tool_use_id: call.id, content: result };
    const user = { type: "user", isSidechain: sidechain, message: { content: [answer] } };
    // The CLI writes a response once per content block, so the same response can appear twice.
    return [assistant, assistant, user];
  });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const find = (id, model, answer) => [id, model, "mcp__findwright__find", { query: id }, `${answer}\n`, 0];
const read = (id, model, path) => [id, model, "Read", { file_path: path }, "", 0];
const grep = (id, model, tokens) => [id, model, "Grep", { pattern: "c" }, "", tokens];

// A repo whose session transcripts live in its own folder, where the pool is read from.
function repo() {
  const root = mkdtempSync(join(tmpdir(), "findwright-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  process.env.FINDWRIGHT_TRANSCRIPTS = root;
  return root;
}

// A session transcript at `<root>/<name>.jsonl`, with one helper whose transcript holds `helperSteps`.
function session(root, name, steps, helperSteps = null) {
  const file = join(root, `${name}.jsonl`);
  transcript(file, steps);
  if (helperSteps) {
    mkdirSync(join(root, name, "subagents"), { recursive: true });
    transcript(join(root, name, "subagents", "agent-1.jsonl"), helperSteps, { sidechain: true });
  }
  return file;
}

test("the saving prices a miss's extra turns per model and effort, for the session and its helpers", () => {
  const root = repo();
  const main = session(root, "main", [
    find("r1", opus, "src/a.mjs"), read("r2", opus, "src/a.mjs"),
    find("r3", opus, "src/b.mjs"), grep("r4", opus, MILLION), read("r5", opus, "src/c.mjs"),
  ], [find("h1", haiku, "src/a.mjs"), read("h2", haiku, "src/a.mjs")]);
  const first = recordSession(root, { transcript: main }).saved;
  // The miss cost one extra turn of 1M input tokens on Opus 5.5 ($4 per million). The helper's
  // Haiku 5.5 group has no miss of its own, so it borrows that turn at Haiku's long-prompt price.
  assert.deepEqual([first.main, first.helpers], [4, 0.5]);
  assert.deepEqual(first.groups.map((g) => [g.role, g.model, g.measured]),
    [["main", opus, true], ["helpers", haiku, false]]);

  const later = session(root, "later", [find("s1", opus, "src/a.mjs"), read("s2", opus, "src/a.mjs")]);
  const laterSaving = recordSession(root, { transcript: later }).saved;
  assert.equal(laterSaving.main, 4, "a session with no miss uses the earlier ones");
  rmSync(root, { recursive: true, force: true });
});

test("a miss whose file opens on the next turn costs nothing, also for a group that borrows it", () => {
  const root = repo();
  const file = session(root, "next", [find("r1", opus, "src/b.mjs"), read("r2", opus, "src/c.mjs")],
    [find("h1", haiku, "src/a.mjs"), read("h2", haiku, "src/a.mjs")]);
  const { saved } = recordSession(root, { transcript: file });
  assert.deepEqual([saved.main, saved.helpers, saved.unpriced], [0, 0, []]);
  assert.deepEqual(saved.groups.map((g) => [g.model, g.perMiss, g.measured]), [[haiku, 0, false]]);
  rmSync(root, { recursive: true, force: true });
});

test("a session whose only searches ran in its helpers still counts toward later estimates", () => {
  const root = repo();
  session(root, "first", [read("r1", opus, "src/a.mjs")],
    [find("h1", haiku, "src/b.mjs"), grep("h2", haiku, MILLION), read("h3", haiku, "src/c.mjs")]);
  const later = session(root, "later", [read("s1", opus, "src/a.mjs")],
    [find("k1", haiku, "src/a.mjs"), read("k2", haiku, "src/a.mjs")]);
  // The earlier miss cost one turn of 1M input tokens, past Haiku 5.5's long-prompt threshold.
  assert.equal(recordSession(root, { transcript: later }).saved.helpers, 0.5);
  rmSync(root, { recursive: true, force: true });
});

test("odd token counts in a transcript never make the saving infinite or not a number", () => {
  const root = repo();
  const odd = [
    ["text", { input_tokens: "1000" }],
    ["negative", { input_tokens: -5 }],
    ["huge", { input_tokens: 1e308, cache_read_input_tokens: 1e308 }],
    ["missing", null],
  ];
  const file = session(root, "odd", [
    find("r1", opus, "src/a.mjs"), read("r2", opus, "src/a.mjs"),
    ...odd.flatMap(([name, usage], i) => [
      find(`m${i}`, opus, "src/b.mjs"), grep(`g${i}`, opus, usage), read(`o${i}`, opus, "src/c.mjs"),
    ]),
  ]);
  const { saved } = recordSession(root, { transcript: file });
  assert.ok(Number.isFinite(saved.main), `${saved.main} from ${odd.map(([name]) => name).join(", ")}`);
  rmSync(root, { recursive: true, force: true });
});

test("another session's damaged transcript drops out of the estimate and the hit rate is still recorded", () => {
  const root = repo();
  session(root, "healthy", [find("p1", opus, "src/b.mjs"), grep("p2", opus, MILLION), read("p3", opus, "src/c.mjs")]);
  // A row the parser cannot walk, and a helper folder that is a file.
  const content = { type: "tool_use", name: "mcp__findwright__find" };
  const row = { type: "assistant", message: { id: "x", content } };
  writeFileSync(join(root, "damaged.jsonl"), JSON.stringify(row) + "\n");
  mkdirSync(join(root, "damaged"));
  writeFileSync(join(root, "damaged", "subagents"), "");
  const file = session(root, "now", [find("r1", opus, "src/a.mjs"), read("r2", opus, "src/a.mjs")]);
  const result = recordSession(root, { transcript: file });
  assert.equal(result.saved.main, 4);
  assert.equal(result.rate, 100);
  rmSync(root, { recursive: true, force: true });
});

test("a model name holding the key's punctuation stays its own unpriced model", () => {
  const root = repo();
  session(root, "earlier", [find("p1", opus, "src/b.mjs"), grep("p2", opus, MILLION), read("p3", opus, "src/c.mjs")]);
  const odd = `${opus}|x`;
  const file = session(root, "now", [find("r1", odd, "src/a.mjs"), read("r2", odd, "src/a.mjs")]);
  const { saved } = recordSession(root, { transcript: file });
  assert.deepEqual([saved.main, saved.unpriced], [0, [odd]]);
  rmSync(root, { recursive: true, force: true });
});

test("with no miss in any transcript the saving says why instead of guessing", () => {
  const root = repo();
  const only = session(root, "only", [find("r1", opus, "src/a.mjs"), read("r2", opus, "src/a.mjs")]);
  const { saved } = recordSession(root, { transcript: only });
  assert.equal(saved.main, null);
  assert.match(saved.why, /no missed search/);
  rmSync(root, { recursive: true, force: true });
});

test("a turn's price follows its model, cache use, prompt size and speed", () => {
  const tokens = (fields) => ({ input: 0, write5m: 0, write1h: 0, read: 0, output: 0, ...fields });
  const cases = [
    ["input", opus, tokens({ input: MILLION }), {}, 4],
    ["output", opus, tokens({ output: MILLION }), {}, 20],
    ["5-minute cache write", opus, tokens({ write5m: MILLION }), {}, 5],
    ["1-hour cache write", opus, tokens({ write1h: MILLION }), {}, 8],
    ["cache read", opus, tokens({ read: MILLION }), {}, 0.2],
    ["long-context id", "claude-opus-5-5[1m]", tokens({ input: MILLION }), {}, 4],
    ["dated snapshot id", "claude-opus-5-5-20261001", tokens({ input: MILLION }), {}, 4],
    ["older model sharing a prefix", "claude-opus-5", tokens({ input: MILLION }), {}, 5],
    ["fast mode", opus, tokens({ input: MILLION }), { fast: true }, 8],
    ["short Haiku prompt", haiku, tokens({ input: 100_000 }), {}, 0.01],
    ["long Haiku prompt", haiku, tokens({ input: 100_001 }), {}, 0.0500005],
    ["unlisted minor release", "claude-opus-5-6", tokens({ input: MILLION }), {}, null],
    ["unknown model", "some-other-model", tokens({ input: MILLION }), {}, null],
  ];
  for (const [name, model, used, options, dollars] of cases) {
    const cost = costOf(model, used, options);
    if (dollars === null) assert.equal(cost, null, name);
    else assert.ok(Math.abs(cost - dollars) < 1e-9, `${name}: ${cost}`);
  }
  assert.equal(priceOf("constructor"), null, "a name on every object is not a model");
});
