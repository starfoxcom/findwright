// Reads what git stores at a ref. The working tree never enters, so an edit that
// is not committed cannot change a pack.

import { execFileSync } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 ** 3;

function git(repo, args, input) {
  return execFileSync("git", args, { cwd: repo, input, maxBuffer: MAX_OUTPUT_BYTES });
}

function parseTreeLine(line) {
  const tab = line.indexOf("\t");
  const [mode, type, sha] = line.slice(0, tab).split(" ");
  return { mode, type, sha, path: line.slice(tab + 1) };
}

function listBlobs(repo, ref) {
  const listing = git(repo, ["ls-tree", "-r", "-z", "--full-tree", ref]).toString("utf8");
  return listing.split("\0")
    .filter(Boolean)
    .map(parseTreeLine)
    .filter((entry) => entry.type === "blob");
}

// `cat-file --batch` answers each object as "<sha> <type> <size>", its bytes, then a newline.
function catBlobs(repo, shas) {
  if (shas.length === 0) return [];
  const out = git(repo, ["cat-file", "--batch"], `${shas.join("\n")}\n`);
  const blobs = [];
  let pos = 0;
  for (let i = 0; i < shas.length; i++) {
    const eol = out.indexOf(0x0a, pos);
    const [sha, type, size] = out.toString("latin1", pos, eol).split(" ");
    if (type !== "blob") throw new Error(`git has no blob ${sha}`);
    const start = eol + 1;
    const end = start + Number(size);
    blobs.push(out.subarray(start, end));
    pos = end + 1;
  }
  return blobs;
}

/**
 * The blobs at `ref` whose paths `keep` accepts, as a Map of path to { mode, data }.
 * `mode` is the tar mode: 0o755 for an executable blob, 0o644 otherwise.
 */
export function readBlobs(repo, ref, keep) {
  const entries = listBlobs(repo, ref).filter((entry) => keep(entry.path));
  const contents = catBlobs(repo, entries.map((entry) => entry.sha));
  return new Map(entries.map((entry, i) => {
    if (entry.mode === "120000") {
      throw new Error(`${entry.path} is a symlink, which a pack cannot hold`);
    }
    const mode = entry.mode === "100755" ? 0o755 : 0o644;
    return [entry.path, { mode, data: contents[i] }];
  }));
}
