// Replays harvested searches through tokensave (its CLI, against today's index)
// and through the code index prototype, and scores each answer against the files
// the session went on to use.
//   node replay.mjs events.jsonl results.jsonl
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync } from "node:fs";
import { openIndex, refresh } from "../src/store.mjs";
import { search } from "../src/query.mjs";
import { find } from "../src/find.mjs";
import { ensureModel, loadModel } from "../src/embed.mjs";
import { embedMissing } from "../src/meaning.mjs";
// BENCH_MODEL names another model folder (Model2Vec, F16 table, WordPiece) to measure in place of the pinned one.
// BENCH_RECORD=<file> writes each distinct text the model embeds as a JSON line
// ({ kind: "doc" | "query", text }); BENCH_VECTORS=<folder> answers those texts
// from vectors computed elsewhere (texts.json, a list of [kind, text], and
// vectors.f32, one row per text), so a transformer run in Python is measured the
// same way. BENCH_TAG names the index the run builds; give each model its own.
const BASE_MODEL = loadModel(process.env.BENCH_MODEL
  ?? await ensureModel(new URL("./out/models", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")));
const MODEL_TAG = process.env.BENCH_TAG ? `-${process.env.BENCH_TAG}`
  : process.env.BENCH_MODEL ? `-${process.env.BENCH_MODEL.split(/[\/]/).filter(Boolean).at(-1)}` : "";
let phase = "query";
const MODEL = benchModel(BASE_MODEL);

function benchModel(base) {
  const key = (text) => `${phase}\0${text}`;
  if (process.env.BENCH_RECORD) {
    const seen = new Set();
    const out = openSync(process.env.BENCH_RECORD, "w");
    return { ...base, encode(text) {
      if (!seen.has(key(text))) {
        seen.add(key(text));
        writeSync(out, JSON.stringify({ kind: phase, text }) + "\n");
      }
      return base.encode(text);
    } };
  }
  if (!process.env.BENCH_VECTORS) return base;
  const dir = process.env.BENCH_VECTORS;
  const texts = JSON.parse(readFileSync(`${dir}/texts.json`, "utf8"));
  const index = new Map(texts.map(([kind, text], i) => [`${kind}\0${text}`, i]));
  const bytes = readFileSync(`${dir}/vectors.f32`);
  const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const dims = all.length / texts.length;
  return { ...base, encode(text) {
    const i = index.get(key(text));
    if (i === undefined) throw new Error(`no precomputed vector for a ${phase} text`);
    return all.subarray(i * dims, (i + 1) * dims);
  } };
}
const WEIGHTS = [0, 0.5, 1, 2, 4];
import { RULE_SETS } from "./configs.mjs";

const [eventsFile, outFile] = process.argv.slice(2);
// projects.local.json (git-ignored): { "<name>": { "root": "<repo>", "rules": ["dart"], "exclude": [], "config": "<file>" } }
const PROJECTS = JSON.parse(readFileSync(new URL("./projects.local.json", import.meta.url), "utf8"));
const ROOTS = Object.fromEntries(Object.entries(PROJECTS).map(([name, p]) => [name, p.root]));
const STOP = new Set(("the and for with from that this into when what which where how does are was not has have its "
  + "use uses used using all any each per via its them they then than also only just like out off our new old "
  + "file files code function functions method class find show list read write make get set run runs").split(" "));
const PATH_RE = /[\w@.+-]+(?:[\/\\][\w@.+-]+)*\.\w+/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function filesIn(text, root, fileset) {
  const prefix = root.toLowerCase() + "/";
  const out = [];
  for (const m of text.matchAll(PATH_RE)) {
    let p = m[0].replaceAll("\\", "/");
    if (p.toLowerCase().startsWith(prefix)) p = p.slice(prefix.length);
    p = p.replace(/^\.\//, "");
    if (fileset.has(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

import { existsSync } from "node:fs";
const CACHE = existsSync("ts-cache.json") ? JSON.parse(readFileSync("ts-cache.json", "utf8")) : {};
function tokensave(tool, input, root) {
  const key = JSON.stringify([tool, input, root]);
  if (tool !== "ts_status" && CACHE[key]) return CACHE[key];
  const res = tokensaveRun(tool, input, root);
  if (tool !== "ts_status") CACHE[key] = res;
  return res;
}
function tokensaveRun(tool, input, root) {
  const name = tool.replace("ts_", "");
  const args = { ...input };
  for (const key of ["graph_root", "graph_branch", "ids", "exclude_node_ids"]) delete args[key];
  const t = performance.now();
  const run = spawnSync("tokensave", ["tool", name, "--project", root, "--args", JSON.stringify(args), "--json"],
    { encoding: "utf8", timeout: 60000, maxBuffer: 1 << 26, cwd: root });
  const ms = performance.now() - t;
  let text = run.stdout ?? "";
  try { text = JSON.parse(text).content.map((c) => c.text).join("\n"); } catch { /* raw text */ }
  return { text, ms, ok: run.status === 0 };
}

function terms(ev) {
  const raw = ev.tool === "ts_context" ? [ev.input.task ?? "", ...(ev.input.keywords ?? [])].join(" ") : ev.input.query ?? "";
  const words = raw.match(/[A-Za-z_][\w]*/g) ?? [];
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

function pathFilter(input) {
  const inc = input.path_include ?? [];
  const exc = input.path_exclude ?? [];
  return (p) => (!inc.length || inc.some((s) => p.includes(s))) && !exc.some((s) => p.includes(s));
}

// The prototype's answer: ranked files, plus the text it would hand back.
function ours(db, ev, k) {
  const keep = pathFilter(ev.input);
  const t = performance.now();
  let ranked = [];
  let lines = [];
  if (ev.input.literal) {
    const res = search(db, { patterns: [escapeRe(ev.input.query)], limit: ev.input.limit ?? 10 });
    const files = res.files.filter((f) => keep(f.path));
    ranked = files.sort((a, b) => b.hits.length - a.hits.length).map((f) => f.path);
    lines = files.flatMap((f) => f.hits.map((h) => `${f.path}:${h.line}: ${h.text.trim()}`));
  } else {
    const score = new Map();
    const shown = new Map();
    const exact = db.prepare("SELECT path, name, kind, line FROM symbols WHERE lower(name) = ?");
    const part = db.prepare("SELECT path, name, kind, line FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT 400");
    const body = db.prepare("SELECT path FROM body WHERE body MATCH ?");
    const add = (path, n) => keep(path) && score.set(path, (score.get(path) ?? 0) + n);
    for (const term of terms(ev)) {
      const seen = new Set();
      for (const r of exact.all(term)) { if (!seen.has(r.path)) add(r.path, 6); seen.add(r.path); shown.set(r.path, [...(shown.get(r.path) ?? []), r]); }
      for (const r of part.all(`%${term.replace(/[\\%_]/g, "\\$&")}%`)) {
        if (!seen.has(r.path)) { add(r.path, 3); seen.add(r.path); shown.set(r.path, [...(shown.get(r.path) ?? []), r]); }
      }
      for (const r of body.all(`text : "${term}"`)) add(r.path, 1);
    }
    ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([p]) => p);
    lines = ranked.slice(0, k).flatMap((p) => [p, ...(shown.get(p) ?? []).slice(0, 3).map((s) => `  ${s.line}: ${s.kind} ${s.name}`)]);
  }
  return { ranked: ranked.slice(0, k), text: lines.join("\n"), ms: performance.now() - t };
}

const snake = (w) => w.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
const DOC_KINDS = new Set(["markdown", "json", "yaml", "text"]);

// Version 2: rare terms weigh more (IDF), file names count, `Foo::bar` answers
// to `bar`, CamelCase answers to its snake_case file, and literal hits are ranked.
function ours2(db, ev, k) {
  const keep = pathFilter(ev.input);
  const t = performance.now();
  const N = db.prepare("SELECT COUNT(*) AS n FROM files").get().n;
  const kinds = new Map(db.prepare("SELECT path, kind FROM files").all().map((r) => [r.path, r.kind]));
  const paths = [...kinds.keys()].filter(keep);
  const base = (p) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  let ranked;
  let lines = [];
  if (ev.input.literal) {
    const res = search(db, { patterns: [escapeRe(ev.input.query)], limit: 100000 });
    const q = ev.input.query.toLowerCase();
    const scoreOf = (f) => (base(f.path).includes(q) ? 5 : 0) + (f.hits.some((h) => h.symbol?.toLowerCase().includes(q)) ? 3 : 0)
      + (DOC_KINDS.has(kinds.get(f.path)) ? 0 : 2) + Math.min(f.hits.length, 5) / 5;
    const files = res.files.filter((f) => keep(f.path)).map((f) => ({ ...f, s: scoreOf(f) })).sort((a, b) => b.s - a.s);
    ranked = files.map((f) => f.path);
    let budget = ev.input.limit ?? 10;
    for (const f of files) for (const h of f.hits) if (budget-- > 0) lines.push(`${f.path}:${h.line}: ${h.text.trim()}`);
  } else {
    const score = new Map();
    const shown = new Map();
    const symbolRows = db.prepare("SELECT path, name, kind, line FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT 2000");
    const body = db.prepare("SELECT path FROM body WHERE body MATCH ?");
    for (const term of terms(ev)) {
      const variants = [...new Set([term, snake(term)])];
      const best = new Map();
      const bump = (p, n) => keep(p) && best.set(p, Math.max(best.get(p) ?? 0, n));
      for (const v of variants) {
        for (const r of symbolRows.all(`%${v.replace(/[\\%_]/g, "\\$&")}%`)) {
          const n = r.name.toLowerCase();
          const tail = n.slice(n.lastIndexOf(":") + 1);
          bump(r.path, n === v || tail === v ? 6 : 3);
          if (n === v || tail === v) shown.set(r.path, [...(shown.get(r.path) ?? []), r]);
        }
        for (const p of paths) {
          if (base(p).includes(v)) bump(p, 5);
          else if (p.toLowerCase().includes(v)) bump(p, 2);
        }
      }
      const inBody = new Set(term.length >= 3 ? body.all(`text : "${term}"`).map((r) => r.path) : []);
      const df = Math.max(inBody.size, best.size);
      const w = Math.log(1 + N / (1 + df));
      for (const p of new Set([...best.keys(), ...inBody])) {
        if (!keep(p)) continue;
        score.set(p, (score.get(p) ?? 0) + w * ((best.get(p) ?? 0) + (inBody.has(p) ? 1 : 0)));
      }
    }
    ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([p]) => p);
    lines = ranked.slice(0, k).flatMap((p) => [p, ...(shown.get(p) ?? []).slice(0, 3).map((s) => `  ${s.line}: ${s.kind} ${s.name}`)]);
  }
  return { ranked: ranked.slice(0, k), text: lines.join("\n"), ms: performance.now() - t };
}

// Version 3: the tool's own find() for words and questions; literal hits ranked
// without pushing docs and config files down.
function ours3(db, ev, k) {
  const keep = pathFilter(ev.input);
  const t = performance.now();
  let ranked;
  if (ev.input.literal) {
    const q = ev.input.query.toLowerCase();
    const base = (p) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    const res = search(db, { patterns: [escapeRe(ev.input.query)], limit: 100000 });
    const s = (f) => (base(f.path).includes(q) ? 5 : 0) + (f.hits.some((h) => h.symbol?.toLowerCase().includes(q)) ? 3 : 0)
      + Math.min(f.hits.length, 5) / 5;
    ranked = res.files.filter((f) => keep(f.path)).sort((a, b) => s(b) - s(a)).map((f) => f.path);
  } else {
    const text = ev.tool === "ts_context" ? [ev.input.task ?? "", ...(ev.input.keywords ?? [])].join(" ") : ev.input.query ?? "";
    ranked = find(db, { query: text, keep, limit: 1e9 }).map((r) => r.path);
  }
  return { ranked, ms: performance.now() - t };
}

function project(name, events, out) {
  const root = ROOTS[name];
  const p = PROJECTS[name];
  const config = p.config
    ? JSON.parse(readFileSync(new URL(p.config, import.meta.url), "utf8"))
    : { exclude: p.exclude ?? [], rules: (p.rules ?? []).flatMap((set) => RULE_SETS[set]) };
  mkdirSync("db", { recursive: true });
  process.env.FINDWRIGHT_DB = `db/${name}${MODEL_TAG}.db`;
  const db = openIndex(root);
  const t = performance.now();
  const built = refresh(db, root, config);
  const buildMs = Math.round(performance.now() - t);
  const te = performance.now();
  phase = "doc";
  const embedded = embedMissing(db, MODEL);
  phase = "query";
  console.log(`  embedded ${embedded} files in ${Math.round(performance.now() - te)} ms`);
  const fileset = new Set(db.prepare("SELECT path FROM files").all().map((r) => r.path));
  const tracked = new Set(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));
  const known = (p) => fileset.has(p) || tracked.has(p);
  const bare = db.prepare("SELECT COUNT(*) AS n FROM files WHERE symbols = 0 AND kind != 'binary'").get().n;
  console.log(`${name}: ${built.files} files, ${bare} without symbols, built in ${buildMs} ms`);
  let scored = 0;
  for (const ev of events) {
    if (!ev.tool.startsWith("ts_")) continue;
    let truth = ev.truth.filter(known);
    let source = "used";
    if (!truth.length && ev.fb_text) {
      truth = filesIn(ev.fb_text, root, { has: known });
      source = "fallback";
      if (truth.length > 10) truth = [];
    }
    if (!truth.length) continue;
    const ts = tokensave(ev.tool, ev.input, root);
    const tsFiles = filesIn(ts.text, root, { has: known });
    const k = Math.max(tsFiles.length, ev.input.literal ? 1 : 5);
    const our = ours(db, ev, k);
    const v2 = ours2(db, ev, k);
    const v3all = ours3(db, ev, k);
    const qtext = ev.tool === "ts_context" ? [ev.input.task ?? "", ...(ev.input.keywords ?? [])].join(" ") : ev.input.query ?? "";
    const v4 = {};
    for (const w of WEIGHTS) {
      const ranked = ev.input.literal ? v3all.ranked : find(db, { query: qtext, keep: pathFilter(ev.input), limit: 1e9, model: MODEL, meaningWeight: w }).map((x) => x.path);
      const rk = Math.min(...truth.map((p) => { const i = ranked.indexOf(p); return i < 0 ? Infinity : i + 1; }));
      v4[w] = rk === Infinity ? null : rk;
    }
    const v3rank = Math.min(...truth.map((p) => { const i = v3all.ranked.indexOf(p); return i < 0 ? Infinity : i + 1; }));
    const full = ours2(db, ev, 1e9).ranked;
    const rank = Math.min(...truth.map((p) => { const i = full.indexOf(p); return i < 0 ? Infinity : i + 1; }));
    const ts_rank = Math.min(...truth.map((p) => { const i = tsFiles.indexOf(p); return i < 0 ? Infinity : i + 1; }));
    const words = terms(ev).flatMap((w) => [w, snake(w)]);
    const textOf = db.prepare("SELECT text FROM body WHERE path = ?");
    const reachable = truth.some((p) => { const b = (textOf.get(p)?.text ?? "").toLowerCase() + " " + p.toLowerCase();
      return ev.input.literal ? b.includes(ev.input.query.toLowerCase()) : words.some((w) => b.includes(w)); });
    const indexed = truth.some((p) => fileset.has(p));
    const hit = (files) => truth.some((p) => files.includes(p));
    out.push({
      project: name, tool: ev.tool, literal: !!ev.input.literal, source, fell_back: ev.fell_back,
      query: ev.input.query ?? ev.input.task, truth, k,
      ts: { hit: hit(tsFiles), files: tsFiles.length, bytes: ts.text.length, ms: Math.round(ts.ms), ok: ts.ok },
      ours: { hit: hit(our.ranked), files: our.ranked.length, bytes: our.text.length, ms: +our.ms.toFixed(1) },
      rank: rank === Infinity ? null : rank, ts_rank: ts_rank === Infinity ? null : ts_rank, reachable, indexed, ts_files: tsFiles,
      v4,
      v3: { hit: v3rank <= k, rank: v3rank === Infinity ? null : v3rank, ms: +v3all.ms.toFixed(1) },
      v2: { hit: hit(v2.ranked), files: v2.ranked.length, bytes: v2.text.length, ms: +v2.ms.toFixed(1) },
    });
    scored++;
  }
  const spawn = [1, 2, 3].map(() => tokensave("ts_status", {}, root).ms).sort((a, b) => a - b)[1];
  db.close();
  console.log(`  scored ${scored}; tokensave start-up ${Math.round(spawn)} ms`);
  return { name, files: built.files, bare, buildMs };
}

const events = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const out = [];
const meta = [];
for (const name of Object.keys(ROOTS)) meta.push(project(name, events.filter((e) => e.project === name), out));
writeFileSync(outFile, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync("ts-cache.json", JSON.stringify(CACHE));
writeFileSync("meta.json", JSON.stringify(meta, null, 1));
