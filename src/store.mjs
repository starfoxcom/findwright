// The project index: one SQLite file holding every indexed file's text (in a
// trigram full-text table, the shortlist for any search) and its symbols.
// Each call first re-reads the files whose size or modified time changed, so
// answers always match the working tree.

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { EXTRACTORS, fromRules } from "./extract.mjs";
import { linearRegExp } from "./linear.mjs";

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

const DEFAULT_KINDS = {
  "*.md": "markdown", "*.mdx": "markdown",
  "*.yml": "yaml", "*.yaml": "yaml",
  "*.json": "json", "*.jsonc": "json",
  "*.js": "javascript", "*.mjs": "javascript", "*.cjs": "javascript",
  "*.ts": "javascript", "*.tsx": "javascript", "*.jsx": "javascript", "*.mts": "javascript",
  "*.py": "python",
  "*.css": "css",
  "*.html": "html", "*.htm": "html",
  "*.sh": "shell", "*.bash": "shell",
};

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

const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));

/** True for a plain JSON object: not null, not an array. */
export const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);

// The config as the code reads it: a value of the wrong type is dropped, so a hand-edited or hostile
// config.json can make FindWright index less, never fail.
export function normalConfig(raw) {
  const config = isObject(raw) ? raw : {};
  const kinds = Object.fromEntries(Object.entries(isObject(config.kinds) ? config.kinds : {})
    .filter(([, kind]) => typeof kind === "string"));
  const rules = (Array.isArray(config.rules) ? config.rules : [])
    .filter((r) => isObject(r) && typeof r.pattern === "string" && typeof r.kind === "string")
    .map((r) => ({ pattern: r.pattern, kind: r.kind, globs: Array.isArray(r.globs) ? strings(r.globs) : ["**"] }));
  const goal = typeof config.goal === "number" && config.goal > 0 && config.goal <= 100 ? config.goal : undefined;
  return { include: strings(config.include), exclude: strings(config.exclude), kinds, rules, goal };
}

export function readConfig(root) {
  try {
    return normalConfig(JSON.parse(readFileSync(join(root, ".findwright", "config.json"), "utf8")));
  } catch {
    return normalConfig({});
  }
}

// The kind a path is read as: the config's own globs first, then the defaults.
// A `.template` file is read as the file it renders to (`ci.yml.template` as YAML).
export function kindOf(path, config) {
  const kinds = { ...DEFAULT_KINDS, ...(config.kinds ?? {}) };
  const target = path.endsWith(".template") ? path.slice(0, -".template".length) : path;
  const own = Object.entries(config.kinds ?? {}).find(([glob]) => globToRegExp(glob).test(path));
  if (own) return own[1];
  const found = Object.entries(kinds).find(([glob]) => globToRegExp(glob).test(target));
  return found ? found[1] : "text";
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
  return [...files].filter((path) => !matchesAny(path, config.exclude ?? [])).sort();
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
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA trusted_schema = OFF;");
  createSchema(db);
  return db;
}

function readText(root, path, size) {
  if (size > MAX_FILE_BYTES) return null;
  const bytes = readFileSync(join(root, path));
  if (bytes.subarray(0, 8000).includes(0)) return null;
  return bytes.toString("utf8");
}

function symbolsOf(text, path, kind, config) {
  const extractor = EXTRACTORS[kind];
  const own = extractor ? extractor(text) : [];
  const rules = (config.rules ?? []).filter((rule) => matchesAny(path, rule.globs ?? ["**"]));
  return own.concat(fromRules(text, rules));
}

// Brings the index level with the working tree; returns what changed. A change to the config's
// kinds or rules re-extracts every unchanged file's symbols, keeping its text and vectors.
export function refresh(db, root, config = readConfig(root)) {
  const extraction = JSON.stringify({ kinds: config.kinds, rules: config.rules });
  const indexedWith = storedExtraction(db);
  const sameExtraction = indexedWith === extraction;
  const known = new Map(db.prepare("SELECT path, size, mtime FROM files").all().map((r) => [r.path, r]));
  const seen = new Set();
  const changed = [];
  const reextract = [];
  for (const path of listFiles(root, config)) {
    let stat;
    // Regular files only: a submodule, a nested repo or a symlink (which may point
    // outside the repo) is listed by git but never read.
    try { stat = lstatSync(join(root, path)); } catch { continue; }
    if (!stat.isFile()) continue;
    seen.add(path);
    const old = known.get(path);
    if (!old || old.size !== stat.size || old.mtime !== stat.mtimeMs) changed.push({ path, stat });
    else if (!sameExtraction) reextract.push(path);
  }
  const removed = [...known.keys()].filter((path) => !seen.has(path));
  const result = { changed: changed.length, reextracted: reextract.length, removed: removed.length, files: seen.size };
  // A refresh that finds nothing new writes nothing, so it takes no write lock.
  if (sameExtraction && !changed.length && !removed.length) return result;
  db.exec("BEGIN IMMEDIATE");
  // Another process stored other settings since they were read above: its symbols would be mixed
  // with this pass's, so start over from what it stored.
  if (storedExtraction(db) !== indexedWith) {
    db.exec("ROLLBACK");
    return refresh(db, root, config);
  }
  try {
    for (const path of removed) dropFile(db, path);
    for (const { path, stat } of changed) indexFile(db, root, path, stat, config);
    for (const path of reextract) extractAgain(db, path, config);
    if (!sameExtraction) db.prepare("INSERT OR REPLACE INTO settings VALUES ('extraction', ?)").run(extraction);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return result;
}

// The config's kinds and rules the index was built with, as JSON, or undefined before the first build.
function storedExtraction(db) {
  return db.prepare("SELECT value FROM settings WHERE key = 'extraction'").get()?.value;
}

function dropFile(db, path) {
  db.prepare("DELETE FROM files WHERE path = ?").run(path);
  db.prepare("DELETE FROM body WHERE path = ?").run(path);
  db.prepare("DELETE FROM symbols WHERE path = ?").run(path);
  db.prepare("DELETE FROM chunks WHERE path = ?").run(path);
  db.prepare("DELETE FROM embedded WHERE path = ?").run(path);
}

function indexFile(db, root, path, stat, config) {
  dropFile(db, path);
  const kind = kindOf(path, config);
  let text;
  try { text = readText(root, path, stat.size); } catch { text = null; }
  const symbols = text === null ? [] : symbolsOf(text, path, kind, config);
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?)").run(path, stat.size, stat.mtimeMs, text === null ? "binary" : kind, symbols.length);
  if (text === null) return;
  db.prepare("INSERT INTO body (path, text) VALUES (?, ?)").run(path, text);
  writeSymbols(db, path, symbols);
}

// Re-reads an unchanged text file's kind and symbols from its stored text; its vectors stay.
function extractAgain(db, path, config) {
  const stored = db.prepare("SELECT text FROM body WHERE path = ?").get(path);
  if (!stored) return;
  const kind = kindOf(path, config);
  const symbols = symbolsOf(stored.text, path, kind, config);
  db.prepare("DELETE FROM symbols WHERE path = ?").run(path);
  db.prepare("UPDATE files SET kind = ?, symbols = ? WHERE path = ?").run(kind, symbols.length, path);
  writeSymbols(db, path, symbols);
}

function writeSymbols(db, path, symbols) {
  const insert = db.prepare("INSERT INTO symbols VALUES (?, ?, ?, ?, ?)");
  for (const s of symbols) insert.run(path, s.name, s.kind, s.line, s.endLine);
}
