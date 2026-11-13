// Opt-in usage counts: how often FindWright's searches led a session to the file it then
// opened, summed per window and sent to the counter. Only the sums, a random project id,
// the project's kind and the window's start and end leave the computer.

import { randomBytes } from "node:crypto";
import {
  mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { scoreSession, transcriptsOf } from "./hits.mjs";

/** The project kinds a person can pick. */
export const KINDS = ["game", "business-app", "developer-tool", "mobile-app", "website", "other"];
/** The kind that keeps a project out of the counts. */
export const LEFT_OUT = "none";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_SEARCHES = 20000;
const MAX_SESSIONS = 2000;
const TIMEOUT_MS = 2000;
const DEFAULT_COUNTER_URL = "https://findwright-counter.starfoxcom.workers.dev";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const emptyState = () => ({ asked: false, share: false, projects: {} });
const stateFile = () =>
  join(process.env.FINDWRIGHT_HOME ?? join(homedir(), ".findwright"), "counts.json");
const projectKey = (root) => realpathSync.native(resolve(root));

// A missing or damaged file reads as empty state, so the next answer starts from nothing.
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8"));
    if (isObject(parsed)) {
      return {
        asked: parsed.asked === true,
        share: parsed.share === true,
        projects: isObject(parsed.projects) ? parsed.projects : {},
      };
    }
  } catch {
    // Missing or unreadable: the empty state applies.
  }
  return emptyState();
}

// Written beside the file, then renamed over it: a crash keeps the old state, never half a new one.
function writeState(state) {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

const projectOf = (state, root) => state.projects[projectKey(root)];

/** The sharing setting, and the kind of `root`'s project when `root` is given. */
export function status(root = null) {
  const state = readState();
  const project = root ? projectOf(state, root) : undefined;
  return { share: state.share, asked: state.asked, kind: project?.kind ?? null };
}

/** Turns sharing on or off. Setting it also marks the question as asked. */
export function setShare(on) {
  const state = readState();
  state.share = on === true;
  state.asked = true;
  writeState(state);
  return { share: state.share, asked: true };
}

/**
 * Sets the kind of `root`'s project, or LEFT_OUT. The first call also makes the project's
 * random id, which is what the counter sees instead of the path.
 */
export function setProject(root, kind) {
  if (kind !== LEFT_OUT && !KINDS.includes(kind)) {
    return { error: `kind must be one of ${[...KINDS, LEFT_OUT].join(", ")}` };
  }
  const state = readState();
  const key = projectKey(root);
  const project = state.projects[key] ?? {};
  project.id ??= randomBytes(16).toString("hex");
  project.kind = kind;
  state.projects[key] = project;
  writeState(state);
  return { kind };
}

// The sessions not sent yet and idle for an hour, oldest first: a running session waits.
function candidatesOf(root, sent, now) {
  return transcriptsOf(root)
    .map((file) => ({ file, id: basename(file, ".jsonl"), mtimeMs: statSync(file).mtimeMs }))
    .filter((candidate) => !sent.has(candidate.id) && now - candidate.mtimeMs >= HOUR_MS)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// Adds the scored sessions, oldest first, and stops before one would pass a limit.
function totalsOf(root, candidates) {
  const totals = { sessions: 0, searches: 0, hits: 0, bytes: 0 };
  const sessionIds = [];
  let oldestMs = null;
  for (const candidate of candidates) {
    const score = scoreSession(candidate.file, root);
    if (score.scored === 0) continue;
    if (totals.searches + score.scored > MAX_SEARCHES || totals.sessions + 1 > MAX_SESSIONS) break;
    totals.sessions += 1;
    totals.searches += score.scored;
    totals.hits += score.hits;
    totals.bytes += score.bytes;
    sessionIds.push(candidate.id);
    oldestMs ??= candidate.mtimeMs;
  }
  return sessionIds.length ? { totals, sessionIds, oldestMs } : null;
}

// The body for a project at `now`, with the session ids it covers; null when nothing is new.
function gather(root, project, now) {
  const found = totalsOf(root, candidatesOf(root, new Set(project.sent ?? []), now));
  if (!found) return null;
  return {
    body: { ...found.totals, from: project.coveredTo ?? found.oldestMs, to: now },
    sessionIds: found.sessionIds,
  };
}

/** What `root` would send at `now`: `{ body, sessionIds }`, or null when nothing is new. */
export function collect(root, now) {
  return gather(root, projectOf(readState(), root) ?? {}, now);
}

// One POST with a 2 s limit. A timeout or a refused connection throws; the caller changes nothing.
async function post(fetch, payload) {
  const url = `${process.env.FINDWRIGHT_COUNTER_URL ?? DEFAULT_COUNTER_URL}/increment`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// A 409 names the end of the window the counter already holds; the retry starts there.
async function deliver(pending, project, fetch) {
  const payload = (body) => ({ project: project.id, kind: project.kind, ...body });
  let body = pending.body;
  let reply = await post(fetch, payload(body));
  if (reply.status === 409 && Number.isFinite(reply.body?.coveredTo)) {
    body = { ...pending.body, from: reply.body.coveredTo };
    reply = await post(fetch, payload(body));
  }
  return reply.status === 200 ? { body } : { reason: `the counter answered ${reply.status}` };
}

function blockedReason(state, project, now) {
  if (!state.share) return "sharing is off";
  if (!project || !KINDS.includes(project.kind)) return "the project has no kind";
  if (project.lastSend !== undefined && now - project.lastSend < DAY_MS) {
    return "sent within the last 24 hours";
  }
  return null;
}

// Only after a 200: the sessions count as sent and the window as covered.
function recordSent(root, sessionIds, coveredTo, now) {
  const state = readState();
  const project = projectOf(state, root);
  project.sent = [...(project.sent ?? []), ...sessionIds];
  project.coveredTo = coveredTo;
  project.lastSend = now;
  writeState(state);
}

async function attempt(root, now, fetch) {
  const state = readState();
  const project = projectOf(state, root);
  const blocked = blockedReason(state, project, now);
  if (blocked) return { sent: false, reason: blocked };
  const pending = gather(root, project, now);
  if (!pending) return { sent: false, reason: "nothing new" };
  const delivered = await deliver(pending, project, fetch);
  if (!delivered.body) return { sent: false, reason: delivered.reason };
  recordSent(root, pending.sessionIds, delivered.body.to, now);
  return { sent: true, ...delivered.body };
}

/**
 * Sends the pending counts of `root` when sharing is on, the project has a kind and the last
 * send was a day ago. Never throws: returns `{ sent: true, sessions, searches, hits, bytes,
 * from, to }` or `{ sent: false, reason }`.
 */
export async function send(root, { now = Date.now(), fetch = globalThis.fetch } = {}) {
  try {
    return await attempt(root, now, fetch);
  } catch (error) {
    return { sent: false, reason: `not sent: ${error.message}` };
  }
}
