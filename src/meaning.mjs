// The meaning layer of the index: each text file split into overlapping windows
// of lines, each window stored as an int8 vector of the static code model.

import { dot, ensureModel, loadModel, packVector } from "./embed.mjs";

let loading = null;
let loaded = null;
let failure = null;

/**
 * The meaning model with the index's vectors brought up to date: `{ ready }`, or
 * `{ ready: null, note }` while it downloads or when it cannot load, so a search
 * still answers by words alone. Set FINDWRIGHT_MEANING=off to skip it.
 */
export async function meaningModel(db, { wait = false } = {}) {
  if (process.env.FINDWRIGHT_MEANING === "off") return { ready: null };
  // The download runs in the background: until it lands, searches rank by words alone.
  if (!loaded && !loading) {
    failure = null;
    loading = ensureModel().then(loadModel).then((model) => { loaded = model; }, (error) => { failure = error; loading = null; });
  }
  // A one-shot caller (the CLI) waits; the server answers at once.
  if (wait) await loading;
  if (!loaded && failure) return { ready: null, note: `(meaning search is off: ${failure.message}; ranked by words only)` };
  if (!loaded) return { ready: null, note: "(meaning model still downloading; ranked by words only)" };
  // A big repo's vectors are built over several calls, two seconds at a time.
  embedMissing(db, loaded, 2000);
  return { ready: loaded };
}

const WINDOW_LINES = 30;
const STEP_LINES = 20;

/** Embeds every indexed text file that has no vectors yet; returns how many it embedded. */
export function embedMissing(db, model, budgetMs = Infinity) {
  const started = performance.now();
  const todo = db.prepare(
    "SELECT b.path, b.text FROM body b JOIN files f ON f.path = b.path WHERE b.path NOT IN (SELECT path FROM embedded)",
  ).all();
  const insert = db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)");
  const mark = db.prepare("INSERT OR IGNORE INTO embedded VALUES (?)");
  db.exec("BEGIN");
  try {
    for (const { path, text } of todo) {
      const lines = text.split(/\r?\n/);
      for (let start = 0; start < lines.length; start += STEP_LINES) {
        const end = Math.min(lines.length, start + WINDOW_LINES);
        const vector = model.encode(`${path}\n${lines.slice(start, end).join("\n")}`);
        if (vector) insert.run(path, start + 1, end, packVector(vector));
        if (end === lines.length) break;
      }
      mark.run(path);
      if (performance.now() - started > budgetMs) break;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return todo.length;
}

/** Each file's best window similarity to `query`, as a Map of path to [0, 1]. */
export function meaningScores(db, model, query, keep = () => true) {
  const vector = model.encode(query);
  const best = new Map();
  if (!vector) return best;
  for (const { path, vec } of db.prepare("SELECT path, vec FROM chunks").iterate()) {
    if (!keep(path)) continue;
    const s = dot(vector, vec);
    if (s > (best.get(path) ?? 0)) best.set(path, s);
  }
  return best;
}
