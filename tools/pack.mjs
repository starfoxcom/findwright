// Builds the release files from what git stores at a ref, never the working tree.
//
//   node tools/pack.mjs --zip FILE | --tgz DIR | --out DIR | --marketplace [--ref REF]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { problemsIn } from "./directory_check.mjs";
import { gzipStored } from "./pack/gzip.mjs";
import { readBlobs } from "./pack/git.mjs";
import { tarArchive } from "./pack/tar.mjs";
import { zipArchive } from "./pack/zip.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_PREFIX = "plugin/";
const MANIFEST_PATH = "plugin/.claude-plugin/plugin.json";
const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";
const OUT_MARKER = ".findwright-pack.txt";
const RELEASE_URL = "https://github.com/starfoxcom/findwright/releases/download";
const HELPER_TOP_FILES = new Set(["package.json", "README.md", "LICENSE", "CHANGELOG.md"]);

const isHelperFile = (path) =>
  HELPER_TOP_FILES.has(path) || path.startsWith("src/") || path.startsWith("hooks/");
const byPath = (a, b) => (a[0] < b[0] ? -1 : 1);

function at(opts = {}) {
  return { repo: opts.repo ?? REPO_ROOT, ref: opts.ref ?? "HEAD" };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonAt(files, path) {
  const file = files.get(path);
  if (!file) throw new Error(`${path} is missing at the ref`);
  return JSON.parse(file.data.toString("utf8"));
}

/** The version every release file carries: package.json's, which the plugin manifest must match. */
export function readVersion(opts) {
  const { repo, ref } = at(opts);
  const files = readBlobs(repo, ref, (path) => path === "package.json" || path === MANIFEST_PATH);
  const version = jsonAt(files, "package.json").version;
  const pluginVersion = jsonAt(files, MANIFEST_PATH).version;
  if (pluginVersion !== version) {
    throw new Error(`package.json is ${version} but ${MANIFEST_PATH} is ${pluginVersion}`);
  }
  return version;
}

/** The helper's npm package as { name, bytes }: its files under `package/`, sorted by path. */
export function helperTarball(opts) {
  const { repo, ref } = at(opts);
  const version = readVersion({ repo, ref });
  const files = [...readBlobs(repo, ref, isHelperFile)].sort(byPath);
  const entries = files.map(([path, { mode, data }]) => ({ name: `package/${path}`, mode, data }));
  return { name: `findwright-${version}.tgz`, bytes: gzipStored(tarArchive(entries)) };
}

function helperJson(version, tarball) {
  const manifest = {
    version,
    node: {
      file: tarball.name,
      url: `${RELEASE_URL}/v${version}/${tarball.name}`,
      sha256: sha256(tarball.bytes),
    },
  };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Every file under plugin/ at the ref, keyed by its path below plugin/, plus helper.json. */
export function pluginFiles(opts) {
  const { repo, ref } = at(opts);
  const version = readVersion({ repo, ref });
  const files = new Map();
  for (const [path, { data }] of readBlobs(repo, ref, (p) => p.startsWith(PLUGIN_PREFIX))) {
    files.set(path.slice(PLUGIN_PREFIX.length), data);
  }
  files.set("helper.json", helperJson(version, helperTarball({ repo, ref })));
  const found = problemsIn(files);
  if (found.length) throw new Error(`plugin/ breaks the directory's rules:\n${found.join("\n")}`);
  return files;
}

/** The plugin's release zip as a Buffer. */
export function pluginZip(opts) {
  const entries = [...pluginFiles(opts)].sort(byPath).map(([name, data]) => ({ name, data }));
  return zipArchive(entries);
}

function zipName(version) {
  return `findwright-${version}.zip`;
}

function pinMarketplace(opts) {
  const { repo, ref } = at(opts);
  const version = readVersion({ repo, ref });
  const zip = pluginZip({ repo, ref });
  const path = join(repo, MARKETPLACE_PATH);
  const marketplace = JSON.parse(readFileSync(path, "utf8"));
  const index = marketplace.plugins.findIndex((plugin) => plugin.name === "findwright");
  if (index === -1) throw new Error(`${path} has no findwright entry`);
  const source = {
    source: "archive",
    url: `${RELEASE_URL}/v${version}/${zipName(version)}`,
    sha256: sha256(zip),
  };
  marketplace.plugins[index] = { ...marketplace.plugins[index], version, source };
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`);
  return path;
}

// Refuses a folder it did not write, so a stray --out path cannot wipe a real one.
function writeUnpacked(dir, files) {
  if (existsSync(dir) && !existsSync(join(dir, OUT_MARKER))) {
    throw new Error(`${dir} exists and is not a pack folder; refusing to replace it`);
  }
  rmSync(dir, { recursive: true, force: true });
  for (const [path, data] of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  const marker = "Written by tools/pack.mjs from git; replaced on each pack.\n";
  writeFileSync(join(dir, OUT_MARKER), marker);
}

function writeFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`${path} sha256 ${sha256(bytes)}`);
}

function runCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      zip: { type: "string" },
      tgz: { type: "string" },
      out: { type: "string" },
      marketplace: { type: "boolean" },
      ref: { type: "string" },
    },
    strict: true,
  });
  const opts = { ref: values.ref };
  if (values.zip) writeFile(resolve(values.zip), pluginZip(opts));
  if (values.tgz) {
    const tarball = helperTarball(opts);
    writeFile(join(resolve(values.tgz), tarball.name), tarball.bytes);
  }
  if (values.out) writeUnpacked(resolve(values.out), pluginFiles(opts));
  if (values.marketplace) console.log(`updated ${pinMarketplace(opts)}`);
  if (!values.zip && !values.tgz && !values.out && !values.marketplace) {
    throw new Error("nothing to do: pass --zip, --tgz, --out or --marketplace");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
