// Reading a file in fixed-size chunks, so a file larger than the longest string V8 can hold
// (buffer.constants.MAX_STRING_LENGTH, about 512 MB) still reads, in flat memory.

import { constants } from "node:buffer";
import { closeSync, openSync, readSync } from "node:fs";

const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;

// The start of a line that runs past the end of a chunk. A UTF-8 line of at most
// `maxLineBytes` bytes decodes into a string of at most that many characters.
class LineCarry {
  #pieces = [];
  #bytes = 0;

  constructor(maxLineBytes) {
    this.maxLineBytes = maxLineBytes;
  }

  add(piece) {
    this.#bytes += piece.length;
    if (piece.length > 0 && this.#bytes <= this.maxLineBytes) this.#pieces.push(Buffer.from(piece));
  }

  // The whole line that `tail` ends, or null when it is too long for one string.
  finish(tail) {
    const bytes = this.#bytes + tail.length;
    const pieces = this.#pieces;
    this.#pieces = [];
    this.#bytes = 0;
    if (bytes > this.maxLineBytes) return null;
    return (pieces.length === 0 ? tail : Buffer.concat([...pieces, tail])).toString("utf8");
  }
}

/**
 * The lines of a UTF-8 file in order, each without its "\n"; a last line that ends without one
 * counts too. The newline byte never occurs inside a multibyte UTF-8 character, so splitting the
 * raw bytes on it never cuts one. A line too long for one string is skipped.
 */
export function* linesOf(path, {
  chunkBytes = CHUNK_BYTES,
  maxLineBytes = constants.MAX_STRING_LENGTH,
} = {}) {
  const fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(chunkBytes);
  const carry = new LineCarry(maxLineBytes);
  try {
    let read;
    while ((read = readSync(fd, chunk, 0, chunkBytes, null)) > 0) {
      const bytes = chunk.subarray(0, read);
      let start = 0;
      let end;
      while ((end = bytes.indexOf(NEWLINE, start)) !== -1) {
        const line = carry.finish(bytes.subarray(start, end));
        if (line !== null) yield line;
        start = end + 1;
      }
      carry.add(bytes.subarray(start));
    }
    const last = carry.finish(Buffer.alloc(0));
    if (last) yield last;
  } finally {
    closeSync(fd);
  }
}

/** Whether a file holds `text` anywhere, read a chunk at a time. */
export function fileIncludes(path, text, { chunkBytes = CHUNK_BYTES } = {}) {
  const needle = Buffer.from(text, "utf8");
  const fd = openSync(path, "r");
  // Each read keeps the last needle-length-minus-one bytes, so a match across two chunks counts.
  const window = Buffer.allocUnsafe(chunkBytes + needle.length);
  let kept = 0;
  try {
    let read;
    while ((read = readSync(fd, window, kept, chunkBytes, null)) > 0) {
      const filled = kept + read;
      if (window.subarray(0, filled).includes(needle)) return true;
      kept = Math.min(needle.length - 1, filled);
      window.copy(window, 0, filled - kept, filled);
    }
    return false;
  } finally {
    closeSync(fd);
  }
}
