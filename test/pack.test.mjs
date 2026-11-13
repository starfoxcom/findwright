import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, crc32 } from "node:zlib";
import { helperTarball, pluginFiles, pluginZip, readVersion } from "../tools/pack.mjs";

const made = [];

function git(cwd, ...args) {
  return execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false",
    "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args,
  ], { cwd });
}

// Writes `files` into a fresh repo and commits them; `executable` lists paths git stores as 100755.
function makeRepo(files, executable = []) {
  const root = mkdtempSync(join(tmpdir(), "findwright-pack-"));
  made.push(root);
  git(root, "init", "-q");
  writeAll(root, files);
  git(root, "add", "-A");
  for (const path of executable) git(root, "update-index", "--chmod=+x", path);
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

function writeAll(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

const manifest = (version) => `${JSON.stringify({ name: "findwright", version })}\n`;

const BASE = {
  "package.json": `${JSON.stringify({ name: "findwright", version: "9.9.9" }, null, 2)}\n`,
  "src/a.mjs": "export const a = 1;\n",
  "hooks/h.mjs": "export const h = 2;\n",
  "README.md": "# findwright\n",
  LICENSE: "MIT\n",
  "plugin/.claude-plugin/plugin.json": manifest("9.9.9"),
  "plugin/skills/x/SKILL.md": "---\nname: x\ndescription: \"Test skill.\"\n---\n\nBody.\n",
};

function baseRepo(overrides = {}) {
  return makeRepo({ ...BASE, ...overrides }, ["hooks/h.mjs"]);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function field(block, offset, length) {
  return block.toString("utf8", offset, offset + length).replace(/\0[^]*$/, "");
}

// Reads the ustar entries of `tar` and checks each header checksum.
function readTar(tar) {
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const stored = parseInt(field(block, 148, 8), 8);
    const check = Buffer.from(block);
    check.fill(0x20, 148, 156);
    assert.equal(check.reduce((total, byte) => total + byte, 0), stored, "header checksum");
    const size = parseInt(field(block, 124, 12), 8);
    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      mode: parseInt(field(block, 100, 8), 8),
      mtime: parseInt(field(block, 136, 12), 8),
      type: field(block, 156, 1),
      data: tar.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// Reads the stored entries of a zip through its central directory.
function readZip(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50, "end of central directory");
  let pos = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    assert.equal(zip.readUInt32LE(pos), 0x02014b50, "central header");
    const nameLength = zip.readUInt16LE(pos + 28);
    const localAt = zip.readUInt32LE(pos + 42);
    const localNameLength = zip.readUInt16LE(localAt + 26);
    const size = zip.readUInt32LE(pos + 24);
    const start = localAt + 30 + localNameLength;
    const data = zip.subarray(start, start + size);
    assert.equal(zip.readUInt16LE(pos + 10), 0, "stored method");
    assert.equal(crc32(data), zip.readUInt32LE(pos + 16), "crc32");
    entries.push({ name: zip.toString("utf8", pos + 46, pos + 46 + nameLength), data });
    pos += 46 + nameLength;
  }
  return entries;
}

test("two packs of the same commit give identical zip and tarball bytes", () => {
  const repo = baseRepo();
  assert.deepEqual(pluginZip({ repo }), pluginZip({ repo }));
  assert.deepEqual(helperTarball({ repo }).bytes, helperTarball({ repo }).bytes);
  assert.deepEqual(helperTarball({ repo }).bytes, helperTarball({ repo: baseRepo() }).bytes);
});

test("the tarball holds exactly the helper's files under package/", () => {
  const { name, bytes } = helperTarball({ repo: baseRepo() });
  assert.equal(name, "findwright-9.9.9.tgz");
  const tar = gunzipSync(bytes);
  assert.equal(bytes[9], 255, "gzip OS byte");
  const entries = readTar(tar);
  assert.deepEqual(entries.map((entry) => entry.name), [
    "package/LICENSE",
    "package/README.md",
    "package/hooks/h.mjs",
    "package/package.json",
    "package/src/a.mjs",
  ]);
  assert.ok(entries.every((entry) => entry.type === "0"), "regular files only");
  assert.ok(entries.every((entry) => entry.mtime === 499162500));
  assert.deepEqual(entries.map((entry) => entry.mode), [0o644, 0o644, 0o755, 0o644, 0o644]);
  assert.equal(entries[2].data.toString("utf8"), BASE["hooks/h.mjs"]);
  assert.equal(entries[4].data.toString("utf8"), BASE["src/a.mjs"]);
});

test("helper.json names the tarball and its SHA-256", () => {
  const repo = baseRepo();
  const helper = JSON.parse(pluginFiles({ repo }).get("helper.json").toString("utf8"));
  const tarball = helperTarball({ repo });
  assert.deepEqual(helper, {
    version: "9.9.9",
    node: {
      file: "findwright-9.9.9.tgz",
      url: "https://github.com/starfoxcom/findwright/releases/download/v9.9.9/findwright-9.9.9.tgz",
      sha256: sha256(tarball.bytes),
    },
  });
});

test("the zip holds the plugin's files, sorted and stored", () => {
  const repo = baseRepo();
  const files = pluginFiles({ repo });
  const entries = readZip(pluginZip({ repo }));
  assert.deepEqual(entries.map((entry) => entry.name), [
    ".claude-plugin/plugin.json",
    "helper.json",
    "skills/x/SKILL.md",
  ]);
  for (const { name, data } of entries) assert.deepEqual(data, files.get(name), name);
});

test("an edit that is not committed does not change the packs", () => {
  const repo = baseRepo();
  const zip = pluginZip({ repo });
  const tarball = helperTarball({ repo }).bytes;
  writeAll(repo, {
    "src/a.mjs": "export const a = 99;\n",
    "plugin/skills/x/SKILL.md": "---\nname: x\n---\nEdited.\n",
    "plugin/untracked.md": "not committed\n",
  });
  assert.deepEqual(pluginZip({ repo }), zip);
  assert.deepEqual(helperTarball({ repo }).bytes, tarball);
});

test("a version mismatch between package.json and the plugin manifest throws", () => {
  const repo = baseRepo({
    "plugin/.claude-plugin/plugin.json": manifest("1.0.0"),
  });
  assert.throws(() => readVersion({ repo }), /9\.9\.9.*1\.0\.0/);
  assert.throws(() => pluginZip({ repo }), /9\.9\.9.*1\.0\.0/);
});

test("a plugin folder with code or a local server declaration throws", () => {
  const cases = [
    ["plugin/scripts/run.js", /run\.js/],
    ["plugin/.mcp.json", /\.mcp\.json/],
  ];
  for (const [path, message] of cases) {
    const repo = baseRepo({ [path]: "{}\n" });
    assert.throws(() => pluginFiles({ repo }), message, path);
  }
});
