// Paths named by environment settings. A setting counts only when it holds an absolute path: an
// unset, empty or relative value falls back to the default, as the XDG base directory rules say, so
// no path FindWright reads or writes resolves against the repo a session runs in.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** `value` when it is an absolute path (a folder or a file), else `fallback`. */
export function absoluteOr(value, fallback) {
  return typeof value === "string" && isAbsolute(value) ? value : fallback;
}

/** Claude Code's config folder: CLAUDE_CONFIG_DIR, or `~/.claude`. */
export function claudeConfigDir(env = process.env) {
  return absoluteOr(env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude"));
}

/** FindWright's own folder: FINDWRIGHT_HOME, or `~/.findwright`. */
export function findwrightHome(env = process.env) {
  return absoluteOr(env.FINDWRIGHT_HOME, join(homedir(), ".findwright"));
}
