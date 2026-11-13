// The opt-in usage counter behind the FindWright page.
//
//   POST /increment  {project, kind, sessions, searches, hits, bytes, from, to}
//                    adds one send
//   GET  /total      the sums, projects per country and the top projects
//
// Sends come from the plugin of users who said yes at setup; the page reads
// /total. The sender's IP only feeds Cloudflare's rate limiter and is never stored.

import {
  MAX_BODY_IN_BYTES,
  MAX_NEW_PROJECTS_PER_DAY,
  MIN_SEND_GAP_IN_MILLISECONDS,
  TOP_PROJECTS,
  TOTALS_MAX_AGE_IN_SECONDS,
  checkSend,
  countryOf,
} from "./rules.js";
import { D1Store } from "./store.js";

const READ_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
  "cache-control": `public, max-age=${TOTALS_MAX_AGE_IN_SECONDS}`,
};

export default {
  async fetch(request, env) {
    return handle(request, {
      store: new D1Store(env.DB),
      rateLimiter: env.SENDS,
      timeInMilliseconds: Date.now(),
    });
  },
};

/**
 * Answers one request. `store` has the methods of `D1Store`; `rateLimiter`
 * is a Workers rate-limit binding, or undefined to skip it (local runs).
 */
export async function handle(request, { store, rateLimiter, timeInMilliseconds }) {
  const { pathname } = new URL(request.url);
  if (pathname === "/total" && request.method === "GET") {
    const totals = await store.totals({
      topProjects: TOP_PROJECTS,
      timeInMilliseconds,
      maxAgeInMilliseconds: TOTALS_MAX_AGE_IN_SECONDS * 1000,
    });
    return json(totals, 200, READ_HEADERS);
  }
  if (pathname === "/total" && request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: READ_HEADERS });
  }
  if (pathname === "/increment" && request.method === "POST") {
    return increment(request, { store, rateLimiter, timeInMilliseconds });
  }
  return json({ error: "not found" }, 404);
}

async function increment(request, { store, rateLimiter, timeInMilliseconds }) {
  if (rateLimiter !== undefined) {
    const sender = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await rateLimiter.limit({ key: sender });
    if (!success) return json({ error: "too many sends" }, 429);
  }

  const parsed = await readBody(request);
  if (!parsed.ok) return json({ error: parsed.reason }, parsed.status);
  const verdict = checkSend(parsed.body);
  if (!verdict.ok) return json({ error: verdict.reason }, 400);

  const result = await store.addSend({
    send: verdict.send,
    country: countryOf(request),
    timeInMilliseconds,
    gapInMilliseconds: MIN_SEND_GAP_IN_MILLISECONDS,
    maxNewPerDay: MAX_NEW_PROJECTS_PER_DAY,
  });
  if (result.outcome === "overlap") {
    return json({ error: "this window was already counted", coveredTo: result.coveredTo }, 409);
  }
  if (result.outcome === "too-soon") return json({ error: "this project already sent today" }, 429);
  if (result.outcome === "day-full") return json({ error: "too many new projects today" }, 429);
  return json({ ok: true }, 200);
}

const TOO_LARGE = { ok: false, status: 413, reason: "body too large" };

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_IN_BYTES) return TOO_LARGE;
  const bytes = await readAtMost(request.body, MAX_BODY_IN_BYTES);
  if (bytes === null) return TOO_LARGE;
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, reason: "body is not JSON" };
  }
}

// Collects the stream's bytes, or returns null as soon as they pass `limit`, so an
// unbounded body never gets buffered. A missing body (null stream) reads as empty.
async function readAtMost(stream, limit) {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const piece of chunks) {
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  return bytes;
}

function json(value, status, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
