---
name: fit
description: "Fit FindWright's index to this project: read what the repo holds, write the rules that name its functions, types, keys, headings and tests in .findwright/config.json, and check them. Use when a project has no config yet, when coverage shows files with no symbols, or when the hit rate falls short."
---

# /findwright:fit

FindWright knows no language by itself. It runs the rules in `.findwright/config.json`, and this skill is how a session writes them: look at what the repo holds, start from a reference rule set where one fits, write rules for the rest, try them on the repo, and save the file. The config is committed, so everyone who works on the project gets the same index.

`<helper>` is `$HOME/.findwright/helper/node_modules/findwright`, and `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`. Run every command from the repo root.

## 1. See what the repo holds

Run `node "<helper>/src/cli.mjs" coverage`. It lists every file the index holds and the ones that yield no symbol. Group those files by extension and count them, largest first. For each group, decide whether a search would look for something inside it:

- **Fit it:** code, docs, config and data the work reads by name (functions, classes, keys, headings, tests, translation keys, SQL tables, environment variables, shader entry points).
- **Leave it:** licenses, lock files, ignore lists, generated or minified files, vendored code, binaries. Full-text search still covers their text.

Read the project's own notes (`CLAUDE.md`, the README) for what the work searches for, such as a project's own templating or event names.

## 2. Start from a reference rule set

`<plugin>/skills/fit/reference/` holds rule sets for common languages, each with a `description` of what it names:

| File | Covers |
|---|---|
| `markdown.json` | `.md`, `.mdx` |
| `yaml.json` | `.yml`, `.yaml` |
| `json.json` | `.json`, `.jsonc` |
| `javascript-typescript.json` | `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.mts` |
| `python.json` | `.py` |
| `css.json` | `.css` |
| `html.json` | `.html`, `.htm` |
| `shell.json` | `.sh`, `.bash` |
| `c-cpp.json` | `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`, `.inl`, GoogleTest tests |
| `hlsl.json` | `.hlsl`, `.hlsli`, `.fx` |
| `dart.json` | `.dart`, Flutter tests |
| `gdscript.json` | `.gd` |

Copy the rules of each set the repo needs into a draft file in the session's scratch folder, and change their globs when the project keeps a kind of file under another name (a `.yml.template` read as YAML, say). They are starting points: change any rule that misnames this project's code.

## 3. Write rules for the rest

For a kind of file no reference set covers, open three to five typical files, list what a search would look for in them, and write one rule per thing:

```json
{ "globs": ["**/*.sql"], "kind": "table", "pattern": "^\\s*create\\s+table\\s+(?<name>\\w+)", "end": { "until": ";\\s*$" } }
```

- `pattern` is a regular expression run on each line; its `name` group names the symbol. When alternatives each hold the name, call them `name`, `name2`, `name3`.
- `kind` is the word a search filters by: `function`, `class`, `key`, `heading`, `test`.
- `end` gives the symbol its range, which `outline` and the search results show: `"brace"` for code in braces, `"indent"` for code by indentation (an `indent` group sets the depth), `"value"` for a JSON value, `"next"` for sections that run to the next heading of their level (a `level` group holds the `#` marks), `{ "until": "<regex>" }` for a closing line. Without it, the symbol is its one line.
- `nest`: `true`, or a separator such as `"::"`, names a symbol under the one that holds it (`jobs.review.steps`, `Grid::build`). Give it to every rule whose symbols hold others.
- `group`: rules in one group share each line, and the first in the list to match it takes it, so put the more specific rule first (a `const` holding an arrow function before a plain `const`).
- `except`: names to drop, such as `if`, `for` and `return` for a call-shaped pattern.
- `inside` and `outside`: regions a rule matches only within, or never in, such as front matter or code fences: `{ "start": "<regex>", "end": "indent" | { "until": "<regex>" } }`, covering the lines after the start line; `"first": true` holds only for a region on line 1.

Limits: patterns run on a linear-time engine, so back-references and lookarounds are not available (a rule that uses one is skipped); a pattern is at most 300 characters; a rule lists at most 8 `outside` regions; each line is read up to its first 1000 characters.

## 4. Try the draft

Run `node "<helper>/src/cli.mjs" try <draft file>`. It runs the draft over the repo without writing the config or touching the index, and prints, per kind, how many symbols it found with samples spread across the repo, the files the rules' globs match that still get no symbol, and the rules that cannot run.

- **Files still bare:** open a few and add or widen a rule, or leave them out of the globs when there is nothing to find.
- **Wrong names:** a keyword, a call or a variable named as a declaration. Tighten the pattern (anchor it, pin the indentation the project's formatter uses), or add the name to `except`.
- **Wrong ranges:** a block that runs too far or stops at its first line. Check the `end` and the `indent` group.

Try again until the samples read right and the bare files are the ones meant to stay bare.

## 5. Save it

Put the rules under `rules` in `.findwright/config.json`, next to any `include`, `exclude` or `goal` the file already has, and keep the rules already there unless they were the ones being fixed. Show the user what it covers in a few plain lines (which kinds of files gain symbols, how many files stay bare and why) and write it on a yes. The next FindWright call rebuilds the index with it. Run `coverage` again and say how many files gained symbols.
