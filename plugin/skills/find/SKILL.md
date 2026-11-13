---
name: find
description: Locate code before reading or editing it. Use whenever the user asks "where is X", "what calls Y", "find usages of Z", or whenever you need to find a symbol, function, type or pattern yourself.
---

# /findwright:find

The lookup sequence for **FindWright**'s tools. Follow it in order and stop at the first useful result. Read only the range you found, never the whole file.

## Sequence

1. `find` with a plain-English question, a name, or both: the files that answer it, best first.
2. `search` with one or more regexes, optional `globs` and `context`: every matching line, with the symbol around it. It covers every file the project tracks, Markdown, config and templates included.
3. `symbols` to look a name up by kind (function, class, heading, key).
4. `outline` with a path: its symbols and line ranges, to read only the part you need.
5. `coverage` when a file seems missing: what the index reads and which files yield no symbol.

The index updates itself on every call. A project format it does not know gets a pattern rule in `.findwright/config.json`.

## Falling back to Grep and Glob

Allowed only when:

- FindWright returned nothing usable for two differently worded queries;
- the target is not code (Markdown, config, binaries, ignored files);
- FindWright is unavailable for this scope.

Say which condition applies. For a shell `grep` or `rg`, add the comment `# FINDWRIGHT_BYPASS: <reason>` to the command so the search hook lets it through and the fallback reads as deliberate.

## Citing

Name the call that found it, in one line:

> Found `parseHeader` via `<call>` at `src/codec/header.ts:42`.
