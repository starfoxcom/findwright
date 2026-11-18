<p align="center"><img src="assets/icon.svg" width="96" alt=""></p>

# FindWright

A code index and search tool that adapts to each project. It indexes every file the project tracks, answers plain-English questions, names and regular-expression searches over all of them, and pulls symbols out of each file with pattern rules the project keeps in `.findwright/config.json`. FindWright knows no language by itself: the agent writes the rules for each project, starting from reference rule sets, so any language or file format is searchable by name without waiting for FindWright to support it. It serves the index to Claude Code, or any coding assistant, over MCP.

On 169 searches replayed from real coding sessions on four projects, the file the session went on to open was in FindWright's answer 69% of the time, against 53% for the code-search tool it replaced, with answers about a sixth the size. `bench/` holds the replay.

## Install as a plugin

FindWright is a Claude Code plugin of its own; it needs nothing else. In a Claude Code session:

```
/plugin marketplace add starfoxcom/wrights
/plugin install findwright@wrights
```

The `wrights` marketplace ([starfoxcom/wrights](https://github.com/starfoxcom/wrights)) lists FindWright and Bindwright, each pinned to its own release.

Type `/reload-plugins` (or start a new session) so the plugin loads, then run `/findwright:setup`. It first checks what is already in place, then shows one plan of everything it will install or change and does it all on your yes; a no changes nothing. The plan can hold:

- Node's newest security patch, when yours is behind or too old: installed through winget on Windows, or the installer from nodejs.org for you to run elsewhere. Claude Code then restarts and you run setup again for the rest, since a running session does not see a program installed after it started.
- The helper, the part that runs on your computer, from the plugin's GitHub release after checking it against the SHA-256 the plugin pins, into `~/.findwright/helper` for your user only.
- The meaning model (32 MB from Hugging Face, checked against pinned SHA-256 sums), which ranks files by meaning as well as by words.
- FindWright's registration with Claude Code for every project, and its guidance for the agent (which tool to use when, when a fallback to Grep is allowed, and the hit rate to report when a session closes) in `~/.claude/rules/findwright.md`, a file of its own.
- A hook that sends Grep, Glob and shell searches to FindWright in indexed repos; you can say yes to the rest without it.
- Claude Code's auto-update for the wrights marketplace, unless you turned it off before.
- For the project you are in, rules that name its code, which FindWright writes after reading the project, and the index built from them.

Setup then asks once whether to share anonymous usage counts (see Privacy), off unless you say yes.

FindWright then keeps itself current: auto-update moves the plugin, and when a session starts with it, the search server installs the helper the new plugin pins in the background, checked against its SHA-256 the same way. The next session runs it and says so in one line. When that fails, the old helper keeps working and the next session is told why. `/findwright:update` does the same on demand, `/findwright:doctor` checks the setup and `/findwright:remove` takes it back out.

[Bindwright](https://github.com/starfoxcom/bindwright) offers FindWright as its code-search tool and sets it up the same way.

## Use from the shell

Needs Node 22.16 or later (or Node 24 and up), for the full-text search in Node's built-in SQLite. Node 23 lacks it. Run `findwright model` once to download the meaning model `find` needs.

```
findwright model                           # download and check the meaning model
findwright find <question or name>         # the files that answer it, best first
findwright search <regex> [--glob G] [-i] [-C N]
findwright symbols <name> [--kind K]
findwright outline <path>
findwright coverage                        # files per type, and files with no symbols
findwright refresh                         # bring the index level with the working tree
findwright try <rules.json>                # what draft rules would name, without saving them
findwright counts status|share on|share off|project <kind>|send   # the opt-in usage counts
findwright follow [--plugin <folder>]      # bring the helper to the release the plugin pins
findwright home auto-update on|off         # Claude Code's auto-update for the wrights marketplace
findwright home install-guidance|remove-guidance   # the agent guidance in Claude Code's rules
```

A glob starting with `!` leaves out the files it matches, as in ripgrep: `--glob '*.md' --glob '!CHANGELOG.md'` searches every Markdown file but the changelog, and `!` globs alone search every other file.

`findwright-mcp` runs the same queries as an MCP server over stdio. Every call first re-reads the files whose size or modified time changed, so answers match the working tree.

## Per-project settings

`.findwright/config.json` in the project:

- `include`: globs for files git ignores that the work still reads, such as generated typings.
- `exclude`: globs to leave out.
- `rules`: the pattern rules that name the project's symbols, each `{ "globs": [...], "kind": "function", "pattern": "^\s*func\s+(?<name>\w+)" }`; the `name` group is the symbol's name. Optional fields give a symbol its structure (where its block ends, the symbol it sits under, comment lines, regions it skips); the fit skill's [rule fields](plugin/skills/fit/SKILL.md#3-write-rules-for-the-rest) list each one and its limits.

`findwright try <rules.json>` runs draft rules over the repo without writing the config or touching the index, and prints what each kind of symbol finds, with samples, and which matched files still get none. The plugin's `/findwright:fit` skill writes a project's rules this way, starting from the reference rule sets in `plugin/skills/fit/reference/`.

The index lives in `.findwright/index.db`, in a folder that keeps itself out of git.

## Privacy

FindWright sends nothing about you or your code. It makes these network calls:

- **The helper install**: setup downloads the helper file the plugin pins from `github.com/starfoxcom/findwright/releases`.
- **The Node check**: `/findwright:setup` and `/findwright:doctor` read Node's public release list from `nodejs.org/dist/index.json`, to find the newest security patch of your Node. On Windows, setup installs Node or its newest patch through winget when yours is missing or behind; elsewhere you run the installer from nodejs.org.
- **The meaning model**: setup downloads its two files (32 MB) from Hugging Face, checked against pinned SHA-256 sums, into `~/.cache/findwright/models`. Find refuses to answer without it rather than rank worse.
- **The usage counts**, only when you turn them on in setup: once a day, each project whose kind you pick posts four sums about its searches older than an hour (sessions that searched, searches the session followed by opening a file, how many of those answers named that file, and the answers' total bytes), the time span they cover, a random id and the kind to `findwright-counter.starfoxcom.workers.dev`. The counter keeps the country Cloudflare reads from the connection and publishes only projects per country. `findwright counts share off` stops every send.

The index and any project settings stay in each project's `.findwright/` folder.

## Bench

`bench/` replays real searches from past sessions through FindWright and a baseline tool, and scores each answer against the files the session used next. The baseline's command lives in the git-ignored `bench/baseline.local.json`. `bench/harvest.py` collects the searches, `bench/replay.mjs` replays them, and `bench/summarize4.py` turns a replay into hit rates. See `docs/DESIGN.md` for the design.

## Development

`main` holds tagged releases and `develop` is where work lands: branch from `develop` and open pull requests against it. Run the tests with `npm test`. `docs/PLUGIN.md` covers the plugin, the helper and how releases are packed.

## License

MIT. See [`LICENSE`](./LICENSE).
