// ustar archive with fixed owner, mode-only differences and a fixed mtime, so the
// same entries always make the same bytes.

const BLOCK_BYTES = 512;
const MTIME_SECONDS = 499162500;
const NAME_BYTES = 100;
const PREFIX_BYTES = 155;

function writeOctal(block, offset, length, value) {
  block.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

// ustar keeps a long path as prefix/name, each part within its own field.
function splitName(name) {
  if (Buffer.byteLength(name) <= NAME_BYTES) return { name, prefix: "" };
  for (let slash = name.indexOf("/"); slash !== -1; slash = name.indexOf("/", slash + 1)) {
    const prefix = name.slice(0, slash);
    const rest = name.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= PREFIX_BYTES && Buffer.byteLength(rest) <= NAME_BYTES) {
      return { name: rest, prefix };
    }
  }
  throw new Error(`path too long for a tar header: ${name}`);
}

function header(name, mode, size) {
  const parts = splitName(name);
  const block = Buffer.alloc(BLOCK_BYTES);
  block.write(parts.name, 0, NAME_BYTES, "utf8");
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, MTIME_SECONDS);
  block.fill(0x20, 148, 156);
  block[156] = 0x30;
  block.write("ustar", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  writeOctal(block, 329, 8, 0);
  writeOctal(block, 337, 8, 0);
  block.write(parts.prefix, 345, PREFIX_BYTES, "utf8");
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function padding(size) {
  return Buffer.alloc((BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES);
}

/** A tar of regular files, `entries` as { name, mode, data }, in the order given. */
export function tarArchive(entries) {
  const parts = [];
  for (const { name, mode, data } of entries) {
    parts.push(header(name, mode, data.length), data, padding(data.length));
  }
  parts.push(Buffer.alloc(2 * BLOCK_BYTES));
  return Buffer.concat(parts);
}
