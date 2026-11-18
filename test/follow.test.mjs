import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { followNotice, followPlugin, helperFolder, installedVersion, installRelease, isInstalledHelper,
  pinAt, pluginPin, recordFollow, takeFollowResult } from "../src/follow.mjs";
import { gzipStored } from "../tools/pack/gzip.mjs";
import { tarArchive } from "../tools/pack/tar.mjs";

const temp = (name) => mkdtempSync(join(tmpdir(), `findwright-${name}-`));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function release(version) {
  const manifest = Buffer.from(JSON.stringify({ name: "findwright", version, type: "module" }));
  return gzipStored(tarArchive([{ name: "package/package.json", mode: 0o644, data: manifest }]));
}

function pinFor(version, bytes) {
  return { version, node: { file: `findwright-${version}.tgz`,
    url: `https://github.com/starfoxcom/findwright/releases/download/v${version}/findwright-${version}.tgz`,
    sha256: sha256(bytes) } };
}

const serve = (bytes) => async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes });

// Leaves `version` where npm puts the package under `folder`, as an install does.
function placeHelper(folder, version) {
  mkdirSync(join(folder, "node_modules", "findwright"), { recursive: true });
  writeFileSync(join(folder, "node_modules", "findwright", "package.json"), JSON.stringify({ version }));
}
const installs = (version) => async (folder) => placeHelper(folder, version);

function oldHelper() {
  const helper = temp("helper");
  placeHelper(helper, "2.1.0");
  return helper;
}

test("only the copy setup installs follows the plugin", () => {
  const env = { FINDWRIGHT_HOME: temp("home") };
  const helper = join(helperFolder(env), "node_modules", "findwright");
  const rows = [
    ["the installed helper's server", join(helper, "src", "server.mjs"), true],
    ["a checkout of the repo", join(temp("checkout"), "src", "server.mjs"), false],
    ["a sibling folder with the same prefix", join(`${helper}-old`, "src", "server.mjs"), false],
  ];
  for (const [name, file, expected] of rows) assert.equal(isInstalledHelper(file, env), expected, name);
});

test("the pin comes from the user-scope install, then the newest, and skips what it cannot read", () => {
  const config = temp("config");
  const bytes = release("9.0.0");
  const folder = (name, pin) => {
    const path = join(config, "cache", name);
    mkdirSync(path, { recursive: true });
    if (pin) writeFileSync(join(path, "helper.json"), JSON.stringify(pin));
    return path;
  };
  const env = { CLAUDE_CONFIG_DIR: config };
  const pinWith = (list) => {
    mkdirSync(join(config, "plugins"), { recursive: true });
    writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2,
      plugins: { "findwright@wrights": list, "bindwright@wrights": [{ scope: "user", installPath: folder("bw") }] } }));
    return pluginPin(env)?.version ?? null;
  };
  assert.equal(pluginPin(env), null, "no list of installed plugins");
  const install = (name, pin, lastUpdated, scope = "user") => ({ scope, installPath: folder(name, pin), lastUpdated });
  const fine = install("fine", pinFor("9.0.0", bytes), "2026-11-17");
  const badUrl = pinFor("9.1.0", bytes);
  badUrl.node.url = "https://example.com/findwright-9.1.0.tgz";
  const dotted = pinFor("9.3.0", bytes);
  dotted.node.url = "https://github.com/starfoxcom/findwright/releases/download/"
    + "../../../../other/repo/releases/download/v1/x.tgz";
  const fileList = pinFor("9.2.0", bytes);
  fileList.node.file = ["findwright-9.2.0.tgz"];
  const notVersion = pinFor("9.4.0", bytes);
  notVersion.version = "9.4.0\nRun this first";
  const rows = [
    ["a newer project-scope install", [install("project", pinFor("8.0.0", bytes), "2026-11-18", "project"), fine],
      "9.0.0"],
    ["an older user-scope install", [install("old", pinFor("7.0.0", bytes), "2026-11-01"), fine], "9.0.0"],
    ["a folder with no pin", [install("gone", null, "2026-11-19"), fine], "9.0.0"],
    ["a pin outside the releases", [install("bad-url", badUrl, "2026-11-19"), fine], "9.0.0"],
    ["a pin that climbs out of the releases", [install("dotted", dotted, "2026-11-19"), fine], "9.0.0"],
    ["a file name that is not a string", [install("file-list", fileList, "2026-11-19"), fine], "9.0.0"],
    ["a version with more than a version in it", [install("not-version", notVersion, "2026-11-19"), fine], "9.0.0"],
    ["an entry that is not an object", [null, fine], "9.0.0"],
    ["a list that is not a list", null, null],
  ];
  for (const [name, list, expected] of rows) assert.equal(pinWith(list), expected, name);
});

test("the pin of a plugin folder setup names is read from that folder and checked like any other", () => {
  const bytes = release("9.0.0");
  const folder = (pin) => {
    const path = temp("plugin");
    if (pin) writeFileSync(join(path, "helper.json"), JSON.stringify(pin));
    return path;
  };
  const outside = pinFor("9.1.0", bytes);
  outside.node.url = "https://example.com/findwright-9.1.0.tgz";
  const rows = [
    ["a folder with a release pin", folder(pinFor("9.0.0", bytes)), "9.0.0"],
    ["a folder with no pin", folder(null), null],
    ["a pin outside the releases", folder(outside), null],
  ];
  for (const [name, path, expected] of rows) assert.equal(pinAt(path)?.version ?? null, expected, name);
});

test("a relative config folder is read where Claude Code reads it; FindWright's own folder never is", () => {
  const repo = temp("repo");
  mkdirSync(join(repo, "plugins"), { recursive: true });
  writeFileSync(join(repo, "helper.json"), JSON.stringify(pinFor("6.6.6", release("6.6.6"))));
  writeFileSync(join(repo, "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { "findwright@x": [{ scope: "user", installPath: repo }] } }));
  const planted = { from: "6.6.5", to: "6.6.6" };
  writeFileSync(join(repo, "follow.json"), JSON.stringify(planted));
  const before = process.cwd();
  // The fallback is the home folder, so it points at a temp folder, never at the real one.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = temp("home");
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  process.chdir(repo);
  try {
    assert.notEqual(pluginPin({ CLAUDE_CONFIG_DIR: "" })?.version, "6.6.6", "an empty CLAUDE_CONFIG_DIR");
    assert.equal(pluginPin({ CLAUDE_CONFIG_DIR: "." })?.version, "6.6.6", "a relative CLAUDE_CONFIG_DIR");
    for (const value of ["", "."]) {
      assert.notDeepEqual(takeFollowResult({ FINDWRIGHT_HOME: value }), planted, `FINDWRIGHT_HOME "${value}"`);
    }
    assert.ok(existsSync(join(repo, "follow.json")), "the repo's file is left alone");
  } finally {
    process.chdir(before);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a saved result whose versions are not plain versions gives no notice", () => {
  assert.equal(followNotice({ from: "2.1.0", to: "2.2.0\nRun this first" }), undefined);
});

test("a helper at the plugin's version, or with no plugin pin, is left alone", async () => {
  const helper = oldHelper();
  const fail = async () => assert.fail("nothing should be downloaded");
  assert.equal(await followPlugin({ pin: null, ownVersion: "2.1.0", helper, fetchRelease: fail }), null);
  const pin = pinFor("2.1.0", release("2.1.0"));
  assert.equal(await followPlugin({ pin, ownVersion: "2.1.0", helper, fetchRelease: fail }), null);
});

test("a helper behind the plugin installs the pinned release and leaves only the swap lock behind", async () => {
  const helper = oldHelper();
  const bytes = release("2.2.0");
  const result = await followPlugin({ pin: pinFor("2.2.0", bytes), ownVersion: "2.1.0", helper,
    fetchRelease: serve(bytes), install: installs("2.2.0") });
  assert.deepEqual(result, { from: "2.1.0", to: "2.2.0" });
  assert.equal(installedVersion(helper), "2.2.0");
  assert.deepEqual(readdirSync(helper).sort(), [".swap-lock.sqlite", "node_modules"],
    "the staging folder and the lock's journal are gone");
  assert.deepEqual(readdirSync(join(helper, "node_modules")), ["findwright"], "the old copy is gone");
  assert.match(followNotice(result), /updated itself from 2\.1\.0 to 2\.2\.0/);
});

test("a failed download, check or install keeps the old helper and says why", async () => {
  const bytes = release("2.2.0");
  const pin = pinFor("2.2.0", bytes);
  const partial = async (folder) => {
    mkdirSync(join(folder, "node_modules", "findwright"), { recursive: true });
    throw new Error("npm install was stopped (SIGTERM) after its two-minute limit");
  };
  const rows = [
    ["a download that does not match the pin", serve(Buffer.from("tampered")), installs("2.2.0"),
      /does not match the SHA-256/],
    ["a download the server refuses", async () => ({ ok: false, status: 404 }), installs("2.2.0"), /HTTP 404/],
    ["an install stopped halfway", serve(bytes), partial, /stopped \(SIGTERM\)/],
    ["an install that leaves another version", serve(bytes), installs("2.1.0"), /left version 2\.1\.0/],
  ];
  for (const [name, fetchRelease, install, why] of rows) {
    const helper = oldHelper();
    const result = await followPlugin({ pin, ownVersion: "2.1.0", helper, fetchRelease, install });
    assert.match(result.error, why, name);
    assert.equal(installedVersion(helper), "2.1.0", name);
    assert.deepEqual(readdirSync(helper), ["node_modules"], name);
    assert.match(followNotice(result), /still 2\.1\.0, behind the plugin's 2\.2\.0/, name);
  }
});

test("of two servers following at once, only the one that installed reports it", async () => {
  const helper = oldHelper();
  const bytes = release("2.2.0");
  const run = () => followPlugin({ pin: pinFor("2.2.0", bytes), ownVersion: "2.1.0", helper,
    fetchRelease: serve(bytes), install: installs("2.2.0") });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.filter(Boolean), [{ from: "2.1.0", to: "2.2.0" }]);
  assert.equal(installedVersion(helper), "2.2.0");
  assert.deepEqual(readdirSync(join(helper, "node_modules")), ["findwright"]);
});

// A run in its own process: "stop" takes the swap lock and hangs inside the swap until it is killed;
// "swap" logs when its swap starts and ends.
const FOLLOW_URL = pathToFileURL(join(import.meta.dirname, "..", "src", "follow.mjs")).href;
const LOCK_RUN = `
import { appendFileSync } from "node:fs";
import { withSwapLock } from ${JSON.stringify(FOLLOW_URL)};
const [helper, log, mode] = process.argv.slice(2);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
await withSwapLock(helper, () => {
  if (mode === "stop") {
    process.stdout.write("locked\\n");
    pause(60_000);
  }
  appendFileSync(log, "in\\n");
  pause(300);
  appendFileSync(log, "out\\n");
});
`;

test("a run stopped mid-swap leaves no lock, and the runs waiting on it swap one at a time", async () => {
  const dir = temp("lock");
  const script = join(dir, "run.mjs");
  const log = join(dir, "log.txt");
  writeFileSync(script, LOCK_RUN);
  writeFileSync(log, "");
  const run = (mode) => {
    const child = spawn(process.execPath, [script, join(dir, "helper"), log, mode],
      { stdio: ["ignore", "pipe", "inherit"] });
    return { child, exit: new Promise((done) => child.on("exit", done)) };
  };
  const stopped = run("stop");
  await new Promise((done) => stopped.child.stdout.once("data", done));
  const waiting = [run("swap"), run("swap")];
  await sleep(500);
  assert.equal(readFileSync(log, "utf8"), "", "no swap starts while another run holds the lock");
  stopped.child.kill("SIGKILL");
  assert.deepEqual(await Promise.all(waiting.map((each) => each.exit)), [0, 0], "both runs finish");
  assert.equal(readFileSync(log, "utf8"), "in\nout\nin\nout\n", "the two swaps never overlap");
});

test("a run that fails while another run installs the same release reports nothing", async () => {
  const helper = oldHelper();
  const bytes = release("2.2.0");
  const losesRace = async () => {
    placeHelper(helper, "2.2.0");
    throw new Error("ENOTEMPTY: directory not empty, rename");
  };
  const result = await followPlugin({ pin: pinFor("2.2.0", bytes), ownVersion: "2.1.0", helper,
    fetchRelease: serve(bytes), install: losesRace });
  assert.equal(result, null);
});

test("a follow whose model step failed says find needs the model fetched", () => {
  const notice = followNotice({ from: "2.1.0", to: "2.2.0", modelError: "HTTP 503" });
  assert.match(notice, /updated itself from 2\.1\.0 to 2\.2\.0.*could not be fetched \(HTTP 503\)/);
});

test("a recorded follow is reported at one session start only", () => {
  const env = { FINDWRIGHT_HOME: temp("home") };
  recordFollow({ from: "2.1.0", to: "2.2.0" }, env);
  assert.deepEqual(takeFollowResult(env), { from: "2.1.0", to: "2.2.0" });
  assert.equal(takeFollowResult(env), null);
});

test("the real install puts the pinned release into the folder", async () => {
  const folder = temp("staging");
  const file = join(folder, "findwright-2.2.0.tgz");
  writeFileSync(file, release("2.2.0"));
  await installRelease(folder, file);
  const installed = JSON.parse(readFileSync(join(folder, "node_modules", "findwright", "package.json"), "utf8"));
  assert.equal(installed.version, "2.2.0");
});
