// Runs draft rules over the repo without writing the config or touching the index, so a
// session fitting FindWright to a project can see what each rule finds before it commits to it.

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { canRun, fromRules, normalRule } from "./rules.mjs";
import { listFiles, matchesAny, readText } from "./store.mjs";

const SAMPLES = 8;
const MAX_BARE = 40;
const SKIPPED = "unreadable, or a pattern the linear engine cannot run";

// Up to SAMPLES entries spread evenly over the list, so a sample shows the whole repo, not its first folder.
function spread(list) {
  const step = Math.max(1, Math.floor(list.length / SAMPLES));
  return list.filter((_, i) => i % step === 0).slice(0, SAMPLES);
}

function textOf(root, path) {
  try {
    const stat = lstatSync(join(root, path));
    return stat.isFile() ? readText(root, path, stat.size) : null;
  } catch {
    return null;
  }
}

/** What `rules` would name in the repo: per symbol kind its count and samples, the rules that
 * cannot run, and the files the rules' globs match that still get no symbol. */
export function tryRules(root, rules, config) {
  // Read as the index reads a saved config, so a draft behaves exactly as it will once saved.
  const live = rules.filter(canRun).map(normalRule);
  const byKind = new Map();
  const bare = [];
  let matched = 0;
  for (const path of listFiles(root, config)) {
    const own = live.filter((rule) => matchesAny(path, rule.globs));
    if (!own.length) continue;
    const text = textOf(root, path);
    if (text === null) continue;
    matched++;
    const symbols = fromRules(text, own);
    if (!symbols.length) bare.push(path);
    for (const symbol of symbols) {
      if (!byKind.has(symbol.kind)) byKind.set(symbol.kind, []);
      byKind.get(symbol.kind).push(`${symbol.name}  ${path}:${symbol.line}-${symbol.endLine}`);
    }
  }
  return {
    files: matched,
    bare: bare.length,
    bareFiles: bare.slice(0, MAX_BARE),
    kinds: Object.fromEntries([...byKind]
      .map(([kind, list]) => [kind, { symbols: list.length, samples: spread(list) }])),
    skipped: rules.flatMap((rule, i) => (canRun(rule) ? [] : [{ rule: i, why: SKIPPED }])),
  };
}
