// FindWright's guidance for the agent: a rules file of its own in Claude Code's user rules folder,
// which Claude Code reads in every session. The file belongs to FindWright alone, so writing it never
// edits text someone else wrote, and removing it is deleting it.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { helperFolder } from "./follow.mjs";

const TEMPLATE = new URL("./agent-guidance.md", import.meta.url);

/** Where the guidance lives: `<CLAUDE_CONFIG_DIR or ~/.claude>/rules/findwright.md`. */
export function guidancePath(env = process.env, home = homedir()) {
  return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "rules", "findwright.md");
}

// The commands in it name the installed helper, the copy setup keeps current, wherever this one runs.
function guidanceText(env) {
  const helper = join(helperFolder(env), "node_modules", "findwright").replaceAll("\\", "/");
  return readFileSync(TEMPLATE, "utf8").replaceAll("{{HELPER}}", helper);
}

/** "current", "outdated" (another text than this helper's) or "missing". */
export function guidanceState(env = process.env) {
  const file = guidancePath(env);
  if (!existsSync(file)) return "missing";
  return readFileSync(file, "utf8") === guidanceText(env) ? "current" : "outdated";
}

/** Writes the guidance unless it is current; `written` says whether the file changed. */
export function installGuidance(env = process.env) {
  const file = guidancePath(env);
  if (guidanceState(env) === "current") return { guidance: file, written: false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, guidanceText(env));
  return { guidance: file, written: true };
}

export function removeGuidance(env = process.env) {
  const file = guidancePath(env);
  if (!existsSync(file)) return { guidance: file, removed: false };
  rmSync(file);
  return { guidance: file, removed: true };
}

/** Brings guidance that setup wrote up to this helper's text; never writes it where it is missing. */
export function refreshGuidance(env = process.env) {
  return guidanceState(env) === "outdated" && installGuidance(env).written;
}
