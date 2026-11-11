#!/usr/bin/env node
// findwright: build and query the project index from the shell.
//   findwright refresh
//   findwright search <regex> [<regex> ...] [--glob G] [-i] [-C N] [--all]
//   findwright symbols <name> [--kind K] [--glob G]
//   findwright outline <path>
//   findwright coverage
//   findwright find <question or name>
//   findwright hits [transcript]   (score the newest session, record it, say when to assess)
//   findwright assess              (why recorded searches missed, and what would fix it)
// Runs from the repo root (or any folder inside it).

import { execFileSync } from "node:child_process";
import { openIndex, readConfig, refresh } from "./store.mjs";
import { coverage, outline, search, symbols } from "./query.mjs";
import { find } from "./find.mjs";
import { assess, DEFAULT_GOAL, recordSession } from "./hits.mjs";
import { meaningModel } from "./meaning.mjs";

function parse(argv) {
  const opts = { positional: [], globs: [], ignoreCase: false, context: 0, all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--glob") opts.globs.push(argv[++i]);
    else if (arg === "--kind") opts.kind = argv[++i];
    else if (arg === "-i") opts.ignoreCase = true;
    else if (arg === "--all") opts.all = true;
    else if (arg === "-C") opts.context = Number(argv[++i]);
    else opts.positional.push(arg);
  }
  return opts;
}

function printSearch(result) {
  for (const file of result.files) {
    console.log(file.path);
    for (const h of file.hits) {
      for (const c of h.context.filter((c) => c.line < h.line)) console.log(`  ${c.line}- ${c.text}`);
      console.log(`  ${h.line}: ${h.text}${h.symbol ? `   [${h.symbol}]` : ""}`);
      for (const c of h.context.filter((c) => c.line > h.line)) console.log(`  ${c.line}- ${c.text}`);
    }
  }
  if (result.truncated) console.log("(more matches; narrow the search)");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const db = openIndex(root);
  const started = performance.now();
  const changes = refresh(db, root, readConfig(root));
  const refreshed = performance.now() - started;
  const opts = parse(rest);
  if (command === "refresh") console.log(JSON.stringify({ ...changes, ms: Math.round(refreshed) }));
  else if (command === "search") printSearch(search(db, { patterns: opts.positional, ...opts }));
  else if (command === "symbols") {
    for (const s of symbols(db, { query: opts.positional[0], kind: opts.kind, globs: opts.globs })) {
      console.log(`${s.path}:${s.line}-${s.end_line}  ${s.kind} ${s.name}`);
    }
  } else if (command === "outline") {
    for (const s of outline(db, opts.positional[0])) console.log(`${s.line}-${s.end_line}  ${s.kind} ${s.name}`);
  } else if (command === "coverage") console.log(JSON.stringify(coverage(db), null, 1));
  else if (command === "find") {
    const model = await meaningModel(db, { wait: true });
    for (const f of find(db, { query: opts.positional.join(" "), limit: 12, model: model.ready })) console.log(f.path);
    if (model.note) console.log(model.note);
  } else if (command === "hits") {
    const goal = readConfig(root).goal ?? DEFAULT_GOAL;
    console.log(JSON.stringify(recordSession(root, { goal, ...(opts.positional[0] ? { transcript: opts.positional[0] } : {}) })));
  } else if (command === "assess") console.log(JSON.stringify(assess(db, root, (await meaningModel(db, { wait: true })).ready), null, 1));
  else console.log("Usage: see the top of src/cli.mjs");
  db.close();
}

await main();
