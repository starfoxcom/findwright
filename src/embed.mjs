// Meaning-based search with a static code embedding model (Model2Vec's
// potion-code-16M-v2): a text's vector is the mean of its tokens' rows in one
// table, so no inference runtime is needed. The model is downloaded once from a
// pinned revision, checked against pinned SHA-256 sums, and kept in memory as
// int8 rows with one scale each (16 MB).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODEL = {
  name: "potion-code-16M-v2",
  base: "https://huggingface.co/minishlab/potion-code-16M-v2/resolve/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b/",
  files: {
    "model.safetensors": "75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c",
    "tokenizer.json": "107bbdcbad4bff1d299b7a4c3a2fb17c52890688b7dd0e4c9deab79d3c4f3d45",
  },
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const modelsDir = () => process.env.FINDWRIGHT_MODELS ?? join(homedir(), ".cache", "findwright", "models");

/** The model folder when every file is there and matches its pinned SHA-256, else null. */
export function installedModel(dir = modelsDir()) {
  const folder = join(dir, MODEL.name);
  const intact = Object.entries(MODEL.files).every(([file, sum]) => {
    const target = join(folder, file);
    return existsSync(target) && sha256(readFileSync(target)) === sum;
  });
  return intact ? folder : null;
}

/** The model folder, downloading and checking each file the first time. */
export async function ensureModel(dir = modelsDir()) {
  const folder = join(dir, MODEL.name);
  mkdirSync(folder, { recursive: true });
  for (const [file, sum] of Object.entries(MODEL.files)) {
    const target = join(folder, file);
    if (existsSync(target) && sha256(readFileSync(target)) === sum) continue;
    const response = await fetch(MODEL.base + file);
    if (!response.ok) throw new Error(`Downloading ${file} failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== sum) throw new Error(`${file} does not match its pinned SHA-256; refusing it`);
    writeFileSync(`${target}.part`, bytes);
    renameSync(`${target}.part`, target);
  }
  return folder;
}

function halfToFloat(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

// The embedding table as int8 rows, each with its own scale.
function readTable(path) {
  const bytes = readFileSync(path);
  const headerLength = Number(bytes.readBigUInt64LE(0));
  const { embeddings } = JSON.parse(bytes.subarray(8, 8 + headerLength).toString("utf8"));
  if (embeddings?.dtype !== "F16") throw new Error("Expected a float16 embedding table");
  const [rows, dims] = embeddings.shape;
  const start = 8 + headerLength + embeddings.data_offsets[0];
  const halves = new Uint16Array(bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + start + rows * dims * 2));
  const values = new Int8Array(rows * dims);
  const scales = new Float32Array(rows);
  const row = new Float32Array(dims);
  for (let r = 0; r < rows; r++) {
    let max = 0;
    for (let d = 0; d < dims; d++) {
      row[d] = halfToFloat(halves[r * dims + d]);
      max = Math.max(max, Math.abs(row[d]));
    }
    scales[r] = max / 127 || 1;
    for (let d = 0; d < dims; d++) values[r * dims + d] = Math.round(row[d] / scales[r]);
  }
  return { values, scales, dims };
}

const isPunctuation = (ch) => /[\p{P}\p{S}]/u.test(ch);

// BERT's normalizer and pre-tokenizer: drop control characters, lower-case,
// strip accents, split on whitespace and around every punctuation mark.
function words(text) {
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/g, "")
    .toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "");
  const out = [];
  for (const part of clean.split(/\s+/)) {
    let word = "";
    for (const ch of part) {
      if (isPunctuation(ch)) {
        if (word) out.push(word);
        out.push(ch);
        word = "";
      } else word += ch;
    }
    if (word) out.push(word);
  }
  return out;
}

/** Loads the model from its folder; `encode(text)` gives a unit-length Float32Array. */
export function loadModel(folder) {
  const tokenizer = JSON.parse(readFileSync(join(folder, "tokenizer.json"), "utf8")).model;
  const vocab = new Map(Object.entries(tokenizer.vocab));
  const prefix = tokenizer.continuing_subword_prefix;
  const { values, scales, dims } = readTable(join(folder, "model.safetensors"));
  const cache = new Map();

  // WordPiece: longest known piece first; a word with an unknown piece adds nothing.
  function pieces(word) {
    if (cache.has(word)) return cache.get(word);
    const ids = [];
    let start = 0;
    while (word.length <= tokenizer.max_input_chars_per_word && start < word.length) {
      let end = word.length;
      let id;
      for (; end > start; end--) {
        id = vocab.get((start > 0 ? prefix : "") + word.slice(start, end));
        if (id !== undefined) break;
      }
      if (end === start) { ids.length = 0; break; }
      ids.push(id);
      start = end;
    }
    if (cache.size < 200_000) cache.set(word, ids);
    return ids;
  }

  function encode(text) {
    const sum = new Float32Array(dims);
    let count = 0;
    for (const word of words(text)) {
      for (const id of pieces(word)) {
        const scale = scales[id];
        for (let d = 0, o = id * dims; d < dims; d++) sum[d] += values[o + d] * scale;
        count++;
      }
    }
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += sum[d] * sum[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) sum[d] /= norm;
    return count ? sum : null;
  }

  return { encode, dims };
}

/** A unit vector as int8 bytes for storage, and back. */
export function packVector(v) {
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)));
  return Buffer.from(out.buffer);
}

export function dot(query, packed) {
  const v = new Int8Array(packed.buffer, packed.byteOffset, packed.byteLength);
  let s = 0;
  for (let i = 0; i < v.length; i++) s += query[i] * v[i];
  return s / 127;
}
