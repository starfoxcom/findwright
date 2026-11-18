import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followNotice, followPlugin, helperFolder, installRelease, isInstalledHelper, pluginPin }
  from "../src/follow.mjs";
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

// A fake install that leaves the given version where npm would put it.
const installs = (version) => async (helper) => {
  mkdirSync(join(helper, "node_modules", "findwright"), { recursive: true });
  writeFileSync(join(helper, "node_modules", "findwright", "package.json"), JSON.stringify({ version }));
};

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

test("the pin comes from the user-scope install, then the newest, and skips one it cannot read", () => {
  const config = temp("config");
  const folder = (name, pin) => {
    const path = join(config, "cache", name);
    mkdirSync(path, { recursive: true });
    if (pin) writeFileSync(join(path, "helper.json"), JSON.stringify(pin));
    return path;
  };
  const bytes = release("9.0.0");
  const writeInstalls = (list) => {
    mkdirSync(join(config, "plugins"), { recursive: true });
    writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2,
      plugins: { "findwright@wrights": list, "bindwright@wrights": [{ scope: "user", installPath: folder("bw") }] } }));
  };
  const env = { CLAUDE_CONFIG_DIR: config };
  assert.equal(pluginPin(env), null, "no list of installed plugins");

  writeInstalls([
    { scope: "project", installPath: folder("project", pinFor("8.0.0", bytes)), lastUpdated: "2026-11-18T00:00:00Z" },
    { scope: "user", installPath: folder("old", pinFor("7.0.0", bytes)), lastUpdated: "2026-11-01T00:00:00Z" },
    { scope: "user", installPath: folder("new", pinFor("9.0.0", bytes)), lastUpdated: "2026-11-17T00:00:00Z" },
  ]);
  assert.equal(pluginPin(env).version, "9.0.0");

  const badUrl = { ...pinFor("9.1.0", bytes) };
  badUrl.node = { ...badUrl.node, url: "https://example.com/findwright-9.1.0.tgz" };
  writeInstalls([
    { scope: "user", installPath: folder("gone"), lastUpdated: "2026-11-19T00:00:00Z" },
    { scope: "user", installPath: folder("bad-url", badUrl), lastUpdated: "2026-11-18T00:00:00Z" },
    { scope: "user", installPath: folder("fine", pinFor("9.0.0", bytes)), lastUpdated: "2026-11-17T00:00:00Z" },
  ]);
  assert.equal(pluginPin(env).version, "9.0.0", "a folder with no pin and a pin outside the releases are skipped");
});

test("a helper at the plugin's version, or with no plugin pin, is left alone", async () => {
  const helper = temp("helper");
  const fail = async () => assert.fail("nothing should be downloaded");
  assert.equal(await followPlugin({ pin: null, ownVersion: "2.1.0", helper, fetchRelease: fail }), null);
  const pin = pinFor("2.1.0", release("2.1.0"));
  assert.equal(await followPlugin({ pin, ownVersion: "2.1.0", helper, fetchRelease: fail }), null);
});

test("a helper behind the plugin installs the pinned release and leaves no files behind", async () => {
  const helper = temp("helper");
  const bytes = release("2.2.0");
  const result = await followPlugin({ pin: pinFor("2.2.0", bytes), ownVersion: "2.1.0", helper,
    fetchRelease: serve(bytes), install: installs("2.2.0") });
  assert.deepEqual(result, { from: "2.1.0", to: "2.2.0" });
  assert.deepEqual(readdirSync(helper), ["node_modules"], "the release file and the lock are gone");
  assert.match(followNotice(result), /updated itself from 2\.1\.0 to 2\.2\.0/);
});

test("a failed download, check or install keeps the old helper and says why", async () => {
  const bytes = release("2.2.0");
  const pin = pinFor("2.2.0", bytes);
  const rows = [
    ["a download that does not match the pin", serve(Buffer.from("tampered")), installs("2.2.0"),
      /does not match the SHA-256/],
    ["a download the server refuses", async () => ({ ok: false, status: 404 }), installs("2.2.0"), /HTTP 404/],
    ["an install that fails", serve(bytes), async () => { throw new Error("npm install failed: EPERM"); }, /EPERM/],
    ["an install that leaves another version", serve(bytes), installs("2.1.0"), /left version 2\.1\.0/],
  ];
  for (const [name, fetchRelease, install, why] of rows) {
    const helper = temp("helper");
    const result = await followPlugin({ pin, ownVersion: "2.1.0", helper, fetchRelease, install });
    assert.match(result.error, why, name);
    assert.ok(!existsSync(join(helper, pin.node.file)) && !existsSync(join(helper, ".follow.lock")), name);
    assert.match(followNotice(result), /still 2\.1\.0, behind the plugin's 2\.2\.0/, name);
  }
});

test("a server that finds another one installing waits for it instead of installing twice", async () => {
  const helper = temp("helper");
  const lock = join(helper, ".follow.lock");
  writeFileSync(lock, "1");
  setTimeout(() => rmSync(lock), 300);
  const fail = async () => assert.fail("the second server must not download");
  const pin = pinFor("2.2.0", release("2.2.0"));
  assert.equal(await followPlugin({ pin, ownVersion: "2.1.0", helper, fetchRelease: fail }), null);
});

test("the real install puts the pinned release into the helper folder", async () => {
  const helper = temp("helper");
  const file = join(helper, "findwright-2.2.0.tgz");
  writeFileSync(file, release("2.2.0"));
  await installRelease(helper, file);
  const installed = JSON.parse(readFileSync(join(helper, "node_modules", "findwright", "package.json"), "utf8"));
  assert.equal(installed.version, "2.2.0");
});
