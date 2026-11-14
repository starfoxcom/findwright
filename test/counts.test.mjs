import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureToReport, LEFT_OUT, send, setProject, setShare, status } from "../src/counts.mjs";

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
// search directly, so every search is scored. Each search runs `entry.ageMs` (or `ageMs`) before NOW.
function writeSession(name, entries, ageMs) {
  const rows = entries.flatMap((entry, i) => [
    { type: "assistant", timestamp: new Date(NOW - (entry.ageMs ?? ageMs)).toISOString(),
      message: { content: [{ type: "tool_use", id: `${name}-s${i}`,
        name: "mcp__findwright__find", input: { query: "where" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `${name}-s${i}`,
      content: entry.answer }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: `${name}-r${i}`,
      name: "Read", input: { file_path: join(ctx.repo, entry.opens) } }] } },
  ]);
  const file = join(ctx.transcripts, `${name}.jsonl`);
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
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

test("one send sums the searches older than an hour and covers the span up to then", async () => {
  writeSession("older", [hitSearch, missSearch], 3 * HOUR);
  writeSession("newer", [hitSearch], 2 * HOUR);
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
    from: 0,
    to: NOW - HOUR,
  }]);
  assert.equal(project.coveredTo, NOW - HOUR);
  assert.equal(project.lastTry, NOW);
});

test("a second try within 24 hours sends nothing, even with a new search", async () => {
  writeSession("first", [hitSearch], 2 * HOUR);
  setShare(true);
  setProject(ctx.repo, "game");
  assert.equal((await send(ctx.repo, { now: NOW })).sent, true);
  writeSession("second", [hitSearch], 2 * HOUR);
  assert.equal((await send(ctx.repo, { now: NOW + 23 * HOUR })).sent, false);
  assert.equal(received.length, 1);
});

// A session goes on after a send: its later searches belong to the next span, counted once.
test("a search newer than an hour waits for the next send, also in a session already counted", async () => {
  writeSession("long", [{ ...hitSearch, ageMs: 3 * HOUR }, { ...missSearch, ageMs: HOUR / 2 }]);
  setShare(true);
  setProject(ctx.repo, "game");
  await send(ctx.repo, { now: NOW });
  assert.deepEqual([received[0].sessions, received[0].searches, received[0].hits], [1, 1, 1]);
  await send(ctx.repo, { now: NOW + 25 * HOUR });
  assert.deepEqual([received[1].sessions, received[1].searches, received[1].hits], [1, 1, 0]);
  assert.equal(received[1].from, NOW - HOUR);
});

// A 409 answers a send whose earlier copy was counted though its reply was lost.
test("a 409 resends nothing, and the next send counts only searches after the counted span", async () => {
  writeSession("older", [hitSearch], 3 * HOUR);
  writeSession("newer", [hitSearch, missSearch], 2 * HOUR);
  const coveredTo = NOW - 2.5 * HOUR;
  replies.push({ status: 409, body: { coveredTo } });
  setShare(true);
  setProject(ctx.repo, "game");
  assert.equal((await send(ctx.repo, { now: NOW })).sent, false);
  assert.equal(received.length, 1);
  assert.equal((await send(ctx.repo, { now: NOW })).sent, true);
  assert.deepEqual([received[1].sessions, received[1].searches, received[1].from], [1, 2, coveredTo]);
});

test("a 500 or an unreachable counter covers nothing and waits a day", async () => {
  writeSession("only", [hitSearch], 2 * HOUR);
  setShare(true);
  setProject(ctx.repo, "game");
  replies.push({ status: 500, body: {} });
  assert.equal((await send(ctx.repo, { now: NOW })).sent, false);
  assert.equal(projectState().coveredTo, undefined);
  assert.equal((await send(ctx.repo, { now: NOW + HOUR })).reason, "tried within the last 24 hours");
  process.env.FINDWRIGHT_COUNTER_URL = "http://127.0.0.1:1";
  assert.equal((await send(ctx.repo, { now: NOW + 25 * HOUR })).sent, false);
  assert.equal(projectState().coveredTo, undefined);
  assert.equal(projectState().lastTry, NOW + 25 * HOUR);
});

test("a failed send is reported once a day until a send gets through", async () => {
  writeSession("only", [hitSearch], 2 * HOUR);
  setShare(true);
  setProject(ctx.repo, "game");
  const morning = new Date(2030, 0, 1, 9).getTime();
  assert.equal(failureToReport(ctx.repo, morning), null, "no send failed yet");
  replies.push({ status: 500, body: {} });
  await send(ctx.repo, { now: NOW });
  assert.equal(failureToReport(ctx.repo, morning), NOW, "first session of the day");
  assert.equal(failureToReport(ctx.repo, morning + HOUR), null, "later that day");
  setShare(false);
  assert.equal(failureToReport(ctx.repo, morning + 24 * HOUR), null, "sharing off");
  setShare(true);
  assert.equal(failureToReport(ctx.repo, morning + 25 * HOUR), NOW, "next day, sharing on");
  assert.equal((await send(ctx.repo, { now: NOW + 25 * HOUR })).sent, true);
  assert.equal(failureToReport(ctx.repo, morning + 48 * HOUR), null, "a send got through");
});

test("a send with nothing left to send clears an old failure", async () => {
  setShare(true);
  setProject(ctx.repo, "game");
  process.env.FINDWRIGHT_COUNTER_URL = "http://127.0.0.1:1";
  writeSession("only", [hitSearch], 2 * HOUR);
  await send(ctx.repo, { now: NOW });
  rmSync(ctx.transcripts, { recursive: true, force: true });
  assert.equal((await send(ctx.repo, { now: NOW + 25 * HOUR })).reason, "nothing new");
  assert.equal(failureToReport(ctx.repo, new Date(2030, 0, 1, 9).getTime()), null);
});

test("a damaged counts.json reads as empty state", async () => {
  writeSession("only", [hitSearch], 2 * HOUR);
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(stateFile(), "{ not json");
  assert.deepEqual(status(ctx.repo), { share: false, asked: false, kind: null });
  assert.equal((await send(ctx.repo, { now: NOW })).reason, "sharing is off");
});

test("bytes count at most 65536 per answer", async () => {
  const big = { answer: `src/a.mjs\n${"x".repeat(70000)}`, opens: "src/a.mjs" };
  writeSession("sized", [big, hitSearch], 2 * HOUR);
  setShare(true);
  setProject(ctx.repo, "game");
  await send(ctx.repo, { now: NOW });
  assert.equal(received[0].bytes, 65536 + Buffer.byteLength(HIT));
});
