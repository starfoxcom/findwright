import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSecretFile, MASK, maskSecrets } from "../src/secrets.mjs";
import { openIndex, refresh } from "../src/store.mjs";
import { search } from "../src/query.mjs";

// Token-shaped values are assembled at run time, so the repo itself holds none for a scanner to flag.
const fake = {
  aws: "AKIA" + "Q".repeat(16),
  github: "gh" + "p_" + "a1".repeat(18),
  githubFineGrained: "github" + "_pat_" + "h2".repeat(30),
  gitlab: "gl" + "pat-" + "i".repeat(20),
  slack: "xo" + "xb-" + "1234567890-abcdef",
  slackWebhook: "https://hooks.slack.com" + "/services/T000/B000/XXXX",
  stripe: "sk" + "_live_" + "b2".repeat(12),
  google: "AI" + "za" + "c".repeat(35),
  anthropic: "sk-" + "ant-" + "d".repeat(40),
  openai: "sk-" + "proj-" + "j".repeat(40),
  openaiServiceAccount: "sk-" + "svcacct-" + "j".repeat(40),
  npm: "np" + "m_" + "k".repeat(36),
  pypi: "pypi-" + "AgEIcHlwaS5vcmc" + "l".repeat(60),
  huggingFace: "h" + "f_" + "m".repeat(34),
  jwt: ["eyJ" + "e".repeat(20), "eyJ" + "f".repeat(20), "g".repeat(20)].join("."),
};
const keyLine = "MIIEowIBAAKCAQEA" + "x9Yb".repeat(12);
const keyHeader = (edge) => `-----${edge} RSA ` + "PRIVATE KEY-----";

test("files that hold secrets by nature are told apart from their templates and from code", () => {
  const cases = [
    [".env", true], ["config/.env.local", true], ["deploy/production.env", true],
    ["certs/server.pem", true], ["keys/signing.key", true], ["android/release.jks", true],
    ["home/.ssh/id_ed25519", true], [".netrc", true], [".aws/credentials", true],
    [".env.dist.local", true], ["certs/prod.defaults.pem", true],
    [".env.example", false], ["config/.env.sample", false], ["example.env", false],
    ["src/env.ts", false], ["src/environment.mjs", false], ["home/.ssh/id_ed25519.pub", false],
    ["docs/keys.md", false], ["key", false],
  ];
  for (const [path, expected] of cases) assert.equal(isSecretFile(path), expected, path);
});

test("each known token shape is masked where it sits, and the rest of the line stays", () => {
  for (const [name, token] of Object.entries(fake)) {
    assert.equal(maskSecrets(`key = "${token}" # ${name}`), `key = "${MASK}" # ${name}`, name);
  }
  assert.equal(maskSecrets("token = ghp_short"), "token = ghp_short");
});

test("a private key body is masked, and the code around a quoted marker is not", () => {
  const cases = [
    ["a block, line by line",
      [keyHeader("BEGIN"), keyLine, "x9Yb2==", keyHeader("END"), "after"],
      [keyHeader("BEGIN"), MASK, MASK, keyHeader("END"), "after"]],
    ["an encrypted block with armor headers",
      [keyHeader("BEGIN"), "Proc-Type: 4,ENCRYPTED", "", keyLine, keyHeader("END")],
      [keyHeader("BEGIN"), MASK, "", MASK, keyHeader("END")]],
    ["a block with Windows line ends",
      [keyHeader("BEGIN") + "\r", keyLine + "\r", keyHeader("END") + "\r"],
      [keyHeader("BEGIN") + "\r", MASK + "\r", keyHeader("END") + "\r"]],
    ["a key on one line, written with escapes",
      [`{"key": "${keyHeader("BEGIN")}\\n${keyLine}\\n${keyHeader("END")}\\n", "id": 1}`],
      [`{"key": "${keyHeader("BEGIN")}${MASK}${keyHeader("END")}\\n", "id": 1}`]],
    ["an indented block in YAML",
      ["tls.key: |", `  ${keyHeader("BEGIN")}`, `  ${keyLine}`, "  x9Yb2==", `  ${keyHeader("END")}`, "name: web"],
      ["tls.key: |", `  ${keyHeader("BEGIN")}`, `  ${MASK}`, `  ${MASK}`, `  ${keyHeader("END")}`, "name: web"]],
    ["a block built by string concatenation",
      [`const pem = "${keyHeader("BEGIN")}\\n" +`, `  "${keyLine}\\n" +`, `  "${keyHeader("END")}";`],
      [`const pem = "${keyHeader("BEGIN")}${MASK}`, `  ${MASK}`, `  ${MASK}${keyHeader("END")}";`]],
    ["a key escaped twice, as JSON inside JSON",
      [`"{\\"key\\": \\"${keyHeader("BEGIN")}\\\\n${keyLine}\\\\n${keyHeader("END")}\\"}"`],
      [`"{\\"key\\": \\"${keyHeader("BEGIN")}${MASK}${keyHeader("END")}\\"}"`]],
    ["a key whose slashes are escaped, as PHP writes JSON",
      [`{"key":"${keyHeader("BEGIN")}\\n${keyLine.slice(0, 30)}\\/${keyLine.slice(30)}\\n${keyHeader("END")}"}`],
      [`{"key":"${keyHeader("BEGIN")}${MASK}${keyHeader("END")}"}`]],
    ["a key flattened onto one line with spaces",
      [`KEY="${keyHeader("BEGIN")} ${keyLine.slice(0, 32)} ${keyLine.slice(32)} ${keyHeader("END")}"`],
      [`KEY="${keyHeader("BEGIN")} ${MASK}${keyHeader("END")}"`]],
    ["a marker quoted in code",
      [`if (!pem.includes("${keyHeader("BEGIN")}")) throw new Error("bad key");`, "return pem;"],
      [`if (!pem.includes("${keyHeader("BEGIN")}")) throw new Error("bad key");`, "return pem;"]],
    ["both markers quoted as constants, with code between them",
      [`  begin: "${keyHeader("BEGIN")}",`, `  end: "${keyHeader("END")}",`, `  label: "pem",`],
      [`  begin: "${keyHeader("BEGIN")}",`, `  end: "${keyHeader("END")}",`, `  label: "pem",`]],
    ["a marker in a scanner rule, then the rule's fields",
      [`- pattern: "${keyHeader("BEGIN")}"`, "  message: Private key found", "  severity: high"],
      [`- pattern: "${keyHeader("BEGIN")}"`, "  message: Private key found", "  severity: high"]],
  ];
  for (const [name, lines, expected] of cases) assert.equal(maskSecrets(lines.join("\n")), expected.join("\n"), name);
});

test("real keys are masked whole, as a file, indented in YAML and inside JSON", () => {
  const keys = {
    "Ed25519 in PKCS#8": generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
    "encrypted RSA": generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey
      .export({ type: "pkcs1", format: "pem", cipher: "aes-128-cbc", passphrase: "test" }),
  };
  for (const [name, pem] of Object.entries(keys)) {
    const body = pem.split("\n").filter((line) => line && !line.startsWith("-----") && !line.includes(":"));
    const forms = {
      file: pem,
      yaml: "tls.key: |\n" + pem.split("\n").map((line) => `  ${line}`).join("\n"),
      json: JSON.stringify({ key: pem }),
    };
    for (const [form, text] of Object.entries(forms)) {
      const masked = maskSecrets(text);
      assert.deepEqual(body.filter((line) => masked.includes(line)), [], `${name} as ${form}`);
      assert.equal(masked.split("\n").length, text.split("\n").length, `${name} as ${form} keeps its lines`);
    }
  }
});

test("masking a hostile file costs time in proportion to its size", () => {
  const hostile = (copies) => ("eyJ" + "a".repeat(10) + "-").repeat(copies) + keyHeader("BEGIN").repeat(copies / 8);
  const timed = (text) => {
    const start = performance.now();
    maskSecrets(text);
    return performance.now() - start;
  };
  const [small, large] = [hostile(20_000), hostile(80_000)];
  timed(small);
  const ratio = timed(large) / Math.max(timed(small), 1);
  // Four times the input: about 4 when linear, about 16 when quadratic.
  assert.ok(ratio < 9, `four times the input took ${ratio.toFixed(1)} times as long`);
});

test("the index skips secret files and stores masked text, so search hands back no secret", () => {
  const root = mkdtempSync(join(tmpdir(), "findwright-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".env"), "API_SECRET=hunter2\n");
  writeFileSync(join(root, ".env.example"), "API_SECRET=\n");
  writeFileSync(join(root, "src", "client.mjs"), `const a = 1;\nconst token = "${fake.github}";\n`);
  const db = openIndex(root);
  refresh(db, root);
  const paths = (pattern) => search(db, { patterns: [pattern] }).files.map((f) => f.path);
  assert.deepEqual(paths("API_SECRET"), [".env.example"]);
  assert.deepEqual(paths(fake.github), []);
  const [hit] = search(db, { patterns: ["const token"] }).files;
  assert.deepEqual(hit.hits.map((h) => [h.line, h.text]), [[2, `const token = "${MASK}";`]]);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const secret = "hunter2-" + "sentinel".repeat(8);

// A repo holding the secret in one file among many, indexed once.
function indexedRepo() {
  const root = mkdtempSync(join(tmpdir(), "findwright-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "notes.txt"), `password ${secret}\n` + "filler line\n".repeat(200));
  for (let i = 0; i < 60; i++) writeFileSync(join(root, `f${i}.txt`), `line ${i} of other text\n`.repeat(150));
  const db = openIndex(root);
  refresh(db, root);
  return { root, db };
}

function indexHolds(root, text) {
  const file = join(root, ".findwright", "index.db");
  return [file, `${file}-wal`].some((path) => existsSync(path) && readFileSync(path).includes(text));
}

test("a file re-read with new text leaves no copy of the old text in the index or its log", () => {
  const { root, db } = indexedRepo();
  writeFileSync(join(root, "notes.txt"), "now clean\n");
  refresh(db, root);
  assert.equal(indexHolds(root, secret), false);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// The index as an older copy leaves it: its text deleted without being wiped.
function oldIndex() {
  const { root, db } = indexedRepo();
  db.exec("PRAGMA secure_delete = OFF; INSERT INTO body(body, rank) VALUES ('secure-delete', 0);");
  db.exec("DELETE FROM body WHERE path = 'notes.txt'");
  db.close();
  writeFileSync(join(root, "notes.txt"), "now clean\n");
  return root;
}

test("an index built without the wipe loses the text it freed at its next refresh", () => {
  const root = oldIndex();
  assert.equal(indexHolds(root, secret), true, "the old index keeps the freed text");
  const db = openIndex(root);
  refresh(db, root);
  assert.equal(indexHolds(root, secret), false);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("an old index opens while another process holds its write lock", () => {
  const root = oldIndex();
  const other = new DatabaseSync(join(root, ".findwright", "index.db"));
  other.exec("BEGIN IMMEDIATE");
  const db = openIndex(root);
  db.close();
  other.exec("ROLLBACK");
  other.close();
  rmSync(root, { recursive: true, force: true });
});

test("a log another reader kept from emptying is emptied at the next refresh", () => {
  const { root, db } = indexedRepo();
  const reader = new DatabaseSync(join(root, ".findwright", "index.db"));
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM files").get();
  writeFileSync(join(root, "notes.txt"), "now clean\n");
  refresh(db, root);
  assert.equal(indexHolds(root, secret), true, "the blocked log keeps the old text");
  reader.exec("COMMIT");
  reader.close();
  refresh(db, root);
  assert.equal(indexHolds(root, secret), false);
  db.close();
  rmSync(root, { recursive: true, force: true });
});
