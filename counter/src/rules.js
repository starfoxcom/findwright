// What the counter accepts. Kept apart from the request handling so the
// limits read in one place and the tests can import them.

/** The project kinds a user can pick at opt-in. Anything else is refused. */
export const KINDS = Object.freeze([
  "game",
  "business-app",
  "developer-tool",
  "mobile-app",
  "website",
  "other",
]);

/** The counts a send carries, in the order the page shows them. */
export const COUNT_FIELDS = Object.freeze(["sessions", "searches", "hits", "bytes"]);

/** Upper bounds per send, sized so a project's first send can carry its whole past history. */
export const MAX_SESSIONS_PER_SEND = 2000;
export const MAX_SEARCHES_PER_SEND = 20000;

/** The largest answer, in bytes, that one search adds to `bytes`. */
export const MAX_ANSWER_BYTES = 65536;

/** A project may send again only this long after its last accepted send. */
export const MIN_SEND_GAP_IN_MILLISECONDS = 20 * 60 * 60 * 1000;

/** New project ids accepted per UTC day, across all senders. */
export const MAX_NEW_PROJECTS_PER_DAY = 200;

/** Request bodies above this size are refused before parsing. */
export const MAX_BODY_IN_BYTES = 1024;

/** How many projects `GET /total` lists. */
export const TOP_PROJECTS = 10;

const PROJECT_ID = /^[0-9a-f]{32}$/;

/** The window a send covers: the sessions it counts ran from `from` up to `to`, in epoch ms. */
const WINDOW = Object.freeze(["from", "to"]);

const ALLOWED_KEYS = new Set(["project", "kind", ...COUNT_FIELDS, ...WINDOW]);

/**
 * Checks a parsed send and returns either `{ ok: true, send }` with the
 * clean values or `{ ok: false, reason }`. Unknown keys are refused rather
 * than dropped, so a client that starts sending more data fails loudly.
 *
 * ```js
 * checkSend({ project: "0f...", kind: "game", sessions: 2, searches: 10, hits: 7,
 *   bytes: 40000, from: 1793750400000, to: 1793836800000 });
 * ```
 */
export function checkSend(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return refuse("body must be a JSON object");
  }
  const extra = Object.keys(body).find((key) => !ALLOWED_KEYS.has(key));
  if (extra !== undefined) return refuse(`unknown field: ${extra}`);
  if (typeof body.project !== "string" || !PROJECT_ID.test(body.project)) {
    return refuse("project must be 32 lowercase hex characters");
  }
  if (!KINDS.includes(body.kind)) return refuse("kind is not one of the listed kinds");
  const isTime = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!isTime(body.from) || !isTime(body.to)) {
    return refuse("from and to must be times in milliseconds");
  }
  if (body.from >= body.to) return refuse("from must be before to");

  const counts = {};
  for (const field of COUNT_FIELDS) {
    const value = body[field];
    const limit = limitOf(field, counts);
    if (!Number.isInteger(value) || value < 0 || value > limit) {
      return refuse(`${field} must be a whole number from 0 to ${limit}`);
    }
    counts[field] = value;
  }
  const contradiction = contradictionOf(counts);
  if (contradiction !== null) return refuse(contradiction);
  if (counts.searches === 0) return refuse("nothing to add");
  const { project, kind, from, to } = body;
  return { ok: true, send: { project, kind, ...counts, from, to } };
}

// The most one count may hold. Bytes are bounded by the searches they came
// from, so `counts` must already hold the searches when bytes is checked.
function limitOf(field, counts) {
  if (field === "sessions") return MAX_SESSIONS_PER_SEND;
  if (field === "bytes") return counts.searches * MAX_ANSWER_BYTES;
  return MAX_SEARCHES_PER_SEND;
}

// The first reason two counts of one send contradict each other, or null when they agree.
function contradictionOf(counts) {
  if (counts.hits > counts.searches) return "hits cannot exceed searches";
  if (counts.sessions > counts.searches) return "sessions cannot exceed searches";
  if (counts.searches > 0 && counts.sessions === 0) return "searches need a session";
  return null;
}

/** The country code Cloudflare derived from the request, or "XX" when unknown. */
export function countryOf(request) {
  const country = request.cf?.country;
  return typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : "XX";
}

/** The UTC day of a timestamp, as `YYYY-MM-DD`. */
export function dayOf(timeInMilliseconds) {
  return new Date(timeInMilliseconds).toISOString().slice(0, 10);
}

function refuse(reason) {
  return { ok: false, reason };
}
