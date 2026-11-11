// Every pattern FindWright runs on a repo's files or paths goes through V8's linear-time regex engine
// (the `l` flag): it never backtracks, the same guarantee RE2 and ripgrep give, so no file, glob or
// rule a cloned repo carries can hang the index.

import v8 from "node:v8";

v8.setFlagsFromString("--enable-experimental-regexp-engine");

/** `source` compiled for the linear engine, or null when that engine cannot run it (back-references, lookarounds). */
export function linearRegExp(source, flags = "") {
  try {
    return new RegExp(source, `${flags}l`);
  } catch {
    return null;
  }
}

/** A built-in pattern moved onto the linear engine; it stays as written only where that engine is missing. */
export const linear = (pattern) => linearRegExp(pattern.source, pattern.flags) ?? pattern;
