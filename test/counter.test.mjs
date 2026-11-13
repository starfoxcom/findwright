// The opt-in usage counter Worker (counter/): what it accepts, refuses and reports.
// Every case runs the real handler and the real D1Store, its SQL against counter/schema.sql
// in an in-memory SQLite database behind the small part of D1's API the store uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { handle } from "../counter/src/worker.js";
import { D1Store } from "../counter/src/store.js";
import {
  MAX_ANSWER_BYTES,
  MAX_BODY_IN_BYTES,
  MAX_NEW_PROJECTS_PER_DAY,
  MAX_SEARCHES_PER_SEND,
  MAX_SESSIONS_PER_SEND,
  MIN_SEND_GAP_IN_MILLISECONDS,
  TOP_PROJECTS,
  TOTALS_MAX_AGE_IN_SECONDS,
  checkSend,
  countryOf,
} from "../counter/src/rules.js";

const SCHEMA = readFileSync(new URL("../counter/schema.sql", import.meta.url), "utf8");
const PROJECT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const NOON = Date.UTC(2026, 10, 4, 12);
const DAY = 24 * 60 * 60 * 1000;
const LATER = NOON + MIN_SEND_GAP_IN_MILLISECONDS;
const projectId = (n) => String(n).padStart(32, "0");

const isRead = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql);

/**
 * D1's prepare/bind/first/batch over node:sqlite. `batch` runs its statements in one
 * transaction, as D1 does, and reports `meta.changes` per statement.
 */
class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(SCHEMA);
  }

  prepare(sql) {
    const database = this;
    const statement = (params) => ({
      bind: (...values) => statement(values),
      first: async () => database.sqlite.prepare(sql).get(...params) ?? null,
      execute: () => database.execute(sql, params),
    });
    return statement([]);
  }

  execute(sql, params) {
    const prepared = this.sqlite.prepare(sql);
    if (isRead(sql)) return { results: prepared.all(...params), meta: { changes: 0 } };
    return { results: [], meta: { changes: Number(prepared.run(...params).changes) } };
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function newStore() {
  const database = new SqliteD1();
  return { store: new D1Store(database), database };
}

function rowOf(database, id) {
  return database.sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

function send(fields = {}) {
  return {
    project: PROJECT, kind: "game", sessions: 2, searches: 10, hits: 7, bytes: 40000,
    from: NOON - DAY, to: NOON,
    ...fields,
  };
}

function post(body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://counter.test/increment", { method: "POST", body: text, headers });
}

async function run(request, { store, rateLimiter, time = NOON }) {
  const response = await handle(request, { store, rateLimiter, timeInMilliseconds: time });
  return { status: response.status, body: await response.json().catch(() => null), response };
}

function assertReadHeaders(headers) {
  assert.equal(headers.get("access-control-allow-origin"), "*");
  assert.equal(headers.get("access-control-allow-methods"), "GET");
  assert.equal(headers.get("cache-control"), "public, max-age=300");
}

test("checkSend accepts a valid send and refuses each bad field", () => {
  assert.equal(checkSend(send()).ok, true);
  assert.equal(checkSend(send({ hits: 10 })).ok, true, "every search a hit");
  const atCaps = send({
    sessions: MAX_SESSIONS_PER_SEND,
    searches: MAX_SEARCHES_PER_SEND,
    hits: MAX_SEARCHES_PER_SEND,
    bytes: MAX_SEARCHES_PER_SEND * MAX_ANSWER_BYTES,
  });
  assert.equal(checkSend(atCaps).ok, true, "caps");
  const refused = [
    ["not an object", []],
    ["null body", null],
    ["unknown field", send({ repo: "secret" })],
    ["short project id", send({ project: "abc" })],
    ["uppercase project id", send({ project: PROJECT.toUpperCase() })],
    ["non-hex project id", send({ project: "g".repeat(32) })],
    ["free-text kind", send({ kind: "my secret game" })],
    ["negative count", send({ hits: -1 })],
    ["fraction", send({ hits: 1.5 })],
    ["count as text", send({ searches: "10" })],
    ["sessions above the cap", send({ sessions: MAX_SESSIONS_PER_SEND + 1, searches: 20000 })],
    ["searches above the cap", send({ searches: MAX_SEARCHES_PER_SEND + 1 })],
    ["hits above the cap", send({ searches: MAX_SEARCHES_PER_SEND, hits: 20001 })],
    ["bytes above the answer cap", send({ bytes: 10 * MAX_ANSWER_BYTES + 1 })],
    ["window missing", { ...send(), from: undefined }],
    ["window ending before it starts", send({ from: NOON, to: NOON - 1 })],
    ["window ending where it starts", send({ from: NOON, to: NOON })],
    ["window as text", send({ to: String(NOON) })],
    ["hits above searches", send({ hits: 11 })],
    ["sessions above searches", send({ sessions: 11 })],
    ["searches without a session", send({ sessions: 0 })],
    ["sessions with no searches", send({ searches: 0, hits: 0, bytes: 0 })],
    ["bytes with no searches", send({ searches: 0, sessions: 0, hits: 0 })],
    ["nothing to add", send({ sessions: 0, searches: 0, hits: 0, bytes: 0 })],
  ];
  for (const [name, body] of refused) assert.equal(checkSend(body).ok, false, name);
});

test("countryOf keeps Cloudflare's two-letter code and says XX otherwise", () => {
  assert.equal(countryOf({ cf: { country: "MX" } }), "MX");
  assert.equal(countryOf({ cf: { country: "mx" } }), "XX");
  assert.equal(countryOf({ cf: { country: "USA" } }), "XX");
  assert.equal(countryOf({}), "XX");
});

test("a send adds to the totals, and /total reports kinds and counts only", async () => {
  const { store } = newStore();
  assert.equal((await run(post(send()), { store })).status, 200);
  const searching = send({
    project: OTHER, kind: "website", sessions: 5, searches: 300, hits: 120, bytes: 1000000,
  });
  assert.equal((await run(post(searching), { store })).status, 200);

  const total = await run(new Request("https://counter.test/total"), { store });
  assert.equal(total.status, 200);
  assert.equal(total.body.projects, 2);
  assert.equal(total.body.sessions, 7);
  assert.equal(total.body.searches, 310);
  assert.equal(total.body.hits, 127);
  assert.equal(total.body.bytes, 1040000);
  assert.deepEqual(total.body.countries, [{ country: "XX", projects: 2 }]);
  assert.deepEqual(total.body.top[0], {
    kind: "website", sessions: 5, searches: 300, hits: 120, bytes: 1000000,
  });
  const text = JSON.stringify(total.body);
  assert.equal(text.includes(PROJECT) || text.includes(OTHER), false, "project ids stay private");
});

test("top rows order by searches, then hits", async () => {
  const { store } = newStore();
  const sends = [
    [1, 50, 10],
    [2, 50, 20],
    [3, 60, 1],
  ];
  for (const [id, searches, hits] of sends) {
    const body = send({ project: projectId(id), searches, hits });
    assert.equal((await run(post(body), { store })).status, 200);
  }
  const { body } = await run(new Request("https://counter.test/total"), { store });
  assert.deepEqual(body.top.map((row) => [row.searches, row.hits]), [[60, 1], [50, 20], [50, 10]]);
});

test("/total lists at most TOP_PROJECTS projects", async () => {
  const { store } = newStore();
  for (let id = 1; id <= TOP_PROJECTS + 1; id += 1) {
    const body = send({ project: projectId(id), sessions: 1, searches: id, hits: 0, bytes: 0 });
    assert.equal((await run(post(body), { store })).status, 200);
  }
  const { body } = await run(new Request("https://counter.test/total"), { store });
  assert.equal(body.top.length, TOP_PROJECTS);
  assert.equal(body.top[0].searches, TOP_PROJECTS + 1);
});

test("/total answers from its saved copy until TOTALS_MAX_AGE_IN_SECONDS passes", async () => {
  const { store } = newStore();
  const total = new Request("https://counter.test/total");
  assert.equal((await run(total, { store })).body.projects, 0, "the first read computes");
  assert.equal((await run(post(send()), { store })).status, 200);
  const maxAge = TOTALS_MAX_AGE_IN_SECONDS * 1000;
  assert.equal((await run(total, { store, time: NOON + maxAge - 1 })).body.projects, 0, "still the copy");
  assert.equal((await run(total, { store, time: NOON + maxAge })).body.projects, 1, "refreshed");
});

test("a project sends once per gap", async () => {
  const { store, database } = newStore();
  await run(post(send()), { store });
  const early = await run(post(send({ from: NOON, to: LATER - 1 })), { store, time: LATER - 1 });
  assert.equal(early.status, 429);
  assert.equal(early.body.error, "this project already sent today");
  const later = await run(post(send({ from: NOON, to: LATER })), { store, time: LATER });
  assert.equal(later.status, 200);
  assert.equal(rowOf(database, PROJECT).sessions, 4);
});

test("a resent window is refused with where the count stops, then the next counts", async () => {
  const { store, database } = newStore();
  await run(post(send()), { store });
  const resent = await run(post(send()), { store, time: LATER });
  assert.equal(resent.status, 409);
  assert.equal(resent.body.coveredTo, NOON);
  const overlapping = await run(post(send({ from: NOON - 1, to: LATER })), { store, time: LATER });
  assert.equal(overlapping.status, 409);
  const next = send({ from: NOON, to: LATER });
  assert.equal((await run(post(next), { store, time: LATER })).status, 200);
  assert.equal(rowOf(database, PROJECT).sessions, 4);
});

test("two sends for one project arriving together count once", async () => {
  const { store, database } = newStore();
  const results = await Promise.all([run(post(send()), { store }), run(post(send()), { store })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(rowOf(database, PROJECT).sessions, 2);
});

test("new projects stop at the daily cap, existing ones keep sending", async () => {
  const { store, database } = newStore();
  await run(post(send()), { store, time: NOON - MIN_SEND_GAP_IN_MILLISECONDS });
  const claim = database.sqlite.prepare(
    "INSERT INTO new_projects (day, id) VALUES ('2026-11-04', ?)",
  );
  for (let i = 0; i < MAX_NEW_PROJECTS_PER_DAY; i += 1) claim.run(`filler${i}`);

  const refused = await run(post(send({ project: OTHER })), { store });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "too many new projects today");
  assert.equal(rowOf(database, OTHER), undefined);
  const known = await run(post(send({ from: NOON, to: NOON + 1 })), { store });
  assert.equal(known.status, 200, "a known project is not new");
});

test("a new day frees the cap and keeps projects from earlier days", async () => {
  const { store, database } = newStore();
  await run(post(send()), { store });
  const nextDay = send({ from: NOON, to: NOON + DAY });
  assert.equal((await run(post(nextDay), { store, time: NOON + DAY })).status, 200);
  const days = database.sqlite.prepare("SELECT DISTINCT day FROM new_projects").all();
  assert.deepEqual(days, [], "earlier days are cleared on the next send");
  assert.equal(rowOf(database, PROJECT).sessions, 4);
});

test("oversized, non-JSON and rate-limited sends are refused before they count", async () => {
  const { store, database } = newStore();
  const padded = JSON.stringify(send()).padEnd(MAX_BODY_IN_BYTES + 1, " ");
  assert.equal((await run(post(padded), { store })).status, 413);
  assert.equal((await run(post("{not json"), { store })).status, 400);
  const limiter = { limit: async () => ({ success: false }) };
  assert.equal((await run(post(send()), { store, rateLimiter: limiter })).status, 429);
  assert.equal(rowOf(database, PROJECT), undefined);
});

test("an unsized body over the limit is refused before it is all read", async () => {
  const { store, database } = newStore();
  const chunk = new TextEncoder().encode(" ".repeat(512));
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulled === 1000) return controller.close();
      pulled += 1;
      return controller.enqueue(chunk);
    },
  });
  const request = new Request("https://counter.test/increment", {
    method: "POST", body: stream, duplex: "half",
  });
  assert.equal(request.headers.get("content-length"), null, "the case has no declared length");
  const { status, body } = await run(request, { store });
  assert.equal(status, 413);
  assert.equal(body.error, "body too large");
  assert.ok(pulled < 10, `read ${pulled} chunks of 1000 before refusing`);
  assert.equal(rowOf(database, PROJECT), undefined);
});

test("GET and OPTIONS /total carry the read headers", async () => {
  const { store } = newStore();
  const read = await run(new Request("https://counter.test/total"), { store });
  assert.equal(read.status, 200);
  assertReadHeaders(read.response.headers);
  const preflight = await run(
    new Request("https://counter.test/total", { method: "OPTIONS" }),
    { store },
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.body, null, "no body on a preflight");
  assertReadHeaders(preflight.response.headers);
});

test("other routes and methods answer 404", async () => {
  const { store } = newStore();
  const misses = [
    new Request("https://counter.test/increment"),
    new Request("https://counter.test/"),
    new Request("https://counter.test/total", { method: "POST", body: "{}" }),
  ];
  for (const request of misses) {
    const { status } = await run(request, { store });
    assert.equal(status, 404, `${request.method} ${new URL(request.url).pathname}`);
  }
});
