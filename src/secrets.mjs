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

// A private key is a BEGIN marker, its body and an END marker, the way secret scanners read it.
// The key type in a marker (`RSA `, `ENCRYPTED `, `OPENSSH `) is at most 24 characters.
const MARKER = (edge) => compile(`^-----${edge} [A-Z0-9 ]{0,16}[A-Z0-9 ]{0,8}PRIVATE KEY(?: BLOCK)?-----`);
const KEY_BEGIN = { text: "-----BEGIN ", pattern: MARKER("BEGIN") };
const KEY_END = { text: "-----END ", pattern: MARKER("END") };
const MARKER_MAX = 64;
// The largest key body read (a 16384-bit RSA key in PEM is about 12 KB).
const BODY_MAX = 64 * 1024;
// The smallest real key body (Ed25519 in PKCS#8) holds 64 base64 characters.
const BODY_MIN = 64;
// What code wraps a key body in: armor headers, escaped line breaks, quotes, concatenation, indentation.
const QUOTES = "[\"'`]";
const ARMOR_HEADERS = compile(String.raw`(?:^|\n)[ \t]*[A-Za-z-]+: [^\n]*`, "g");
const LINE_ESCAPES = compile(String.raw`\\+[nr]`, "g");
const SLASH_ESCAPES = compile(String.raw`\\+/`, "g");
// A `+` joins strings only next to a quote; inside a key body it is base64.
const CONCATENATION = compile(String.raw`${QUOTES}[ \t]*\+|\+[ \t]*${QUOTES}`, "g");
const WRAPPING = compile(String.raw`[\s,;]|${QUOTES}`, "g");
const BASE64_RUN = compile("^[A-Za-z0-9+/=]+$");

/** `text` with every known token shape and private key body replaced by MASK, on the same lines. */
export function maskSecrets(text) {
  let masked = text.includes("PRIVATE KEY") ? maskKeyBlocks(text) : text;
  for (const { prefixes, pattern } of TOKENS) {
    if (prefixes.some((prefix) => masked.includes(prefix))) masked = masked.replace(pattern, MASK);
  }
  return masked;
}

// Masks the text between each BEGIN marker and the END marker after it when that text is a key body.
// A marker with no END before the next BEGIN masks nothing, so code that quotes a marker keeps its text.
// Spans never overlap and each END search starts past the last one, so a file is read in linear time.
function maskKeyBlocks(text) {
  const pieces = [];
  let from = 0;
  let end = null;
  let begin = nextMarker(text, KEY_BEGIN, 0);
  while (begin) {
    const next = nextMarker(text, KEY_BEGIN, begin.end);
    if (!end || end.at < begin.end) end = nextMarker(text, KEY_END, begin.end);
    if (!end) break;
    const closes = (!next || end.at < next.at) && end.at - begin.end <= BODY_MAX;
    const body = closes ? text.slice(begin.end, end.at) : "";
    if (closes && isKeyBody(body)) {
      pieces.push(text.slice(from, begin.end), maskLines(body));
      from = end.at;
    }
    begin = next;
  }
  pieces.push(text.slice(from));
  return pieces.join("");
}

// The next marker at or after `from`, found with indexOf and checked on a short slice.
function nextMarker(text, marker, from) {
  for (let at = text.indexOf(marker.text, from); at >= 0; at = text.indexOf(marker.text, at + 1)) {
    const found = marker.pattern.exec(text.slice(at, at + MARKER_MAX));
    if (found) return { at, end: at + found[0].length };
  }
  return null;
}

// True when `body`, once its armor headers and the wrapping code puts around a key are taken out,
// is one run of base64 long enough to be a key.
function isKeyBody(body) {
  const bare = body.replace(LINE_ESCAPES, "\n").replace(ARMOR_HEADERS, "").replace(SLASH_ESCAPES, "/")
    .replace(CONCATENATION, "").replace(WRAPPING, "");
  return bare.length >= BODY_MIN && BASE64_RUN.test(bare);
}

// Each line of the span becomes MASK after its indent, so line numbers stay true.
function maskLines(body) {
  return body.split("\n").map((line) => {
    const indent = line.length - line.trimStart().length;
    const cr = line.endsWith("\r") ? "\r" : "";
    return line.trim() === "" ? line : line.slice(0, indent) + MASK + cr;
  }).join("\n");
}
