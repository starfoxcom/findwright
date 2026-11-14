# FindWright as a plugin: design

FindWright ships as its own Claude Code plugin, installed from its own marketplace and from Anthropic's plugin directory, with its own releases and page. Until now it shipped only inside Bindwright's helper (`helper/findwright/` there, a copy of `src/`).

## The constraint that shapes it

The plugin directory accepts from an organization that is not Verified only Markdown, text, JSON, YAML and images: no scripts, no package manager files, no hooks, no MCP servers and no skill frontmatter keys beyond `name`, `description`, `disable-model-invocation` and `argument-hint`. Bindwright met the same rule in its v3.0.0 and split into a skills-only plugin plus a helper the plugin pins by SHA-256. FindWright takes the same shape.

## Shape

- **The plugin** (`plugin/` in this repo, packed into `findwright-X.Y.Z.zip`):
  - `.claude-plugin/plugin.json` and `.claude-plugin/icon.png`.
  - `README.md`.
  - `helper.json`: the helper tarball's file name, release URL and SHA-256, written by the packer.
  - Skills: `setup`, `update`, `doctor`, `remove`, and `find` (the lookup sequence: `find`, then `search`, `symbols` and `outline`).
- **The helper** (`findwright-X.Y.Z.tgz`, attached to each release): `package.json`, `src/`, `hooks/findwright-first.mjs`, `README.md`, `LICENSE`, `CHANGELOG.md`. No dependencies and no install scripts. Setup installs it with `npm install --prefix ~/.findwright/helper --no-save --ignore-scripts --no-audit --no-fund <file>`, so it lands at `~/.findwright/helper/node_modules/findwright/`.
- **The marketplace**: the shared `wrights` marketplace ([starfoxcom/wrights](https://github.com/starfoxcom/wrights)) lists `findwright` beside Bindwright, with an `archive` source naming the release zip and its SHA-256. Each release opens a pull request there that moves the entry.
- **The `plugin` branch**: the packed plugin of the newest release at its root, one commit per release, which the directory listing follows. Each of those commits is tagged `findwright--vX.Y.Z`, so a marketplace that sources the branch can resolve a version range.

## What setup does

1. Checks Node 22.16 or later (or Node 24 and up), whose built-in SQLite has full-text search; Node 23 does not. It also reads `nodejs.org/dist/index.json`, and when a newer patch of the same line exists, since an old patch leaves known security holes open, installs it with winget on Windows or gives the nodejs.org installer elsewhere. A line outside long-term support gets a note. A missing Node is installed the same way, then setup stops for a restart.
2. When `~/.findwright/helper/node_modules/findwright/package.json` is missing or holds another version than the plugin, downloads the file `helper.json` names, checks its SHA-256 and installs it as above.
3. Installs the meaning model with `findwright model`, which downloads it and checks the pinned SHA-256; find returns an error naming setup without it.
4. Registers the server for the user: `claude mcp add --scope user findwright -- node "<home>/.findwright/helper/node_modules/findwright/src/server.mjs"`. When a `findwright` server is registered already (Bindwright's copy), it says which copy runs now and switches to the plugin's one, which is the newer.
5. Offers the search hook, which sends Grep, Glob and shell searches to FindWright in repos that have an index: `findwright home install-hook` merges it into `~/.claude/settings.json` (backup first, refusing a file that is not valid JSON). When Bindwright's `findwright-first.py` is registered, it leaves that one in place, since two would answer every search twice.
6. In a git repo, offers to fit the index to the project: runs `coverage`, and for file kinds with no symbols proposes `kinds` and `rules` for `.findwright/config.json`, written on a yes.

`update` reinstalls the helper at the plugin's version, `doctor` checks Node, the helper version, the registration and the hook and says each fix, and `remove` takes out the hook, the registration and the helper folder, then the plugin, each on a yes. Indexes in projects (`.findwright/`) stay unless the user asks.

## Building and releasing

- `tools/pack.mjs` builds the zip and the tarball from the files git stores at a ref, never the working tree, so every machine and CI get the same bytes whatever the line endings. Entries are stored uncompressed with fixed dates and modes, so zlib versions cannot change the bytes. `--marketplace FILE` rewrites the `findwright` entry of a marketplace file, a checkout of the wrights repo, to pin the ref's zip.
- `tools/directory_check.mjs` replays the directory's rules on every pack, so a release never meets a refusal.
- `.github/workflows/release-plugin.yml`, on a published release: rebuilds the zip and tarball from the tag, refuses when the zip's SHA-256 differs from the pin on the wrights marketplace's main branch or the tarball differs from the zip's `helper.json`, attaches both to the release, and writes the `plugin` branch.
- Versions: one SemVer number for `package.json`, `plugin.json`, the wrights marketplace entry and the tag. `CHANGELOG.md` keeps one section per release.

## Living beside Bindwright

Bindwright installs this plugin from the `wrights` marketplace and leaves the registration to `/findwright:setup`, so the two never carry different copies. An older Bindwright registered its own copy under the name `findwright`; FindWright's setup switches that registration to its helper.
