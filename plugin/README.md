# FindWright

FindWright gives Claude a code index that adapts to each project. It indexes every file the project tracks (code, docs, config and templates alike) and answers plain-English questions, names and regular-expression searches from it, with short answers that point at the right lines. A file format no built-in extractor knows gets a pattern rule in the project's `.findwright/config.json`, so it is still searchable by name.

## Install

From the plugin directory: in Claude Code, run `/plugin`, open Discover and install FindWright. Or from FindWright's own marketplace, in a Claude Code session:

```
/plugin marketplace add starfoxcom/findwright
/plugin install findwright@findwright
```

Then run `/findwright:setup`. It asks to install FindWright's helper, the part that runs on your computer: the file attached to the plugin's GitHub release, checked against the SHA-256 the plugin pins, into `~/.findwright/helper` for your user only. It then registers FindWright with Claude Code for every project, offers a hook that sends searches to it in indexed repos, and, inside a project, offers to fit the index to that project.

## Use

- `/findwright:setup` installs and registers FindWright, and fits the index to the project you are in.
- `/findwright:find` is the lookup sequence Claude follows: `find` first, then `search`, `symbols` and `outline`.
- `/findwright:update` brings the helper to the plugin's version.
- `/findwright:doctor` checks Node, the helper, the registration and the hook, and says how to fix what is wrong.
- `/findwright:remove` takes the hook, the registration and the helper back out.

The tools themselves are `find` (the files that answer a question or hold a name, best first), `search` (regexes over every tracked file, with globs and context lines), `symbols`, `outline` and `coverage`. Every call first re-reads the files that changed, so answers match the working tree.

## Privacy

FindWright sends nothing about you or your code. It makes two kinds of network call:

- **The helper install**, after your yes, downloads the helper file the plugin pins from `github.com/starfoxcom/findwright/releases`.
- **The meaning model**, on the first search, downloads its two files (32 MB) from Hugging Face, checked against pinned SHA-256 sums, into `~/.cache/findwright/models`. Set `FINDWRIGHT_MEANING=off` to skip it; FindWright then ranks by words alone.

The index stays in each project's `.findwright/` folder, which keeps itself out of git.

## Needs

Node 22.16 or later (or Node 24 and up), since FindWright keeps its index in Node's built-in SQLite and needs its full-text search, which Node 23 lacks. Setup says how to install it when it is missing.
