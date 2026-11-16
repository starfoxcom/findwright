// Keeps secrets out of the index: files that hold secrets by nature are never indexed, and token
// shapes with a known prefix are masked in the text the index stores, so no search hands them back.

import { linearRegExp } from "./linear.mjs";

/** What a masked secret reads as in the index. */
export const MASK = "[masked]";

const SECRET_EXTENSIONS = new Set(["pem", "key", "p8", "p12", "pfx", "jks", "keystore", "ppk"]);
const SECRET_NAMES = new Set([
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", "_netrc", ".git-credentials", ".pgpass", ".htpasswd",
]);
// A name part that marks a file as a template of the secret one, such as `.env.example`.
const TEMPLATE_PARTS = new Set(["example", "sample", "template", "dist", "defaults"]);

/** True when `path` names a file that holds secrets by nature: an env file, a private key, a key store, credentials. */
export function isSecretFile(path) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const parts = name.split(".");
  if (parts.some((part) => TEMPLATE_PARTS.has(part))) return false;
  if (SECRET_NAMES.has(name) || path.toLowerCase().endsWith(".aws/credentials")) return true;
  const envFile = name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
  return envFile || (parts.length > 1 && SECRET_EXTENSIONS.has(parts.at(-1)));
}

// The linear engine takes repeat counts up to 16, so a longer run is written as chunks of 16.
function run(characters, length, { exact = false } = {}) {
  const chunks = `(?:${characters}{16})`.repeat(Math.floor(length / 16));
  return `${chunks}${characters}{${length % 16}${exact ? "" : ","}}`;
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
  [["sk-ant-", "sk-proj-"], String.raw`\bsk-(?:ant-|proj-)${run(URL_SAFE, 20)}`], // Anthropic, OpenAI
  [["npm_"], String.raw`\bnpm_${run(ALNUM, 36)}`],
  [["pypi-"], String.raw`\bpypi-AgEIcHlwaS5vcmc${run(URL_SAFE, 50)}`],
  [["hf_"], String.raw`\bhf_${run(ALNUM, 30)}`], // Hugging Face
  [["eyJ"], String.raw`\beyJ${run(URL_SAFE, 10)}\.eyJ${run(URL_SAFE, 10)}\.${run(URL_SAFE, 10)}`], // JSON web token
].map(([prefixes, source]) => ({ prefixes, pattern: linearRegExp(source, "g") }));
const KEY_BEGIN = linearRegExp("-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----");
const KEY_END = linearRegExp("-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----");

/** `text` with every known token shape and private key body replaced by MASK, on the same lines. */
export function maskSecrets(text) {
  let masked = maskKeyBlocks(text);
  for (const { prefixes, pattern } of TOKENS) {
    if (prefixes.some((prefix) => masked.includes(prefix))) masked = masked.replace(pattern, MASK);
  }
  return masked;
}

// A private key's body sits between its BEGIN and END lines, or between the two markers on one line
// when a config holds it with `\n` escapes. Each line keeps its place, so line numbers stay true.
function maskKeyBlocks(text) {
  if (!text.includes("PRIVATE KEY")) return text;
  let inside = false;
  return text.split("\n").map((line) => {
    let out = "";
    let rest = line;
    for (;;) {
      const marker = (inside ? KEY_END : KEY_BEGIN).exec(rest);
      if (!marker) return out + (inside && rest ? MASK : rest);
      const kept = rest.slice(0, marker.index);
      out += (inside && kept ? MASK : kept) + marker[0];
      rest = rest.slice(marker.index + marker[0].length);
      inside = !inside;
    }
  }).join("\n");
}
