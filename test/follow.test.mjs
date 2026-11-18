import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followNotice, followPlugin, helperFolder, installedVersion, installRelease, isInstalledHelper,
  pluginPin, recordFollow, takeFollowResult } from "../src/follow.mjs";
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
  const fileList = pinFor("9.2.0", bytes);
  fileList.node.file = ["findwright-9.2.0.tgz"];
  const rows = [
    ["a newer project-scope install", [install("project", pinFor("8.0.0", bytes), "2026-11-18", "project"), fine],
      "9.0.0"],
    ["an older user-scope install", [install("old", pinFor("7.0.0", bytes), "2026-11-01"), fine], "9.0.0"],
    ["a folder with no pin", [install("gone", null, "2026-11-19"), fine], "9.0.0"],
    ["a pin outside the releases", [install("bad-url", badUrl, "2026-11-19"), fine], "9.0.0"],
    ["a file name that is not a string", [install("file-list", fileList, "2026-11-19"), fine], "9.0.0"],
    ["an entry that is not an object", [null, fine], "9.0.0"],
    ["a list that is not a list", null, null],
  ];
  for (const [name, list, expected] of rows) assert.equal(pinWith(list), expected, name);
});

test("a helper at the plugin's version, or with no plugin pin, is left alone", async () => {
  const helper = oldHelper();
  const fail = async () => assert.fail("nothing should be downloaded");
  assert.equal(await followPlugin({ pin: null, ownVersion: "2.1.0", helper, fetchRelease: fail }), null);
  const pin = pinFor("2.1.0", release("2.1.0"));
  assert.equal(await followPlugin({ pin, ownVersion: "2.1.0", helper, fetchRelease: fail }), null);
});

test("a helper behind the plugin installs the pinned release and leaves no files behind", async () => {
  const helper = oldHelper();
  const bytes = release("2.2.0");
  const result = await followPlugin({ pin: pinFor("2.2.0", bytes), ownVersion: "2.1.0", helper,
    fetchRelease: serve(bytes), install: installs("2.2.0") });
  assert.deepEqual(result, { from: "2.1.0", to: "2.2.0" });
  assert.equal(installedVersion(helper), "2.2.0");
  assert.deepEqual(readdirSync(helper), ["node_modules"], "the staging folder is gone");
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

test("two servers following at once both end with the new helper in place", async () => {
  const helper = oldHelper();
  const bytes = release("2.2.0");
  const run = () => followPlugin({ pin: pinFor("2.2.0", bytes), ownVersion: "2.1.0", helper,
    fetchRelease: serve(bytes), install: installs("2.2.0") });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map((r) => r.error), [undefined, undefined]);
  assert.equal(installedVersion(helper), "2.2.0");
  assert.deepEqual(readdirSync(join(helper, "node_modules")), ["findwright"]);
});

test("the swap waits for another run's lock, and takes over one a stopped run left", async () => {
  const bytes = release("2.2.0");
  const follow = (helper) => followPlugin({ pin: pinFor("2.2.0", bytes), ownVersion: "2.1.0", helper,
    fetchRelease: serve(bytes), install: installs("2.2.0") });
  const held = oldHelper();
  mkdirSync(join(held, ".swap.lock"));
  setTimeout(() => rmSync(join(held, ".swap.lock"), { recursive: true }), 300);
  assert.deepEqual(await follow(held), { from: "2.1.0", to: "2.2.0" }, "a lock released soon");
  assert.equal(installedVersion(held), "2.2.0");

  const left = oldHelper();
  mkdirSync(join(left, ".swap.lock"));
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(join(left, ".swap.lock"), hourAgo, hourAgo);
  assert.deepEqual(await follow(left), { from: "2.1.0", to: "2.2.0" }, "a lock a stopped run left");
  assert.deepEqual(readdirSync(left), ["node_modules"]);
});

test("a run that loses the swap to another run installing the same release reports success", async () => {
  const helper = oldHelper();
  const bytes = release("2.2.0");
  const losesRace = async () => {
    placeHelper(helper, "2.2.0");
    throw new Error("ENOTEMPTY: directory not empty, rename");
  };
  const result = await followPlugin({ pin: pinFor("2.2.0", bytes), ownVersion: "2.1.0", helper,
    fetchRelease: serve(bytes), install: losesRace });
  assert.deepEqual(result, { from: "2.1.0", to: "2.2.0" });
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
