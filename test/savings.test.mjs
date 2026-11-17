import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSession } from "../src/hits.mjs";
import { costOf } from "../src/prices.mjs";

const MILLION = 1_000_000;

// A transcript from steps: [response id, model, tool name, input, result text, input tokens].
function transcript(file, steps, { sidechain = false, effort = "high" } = {}) {
  const rows = steps.flatMap(([id, model, name, input, result, tokens], i) => {
    const call = { type: "tool_use", id: `call-${id}`, name, input };
    const assistant = {
      type: "assistant", isSidechain: sidechain, perTurnEffort: effort, timestamp: new Date(i * 1000).toISOString(),
      message: { id, model, content: [call], usage: { input_tokens: tokens, output_tokens: 0 } },
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

function repo() {
  const root = mkdtempSync(join(tmpdir(), "findwright-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test("the saving prices a miss's extra turns per model and effort, for the session and its helpers", () => {
  const root = repo();
  const opus = "claude-opus-5-5";
  const main = join(root, "main.jsonl");
  transcript(main, [
    find("r1", opus, "src/a.mjs"), read("r2", opus, "src/a.mjs"),
    find("r3", opus, "src/b.mjs"), ["r4", opus, "Grep", { pattern: "c" }, "", MILLION], read("r5", opus, "src/c.mjs"),
  ]);
  mkdirSync(join(root, "main", "subagents"), { recursive: true });
  transcript(join(root, "main", "subagents", "agent-1.jsonl"),
    [find("h1", "claude-haiku-5-5", "src/a.mjs"), read("h2", "claude-haiku-5-5", "src/a.mjs")], { sidechain: true });

  const first = recordSession(root, { transcript: main }).saved;
  // The miss cost one extra turn of 1M input tokens on Opus 5.5 ($4 per million). The helper's
  // Haiku 5.5 group has no miss of its own, so it borrows that turn at Haiku's long-prompt price.
  assert.deepEqual([first.main, first.helpers], [4, 0.5]);
  assert.deepEqual(first.groups.map((g) => [g.role, g.model, g.measured]),
    [["main", opus, true], ["helpers", "claude-haiku-5-5", false]]);

  const later = join(root, "later.jsonl");
  transcript(later, [find("s1", opus, "src/a.mjs"), read("s2", opus, "src/a.mjs")]);
  const laterSaving = recordSession(root, { transcript: later }).saved;
  assert.equal(laterSaving.main, 4, "a session with no miss uses the recorded ones");
  assert.equal(readFileSync(join(root, ".findwright", "hits.jsonl"), "utf8").trim().split("\n").length, 2);
  rmSync(root, { recursive: true, force: true });
});

// A session transcript at `<root>/<name>.jsonl` with one helper whose transcript holds `helperSteps`.
function sessionWithHelper(root, name, steps, helperSteps) {
  const file = join(root, `${name}.jsonl`);
  transcript(file, steps);
  mkdirSync(join(root, name, "subagents"), { recursive: true });
  transcript(join(root, name, "subagents", "agent-1.jsonl"), helperSteps, { sidechain: true });
  return file;
}

test("a miss whose file opens on the next turn costs nothing, also for a group that borrows it", () => {
  const root = repo();
  const opus = "claude-opus-5-5";
  const haiku = "claude-haiku-5-5";
  const file = sessionWithHelper(root, "next", [find("r1", opus, "src/b.mjs"), read("r2", opus, "src/c.mjs")],
    [find("h1", haiku, "src/a.mjs"), read("h2", haiku, "src/a.mjs")]);
  const { saved } = recordSession(root, { transcript: file });
  assert.deepEqual([saved.main, saved.helpers, saved.unpriced], [0, 0, []]);
  assert.deepEqual(saved.groups.map((g) => [g.model, g.perMiss, g.measured]), [[haiku, 0, false]]);
  rmSync(root, { recursive: true, force: true });
});

test("a session whose only searches ran in its helpers is recorded, so their misses count later", () => {
  const root = repo();
  const haiku = "claude-haiku-5-5";
  const first = sessionWithHelper(root, "first", [read("r1", "claude-opus-5-5", "src/a.mjs")], [
    find("h1", haiku, "src/b.mjs"),
    ["h2", haiku, "Grep", { pattern: "c" }, "", MILLION],
    read("h3", haiku, "src/c.mjs"),
  ]);
  assert.equal(recordSession(root, { transcript: first }).rate, null);
  const later = sessionWithHelper(root, "later", [read("s1", "claude-opus-5-5", "src/a.mjs")],
    [find("k1", haiku, "src/a.mjs"), read("k2", haiku, "src/a.mjs")]);
  // The recorded miss cost one turn of 1M input tokens, past Haiku 5.5's long-prompt threshold.
  assert.equal(recordSession(root, { transcript: later }).saved.helpers, 0.5);
  rmSync(root, { recursive: true, force: true });
});

test("a malformed group in the recorded sessions is skipped, never fatal", () => {
  const root = repo();
  const zero = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
  const side = (count, turns, cost, input = 0) => ({ count, turns, cost, tokens: { ...zero, input } });
  const valid = { hits: side(0, 0, 0), misses: side(1, 1, 4, MILLION) };
  // Each bad group sits under the same key as the valid one, so counting it would change the result.
  const key = "claude-opus-5-5|high";
  const malformed = [
    ["not an object", "x"],
    ["a group with no misses", { [key]: { hits: side(1, 0, 0) } }],
    ["a negative count", { [key]: { hits: side(0, 0, 0), misses: side(-1, 0, 0) } }],
    ["a count written as text", { [key]: { hits: side(0, 0, 0), misses: side("1", 0, 0) } }],
    ["a side with no tokens", { [key]: { hits: side(0, 0, 0), misses: { count: 1, turns: 0, cost: 0 } } }],
    ["keys named like object members", JSON.parse(JSON.stringify({ constructor: valid, toString: valid }))],
  ];
  const lines = [{ groups: { [key]: valid } }, ...malformed.map(([, groups]) => ({ groups }))]
    .map((fields, i) => JSON.stringify({ session: `old-${i}`, scored: 1, hits: 0, misses: [], ...fields }));
  mkdirSync(join(root, ".findwright"));
  writeFileSync(join(root, ".findwright", "hits.jsonl"), lines.join("\n") + "\n");
  const file = join(root, "now.jsonl");
  transcript(file, [find("r1", "claude-opus-5-5", "src/a.mjs"), read("r2", "claude-opus-5-5", "src/a.mjs")]);
  // Only the valid line counts: one recorded miss that cost $4.
  assert.equal(recordSession(root, { transcript: file }).saved.main, 4, malformed.map(([name]) => name).join(", "));
  rmSync(root, { recursive: true, force: true });
});

test("with no miss recorded anywhere the saving says why instead of guessing", () => {
  const root = repo();
  const only = join(root, "only.jsonl");
  transcript(only, [find("r1", "claude-opus-5-5", "src/a.mjs"), read("r2", "claude-opus-5-5", "src/a.mjs")]);
  const { saved } = recordSession(root, { transcript: only });
  assert.equal(saved.main, null);
  assert.match(saved.why, /no missed search/);
  rmSync(root, { recursive: true, force: true });
});

test("a turn's price follows its model, cache use, prompt size and speed", () => {
  const tokens = (fields) => ({ input: 0, write5m: 0, write1h: 0, read: 0, output: 0, ...fields });
  const cases = [
    ["input", "claude-opus-5-5", tokens({ input: MILLION }), {}, 4],
    ["output", "claude-opus-5-5", tokens({ output: MILLION }), {}, 20],
    ["5-minute cache write", "claude-opus-5-5", tokens({ write5m: MILLION }), {}, 5],
    ["1-hour cache write", "claude-opus-5-5", tokens({ write1h: MILLION }), {}, 8],
    ["cache read", "claude-opus-5-5", tokens({ read: MILLION }), {}, 0.2],
    ["long-context id", "claude-opus-5-5[1m]", tokens({ input: MILLION }), {}, 4],
    ["older model sharing a prefix", "claude-opus-5", tokens({ input: MILLION }), {}, 5],
    ["fast mode", "claude-opus-5-5", tokens({ input: MILLION }), { fast: true }, 8],
    ["short Haiku prompt", "claude-haiku-5-5", tokens({ input: 100_000 }), {}, 0.01],
    ["long Haiku prompt", "claude-haiku-5-5", tokens({ input: 100_001 }), {}, 0.0500005],
    ["unknown model", "some-other-model", tokens({ input: MILLION }), {}, null],
  ];
  for (const [name, model, used, options, dollars] of cases) {
    const cost = costOf(model, used, options);
    if (dollars === null) assert.equal(cost, null, name);
    else assert.ok(Math.abs(cost - dollars) < 1e-9, `${name}: ${cost}`);
  }
});
