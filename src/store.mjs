// The project index: one SQLite file holding every indexed file's text (in a
// trigram full-text table, the shortlist for any search) and its symbols.
// Each call first re-reads the files whose size or modified time changed, so
// answers always match the working tree.

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fromRules, isObject, normalRule, strings } from "./rules.mjs";

export { isObject };
import { linearRegExp } from "./linear.mjs";
import { isSecretFile, maskSecrets } from "./secrets.mjs";

/** The root of the git repository the process runs in, or null outside one. */
export function gitRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Files past this size are listed but not read: they are data, not code.
const MAX_FILE_BYTES = 2 * 1024 * 1024;


const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER, mtime REAL, kind TEXT, symbols INTEGER);
  CREATE VIRTUAL TABLE IF NOT EXISTS body USING fts5(path UNINDEXED, text, tokenize = 'trigram');
  CREATE TABLE IF NOT EXISTS symbols (path TEXT, name TEXT, kind TEXT, line INTEGER, end_line INTEGER);
  CREATE INDEX IF NOT EXISTS symbols_name ON symbols (name);
  CREATE INDEX IF NOT EXISTS symbols_path ON symbols (path);
  CREATE TABLE IF NOT EXISTS chunks (path TEXT, line INTEGER, end_line INTEGER, vec BLOB);
  CREATE INDEX IF NOT EXISTS chunks_path ON chunks (path);
  CREATE TABLE IF NOT EXISTS embedded (path TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

// Node's SQLite has full-text search from 22.16 on the 22 line and from 24.0; 23 never had it.
function createSchema(db) {
  try {
    db.exec(SCHEMA);
  } catch (error) {
    if (!String(error.message).includes("no such module: fts5")) throw error;
    throw new Error("FindWright needs Node 22.16 or later (or Node 24 and up): "
      + `the SQLite in Node ${process.version} has no full-text search.`);
  }
}

// With secure-delete, dropping a file removes its words from the full-text index at once, and the
// secure_delete pragma zeroes the pages that held its text. Runs inside a refresh's write transaction.
// An index built without it may still hold text it freed, so it is marked for one full wipe.
function ensureSecureDelete(db) {
  if (db.prepare("SELECT v FROM body_config WHERE k = 'secure-delete'").get()?.v === 1) return;
  const holdsText = db.prepare("SELECT 1 FROM files LIMIT 1").get();
  db.exec("INSERT INTO body(body, rank) VALUES ('secure-delete', 1)");
  if (holdsText) db.exec("INSERT OR REPLACE INTO settings VALUES ('needs-wipe', '1')");
}

// Leaves no copy of dropped text in the index's files: an index marked for a full wipe has its
// full-text segments merged and the file rewritten, and a log that holds page images is emptied into
// the file. Both marks live in the index's files, so whatever one process leaves undone (blocked by
// a reader, or cut short by an exit) the next refresh in any process finishes, and the full wipe
// counts as done only once the log is empty.
function wipeFreedText(db) {
  const pending = db.prepare("SELECT 1 FROM settings WHERE key = 'needs-wipe'").get();
  if (!pending && !logHoldsPages(db)) return;
  try {
    if (pending) {
      db.exec("INSERT INTO body(body) VALUES ('optimize')");
      db.exec("VACUUM");
    }
    if (checkpoint(db) && pending) {
      db.exec("DELETE FROM settings WHERE key = 'needs-wipe'");
      checkpoint(db);
    }
  } catch (error) {
    if (!/locked|busy/i.test(String(error.message))) throw error;
  }
}

// Empties the log into the index file, leaving it 0 bytes long; false when a reader in another process blocked it.
const checkpoint = (db) => db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy === 0;

// True when the index's log holds pages a checkpoint has not emptied into the file.
function logHoldsPages(db) {
  const file = db.prepare("PRAGMA database_list").get()?.file;
  if (!file) return false;
  try {
    return statSync(`${file}-wal`).size > 0;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const compiledGlobs = new Map();

// A glob as a RegExp over forward-slash paths: `**` spans folders, `*` and `?` stay within one.
// It runs on the linear engine, since globs come from the repo's config; one it cannot build matches nothing.
export function globToRegExp(glob) {
  if (!compiledGlobs.has(glob)) compiledGlobs.set(glob, linearRegExp(globSource(glob)) ?? /$^/);
  return compiledGlobs.get(glob);
}

function globSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A glob with no folder in it matches the file name at any depth.
  return glob.includes("/") ? `^${out}$` : `(?:^|/)${out}$`;
}

/**
 * The path test for the tools' `globs`, read the way ripgrep's `-g` reads them: a glob starting
 * with `!` leaves out the files it matches, and the others keep only the files they match.
 * With no plain glob, every file is kept except those the `!` globs leave out.
 */
export function globFilter(globs = []) {
  const plain = globs.filter((g) => !g.startsWith("!")).map(globToRegExp);
  const left = globs.filter((g) => g.startsWith("!")).map((g) => globToRegExp(g.slice(1)));
  return (path) => (!plain.length || plain.some((g) => g.test(path))) && !left.some((g) => g.test(path));
}

/** True when `path` matches any of `globs`. */
export const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));


// The config as the code reads it: a value of the wrong type is dropped, so a hand-edited or hostile
// config.json can make FindWright index less, never fail.
export function normalConfig(raw) {
  const config = isObject(raw) ? raw : {};
  const rules = (Array.isArray(config.rules) ? config.rules : []).map(normalRule).filter(Boolean);
  const goal = typeof config.goal === "number" && config.goal > 0 && config.goal <= 100 ? config.goal : undefined;
  return { include: strings(config.include), exclude: strings(config.exclude), rules, goal };
}

/** True when the repo's config lists rules, an empty list included: a project fitted with no
 * rules says so with `"rules": []`, so it is not sent to the fit again. */
export function hasRules(root) {
  try {
    return Array.isArray(JSON.parse(readFileSync(join(root, ".findwright", "config.json"), "utf8")).rules);
  } catch {
    return false;
  }
}

/** When the repo's config last changed, in milliseconds since the epoch, or 0 when it has none. */
export function configChangedAt(root) {
  try {
    return statSync(join(root, ".findwright", "config.json")).mtimeMs;
  } catch {
    return 0;
  }
}

export function readConfig(root) {
  try {
    return normalConfig(JSON.parse(readFileSync(join(root, ".findwright", "config.json"), "utf8")));
  } catch {
    return normalConfig({});
  }
}

/** The type stored for a file that cannot be read as text; no extension holds a dot. */
export const UNREADABLE = ".binary";

/** A file's type as coverage groups it: its extension (`cpp`), or `text` for a name with none. */
export function typeOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "text";
}

function walk(root, folder, out) {
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, path, out);
    else if (entry.isFile()) out.push(path);
  }
}

// Every file git tracks or would track, plus the config's `include` globs
// (files git ignores but the work reads, such as generated typings), minus `exclude`.
// A folder an include walks must really sit in the repo: one reached through a
// symlink that points outside is skipped.
function realInside(root, folder) {
  try {
    const real = realpathSync(join(root, folder));
    const base = realpathSync(root);
    return real === base || real.startsWith(base + sep);
  } catch {
    return false;
  }
}

// An include glob may not climb out of the repo or name an absolute path.
const insideRepo = (glob) => typeof glob === "string" && !/^([\\/]|[A-Za-z]:)/.test(glob)
  && !glob.split(/[\\/]/).includes("..");

const WILDCARD = /[*?]/;
// git ls-files output for the largest repos fits in 256 MB.
const GIT_LIST_MAX_BYTES = 256 * 1024 * 1024;

export function listFiles(root, config) {
  const git = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"],
    { cwd: root, maxBuffer: GIT_LIST_MAX_BYTES });
  const files = new Set(git.toString("utf8").split("\0").filter(Boolean));
  for (const glob of (config.include ?? []).filter(insideRepo)) {
    const base = glob.split("/").filter((part) => !WILDCARD.test(part));
    const start = WILDCARD.test(glob)
      ? base.slice(0, glob.split("/").findIndex((p) => WILDCARD.test(p))).join("/")
      : glob;
    const found = [];
    if (!realInside(root, start)) continue;
    // A glob that names one file includes that file; the rest walk their fixed folder.
    try {
      if (lstatSync(join(root, start)).isFile()) found.push(start);
      else walk(root, start, found);
    } catch { continue; }
    for (const path of found) if (globToRegExp(glob).test(path)) files.add(path);
  }
  return [...files].filter((path) => !isSecretFile(path) && !matchesAny(path, config.exclude ?? [])).sort();
}

// .findwright/ is where FindWright writes, so a repo must not be able to point it elsewhere: it has to be
// a real folder holding only regular files, and git may track nothing in it but config.json (a committed
// index would be opened as this computer's own).
export function checkOwnFolder(root) {
  const folder = join(root, ".findwright");
  let stat;
  try { stat = lstatSync(folder); } catch { return; }
  const refuse = (what) => {
    throw new Error(`FindWright will not use ${what}; remove it and search again.`);
  };
  if (!stat.isDirectory()) refuse(".findwright, which is not a plain folder");
  for (const name of readdirSync(folder)) {
    if (!lstatSync(join(folder, name)).isFile()) refuse(`.findwright/${name}, which is not a plain file`);
  }
  // Case-insensitive: on macOS and Windows a committed `.FindWright/index.db` is this same folder.
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ":(icase).findwright"], { cwd: root }).toString("utf8");
  const committed = tracked.split("\0").filter((path) => path && path.toLowerCase() !== ".findwright/config.json");
  if (committed.length) refuse(`${committed[0]}, which the repo commits`);
}

export function openIndex(root) {
  const file = process.env.FINDWRIGHT_DB ?? join(root, ".findwright", "index.db");
  if (!process.env.FINDWRIGHT_DB) checkOwnFolder(root);
  mkdirSync(dirname(file), { recursive: true });
  // Everything in .findwright/ is this computer's except config.json, the project's settings.
  const ignore = join(root, ".findwright", ".gitignore");
  if (!process.env.FINDWRIGHT_DB && !existsSync(ignore)) writeFileSync(ignore, "*\n!config.json\n");
  const db = new DatabaseSync(file);
  // secure_delete zeroes a dropped file's text, so the index never keeps text the files no longer hold.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA trusted_schema = OFF;"
    + " PRAGMA secure_delete = ON;");
  createSchema(db);
  return db;
}

/** A file's text with its secrets masked, or null when it is too large to index or binary. */
export function readText(root, path, size) {
  if (size > MAX_FILE_BYTES) return null;
  const bytes = readFileSync(join(root, path));
  if (bytes.subarray(0, 8000).includes(0)) return null;
  return maskSecrets(bytes.toString("utf8"));
}

function symbolsOf(text, path, config) {
  return fromRules(text, (config.rules ?? []).filter((rule) => matchesAny(path, rule.globs ?? ["**"])));
}

// This copy's version, stamped on the index with the config it read: a session can keep an older
// copy running after an update, and that copy must not rebuild an index a newer one wrote.
const ENGINE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const versionParts = (version) => version.split(".").map(Number);

function isNewer(version, than) {
  const [a, b] = [versionParts(version), versionParts(than)];
  const differs = a.findIndex((part, i) => part !== b[i]);
  return differs >= 0 && a[differs] > b[differs];
}

// Throws when a newer copy built the index, rather than rebuild it with older code.
function refuseNewerIndex(stored) {
  let engine;
  try { engine = JSON.parse(stored ?? "{}").engine; } catch { return; }
  if (typeof engine !== "string" || !/^\d+\.\d+\.\d+$/.test(engine) || !isNewer(engine, ENGINE)) return;
  throw new Error(`FindWright ${engine} built this index, and this copy is ${ENGINE}: `
    + "restart the session so it runs the new copy.");
}

// Brings the index level with the working tree; returns what changed. A change to the config's
// rules, or to this copy's version, sends every indexed file through indexFile again,
// the path a fresh index takes.
// The stored settings are checked and those files chosen under the write lock, so whenever the
// settings are written, every file row in the index was indexed with them.
export function refresh(db, root, config = readConfig(root)) {
  const extraction = JSON.stringify({ engine: ENGINE, rules: config.rules });
  const indexedWith = storedExtraction(db);
  refuseNewerIndex(indexedWith);
  const sameExtraction = indexedWith === extraction;
  const known = new Map(db.prepare("SELECT path, size, mtime FROM files").all().map((r) => [r.path, r]));
  const seen = new Set();
  const changed = [];
  for (const path of listFiles(root, config)) {
    let stat;
    // Regular files only: a submodule, a nested repo or a symlink (which may point
    // outside the repo) is listed by git but never read.
    try { stat = lstatSync(join(root, path)); } catch { continue; }
    if (!stat.isFile()) continue;
    seen.add(path);
    const old = known.get(path);
    if (!old || old.size !== stat.size || old.mtime !== stat.mtimeMs) changed.push({ path, stat });
  }
  const removed = [...known.keys()].filter((path) => !seen.has(path));
  const result = { changed: changed.length, reindexed: 0, removed: removed.length, files: seen.size };
  // A refresh that finds nothing new writes nothing, so it takes no write lock.
  if (sameExtraction && !changed.length && !removed.length) {
    wipeFreedText(db);
    return result;
  }
  db.exec("BEGIN IMMEDIATE");
  // Another process stored other settings since they were read above: start over from them.
  if (storedExtraction(db) !== indexedWith) {
    db.exec("ROLLBACK");
    return refresh(db, root, config);
  }
  try {
    ensureSecureDelete(db);
    for (const path of removed) dropFile(db, path);
    for (const { path, stat } of changed) indexFile(db, root, path, stat, config);
    if (!sameExtraction) {
      result.reindexed = reindexOthers(db, root, new Set(changed.map((c) => c.path)), config);
      db.prepare("INSERT OR REPLACE INTO settings VALUES ('extraction', ?)").run(extraction);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  wipeFreedText(db);
  return result;
}

// Indexes every file row not in `done` again; returns how many. A file no longer a regular file is dropped.
function reindexOthers(db, root, done, config) {
  const others = db.prepare("SELECT path FROM files").all().map((r) => r.path).filter((p) => !done.has(p));
  for (const path of others) {
    let stat;
    try { stat = lstatSync(join(root, path)); } catch { stat = null; }
    if (stat?.isFile()) indexFile(db, root, path, stat, config);
    else dropFile(db, path);
  }
  return others.length;
}

// The copy's version and the config's rules the index was built with, as JSON,
// or undefined before the first build.
function storedExtraction(db) {
  return db.prepare("SELECT value FROM settings WHERE key = 'extraction'").get()?.value;
}

// `keepText` keeps the stored text and the meaning vectors that come from it.
function dropFile(db, path, { keepText = false } = {}) {
  db.prepare("DELETE FROM files WHERE path = ?").run(path);
  db.prepare("DELETE FROM symbols WHERE path = ?").run(path);
  if (keepText) return;
  db.prepare("DELETE FROM body WHERE path = ?").run(path);
  db.prepare("DELETE FROM chunks WHERE path = ?").run(path);
  db.prepare("DELETE FROM embedded WHERE path = ?").run(path);
}

// A file whose text matches the stored text keeps it, so a rules change rewrites only the symbols:
// deleting text from the full-text index is the slow part of a rebuild.
function indexFile(db, root, path, stat, config) {
  let text;
  try { text = readText(root, path, stat.size); } catch { text = null; }
  const known = db.prepare("SELECT 1 FROM files WHERE path = ?").get(path);
  const stored = known && db.prepare("SELECT text FROM body WHERE path = ?").get(path)?.text;
  const keepText = text !== null && stored === text;
  dropFile(db, path, { keepText });
  const symbols = text === null ? [] : symbolsOf(text, path, config);
  const type = text === null ? UNREADABLE : typeOf(path);
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?)").run(path, stat.size, stat.mtimeMs, type, symbols.length);
  if (text === null) return;
  if (!keepText) db.prepare("INSERT INTO body (path, text) VALUES (?, ?)").run(path, text);
  writeSymbols(db, path, symbols);
}

function writeSymbols(db, path, symbols) {
  const insert = db.prepare("INSERT INTO symbols VALUES (?, ?, ?, ?, ?)");
  for (const s of symbols) insert.run(path, s.name, s.kind, s.line, s.endLine);
}
