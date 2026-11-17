// FindWright's own hit rate. A search scores when the session opens a project
// file within the next few tool calls: a hit when that file was in the answer.
// Each session's figure is appended to .findwright/hits.jsonl; `assess` reads the
// misses back and says why they missed and what config change would help.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { find } from "./find.mjs";
import { checkOwnFolder, configChangedAt, UNREADABLE } from "./store.mjs";
import { estimateSaving, helperTranscripts, mergeGroups, searchGroups } from "./savings.mjs";

const SEARCH_TOOL = /^mcp__findwright__(find|search)$/;
const OPEN_TOOLS = { Read: "file_path", Edit: "file_path", Write: "file_path", MultiEdit: "file_path" };
const WINDOW = 8;
const ANSWER_BYTES = 65536;
export const DEFAULT_GOAL = 90;
const SESSIONS_BEFORE_ASSESS = 3;

/**
 * Every transcript of the CLI sessions that run in `root`. FINDWRIGHT_TRANSCRIPTS
 * replaces the folder that holds them, for tests.
 */
export function transcriptsOf(root) {
  const slug = resolve(root).replace(/[^A-Za-z0-9]/g, "-");
  const folder = process.env.FINDWRIGHT_TRANSCRIPTS
    ?? join(homedir(), ".claude", "projects", slug);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => f.endsWith(".jsonl")).map((f) => join(folder, f));
}

/** The newest transcript of the CLI session that runs in `root`. */
export function newestTranscript(root) {
  const files = transcriptsOf(root);
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

// The session's tool calls in order, each with its result text, the time it was made (whole
// epoch milliseconds, or null when the row has no readable timestamp) and the id of the model
// response that made it. A helper's transcript holds only side-chain rows, so `helper` keeps them.
function calls(transcript, { helper = false } = {}) {
  const seq = [];
  const results = new Map();
  const text = readFileSync(transcript, "utf8");
  // Most transcripts never call FindWright; one text check skips parsing them.
  if (!text.includes("mcp__findwright__")) return seq;
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.isSidechain && !helper) continue;
    for (const part of row.message?.content ?? []) {
      if (part?.type === "tool_use" && row.type === "assistant") {
        const at = Math.floor(Date.parse(row.timestamp));
        seq.push({
          id: part.id, name: part.name, input: part.input ?? {},
          at: Number.isSafeInteger(at) ? at : null, response: row.message.id ?? null,
        });
      }
      if (part?.type === "tool_result") {
        const c = part.content;
        results.set(part.tool_use_id, Array.isArray(c) ? c.map((x) => x.text ?? "").join("\n") : String(c ?? ""));
      }
    }
  }
  return seq.map((c) => ({ ...c, result: results.get(c.id) ?? "" }));
}

const relativeTo = (root, path) => {
  const rel = relative(resolve(root), resolve(root, path)).replaceAll("\\", "/");
  return rel.startsWith("..") ? null : rel;
};

// The project files an answer names: each line that starts with a path.
const answered = (text) => new Set(text.split("\n").map((l) => l.trim().split(/\s|:/)[0]).filter((p) => p.includes(".")));

/**
 * The session's scored searches in order: `[{ at, hit, bytes, query, wanted, from, to }]`. `at` is
 * when the search ran (null without a timestamp); `bytes` is its answer's UTF-8 size, capped at
 * ANSWER_BYTES; `from` and `to` are the ids of the responses that searched and opened the file.
 */
export function scoredSearches(transcript, root, { helper = false } = {}) {
  const seq = calls(transcript, { helper });
  const out = [];
  seq.forEach((call, i) => {
    if (!SEARCH_TOOL.test(call.name)) return;
    for (const next of seq.slice(i + 1, i + 1 + WINDOW)) {
      if (SEARCH_TOOL.test(next.name)) return;
      const key = OPEN_TOOLS[next.name];
      const wanted = key && relativeTo(root, next.input[key] ?? "");
      if (!wanted) continue;
      out.push({
        at: call.at,
        hit: answered(call.result).has(wanted),
        bytes: Math.min(ANSWER_BYTES, Buffer.byteLength(call.result)),
        query: call.input.query ?? (call.input.patterns ?? []).join(" | "),
        wanted,
        from: call.response,
        to: next.response,
      });
      return;
    }
  });
  return out;
}

// A session's score: `{ scored, hits, misses: [{ query, wanted }] }`.
function tally(searches) {
  return {
    scored: searches.length,
    hits: searches.filter((s) => s.hit).length,
    misses: searches.filter((s) => !s.hit).map(({ query, wanted }) => ({ query, wanted })),
  };
}

const logFile = (root) => join(root, ".findwright", "hits.jsonl");

/** The sessions recorded so far, oldest first. */
export function history(root) {
  if (!existsSync(logFile(root))) return [];
  return readFileSync(logFile(root), "utf8").split("\n").filter(Boolean).flatMap(parseLine);
}

// A damaged line (a close cut off mid-write) is dropped, never the whole history.
function parseLine(line) {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry.scored === "number" && Array.isArray(entry.misses) ? [entry] : [];
  } catch {
    return [];
  }
}

const rateOf = (h) => (100 * h.hits) / h.scored;

/** The sessions recorded since the config last changed, so a fit starts the count again. */
export function sinceFit(root, sessions) {
  const changed = configChangedAt(root);
  return sessions.filter((h) => Date.parse(h.at ?? h.date) > changed);
}

/** Whether the last few recorded sessions all fell short of `goal`. */
export function fellShort(sessions, goal) {
  const recent = sessions.slice(-SESSIONS_BEFORE_ASSESS);
  return recent.length === SESSIONS_BEFORE_ASSESS && recent.every((h) => rateOf(h) < goal);
}

// A transcript that cannot be read or parsed, or vanishes while being read, gives `fallback`, so
// it drops out of the estimate and never stops the rest.
function orElse(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

// The search groups of the helper sessions a session started, all added together.
function helperGroups(transcript, root) {
  return mergeGroups(...orElse(() => helperTranscripts(transcript), []).map((file) => orElse(() =>
    searchGroups(file, scoredSearches(file, root, { helper: true }), { helper: true }), {})));
}

const modifiedAt = (file) => orElse(() => statSync(file).mtimeMs, 0);

// The newest sessions that searched are enough to measure what a miss costs; reading every
// transcript would slow each close as the history grows.
const POOLED_SESSIONS = 10;

// The search groups of the newest other sessions that searched, read afresh from their transcripts
// each time, so what a miss costs never comes from a stored total.
function otherSessionGroups(root, transcript) {
  const others = transcriptsOf(root).filter((file) => resolve(file) !== resolve(transcript))
    .map((file) => ({ file, at: modifiedAt(file) })).sort((a, b) => b.at - a.at);
  const pooled = [];
  for (const { file } of others) {
    const own = orElse(() => searchGroups(file, scoredSearches(file, root)), {});
    const groups = mergeGroups(own, helperGroups(file, root));
    if (Object.keys(groups).length) pooled.push(groups);
    if (pooled.length === POOLED_SESSIONS) break;
  }
  return pooled;
}

// The saving is an extra: whatever goes wrong while estimating it, the hit rate is already
// recorded, and the answer says why there is no figure.
function savingOf(root, transcript, searches) {
  try {
    const main = searchGroups(transcript, searches);
    const helpers = helperGroups(transcript, root);
    return estimateSaving({ main, helpers }, mergeGroups(main, helpers, ...otherSessionGroups(root, transcript)));
  } catch (error) {
    return { main: null, helpers: null, why: `the saving could not be estimated: ${error.message}` };
  }
}

/**
 * Scores the newest session and records it once. Returns the session's figure, the goal,
 * whether the last few sessions all fell short of it, and the estimated saving in dollars.
 */
export function recordSession(root, { goal = DEFAULT_GOAL, transcript = newestTranscript(root) } = {}) {
  if (!transcript) return { error: "No session transcript found for this folder." };
  try {
    checkOwnFolder(root);
  } catch (error) {
    return { error: error.message };
  }
  const session = transcript.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, "");
  const searches = scoredSearches(transcript, root);
  const score = tally(searches);
  const past = history(root).filter((h) => h.session !== session);
  const now = new Date().toISOString();
  const entry = { session, date: now.slice(0, 10), at: now, ...score };
  // A second close of the same session replaces its line instead of adding one.
  if (score.scored) {
    mkdirSync(dirname(logFile(root)), { recursive: true });
    writeFileSync(logFile(root), [...past, entry].map((h) => JSON.stringify(h) + "\n").join(""));
  }
  return {
    rate: score.scored ? Math.round(rateOf(entry)) : null,
    scored: score.scored,
    goal,
    assess: fellShort(sinceFit(root, [...past, ...(score.scored ? [entry] : [])]), goal),
    saved: savingOf(root, transcript, searches),
  };
}

// Why one wanted file was not in the answer.
function diagnose(db, miss, model) {
  const file = db.prepare("SELECT kind, symbols FROM files WHERE path = ?").get(miss.wanted);
  if (!file) return { reason: "not-indexed", path: miss.wanted };
  if (file.kind === UNREADABLE) return { reason: "binary", path: miss.wanted };
  const rank = find(db, { query: miss.query, limit: 200, model }).findIndex((f) => f.path === miss.wanted);
  if (rank >= 0) return { reason: "ranked-low", path: miss.wanted, rank: rank + 1 };
  if (file.symbols === 0) return { reason: "no-symbols", path: miss.wanted, kind: file.kind };
  return { reason: "no-shared-words", path: miss.wanted };
}

const extensionOf = (path) => (path.match(/\.[^./]+$/)?.[0] ?? path.replace(/^.*\//, ""));

/**
 * The misses of the recorded sessions, sorted by cause, with the config changes
 * that would address them. Nothing is changed: the person decides.
 */
export function assess(db, root, model = null) {
  const misses = history(root).flatMap((h) => h.misses);
  const causes = misses.map((m) => ({ ...m, ...diagnose(db, m, model) }));
  const count = (reason) => causes.filter((c) => c.reason === reason);
  const suggestions = [];
  const asGlob = (path) => (path.includes("/") ? `${path.split("/")[0]}/**` : path);
  const globs = [...new Set(count("not-indexed").map((c) => asGlob(c.path)))];
  if (globs.length) suggestions.push({ change: "include", globs, why: "files the session opened are not indexed" });
  for (const ext of new Set(count("no-symbols").map((c) => extensionOf(c.path)))) {
    suggestions.push({ change: "rule", glob: `**/*${ext}`, why: `${ext} files yield no symbols; run /findwright:fit to write rules for them` });
  }
  const low = count("ranked-low");
  if (low.length) {
    const ranks = low.map((c) => c.rank).sort((a, b) => a - b);
    suggestions.push({ change: "limit", value: Math.min(30, ranks[Math.floor(ranks.length * 0.8)]), why: "the wanted file was found but listed past the answer's end" });
  }
  return { misses: causes.length, byCause: Object.fromEntries(["not-indexed", "no-symbols", "ranked-low", "no-shared-words", "binary"].map((r) => [r, count(r).length])), suggestions };
}
