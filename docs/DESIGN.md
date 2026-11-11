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
- **Extractors per file kind.** Built in: Markdown (headings with their section range, front matter), YAML (key paths, list items' names, block scalars skipped), JSON (key paths, one-line and unparseable files included), JavaScript and TypeScript, Python, CSS, HTML, shell. A `.template` file is read as the file it renders to.
- **The per-project part: `.findwright/config.json`**, committed, written by the session after it scans the repo:
  - `include`: git-ignored files the work reads (generated typings).
  - `exclude`: files to leave out.
  - `kinds`: globs mapped to an extractor (`*.additions` as Markdown).
  - `rules`: regexes whose `name` group names a symbol of a project kind (i18n text keys, template placeholders, toggles, SQL tables, environment variables).
- **The adapting loop.** At project setup the session runs `coverage`, reads which kinds and files yield no symbol, and adds kinds or rules until every file it cares about has structure. The searches that still go to plain grep get logged, so a later session extends the config.

## Tools (MCP, stdio)

- `search`: regexes (several at once, OR or `all`), globs, context lines, case flag, limit. Output reads like `grep -n`, grouped by file, and each hit names its enclosing symbol.
- `symbols`: by name (regex or substring), kind and glob; exact names first.
- `outline`: one file's symbols with line ranges.
- `coverage`: files per kind and the files with no symbol.

Still to build: `context` (a ranked map for a task, after aider's repo map: references between files ranked with PageRank) and `references` (word-boundary text references, plus parsed ones where a grammar exists).

## Measured on this repo (2026-11-11)

- Coverage: 450 of 468 files with symbols. The 18 left are licenses, ignore lists, `VERSION` and two shell launchers; full-text search still covers them.
- 25 real fallback searches replayed: every one returns exactly the lines `git grep -P` returns on tracked files. 12 of the 25 need regex, which the current tool's search cannot run.
- Speed: 25 searches in about 240 ms in one process (about 10 ms each), against about 800 ms for 25 `git grep` processes. The database is 19 MB (the current tool's: 32 MB).

## Open decisions

1. **Replace the current tool's role in setup.** The code-search choice would offer this index (recommended), `none` and `custom`. It needs Node 22.13 or later for `node:sqlite` without a flag; older Node falls back to `none`.
2. **Graph tools.** The current tool also answers callers, impact, dead code and complexity metrics. Version 1 here covers search, symbols and outlines. References and callers need parsing. Tested 2026-11-11 with `web-tree-sitter` 0.25.10 and the prebuilt grammars of `tree-sitter-wasms` 0.1.13 (36 languages, Dart and C# included): this repo's 256 JS, TS, TSX and Python files parse in about 0.6 s with no native build, giving 2,709 definitions and 29,313 call sites, enough to answer "who calls X" by name. The runtime is 5.7 MB and each grammar 0.3 to 3 MB, so setup would fetch only the grammars for the languages the repo has (JS, TS, TSX and Python together: 5.7 MB). Until that lands, the current tool can stay installed beside it for those questions.
3. **The search hook.** A hook like the current `*-first.py` routes Grep and recursive shell searches to `search`. Since `search` takes regex, the hook can block nearly every plain code search instead of only symbol lookups.
4. **Where it ships.** In the helper package, run as `node "<helper>/src/server.mjs"`, registered per project in `.mcp.json` by setup.
