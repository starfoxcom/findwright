import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { canRun, fromRules, normalRule } from "../src/rules.mjs";
import { matchesAny } from "../src/store.mjs";

const folder = new URL("../plugin/skills/fit/reference/", import.meta.url);
const setOf = (file) => JSON.parse(readFileSync(new URL(file, folder), "utf8"));
const named = (file, path, text) =>
  fromRules(text, setOf(file).rules.filter((rule) => matchesAny(path, normalRule(rule).globs))).map((s) => s.name);

// Lines each set must name, and lines it must not read as a declaration, from ordinary code.
const samples = [
  ["dart: calls in a body are not declarations", "dart.json", "lib/a.dart",
    "void main() {\n  WidgetsFlutterBinding.ensureInitialized();\n  return compute(x);\n}", ["main"]],
  ["dart: a constructor in a class body", "dart.json", "lib/a.dart",
    "class Foo {\n  Foo(this.x);\n  final int x;\n}", ["Foo", "Foo.Foo"]],
  ["dart: an unnamed extension names its members only", "dart.json", "lib/a.dart",
    "extension on String {\n  int get size => length;\n}", ["size"]],
  ["c: a return in an inline body is not a member", "c-cpp.json", "a.h",
    "class A {\n  int f(int x);\n  int g() {\n    return clamp(x);\n  }\n};", ["A", "A::f"]],
  ["c: free functions with a qualified type", "c-cpp.json", "a.c",
    "const char *name(void) {\n}\nunsigned int count(void) {\n}\nstruct node *list_new(void) {\n}",
    ["name", "count", "list_new"]],
  ["c++: constructors and destructors at the line start", "c-cpp.json", "a.cpp",
    "Foo::Foo(int x) {\n}\nFoo::~Foo() {\n}", ["Foo::Foo", "Foo::~Foo"]],
  ["c++: a test macro is a test only", "c-cpp.json", "a_test.cc", "TEST_F(Fixture, Does)\n{\n}", ["Does"]],
  ["c: a function returning an enum is no enum", "c-cpp.json", "a.c",
    "enum color get_color(void) {\n}", ["get_color"]],
  ["c++: a qualified call at the line start is no method", "c-cpp.json", "a.cpp",
    "std::move(x);\nFoo::bar(int x) {\n}\nFoo::Foo() = default;", ["Foo::bar", "Foo::Foo"]],
  ["c++: locals in an inline body are no members", "c-cpp.json", "a.h",
    "class A {\n  void f(int x);\n  void g() {\n" +
      "    std::lock_guard<std::mutex> lock(mutex_);\n    Vec3 v(1, 2, 3);\n  }\n};",
    ["A", "A::f"]],
  ["markdown: a comment in front matter is no heading", "markdown.json", "a.md",
    "---\n# comment\ntitle: x\n---\n# Real", ["title", "Real"]],
];

for (const [name, file, path, text, expected] of samples) {
  test(`a reference set names what its description says: ${name}`, () => {
    assert.deepEqual(named(file, path, text), expected);
  });
}

test("every reference rule set says what it covers, and each of its rules can run", () => {
  const files = readdirSync(folder).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const set = JSON.parse(readFileSync(new URL(file, folder), "utf8"));
    assert.equal(typeof set.description, "string", file);
    assert.ok(Array.isArray(set.rules) && set.rules.length, file);
    set.rules.forEach((rule, i) => {
      assert.ok(canRun(rule), `${file} rule ${i} cannot run`);
      assert.ok(Array.isArray(rule.globs) && rule.globs.length, `${file} rule ${i} names no files`);
    });
  }
});
