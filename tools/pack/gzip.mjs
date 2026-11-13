// A gzip file made of stored (uncompressed) deflate blocks only. Compressing would
// tie the bytes to the zlib build, so the same tree could pack differently per machine.

import { crc32 } from "node:zlib";

const MAX_STORED_BLOCK_BYTES = 0xffff;

// One stored block per 65535 bytes; an empty input still needs one final block.
function storedBlocks(data) {
  const parts = [];
  let offset = 0;
  do {
    const size = Math.min(MAX_STORED_BLOCK_BYTES, data.length - offset);
    const isLast = offset + size >= data.length;
    const header = Buffer.alloc(5);
    header[0] = isLast ? 1 : 0;
    header.writeUInt16LE(size, 1);
    header.writeUInt16LE(size ^ 0xffff, 3);
    parts.push(header, data.subarray(offset, offset + size));
    offset += size;
  } while (offset < data.length);
  return parts;
}

/** A gzip of `data` with a zero mtime, OS byte 255 (unknown) and no name. */
export function gzipStored(data) {
  const header = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(data), 0);
  trailer.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, ...storedBlocks(data), trailer]);
}
