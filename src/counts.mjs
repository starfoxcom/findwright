// Opt-in usage counts: how often FindWright's searches led a session to the file it then
// opened, summed per window and sent to the counter. Only the sums, a random project id,
// the project's kind and the window's start and end leave the computer.

import { randomBytes } from "node:crypto";
import {
  mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { scoredSearches, transcriptsOf } from "./hits.mjs";

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

// Every scored search of the project's sessions made in [from, to), oldest first, each with
// its session. A transcript last written before `from` holds no such search and is not read.
function searchesIn(root, from, to) {
  return transcriptsOf(root)
    .filter((file) => statSync(file).mtimeMs >= from)
    .flatMap((file) => scoredSearches(file, root).map((search) => ({ ...search, session: basename(file) })))
    .filter((search) => search.at !== null && search.at >= from && search.at < to)
    .sort((a, b) => a.at - b.at);
}

// The oldest searches that fit the counter's limits, and where the span they fill ends: at
// `to`, or at the first search left out, together with any taken at that same millisecond.
function fitToLimits(searches, to) {
  const sessions = new Set();
  let taken = 0;
  for (; taken < searches.length; taken++) {
    const session = searches[taken].session;
    if (taken + 1 > MAX_SEARCHES || (!sessions.has(session) && sessions.size + 1 > MAX_SESSIONS)) break;
    sessions.add(session);
  }
  if (taken === searches.length) return { searches, to };
  const end = searches[taken].at;
  return { searches: searches.slice(0, taken).filter((search) => search.at < end), to: end };
}

// The body for a project at `now`, or null when nothing is new. The span starts where the last
// counted one ended and stops an hour ago, so a search's follow-up calls are in its transcript.
function gather(root, project, now) {
  const from = project.coveredTo ?? 0;
  const fitted = fitToLimits(searchesIn(root, from, now - HOUR_MS), now - HOUR_MS);
  if (fitted.searches.length === 0 || fitted.to <= from) return null;
  return {
    sessions: new Set(fitted.searches.map((search) => search.session)).size,
    searches: fitted.searches.length,
    hits: fitted.searches.filter((search) => search.hit).length,
    bytes: fitted.searches.reduce((sum, search) => sum + search.bytes, 0),
    from,
    to: fitted.to,
  };
}

/** What `root` would send at `now`: `{ sessions, searches, hits, bytes, from, to }`, or null. */
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

function blockedReason(state, project, now) {
  if (!state.share) return "sharing is off";
  if (!project || !KINDS.includes(project.kind)) return "the project has no kind";
  if (project.lastTry !== undefined && now - project.lastTry < DAY_MS) return "tried within the last 24 hours";
  return null;
}

// Moves what the counter holds forward and, unless the try is to run again at once, starts the
// day's wait. A project removed meanwhile stays removed.
function record(root, { coveredTo, lastTry }) {
  const state = readState();
  const project = projectOf(state, root);
  if (!project) return;
  if (coveredTo !== undefined) project.coveredTo = Math.max(project.coveredTo ?? 0, coveredTo);
  if (lastTry !== undefined) project.lastTry = lastTry;
  writeState(state);
}

// A 200 covers the span. A 409 means an earlier send was counted though its answer was lost:
// nothing is resent, and the next try, at the next server start, begins where the counter's
// count stops, so no search counts twice. Any other outcome waits a day.
async function attempt(root, now, fetch) {
  const state = readState();
  const project = projectOf(state, root);
  const blocked = blockedReason(state, project, now);
  if (blocked) return { sent: false, reason: blocked };
  const body = gather(root, project, now);
  if (!body) {
    record(root, { lastTry: now });
    return { sent: false, reason: "nothing new" };
  }
  let reply;
  try {
    reply = await post(fetch, { project: project.id, kind: project.kind, ...body });
  } catch (error) {
    record(root, { lastTry: now });
    return { sent: false, reason: `not sent: ${error.message}` };
  }
  if (reply.status === 200) {
    record(root, { coveredTo: body.to, lastTry: now });
    return { sent: true, ...body };
  }
  if (reply.status === 409 && Number.isSafeInteger(reply.body?.coveredTo)) {
    record(root, { coveredTo: reply.body.coveredTo });
    return { sent: false, reason: "already counted; the next send starts after it" };
  }
  record(root, { lastTry: now });
  return { sent: false, reason: `the counter answered ${reply.status}` };
}

/**
 * Sends the pending counts of `root` when sharing is on, the project has a kind and the last
 * try was a day ago. Never throws: returns `{ sent: true, sessions, searches, hits, bytes,
 * from, to }` or `{ sent: false, reason }`.
 */
export async function send(root, { now = Date.now(), fetch = globalThis.fetch } = {}) {
  try {
    return await attempt(root, now, fetch);
  } catch (error) {
    return { sent: false, reason: `not sent: ${error.message}` };
  }
}
