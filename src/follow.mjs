// The helper follows its plugin. Each plugin version pins one helper release by its SHA-256 in its
// helper.json; when the installed plugin pins another version than the helper that is running, the
// server installs that release, the way setup does, before it loads the rest of its code.
// This module imports only Node's own modules: the server loads it before the install, so
// anything else it loaded would stay at the old version for the rest of the process.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const RELEASES = "https://github.com/starfoxcom/findwright/releases/download/";
const DOWNLOAD_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 30_000;
// A lock older than a whole download and install belongs to a server that was stopped mid-way.
const STALE_LOCK_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 60_000;

/** The folder setup installs the helper into: `<FindWright home>/helper`. */
export function helperFolder(env = process.env) {
  return join(env.FINDWRIGHT_HOME ?? join(homedir(), ".findwright"), "helper");
}

/** True when `file` belongs to the helper setup installed, not a checkout or another copy. */
export function isInstalledHelper(file, env = process.env) {
  const path = relative(join(helperFolder(env), "node_modules", "findwright"), file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

const isPin = (pin) => typeof pin?.version === "string" && /^[\w.+-]+\.tgz$/.test(pin.node?.file ?? "")
  && typeof pin.node.url === "string" && pin.node.url.startsWith(RELEASES)
  && /^[0-9a-f]{64}$/.test(pin.node.sha256 ?? "");

/**
 * The helper release the installed FindWright plugin pins (`{ version, node: { file, url, sha256 } }`),
 * read from Claude Code's list of installed plugins, or null when no plugin is installed or its pin
 * cannot be read. A user-scope install wins over others; among equals, the newest update.
 */
export function pluginPin(env = process.env) {
  const config = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  let installs;
  try {
    const plugins = JSON.parse(readFileSync(join(config, "plugins", "installed_plugins.json"), "utf8")).plugins;
    installs = Object.entries(plugins ?? {})
      .filter(([key]) => key.startsWith("findwright@"))
      .flatMap(([, list]) => list);
  } catch {
    return null;
  }
  const rank = (install) => [install.scope === "user" ? 1 : 0, Date.parse(install.lastUpdated) || 0];
  installs.sort((a, b) => {
    const [scopeA, timeA] = rank(a);
    const [scopeB, timeB] = rank(b);
    return scopeB - scopeA || timeB - timeA;
  });
  for (const install of installs) {
    try {
      const pin = JSON.parse(readFileSync(join(install.installPath, "helper.json"), "utf8"));
      if (isPin(pin)) return pin;
    } catch {
      // An install whose folder is gone or holds no pin is skipped.
    }
  }
  return null;
}

/** The npm that ships with this Node, run by Node itself, so no shell parses the arguments. */
function npmCli() {
  const nodeFolder = dirname(process.execPath);
  const candidates = [
    join(nodeFolder, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeFolder, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find((file) => existsSync(file));
  if (!cli) throw new Error("npm was not found next to Node");
  return cli;
}

/** Installs a downloaded release file into the helper folder, as setup does. */
export function installRelease(helper, file) {
  const args = [npmCli(), "install", "--prefix", helper, "--no-save", "--ignore-scripts", "--no-audit",
    "--no-fund", "--offline", file];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      timeout: INSTALL_TIMEOUT_MS });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed: ${errors.trim().split("\n").at(-1) ?? `exit ${code}`}`));
    });
  });
}

async function download(pin, fetchRelease) {
  const response = await fetchRelease(pin.node.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`the download failed (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== pin.node.sha256) {
    throw new Error("the download does not match the SHA-256 the plugin pins");
  }
  return bytes;
}

// Takes the lock that keeps two starting servers from installing at once. Returns false after
// waiting for another server's install to finish, which leaves that server's helper in place.
async function takeLock(lock) {
  try {
    if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
  } catch {
    // No lock yet.
  }
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  for (let waited = 0; existsSync(lock) && waited < LOCK_WAIT_MS; waited += 250) await sleep(250);
  return false;
}

const installedEntry = (helper, ...parts) => join(helper, "node_modules", "findwright", ...parts);

/** The version of the helper installed in `helper`, or null when none is. */
export function installedVersion(helper) {
  try {
    return JSON.parse(readFileSync(installedEntry(helper, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/**
 * Runs the installed helper's model step, which fetches the meaning model it pins, as setup does.
 * In the background it returns null at once; otherwise it resolves to the step's line of JSON.
 */
export function modelStep(helper, { background = false } = {}) {
  const args = [installedEntry(helper, "src", "cli.mjs"), "model"];
  if (background) {
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => resolve({ error: error.message }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(output.trim().split("\n").at(-1)));
      } catch {
        resolve({ error: "the model step printed no result" });
      }
    });
  });
}

/**
 * Brings the helper to the version `pin` names: `{ from, to }` once installed, `{ from, to, error }`
 * when the download or the install failed (the old helper stays), or null when there was nothing to do.
 */
export async function followPlugin({ pin, ownVersion, helper, fetchRelease = fetch, install = installRelease }) {
  if (!pin || pin.version === ownVersion) return null;
  const outcome = { from: ownVersion, to: pin.version };
  const lock = join(helper, ".follow.lock");
  const file = join(helper, pin.node.file);
  try {
    mkdirSync(helper, { recursive: true });
    if (!(await takeLock(lock))) return null;
  } catch (error) {
    return { ...outcome, error: error.message };
  }
  try {
    writeFileSync(file, await download(pin, fetchRelease));
    await install(helper, file);
    const version = installedVersion(helper) ?? "none";
    if (version !== pin.version) throw new Error(`the install left version ${version} in place`);
    return outcome;
  } catch (error) {
    return { ...outcome, error: error.name === "TimeoutError" ? "the download timed out" : error.message };
  } finally {
    rmSync(file, { force: true });
    rmSync(lock, { force: true });
  }
}

/** The line the session's start notice carries about a follow, or undefined when nothing happened. */
export function followNotice(result) {
  if (!result) return undefined;
  if (!result.error) {
    return `Tell the user in one line: FindWright's helper updated itself from ${result.from} to ${result.to} `
      + "to match the plugin.";
  }
  return `Tell the user in one line: FindWright's helper is still ${result.from}, behind the plugin's `
    + `${result.to}, since its update failed (${result.error}); /findwright:update tries again.`;
}
