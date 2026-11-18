// Paths named by environment settings. FindWright's own settings count only when they hold an
// absolute path: an unset, empty or relative value falls back to the default, as the XDG base
// directory rules say, so none of them resolves against the repo a session runs in. Claude Code's
// config folder is the exception: it follows Claude Code, which takes a relative value as given.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** `value` when it is an absolute path (a folder or a file), else `fallback`. */
export function absoluteOr(value, fallback) {
  return typeof value === "string" && isAbsolute(value) ? value : fallback;
}

/**
 * Claude Code's config folder: CLAUDE_CONFIG_DIR as given, a relative path included, so FindWright
 * reads and writes the folder Claude Code reads. An unset or empty value means `~/.claude`.
 */
export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** FindWright's own folder: FINDWRIGHT_HOME, or `~/.findwright`. */
export function findwrightHome(env = process.env) {
  return absoluteOr(env.FINDWRIGHT_HOME, join(homedir(), ".findwright"));
}
