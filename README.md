<p align="center"><img src="assets/icon.svg" width="96" alt=""></p>

# FindWright

A code index and search tool that adapts to each project. It indexes every file the project tracks, answers plain-English questions, names and regular-expression searches over all of them, and pulls symbols out of each file with built-in extractors plus pattern rules the project defines, so a language or file format no extractor knows is still searchable by name. It serves the index to Claude Code, or any coding assistant, over MCP.

Status: early (0.1). On 169 searches replayed from real coding sessions on four projects, the file the session went on to open was in FindWright's answer 69% of the time, against 53% for the code-search tool it replaced, with answers about a sixth the size. The page at https://starfoxcom.github.io/findwright/ has the full numbers.

## Install as a plugin

FindWright is a Claude Code plugin of its own; it needs nothing else. In a Claude Code session:

```
/plugin marketplace add starfoxcom/findwright
/plugin install findwright@findwright
```

Then run `/findwright:setup`. It installs the helper, the part that runs on your computer, from the plugin's GitHub release after checking it against the SHA-256 the plugin pins, into `~/.findwright/helper` for your user only. It then registers FindWright for every project, offers a hook that sends searches to it in indexed repos, and fits the index to the project you are in. `/findwright:update` keeps the helper at the plugin's version, `/findwright:doctor` checks the setup and `/findwright:remove` takes it back out.

[Bindwright](https://github.com/starfoxcom/bindwright) offers FindWright as its code-search tool and sets it up the same way.

## Use from the shell

Needs Node 22.16 or later (or Node 24 and up) on a long-term-support line, for the full-text search in Node's built-in SQLite. Node 23 lacks it.

```
findwright find <question or name>         # the files that answer it, best first
findwright search <regex> [--glob G] [-i] [-C N]
findwright symbols <name> [--kind K]
findwright outline <path>
findwright coverage                        # files per kind, and files with no symbols
findwright refresh                         # bring the index level with the working tree
```

`findwright-mcp` runs the same queries as an MCP server over stdio. Every call first re-reads the files whose size or modified time changed, so answers match the working tree.

## Per-project settings

`.findwright/config.json` in the project:

- `include`: globs for files git ignores that the work still reads, such as generated typings.
- `exclude`: globs to leave out.
- `kinds`: which extractor reads which files, e.g. `{ "*.mdc": "markdown" }`.
- `rules`: pattern rules for anything else, each `{ "globs": [...], "kind": "function", "pattern": "^\s*func\s+(?<name>\w+)" }`; the `name` group is the symbol's name.

The index lives in `.findwright/index.db`, in a folder that keeps itself out of git.

## Privacy

FindWright sends nothing about you or your code. It makes three kinds of network call:

- **The helper install**, after your yes in `/findwright:setup`, downloads the helper file the plugin pins from `github.com/starfoxcom/findwright/releases`.
- **The Node check**: `/findwright:setup` and `/findwright:doctor` read Node's public release list from `nodejs.org/dist/index.json`, to say when your Node is missing security fixes.
- **The meaning model**: setup downloads its two files (32 MB) from Hugging Face, checked against pinned SHA-256 sums, into `~/.cache/findwright/models`. Find refuses to answer without it rather than rank worse. Set `FINDWRIGHT_MEANING=off` in the registration to turn meaning search off.

The index and any project settings stay in each project's `.findwright/` folder.

## Bench

`bench/` replays real searches from past sessions through FindWright and a baseline tool, and scores each answer against the files the session used next. The baseline's command lives in the git-ignored `bench/baseline.local.json`. `bench/page_metrics.py` turns a replay into the page's numbers. See `docs/DESIGN.md` for the design.

## Development

`main` holds tagged releases and `develop` is where work lands: branch from `develop` and open pull requests against it. Run the tests with `npm test`. `docs/PLUGIN.md` covers the plugin, the helper and how releases are packed.

## License

MIT. See [`LICENSE`](./LICENSE).
