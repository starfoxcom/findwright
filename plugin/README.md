# FindWright

FindWright gives Claude a code index that adapts to each project. It indexes every file the project tracks (code, docs, config and templates alike) and answers plain-English questions, names and regular-expression searches from it, with short answers that point at the right lines. FindWright knows no language by itself: Claude writes each project's rules in `.findwright/config.json`, starting from the reference rule sets the plugin ships, so any language or file format is searchable by name.

## Install

From the plugin directory: in Claude Code, run `/plugin`, open Discover and install FindWright. Or from FindWright's own marketplace, in a Claude Code session:

```
/plugin marketplace add starfoxcom/wrights
/plugin install findwright@wrights
```

Then run `/findwright:setup`. Running it is your yes to everything FindWright needs, so it installs each part and says what it installs: Node when yours is missing or behind on security fixes (on Windows; elsewhere it gives you the installer), the helper (the part that runs on your computer, the file attached to the plugin's GitHub release, checked against the SHA-256 the plugin pins, into `~/.findwright/helper` for your user only), the 32 MB meaning model, and the registration with Claude Code for every project. Inside a project, it also fits the index to it: it writes the rules that name the project's code, so searches find it by name. It asks only about the hook that sends searches to FindWright in indexed repos. When a part cannot be installed, setup stops and FindWright stays off.

## Use

- `/findwright:setup` installs and registers FindWright, and fits the index to the project you are in.
- `/findwright:fit` fits the index to a project: it reads what the repo holds, writes the rules that name its functions, types, keys, headings and tests in `.findwright/config.json`, starting from the reference rule sets it ships, and tries them before saving.
- `/findwright:find` is the lookup sequence Claude follows: `find` first, then `search`, `symbols` and `outline`.
- `/findwright:update` brings the helper to the plugin's version.
- `/findwright:doctor` checks Node, the helper, the registration and the hook, and says how to fix what is wrong.
- `/findwright:remove` takes the hook, the registration and the helper back out.

The tools themselves are `find` (the files that answer a question or hold a name, best first), `search` (regexes over every tracked file, with globs and context lines), `symbols`, `outline` and `coverage`. Every call first re-reads the files that changed, so answers match the working tree.

## Privacy

FindWright sends nothing about you or your code. It makes these network calls:

- **The helper install**: setup downloads the helper file the plugin pins from `github.com/starfoxcom/findwright/releases`.
- **The Node check**: `/findwright:setup` and `/findwright:doctor` read Node's public release list from `nodejs.org/dist/index.json`, to find the newest security patch of your Node. On Windows, setup installs Node or its newest patch through winget when yours is missing or behind; elsewhere you run the installer from nodejs.org.
- **The meaning model**: setup downloads its two files (32 MB) from Hugging Face, checked against pinned SHA-256 sums, into `~/.cache/findwright/models`. Find refuses to answer without it rather than rank worse.
- **The usage counts**, only when you turn them on in setup: once a day, each project whose kind you pick posts four sums about its searches older than an hour (sessions that searched, searches the session followed by opening a file, how many of those answers named that file, and the answers' total bytes), the time span they cover, a random id and the kind to `findwright-counter.starfoxcom.workers.dev`. The counter keeps the country Cloudflare reads from the connection and publishes only projects per country. `/findwright:remove` turns them off.

The index stays in each project's `.findwright/` folder, which keeps itself out of git. Files that hold secrets by nature (`.env` files other than templates such as `.env.example`, private keys, key stores, `.netrc` and other credential files) are never indexed, and tokens with a known shape (cloud, code-host and AI-provider keys, private key blocks, JSON web tokens) are stored as `[masked]`, so no search or find hands them back. A password or a token with no known shape in an ordinary file is still indexed, as it is still readable in the file itself. Claude can still open a skipped file when you ask it to.

## Needs

Node 22.16 or later (or Node 24 and up), since FindWright keeps its index in Node's built-in SQLite and needs its full-text search, which Node 23 lacks. Setup installs it on Windows and gives the installer elsewhere.
