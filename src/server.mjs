#!/usr/bin/env node
// FindWright's MCP server entry. Before loading the server, the helper setup installed brings
// itself to the release the installed plugin pins, so a plugin update needs no typed command.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { followNotice, followPlugin, helperFolder, isInstalledHelper, pluginPin } from "./follow.mjs";

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

// A new helper can pin a new meaning model; it downloads in the background, as setup's step does.
function fetchModel() {
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, "model"], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

const result = isInstalledHelper(entry) ? await followPlugin({
  pin: pluginPin(),
  ownVersion: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  helper: helperFolder(),
}) : null;
const notice = followNotice(result);
if (notice) process.env.FINDWRIGHT_HELPER_NOTICE = notice;

if (result && !result.error) {
  fetchModel();
  runNewEntry();
} else {
  await import("./serve.mjs");
}
