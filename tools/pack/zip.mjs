// Zip with stored entries only, fixed 1980-01-01 dates and no extra fields, so the
// bytes depend on the entries alone.

import { crc32 } from "node:zlib";

const VERSION_20 = 20;
// DOS date for 1980-01-01: year 0 (1980), month 1, day 1.
const DOS_DATE_1980_01_01 = (1 << 5) | 1;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;

function localHeader(name, data) {
  const header = Buffer.alloc(LOCAL_HEADER_BYTES);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(VERSION_20, 4);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

function centralHeader(name, data, localOffset) {
  const header = Buffer.alloc(CENTRAL_HEADER_BYTES);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(VERSION_20, 4);
  header.writeUInt16LE(VERSION_20, 6);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(localOffset, 42);
  return Buffer.concat([header, name]);
}

function endRecord(count, centralSize, centralOffset) {
  const record = Buffer.alloc(END_RECORD_BYTES);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  return record;
}

/** A zip of `entries` ({ name, data }) in the order given. */
export function zipArchive(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const local = localHeader(nameBytes, data);
    locals.push(local, data);
    centrals.push(centralHeader(nameBytes, data, offset));
    offset += local.length + data.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, endRecord(entries.length, central.length, offset)]);
}
