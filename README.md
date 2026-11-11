<p align="center"><img src="assets/icon.svg" width="96" alt=""></p>

# FindWright

A code index and search tool that adapts to each project. It indexes every file the project tracks, answers regular-expression searches over all of them, and pulls symbols out of each file with built-in extractors plus pattern rules the project defines, so a language or file format no extractor knows is still searchable by name. It serves the index to coding assistants over MCP.

Status: early (0.1). On 169 searches replayed from real coding sessions, the file the session opened next was in its answer 72% of the time, against 53% for the code-search tool it replaced, at the same answer length.

## Use

Needs Node 22.13 or later (it uses the built-in `node:sqlite`).

```
findwright refresh                         # bring the index level with the working tree
findwright search <regex> [--glob G] [-i] [-C N]
findwright symbols <name> [--kind K]
findwright outline <path>
findwright coverage                        # files per kind, and files with no symbols
```

`findwright-mcp` runs the same queries as an MCP server over stdio. Every call first re-reads the files whose size or modified time changed, so answers match the working tree.

## Per-project settings

`.findwright/config.json` in the project:

- `include`: globs for files git ignores that the work still reads, such as generated typings.
- `exclude`: globs to leave out.
- `kinds`: which extractor reads which files, e.g. `{ "*.mdc": "markdown" }`.
- `rules`: pattern rules for anything else, each `{ "globs": [...], "kind": "function", "pattern": "^\s*func\s+(?<name>\w+)" }`; the `name` group is the symbol's name.

The index lives in `.findwright/index.db`; keep it out of git.

## Bench

`bench/` replays real searches from past sessions through FindWright and the tool it replaces, and scores each answer against the files the session used next. See `docs/DESIGN.md` for the design and the numbers so far.
