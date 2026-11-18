// The helper follows its plugin. Each plugin version pins one helper release by its SHA-256 in its
// helper.json; when the installed plugin pins another version than the helper installed, that
// release is downloaded, checked and installed into a staging folder of its own, then swapped in.
// A failed or interrupted install leaves the installed helper as it was. Runs at once each stage in
// a folder of their own, and the swap itself runs under a lock, so only one run moves folders.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync }
  from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const RELEASES = "https://github.com/starfoxcom/findwright/releases/download/";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 2 * 60 * 1000;
// Older than a whole download and install, so the run that made it has ended.
const STAGING_AGE_MS = 10 * 60 * 1000;
const STAGING_PREFIX = ".staging-";
const OLD_SUFFIX = ".old-";
const SWAP_LOCK = ".swap.lock";
// A swap takes milliseconds, so a lock this old was left by a run stopped during one.
const STALE_SWAP_LOCK_MS = 60_000;
const SWAP_WAIT_MS = 10_000;

const findwrightHome = (env) => env.FINDWRIGHT_HOME ?? join(homedir(), ".findwright");
const resultFile = (env) => join(findwrightHome(env), "follow.json");
const installedEntry = (folder, ...parts) => join(folder, "node_modules", "findwright", ...parts);

/** The folder setup installs the helper into: `<FindWright home>/helper`. */
export function helperFolder(env = process.env) {
  return join(findwrightHome(env), "helper");
}

const realPath = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

/** True when `file` belongs to the helper setup installed, not a checkout or another copy. */
export function isInstalledHelper(file, env = process.env) {
  const path = relative(realPath(installedEntry(helperFolder(env))), realPath(file));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

const isPin = (pin) => typeof pin?.version === "string" && typeof pin.node?.file === "string"
  && /^[\w.+-]+\.tgz$/.test(pin.node.file) && typeof pin.node.url === "string"
  && pin.node.url.startsWith(RELEASES) && typeof pin.node.sha256 === "string"
  && /^[0-9a-f]{64}$/.test(pin.node.sha256);

function rankInstalls(a, b) {
  const scope = (install) => (install.scope === "user" ? 1 : 0);
  const time = (install) => Date.parse(install.lastUpdated) || 0;
  return scope(b) - scope(a) || time(b) - time(a);
}

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
      .filter(([key, list]) => key.startsWith("findwright@") && Array.isArray(list))
      .flatMap(([, list]) => list)
      .filter((install) => typeof install?.installPath === "string");
  } catch {
    return null;
  }
  for (const install of installs.sort(rankInstalls)) {
    try {
      const pin = JSON.parse(readFileSync(join(install.installPath, "helper.json"), "utf8"));
      if (isPin(pin)) return pin;
    } catch {
      // An install whose folder is gone or holds no pin is skipped.
    }
  }
  return null;
}

/** The version of the helper installed under `folder`, or null when none is. */
export function installedVersion(folder) {
  try {
    return JSON.parse(readFileSync(installedEntry(folder, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
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

/** Installs a downloaded release file into `folder`, with setup's npm line. */
export function installRelease(folder, file) {
  const args = [npmCli(), "install", "--prefix", folder, "--no-save", "--ignore-scripts", "--no-audit",
    "--no-fund", "--offline", file];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      timeout: INSTALL_TIMEOUT_MS });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else if (signal) reject(new Error(`npm install was stopped (${signal}) after its two-minute limit`));
      else reject(new Error(`npm install failed: ${errors.trim().split("\n").at(-1) || `exit ${code}`}`));
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

const removeQuietly = (path) => {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // One that cannot be removed now is tried again on the next run.
  }
};

const isOlderThan = (path, ms) => {
  try {
    return Date.now() - statSync(path).mtimeMs > ms;
  } catch {
    return false;
  }
};

// Runs `swap` holding the helper's swap lock, made with mkdir, which only one process can win.
// Another run's swap ends within milliseconds, so this waits for it; a lock past its stale age was
// left by a run stopped mid-swap and is taken over.
async function withSwapLock(helper, swap) {
  const lock = join(helper, SWAP_LOCK);
  for (let waited = 0; ; waited += 100) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (isOlderThan(lock, STALE_SWAP_LOCK_MS)) removeQuietly(lock);
      else if (waited >= SWAP_WAIT_MS) throw new Error("another update kept the helper locked");
      else await sleep(100);
    }
  }
  try {
    swap();
  } finally {
    removeQuietly(lock);
  }
}

// Puts the staged helper in place with two renames, putting the old one back when the second
// fails, and clears old copies a stopped swap left. Runs only under the swap lock, so no other run
// is moving folders; a run that finds the same version already in place leaves it as it is.
function swapIn(helper, staging) {
  const live = installedEntry(helper);
  const modules = dirname(live);
  mkdirSync(modules, { recursive: true });
  for (const name of readdirSync(modules).filter((n) => n.startsWith(`findwright${OLD_SUFFIX}`))) {
    removeQuietly(join(modules, name));
  }
  if (installedVersion(helper) === installedVersion(staging)) return;
  const old = `${live}${OLD_SUFFIX}${randomUUID()}`;
  const hadOld = existsSync(live);
  if (hadOld) renameSync(live, old);
  try {
    renameSync(installedEntry(staging), live);
  } catch (error) {
    if (hadOld) renameSync(old, live);
    throw error;
  }
  removeQuietly(old);
}

// Staging folders a stopped run left behind, once no run can still be using them.
function clearStaging(helper) {
  let names;
  try {
    names = readdirSync(helper);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.startsWith(STAGING_PREFIX))) {
    const path = join(helper, name);
    if (isOlderThan(path, STAGING_AGE_MS)) removeQuietly(path);
  }
}

/**
 * Brings the helper to the version `pin` names: `{ from, to }` once installed, `{ from, to, error }`
 * when the download or the install failed (the old helper stays), or null when there was nothing to do.
 */
export async function followPlugin({ pin, ownVersion, helper, fetchRelease = fetch, install = installRelease }) {
  if (!pin || pin.version === ownVersion) return null;
  const outcome = { from: ownVersion, to: pin.version };
  const staging = join(helper, `${STAGING_PREFIX}${randomUUID()}`);
  try {
    clearStaging(helper);
    mkdirSync(staging, { recursive: true });
    const file = join(staging, pin.node.file);
    writeFileSync(file, await download(pin, fetchRelease));
    await install(staging, file);
    const staged = installedVersion(staging);
    if (staged !== pin.version) throw new Error(`the install left version ${staged ?? "none"}`);
    await withSwapLock(helper, () => swapIn(helper, staging));
    return outcome;
  } catch (error) {
    // A run that lost a race to another one installing the same release still ends with it in place.
    if (installedVersion(helper) === pin.version) return outcome;
    return { ...outcome, error: error.name === "TimeoutError" ? "the download timed out" : error.message };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Runs the installed helper's model step, which fetches the meaning model it pins, as setup does,
 * and resolves to the step's line of JSON.
 */
export function modelStep(helper) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [installedEntry(helper, "src", "cli.mjs"), "model"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
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

/** Saves a follow's result for the next session's start notice. */
export function recordFollow(result, env = process.env) {
  mkdirSync(findwrightHome(env), { recursive: true });
  writeFileSync(resultFile(env), JSON.stringify(result));
}

/** The result a follow saved, removed once read so one session start reports it; null when none. */
export function takeFollowResult(env = process.env) {
  try {
    const result = JSON.parse(readFileSync(resultFile(env), "utf8"));
    rmSync(resultFile(env), { force: true });
    return result;
  } catch {
    return null;
  }
}

/** The line the session's start notice carries about a follow, or undefined when there is none. */
export function followNotice(result) {
  if (typeof result?.from !== "string" || typeof result.to !== "string") return undefined;
  const updated = `Tell the user in one line: FindWright's helper updated itself from ${result.from} to `
    + `${result.to} to match the plugin`;
  if (!result.error && result.modelError) {
    return `${updated}, but the meaning model it pins could not be fetched (${result.modelError}), so find `
      + "fails until /findwright:update fetches it.";
  }
  if (!result.error) return `${updated}.`;
  return `Tell the user in one line: FindWright's helper is still ${result.from}, behind the plugin's `
    + `${result.to}, since its update failed (${result.error}); it tries again at the next session start, `
    + "and /findwright:update tries now.";
}
