# FindWright: design

Started as a Bindwright prototype (starfoxcom/bindwright#766); the code now lives in `src/`. The measurements below were taken on the Bindwright repo.

## Problem

The code-research tool Bindwright installed before FindWright parses a fixed list of languages. In the Bindwright repo 173 of 429 tracked files (Markdown skills and rules, YAML workflows, JSON settings, `.template` files, CSS, HTML) are indexed with no symbols, and its literal search takes one exact substring with no regex. Sessions fall back to plain grep for 43% to 63% of their code searches. Replaying 130 of those fallbacks sorted them into five groups: mixed file kinds in one search, literal strings with no symbol behind them, regex (alternation, context lines, globs), files outside the index, and a search chained in a shell call.

## Shape

- **One SQLite file per project** (`.findwright/index.db`, git-ignored), through the runtime's own SQLite (`node:sqlite`, no dependency):
  - `files`: path, size, modified time, kind, symbol count.
  - `body`: an FTS5 table with the trigram tokenizer holding each file's text. It shortlists the files a regex can match: the longest literal of each top-level branch, skipping lookarounds, optional groups and groups with several branches. The regex then runs only on the shortlist.
  - `symbols`: name, kind, path, first and last line.
- **Fresh on every call.** Each call stats the file list (`git ls-files -co --exclude-standard` plus the config's `include`) and re-reads files whose size or modified time changed. A full build of this repo takes about 1.3 s; a call with nothing changed takes about 40 ms.
- **No built-in languages.** Every symbol comes from the project's rules. The plugin's fit skill writes them: it reads what the repo holds, starts from reference rule sets (Markdown, YAML, JSON, JavaScript and TypeScript, Python, CSS, HTML, shell, C and C++, HLSL, Dart, GDScript) and writes rules for the rest, so a new language needs no FindWright release.
- **The per-project part: `.findwright/config.json`**, committed, written by the session after it scans the repo:
  - `include`: git-ignored files the work reads (generated typings).
  - `exclude`: files to leave out.
  - `rules`: regexes whose `name` group names a symbol of a project kind (i18n text keys, template placeholders, toggles, SQL tables, environment variables). A rule can also say where its block ends (a brace, a JSON value, indentation, the next heading, or a closing pattern), nest its symbols into paths, share lines with other rules in a group, and match only inside or outside regions such as front matter and code fences, with their range and path.
- **The adapting loop.** At project setup the session runs `coverage`, reads which file types and files yield no symbol, and adds rules until every file it cares about has structure. At each session's close, `findwright hits` scores its searches against the files the session opened next, and when three sessions in a row fall short of the goal, `findwright assess` names the causes and the config changes that fix them.

## Tools (MCP, stdio)

- `find`: a plain-English question, a name, or both. Ranks every file by rare-word matches in names, paths and text, plus meaning from a static code embedding model (a 32 MB download, no inference runtime), and returns the best files first.
- `search`: regexes (several at once, OR or `all`), globs, context lines, case flag, limit. Output reads like `grep -n`, grouped by file, and each hit names its enclosing symbol.
- `symbols`: by name (regex or substring), kind and glob; exact names first.
- `outline`: one file's symbols with line ranges.
- `coverage`: files per type and the files with no symbol.

## Where it runs

- **As a plugin with a helper.** `docs/PLUGIN.md` covers the shape: the plugin's skills install the helper into `~/.findwright/helper` and register `src/server.mjs` once for the user. It needs Node 22.16 or later, or Node 24 and up, for `node:sqlite` with full-text search.
- **The search hook** (`hooks/findwright-first.mjs`) sends Grep, Glob and recursive shell searches to `search` in repos that have an index. Since `search` takes regex, it can stop nearly every plain code search instead of only symbol lookups.

## Measured on the Bindwright repo (2026-11-11)

- Coverage: 450 of 468 files with symbols. The 18 left are licenses, ignore lists, `VERSION` and two shell launchers; full-text search still covers them.
- 25 real fallback searches replayed: every one returns exactly the lines `git grep -P` returns on tracked files. 12 of the 25 need regex, which the tool it replaced cannot run.
- Speed: 25 searches in about 240 ms in one process (about 10 ms each), against about 800 ms for 25 `git grep` processes. The database is 19 MB (the replaced tool's: 32 MB).

## Not built: graph tools

The tool FindWright replaced also answered callers, impact, dead code and complexity metrics; FindWright answers none of them. References and callers need parsing. Tested 2026-11-11 with `web-tree-sitter` 0.25.10 and the prebuilt grammars of `tree-sitter-wasms` 0.1.13 (36 languages, Dart and C# included): the Bindwright repo's 256 JS, TS, TSX and Python files parse in about 0.6 s with no native build, giving 2,709 definitions and 29,313 call sites, enough to answer "who calls X" by name. The runtime is 5.7 MB and each grammar 0.3 to 3 MB, so setup would fetch only the grammars for the languages the repo has (JS, TS, TSX and Python together: 5.7 MB).
