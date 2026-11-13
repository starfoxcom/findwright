import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, LEFT_OUT, send, setProject, setShare, status } from "../src/counts.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const ENV_KEYS = ["FINDWRIGHT_HOME", "FINDWRIGHT_TRANSCRIPTS", "FINDWRIGHT_COUNTER_URL"];
const HIT = "src/a.mjs\n  1: code\n";
const MISS = "src/b.mjs\n  1: code\n";
const base = mkdtempSync(join(tmpdir(), "findwright-counts-"));
const saved = {};
const received = [];
const replies = [];
let counter;
let ctx;

after(() => {
  counter.closeAllConnections();
  counter.close();
  rmSync(base, { recursive: true, force: true });
});

before(async () => {
  counter = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      received.push(JSON.parse(text));
      const reply = replies.shift() ?? { status: 200, body: { ok: true } };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => counter.listen(0, "127.0.0.1", resolve));
});

beforeEach(() => {
  const dir = mkdtempSync(join(base, "case-"));
  ctx = {
    home: join(dir, "home"),
    transcripts: join(dir, "transcripts"),
    repo: join(dir, "repo"),
  };
  mkdirSync(ctx.transcripts, { recursive: true });
  mkdirSync(ctx.repo, { recursive: true });
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.FINDWRIGHT_HOME = ctx.home;
  process.env.FINDWRIGHT_TRANSCRIPTS = ctx.transcripts;
  process.env.FINDWRIGHT_COUNTER_URL = `http://127.0.0.1:${counter.address().port}`;
  received.length = 0;
  replies.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const stateFile = () => join(ctx.home, "counts.json");
const readState = () => JSON.parse(readFileSync(stateFile(), "utf8"));
const projectState = () => Object.values(readState().projects)[0];

// One search per entry: its answer, then a Read of the file `opens`. The Read follows the
// search directly, so every search is scored.
function writeSession(name, entries, ageMs) {
  const rows = entries.flatMap((entry, i) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id: `${name}-s${i}`,
      name: "mcp__findwright__find", input: { query: "where" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `${name}-s${i}`,
      content: entry.answer }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: `${name}-r${i}`,
      name: "Read", input: { file_path: join(ctx.repo, entry.opens) } }] } },
  ]);
  const file = join(ctx.transcripts, `${name}.jsonl`);
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const when = new Date(NOW - ageMs);
  utimesSync(file, when, when);
  return file;
}

const hitSearch = { answer: HIT, opens: "src/a.mjs" };
const missSearch = { answer: MISS, opens: "src/a.mjs" };

test("nothing is sent while sharing is off, the kind is missing or the kind is none", async () => {
  writeSession("old", [hitSearch], 2 * HOUR);
  assert.equal((await send(ctx.repo, { now: NOW })).sent, false);
  assert.deepEqual(setProject(ctx.repo, "game"), { kind: "game" });
  assert.equal((await send(ctx.repo, { now: NOW })).sent, false);
  setShare(true);
  assert.deepEqual(setProject(ctx.repo, LEFT_OUT), { kind: LEFT_OUT });
  assert.equal((await send(ctx.repo, { now: NOW })).sent, false);
  assert.deepEqual(status(ctx.repo), { share: true, asked: true, kind: LEFT_OUT });
  assert.deepEqual(received, []);
});

test("a kind outside the list is refused and stored nowhere", () => {
  assert.ok(setProject(ctx.repo, "spaceship").error);
  assert.equal(status(ctx.repo).kind, null);
});

test("one send sums sessions, searches, hits and bytes, and marks the sessions sent", async () => {
  const older = writeSession("older", [hitSearch, missSearch], 3 * HOUR);
  const newer = writeSession("newer", [hitSearch], 2 * HOUR);
  setShare(true);
  setProject(ctx.repo, "game");
  const result = await send(ctx.repo, { now: NOW });
  const project = projectState();
  assert.equal(result.sent, true);
  assert.deepEqual(received, [{
    project: project.id,
    kind: "game",
    sessions: 2,
    searches: 3,
    hits: 2,
    bytes: 2 * Buffer.byteLength(HIT) + Buffer.byteLength(MISS),
    from: statSync(older).mtimeMs,
    to: statSync(newer).mtimeMs + 1,
  }]);
  assert.deepEqual([...project.sent].sort(), ["newer", "older"]);
  assert.equal(project.coveredTo, statSync(newer).mtimeMs + 1);
  assert.equal(project.lastSend, NOW);
});

test("a second send within 24 hours sends nothing, even with a new session", async () => {
  writeSession("first", [hitSearch], 2 * HOUR);
  setShare(true);
  setProject(ctx.repo, "game");
  assert.equal((await send(ctx.repo, { now: NOW })).sent, true);
  writeSession("second", [hitSearch], 2 * HOUR);
  assert.equal((await send(ctx.repo, { now: NOW + 23 * HOUR })).sent, false);
  assert.equal(received.length, 1);
});

test("a session newer than an hour is left out until it is idle", async () => {
  writeSession("idle", [hitSearch], 2 * HOUR);
  writeSession("running", [hitSearch], HOUR / 2);
  setShare(true);
  setProject(ctx.repo, "game");
  await send(ctx.repo, { now: NOW });
  assert.equal(received[0].sessions, 1);
  assert.deepEqual(projectState().sent, ["idle"]);
});

// A 409 answers a send whose earlier copy was counted though its reply was lost.
test("a 409 resends nothing, and the next send counts only sessions after the counted window", async () => {
  const older = writeSession("older", [hitSearch], 3 * HOUR);
  const newer = writeSession("newer", [hitSearch, missSearch], 2 * HOUR);
  replies.push({ status: 409, body: { coveredTo: statSync(older).mtimeMs + 1 } });
  setShare(true);
  setProject(ctx.repo, "game");
  assert.equal((await send(ctx.repo, { now: NOW })).sent, false);
  assert.equal(received.length, 1);
  assert.equal((await send(ctx.repo, { now: NOW })).sent, true);
  assert.equal(received[1].sessions, 1);
  assert.equal(received[1].searches, 2);
  assert.equal(received[1].from, statSync(newer).mtimeMs);
});

test("a transcript time with a fraction of a millisecond goes out as whole milliseconds", async () => {
  const file = writeSession("fraction", [hitSearch], 2 * HOUR);
  const seconds = (NOW - 2 * HOUR + 0.4321) / 1000;
  utimesSync(file, seconds, seconds);
  setShare(true);
  setProject(ctx.repo, "game");
  assert.equal((await send(ctx.repo, { now: NOW })).sent, true);
  assert.ok(Number.isSafeInteger(received[0].from) && Number.isSafeInteger(received[0].to));
  assert.ok(received[0].from < received[0].to);
});

test("a 500 or an unreachable counter changes nothing", async () => {
  writeSession("only", [hitSearch], 2 * HOUR);
  setShare(true);
  setProject(ctx.repo, "game");
  const stateBefore = readFileSync(stateFile(), "utf8");
  replies.push({ status: 500, body: {} });
  assert.equal((await send(ctx.repo, { now: NOW })).sent, false);
  assert.equal(readFileSync(stateFile(), "utf8"), stateBefore);
  process.env.FINDWRIGHT_COUNTER_URL = "http://127.0.0.1:1";
  assert.equal((await send(ctx.repo, { now: NOW })).sent, false);
  assert.equal(readFileSync(stateFile(), "utf8"), stateBefore);
});

test("a damaged counts.json reads as empty state", async () => {
  writeSession("only", [hitSearch], 2 * HOUR);
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(stateFile(), "{ not json");
  assert.deepEqual(status(ctx.repo), { share: false, asked: false, kind: null });
  assert.equal((await send(ctx.repo, { now: NOW })).sent, false);
  assert.equal(collect(ctx.repo, NOW).body.sessions, 1);
});

test("bytes count at most 65536 per answer", async () => {
  const big = { answer: `src/a.mjs\n${"x".repeat(70000)}`, opens: "src/a.mjs" };
  writeSession("sized", [big, hitSearch], 2 * HOUR);
  setShare(true);
  setProject(ctx.repo, "game");
  await send(ctx.repo, { now: NOW });
  assert.equal(received[0].bytes, 65536 + Buffer.byteLength(HIT));
});
