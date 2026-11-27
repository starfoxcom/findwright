import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIncludes, linesOf } from "../src/lines.mjs";

const folder = mkdtempSync(join(tmpdir(), "findwright-lines-"));
after(() => rmSync(folder, { recursive: true, force: true }));

let files = 0;
function fileOf(content) {
  const path = join(folder, `f${files++}.txt`);
  writeFileSync(path, content);
  return path;
}

// Small chunks put every boundary case inside a few bytes.
const LINE_ROWS = [
  ["an empty file has no lines", "", {}, []],
  ["a trailing newline adds no empty last line", "a\nb\n", {}, ["a", "b"]],
  ["a last line without a newline counts", "a\nb", {}, ["a", "b"]],
  ["empty lines in the middle stay", "a\n\nb\n", {}, ["a", "", "b"]],
  ["a line across several chunks is whole",
    "abcdefghij\nk\n", { chunkBytes: 3 }, ["abcdefghij", "k"]],
  ["a newline at a chunk's last byte splits there",
    "abc\ndef\n", { chunkBytes: 4 }, ["abc", "def"]],
  ["a multibyte character across a chunk boundary decodes",
    "é€😀\nx\n", { chunkBytes: 1 }, ["é€😀", "x"]],
  ["a carriage return stays on its line", "a\r\nb\r\n", {}, ["a\r", "b\r"]],
  ["a line longer than a string can hold is skipped",
    "ok\ntoolong\nok2\n", { chunkBytes: 2, maxLineBytes: 4 }, ["ok", "ok2"]],
  ["a line exactly at the string limit is kept",
    "abcd\n", { chunkBytes: 2, maxLineBytes: 4 }, ["abcd"]],
];

for (const [name, content, options, expected] of LINE_ROWS) {
  test(`linesOf: ${name}`, () => {
    assert.deepEqual([...linesOf(fileOf(content), options)], expected);
  });
}

const INCLUDE_ROWS = [
  ["text inside one chunk is found", "xx needle xx", 64, true],
  ["text across a chunk boundary is found", "xxxneedlexxx", 4, true],
  ["text split over three chunks is found", "needle", 2, true],
  ["absent text is not found", "xx needl xx", 4, false],
  ["an empty file holds nothing", "", 4, false],
];

for (const [name, content, chunkBytes, expected] of INCLUDE_ROWS) {
  test(`fileIncludes: ${name}`, () => {
    assert.equal(fileIncludes(fileOf(content), "needle", { chunkBytes }), expected);
  });
}
