// Replays the plugin directory's rules for organizations that are not Verified.
// The directory refuses such a plugin when it ships anything other than Markdown,
// text, JSON, YAML or an image; a text file that is not UTF-8, holds a NUL byte or
// starts with a shebang; a package manager's file; command hooks, mods or local MCP
// servers; or a skill whose frontmatter carries keys outside the allowed list.
// The packer runs this on every pack, so a release never meets a refusal.
//
//   node tools/directory_check.mjs DIR   -> lists each problem, exit 1 on any

import { readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
// Extensionless files the directory reads as text.
const TEXT_NAMES = new Set(["LICENSE", ".gitignore"]);
const IMAGE_MAGIC = new Map([
  [".png", [Buffer.from("89504e470d0a1a0a", "hex")]],
  [".jpg", [Buffer.from("ffd8ff", "hex")]],
  [".jpeg", [Buffer.from("ffd8ff", "hex")]],
  [".gif", [Buffer.from("GIF87a"), Buffer.from("GIF89a")]],
  [".ico", [Buffer.from("00000100", "hex")]],
]);
const WEBP_RIFF = Buffer.from("RIFF");
const WEBP_TAG = Buffer.from("WEBP");
const PACKAGE_FILES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc", "yarn.lock", ".yarnrc.yml",
  "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lock", "bun.lockb", "requirements.txt",
  "pyproject.toml", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "setup.py", "setup.cfg",
  "Gemfile", "Cargo.toml",
]);
// What hooks, mods and local servers are declared with.
const DECLARATION_FILES = new Set(["hooks/hooks.json", ".mcp.json"]);
const MANIFEST_PATH = ".claude-plugin/plugin.json";
const MANIFEST_CODE_KEYS = ["hooks", "mcpServers", "modules", "lspServers"];
// The frontmatter keys this plugin's skills use; all are core skill keys.
const SKILL_KEYS = new Set(["name", "description", "disable-model-invocation", "argument-hint"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const notImage = (rel) => `${rel} is not the image its name says`;

function startsAt(data, offset, magic) {
  return data.subarray(offset, offset + magic.length).equals(magic);
}

const OPENER = /^---[ \t]*\n/;
// The only frontmatter line this check reads: a top-level key with its value on the same line.
const PLAIN_KEY_LINE = /^([A-Za-z][\w-]*):(?:[ \t].*)?$/;

// Anything but plain one-line keys (indented lines, lists, block scalars) reports a pseudo-key,
// so the check fails closed instead of passing keys it never read.
function frontmatterKeys(rawText) {
  const text = rawText.replace(/^﻿/, "");
  const opener = text.match(OPENER);
  if (!opener) return [];
  const end = text.indexOf("\n---", opener[0].length - 1);
  if (end === -1) return ["(unclosed frontmatter)"];
  const lines = text.slice(opener[0].length, end).split("\n").filter((line) => line.trim());
  const keys = [];
  for (const line of lines) {
    const match = line.match(PLAIN_KEY_LINE);
    if (!match) return ["(frontmatter other than one-line keys)"];
    keys.push(match[1]);
  }
  return keys;
}

function skillProblems(rel, text) {
  const isSkillText = rel.endsWith("SKILL.md") || rel.startsWith("agents/")
    || rel.startsWith("commands/");
  if (!isSkillText) return [];
  const keys = frontmatterKeys(text.replace(/\r\n/g, "\n"));
  const extra = keys.filter((key) => !SKILL_KEYS.has(key));
  if (!extra.length) return [];
  return [`${rel} has frontmatter keys the directory refuses: ${extra.join(", ")}`];
}

function manifestProblems(rel, text) {
  if (rel !== MANIFEST_PATH) return [];
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [`${rel} is not valid JSON`];
  }
  const declared = MANIFEST_CODE_KEYS.filter((key) => Object.hasOwn(Object(manifest), key)).sort();
  return declared.length ? [`plugin.json declares ${declared.join(", ")}`] : [];
}

function textProblems(rel, data) {
  if (data.includes(0)) return [`${rel} holds a NUL byte`];
  let text;
  try {
    text = UTF8.decode(data);
  } catch {
    return [`${rel} is not UTF-8`];
  }
  if (text.replace(/^﻿+/, "").startsWith("#!")) return [`${rel} starts with #!`];
  return [...skillProblems(rel, text), ...manifestProblems(rel, text)];
}

function fileProblems(rel, data) {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const ext = posix.extname(name).toLowerCase();
  if (PACKAGE_FILES.has(name)) return [`${rel} is a package manager's file`];
  if (DECLARATION_FILES.has(rel)) return [`${rel} declares hooks or a local server`];
  if (IMAGE_MAGIC.has(ext)) {
    return IMAGE_MAGIC.get(ext).some((magic) => startsAt(data, 0, magic)) ? [] : [notImage(rel)];
  }
  if (ext === ".webp") {
    return startsAt(data, 0, WEBP_RIFF) && startsAt(data, 8, WEBP_TAG) ? [] : [notImage(rel)];
  }
  if (TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.has(name)) return textProblems(rel, data);
  return [`${rel} is not Markdown, text, JSON, YAML or an allowed image`];
}

/** Every rule `files` (a Map of plugin-relative path, forward slashes, to Buffer) breaks. */
export function problemsIn(files) {
  return [...files.keys()].sort().flatMap((rel) => fileProblems(rel, files.get(rel)));
}

/** Reads every file under `root` into a Map keyed by its forward-slash path. */
export function readFolder(root) {
  const files = new Map();
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else files.set(path, readFileSync(join(root, path)));
    }
  };
  walk("");
  return files;
}

function main(argv) {
  if (argv.length !== 1) {
    console.error("usage: node tools/directory_check.mjs DIR");
    process.exitCode = 2;
    return;
  }
  const found = problemsIn(readFolder(resolve(argv[0])));
  for (const line of found) console.log(line);
  if (found.length) process.exitCode = 1;
  else console.log("Meets the directory's rules for organizations that are not Verified");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
