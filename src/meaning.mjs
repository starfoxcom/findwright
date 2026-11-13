// The meaning layer of the index: each text file split into overlapping windows
// of lines, each window stored as an int8 vector of the static code model.

import { dot, installedModel, loadModel, packVector } from "./embed.mjs";

const NOT_INSTALLED = "FindWright's meaning model is not installed or does not match its pinned checksum. "
  + "Run /findwright:setup (or `findwright model` from a shell) to install it, "
  + "or set FINDWRIGHT_MEANING=off to turn meaning search off.";

let loaded = null;

/**
 * The meaning model with the index's vectors brought up to date: `{ ready }`; `{ ready: null }`
 * when FINDWRIGHT_MEANING=off turns meaning search off; or `{ error }` when the model setup
 * installs is missing or will not load, since a search without it would quietly rank worse.
 */
export function meaningModel(db) {
  if (process.env.FINDWRIGHT_MEANING === "off") return { ready: null };
  if (!loaded) {
    const folder = installedModel();
    if (!folder) return { error: NOT_INSTALLED };
    try {
      loaded = loadModel(folder);
    } catch (error) {
      return { error: `FindWright's meaning model would not load (${error.message}). ${NOT_INSTALLED}` };
    }
  }
  // A big repo's vectors are built over several calls, two seconds at a time.
  embedMissing(db, loaded, 2000);
  return { ready: loaded };
}

const WINDOW_LINES = 30;
const STEP_LINES = 20;

/** Embeds every indexed text file that has no vectors yet; returns how many it embedded. */
export function embedMissing(db, model, budgetMs = Infinity) {
  const started = performance.now();
  // Paths first and each text as it is reached, so a call holds one file's text, not the whole repo's.
  const todo = db.prepare(
    "SELECT b.path FROM body b JOIN files f ON f.path = b.path WHERE b.path NOT IN (SELECT path FROM embedded)",
  ).all();
  const textOf = db.prepare("SELECT text FROM body WHERE path = ?");
  const insert = db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)");
  const mark = db.prepare("INSERT OR IGNORE INTO embedded VALUES (?)");
  db.exec("BEGIN");
  try {
    for (const { path } of todo) {
      const lines = textOf.get(path).text.split(/\r?\n/);
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
