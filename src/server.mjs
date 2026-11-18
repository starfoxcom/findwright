#!/usr/bin/env node
// FindWright's MCP server entry. Before loading the server, the helper setup installed brings
// itself to the release the installed plugin pins, so a plugin update needs no typed command.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { followNotice, followPlugin, helperFolder, installedVersion, isInstalledHelper, modelStep, pluginPin }
  from "./follow.mjs";

const entry = fileURLToPath(import.meta.url);

// Runs the entry the install just wrote in a child that takes over this process's stdio, since
// this process already holds the old version of every module it loaded.
function runNewEntry() {
  const child = spawn(process.execPath, [entry], { stdio: "inherit", windowsHide: true });
  child.on("error", (error) => {
    process.stderr.write(`findwright: the updated server would not start (${error.message})\n`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

const helper = helperFolder();
const result = isInstalledHelper(entry)
  ? await followPlugin({ pin: pluginPin(), ownVersion: installedVersion(helper), helper })
  : null;
const notice = followNotice(result);
if (notice) process.env.FINDWRIGHT_HELPER_NOTICE = notice;

if (result && !result.error) {
  // A new helper can pin a new meaning model; it downloads in the background.
  modelStep(helper, { background: true });
  runNewEntry();
} else {
  await import("./serve.mjs");
}
