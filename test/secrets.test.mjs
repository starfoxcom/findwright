import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSecretFile, MASK, maskSecrets } from "../src/secrets.mjs";
import { openIndex, refresh } from "../src/store.mjs";
import { search } from "../src/query.mjs";

// Token-shaped values are assembled at run time, so the repo itself holds none for a scanner to flag.
const fake = {
  aws: "AKIA" + "Q".repeat(16),
  github: "gh" + "p_" + "a1".repeat(18),
  stripe: "sk" + "_live_" + "b2".repeat(12),
  google: "AI" + "za" + "c".repeat(35),
  anthropic: "sk-" + "ant-" + "d".repeat(40),
  jwt: ["eyJ" + "e".repeat(20), "eyJ" + "f".repeat(20), "g".repeat(20)].join("."),
};
const keyHeader = (edge) => `-----${edge} RSA ` + "PRIVATE KEY-----";

test("files that hold secrets by nature are told apart from their templates and from code", () => {
  const cases = [
    [".env", true], ["config/.env.local", true], ["deploy/production.env", true],
    ["certs/server.pem", true], ["keys/signing.key", true], ["android/release.jks", true],
    ["home/.ssh/id_ed25519", true], [".netrc", true], [".aws/credentials", true],
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

test("a private key body is masked line by line, and on one line when written with escapes", () => {
  const block = [keyHeader("BEGIN"), "MIIEowIBAAKCAQEA", "x9Yb2", keyHeader("END"), "after"].join("\n");
  assert.equal(maskSecrets(block), [keyHeader("BEGIN"), MASK, MASK, keyHeader("END"), "after"].join("\n"));
  const escaped = `{"key": "${keyHeader("BEGIN")}\\nMIIE\\n${keyHeader("END")}\\n", "id": 1}`;
  assert.equal(maskSecrets(escaped), `{"key": "${keyHeader("BEGIN")}${MASK}${keyHeader("END")}\\n", "id": 1}`);
});

test("masking a hostile file stays linear in its size", () => {
  const hostile = ("eyJ" + "a".repeat(10) + "-").repeat(150_000) + keyHeader("BEGIN").repeat(20_000);
  const start = performance.now();
  maskSecrets(hostile);
  assert.ok(performance.now() - start < 2000, `took ${Math.round(performance.now() - start)} ms`);
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

test("a file that leaves the index leaves no copy of its text in the index file", () => {
  const root = mkdtempSync(join(tmpdir(), "findwright-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const secret = "hunter2-" + "sentinel".repeat(8);
  writeFileSync(join(root, "notes.txt"), `password ${secret}\n` + "filler line\n".repeat(200));
  for (let i = 0; i < 60; i++) writeFileSync(join(root, `f${i}.txt`), `line ${i} of other text\n`.repeat(150));
  let db = openIndex(root);
  refresh(db, root);
  db.close();
  writeFileSync(join(root, "notes.txt"), "now clean\n");
  db = openIndex(root);
  refresh(db, root);
  db.close();
  assert.ok(!readFileSync(join(root, ".findwright", "index.db")).includes(secret));
  rmSync(root, { recursive: true, force: true });
});
