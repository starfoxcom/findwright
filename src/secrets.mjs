// Keeps secrets out of the index: files that hold secrets by nature are never indexed, and token
// shapes with a known prefix are masked in the text the index stores, so no search hands them back.

import { linearRegExp } from "./linear.mjs";

/** What a masked secret reads as in the index. */
export const MASK = "[masked]";

const SECRET_EXTENSIONS = new Set(["pem", "key", "p8", "p12", "pfx", "jks", "keystore", "ppk"]);
const SECRET_NAMES = new Set([
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", "_netrc", ".git-credentials", ".pgpass", ".htpasswd",
]);
// A last name part that marks a template of the secret file, such as `.env.example` or `example.env`.
const TEMPLATE_PARTS = new Set(["example", "sample", "template", "dist", "defaults"]);

/** True when `path` names a file that holds secrets by nature: an env file, a private key, a key store, credentials. */
export function isSecretFile(path) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const parts = name.split(".");
  if (SECRET_NAMES.has(name) || path.toLowerCase().endsWith(".aws/credentials")) return true;
  const envFile = name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
  if (envFile) return !TEMPLATE_PARTS.has(parts.at(-1)) && !(name.endsWith(".env") && TEMPLATE_PARTS.has(parts[0]));
  return parts.length > 1 && SECRET_EXTENSIONS.has(parts.at(-1));
}

// The linear engine takes repeat counts up to 16, so a longer run is written as chunks of 16.
function run(characters, length, { exact = false } = {}) {
  const chunks = `(?:${characters}{16})`.repeat(Math.floor(length / 16));
  return `${chunks}${characters}{${length % 16}${exact ? "" : ","}}`;
}

function compile(source, flags = "") {
  const pattern = linearRegExp(source, flags);
  if (!pattern) throw new Error(`The secret pattern ${source} does not run on the linear engine.`);
  return pattern;
}

const ALNUM = "[A-Za-z0-9]";
const URL_SAFE = "[A-Za-z0-9_-]";
// Each shape runs only on text holding one of its literal prefixes, which most files lack.
const TOKENS = [
  [["AKIA", "ASIA", "ABIA", "ACCA"], String.raw`\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b`], // AWS access key id
  [["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], String.raw`\bgh[pousr]_${run(ALNUM, 36)}`], // GitHub
  [["github_pat_"], String.raw`\bgithub_pat_${run("[A-Za-z0-9_]", 22)}`],
  [["glpat-"], String.raw`\bglpat-${run(URL_SAFE, 20)}`], // GitLab
  [["xox"], String.raw`\bxox[abposr]-${run("[A-Za-z0-9-]", 10)}`], // Slack
  [["hooks.slack.com/services/"], String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+`],
  [["k_live_", "k_test_"], String.raw`\b[sr]k_(?:live|test)_${run(ALNUM, 16)}`], // Stripe
  [["AIza"], String.raw`\bAIza${run(URL_SAFE, 35, { exact: true })}`], // Google
  [["sk-ant-", "sk-proj-", "sk-svcacct-", "sk-admin-"],
    String.raw`\bsk-(?:ant-|proj-|svcacct-|admin-)${run(URL_SAFE, 20)}`], // Anthropic, OpenAI
  [["npm_"], String.raw`\bnpm_${run(ALNUM, 36)}`],
  [["pypi-"], String.raw`\bpypi-AgEIcHlwaS5vcmc${run(URL_SAFE, 50)}`],
  [["hf_"], String.raw`\bhf_${run(ALNUM, 30)}`], // Hugging Face
  [["eyJ"], String.raw`\beyJ${run(URL_SAFE, 10)}\.eyJ${run(URL_SAFE, 10)}\.${run(URL_SAFE, 10)}`], // JSON web token
].map(([prefixes, source]) => ({ prefixes, pattern: compile(source, "g") }));

const BEGIN = "-----BEGIN ";
// The longest BEGIN marker read: its key type (`RSA `, `ENCRYPTED `, `OPENSSH `) is at most 24 characters.
const MARKER_MAX = 64;
const KEY_BEGIN = compile("^-----BEGIN [A-Z0-9 ]{0,16}[A-Z0-9 ]{0,8}PRIVATE KEY(?: BLOCK)?-----");
const BASE64 = /^[A-Za-z0-9+/=]$/;
// A body line: a base64 run, with the indent, quotes, concatenation and `\n` escapes code wraps it in.
const QUOTES = "\"'`";
const WRAP_AFTER = String.raw`(?:\\+[nr]|[\s${QUOTES}+,;])*`;
const BODY_LINE = compile(String.raw`^([\s${QUOTES}+,]*)([A-Za-z0-9+/=]+)(${WRAP_AFTER})$`);
const WRAPPING = compile(`^${WRAP_AFTER}$`);
const ARMOR_HEADER = compile(String.raw`^(\s*)[A-Za-z-]+: .*$`);
// A real key's first body line is a full line of base64 (64 characters in PEM and PGP armor).
const FIRST_BODY_LINE = 40;

/** `text` with every known token shape and private key body replaced by MASK, on the same lines. */
export function maskSecrets(text) {
  let masked = text.includes("PRIVATE KEY") ? maskKeyBlocks(text) : text;
  for (const { prefixes, pattern } of TOKENS) {
    if (prefixes.some((prefix) => masked.includes(prefix))) masked = masked.replace(pattern, MASK);
  }
  return masked;
}

// A block opens at a BEGIN marker whose line ends there, and stays open over armor headers, blank
// lines and base64 lines; it closes at the first other line, so a BEGIN marker quoted in code
// masks nothing after it. Masking keeps the line breaks, so line numbers stay true.
function maskKeyBlocks(text) {
  let block = null;
  return text.split("\n").map((line) => {
    const content = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (block) {
      const cr = line.slice(content.length);
      if (content.trim() === "") return line;
      const header = !block.started && ARMOR_HEADER.exec(content);
      if (header) return header[1] + MASK + cr;
      const body = BODY_LINE.exec(content);
      if (body && (block.started || body[2].length >= FIRST_BODY_LINE)) {
        block.started = true;
        return body[1] + MASK + body[3] + cr;
      }
      block = null;
    }
    const { masked, opens } = maskBodiesAfterMarkers(line, content.length);
    if (opens) block = { started: false };
    return masked;
  }).join("\n");
}

// Masks the base64 run after each BEGIN marker on one line; `opens` when the line's content ends at a marker.
// Markers are found with indexOf and checked on a short slice, so a line packed with them stays linear.
function maskBodiesAfterMarkers(line, contentEnd) {
  const pieces = [];
  let from = 0;
  let lastBodyless = -1;
  let at = line.indexOf(BEGIN);
  while (at >= 0) {
    const marker = KEY_BEGIN.exec(line.slice(at, at + MARKER_MAX));
    if (marker) {
      const end = at + marker[0].length;
      const body = keyBody(line, end);
      pieces.push(line.slice(from, end), body.base64 ? MASK : "");
      from = body.base64 ? body.end : end;
      lastBodyless = body.base64 ? -1 : end;
    }
    at = line.indexOf(BEGIN, marker ? from : at + 1);
  }
  pieces.push(line.slice(from));
  // The block goes on to the next lines when only quotes, escapes or concatenation follow the last marker.
  const opens = lastBodyless >= 0 && WRAPPING.test(line.slice(lastBodyless, contentEnd));
  return { masked: pieces.join(""), opens };
}

// The run of base64 characters and `\n` or `\r` escapes (`\\n` when escaped twice) starting at `start`:
// where it ends, and whether it holds any base64, since escapes alone are no key.
function keyBody(line, start) {
  let i = start;
  let base64 = false;
  for (;;) {
    if (BASE64.test(line[i] ?? "")) {
      i += 1;
      base64 = true;
      continue;
    }
    let slashes = i;
    while (line[slashes] === "\\") slashes += 1;
    if (slashes === i || (line[slashes] !== "n" && line[slashes] !== "r")) return { end: i, base64 };
    i = slashes + 1;
  }
}
