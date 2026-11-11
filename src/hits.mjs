// FindWright's own hit rate. A search scores when the session opens a project
// file within the next few tool calls: a hit when that file was in the answer.
// Each session's figure is appended to .findwright/hits.jsonl; `assess` reads the
// misses back and says why they missed and what config change would help.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { find } from "./find.mjs";

const SEARCH_TOOL = /^mcp__findwright__(find|search)$/;
const OPEN_TOOLS = { Read: "file_path", Edit: "file_path", Write: "file_path", MultiEdit: "file_path" };
const WINDOW = 8;
export const DEFAULT_GOAL = 90;
const SESSIONS_BEFORE_ASSESS = 3;

/** The newest transcript of the CLI session that runs in `root`. */
export function newestTranscript(root) {
  const slug = resolve(root).replace(/[^A-Za-z0-9]/g, "-");
  const folder = join(homedir(), ".claude", "projects", slug);
  if (!existsSync(folder)) return null;
  const files = readdirSync(folder).filter((f) => f.endsWith(".jsonl")).map((f) => join(folder, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

// The session's tool calls in order, each with its result text.
function calls(transcript) {
  const seq = [];
  const results = new Map();
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.isSidechain) continue;
    for (const part of row.message?.content ?? []) {
      if (part?.type === "tool_use" && row.type === "assistant") seq.push({ id: part.id, name: part.name, input: part.input ?? {} });
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

/** Scores one session: `{ scored, hits, misses: [{ query, wanted }] }`. */
export function scoreSession(transcript, root) {
  const seq = calls(transcript);
  const out = { scored: 0, hits: 0, misses: [] };
  seq.forEach((call, i) => {
    if (!SEARCH_TOOL.test(call.name)) return;
    for (const next of seq.slice(i + 1, i + 1 + WINDOW)) {
      if (SEARCH_TOOL.test(next.name)) return;
      const key = OPEN_TOOLS[next.name];
      const wanted = key && relativeTo(root, next.input[key] ?? "");
      if (!wanted) continue;
      out.scored++;
      if (answered(call.result).has(wanted)) out.hits++;
      else out.misses.push({ query: call.input.query ?? (call.input.patterns ?? []).join(" | "), wanted });
      return;
    }
  });
  return out;
}

const logFile = (root) => join(root, ".findwright", "hits.jsonl");

/** The sessions recorded so far, oldest first. */
export function history(root) {
  if (!existsSync(logFile(root))) return [];
  return readFileSync(logFile(root), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Scores the newest session and records it once. Returns the session's figure,
 * the goal, and whether the last few sessions all fell short of it.
 */
export function recordSession(root, { goal = DEFAULT_GOAL, transcript = newestTranscript(root) } = {}) {
  if (!transcript) return { error: "No session transcript found for this folder." };
  const session = transcript.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, "");
  const score = scoreSession(transcript, root);
  const past = history(root).filter((h) => h.session !== session);
  const entry = { session, date: new Date().toISOString().slice(0, 10), ...score };
  // A second close of the same session replaces its line instead of adding one.
  if (score.scored) writeFileSync(logFile(root), [...past, entry].map((h) => JSON.stringify(h) + "\n").join(""));
  const recent = [...past, ...(score.scored ? [entry] : [])].slice(-SESSIONS_BEFORE_ASSESS);
  const rate = (h) => (100 * h.hits) / h.scored;
  return {
    rate: score.scored ? Math.round(rate(entry)) : null,
    scored: score.scored,
    goal,
    assess: recent.length === SESSIONS_BEFORE_ASSESS && recent.every((h) => rate(h) < goal),
  };
}

// Why one wanted file was not in the answer.
function diagnose(db, miss, model) {
  const file = db.prepare("SELECT kind, symbols FROM files WHERE path = ?").get(miss.wanted);
  if (!file) return { reason: "not-indexed", path: miss.wanted };
  if (file.kind === "binary") return { reason: "binary", path: miss.wanted };
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
  const unindexed = [...new Set(count("not-indexed").map((c) => c.path.split("/")[0]))];
  if (unindexed.length) suggestions.push({ change: "include", globs: unindexed.map((d) => `${d}/**`), why: "files the session opened are not indexed" });
  for (const ext of new Set(count("no-symbols").map((c) => extensionOf(c.path)))) {
    suggestions.push({ change: "rule", glob: `**/*${ext}`, why: `${ext} files yield no symbols; add a pattern rule for their definitions` });
  }
  const low = count("ranked-low");
  if (low.length) {
    const ranks = low.map((c) => c.rank).sort((a, b) => a - b);
    suggestions.push({ change: "limit", value: Math.min(30, ranks[Math.floor(ranks.length * 0.8)]), why: "the wanted file was found but listed past the answer's end" });
  }
  return { misses: causes.length, byCause: Object.fromEntries(["not-indexed", "no-symbols", "ranked-low", "no-shared-words", "binary"].map((r) => [r, count(r).length])), suggestions };
}
