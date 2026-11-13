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
- **The marketplace** (`.claude-plugin/marketplace.json` at the repo root): one plugin, `findwright`, with an `archive` source naming the release zip and its SHA-256.
- **The `plugin` branch**: the packed plugin of the newest release at its root, one commit per release, which the directory listing follows.

## What setup does

1. Checks Node 22.13 or later (for `node:sqlite`). Without it, says how to get it and stops.
2. When `~/.findwright/helper/node_modules/findwright/package.json` is missing or holds another version than the plugin, asks, then downloads the file `helper.json` names, checks its SHA-256 and installs it as above.
3. Registers the server for the user: `claude mcp add --scope user findwright -- node "<home>/.findwright/helper/node_modules/findwright/src/server.mjs"`. When a `findwright` server is registered already (Bindwright's copy), it says which copy runs now and offers to switch to the plugin's one, which is the newer.
4. Offers the search hook, which sends Grep, Glob and shell searches to FindWright in repos that have an index: `findwright home install-hook` merges it into `~/.claude/settings.json` (backup first, refusing a file that is not valid JSON). When Bindwright's `findwright-first.py` is registered, it leaves that one in place, since two would answer every search twice.
5. In a git repo, offers to fit the index to the project: runs `coverage`, and for file kinds with no symbols proposes `kinds` and `rules` for `.findwright/config.json`, written on a yes.

`update` reinstalls the helper at the plugin's version, `doctor` checks Node, the helper version, the registration and the hook and says each fix, and `remove` takes out the hook, the registration and the helper folder, then the plugin, each on a yes. Indexes in projects (`.findwright/`) stay unless the user asks.

## Building and releasing

- `tools/pack.mjs` builds the zip and the tarball from the files git stores at a ref, never the working tree, so every machine and CI get the same bytes whatever the line endings. Entries are stored uncompressed with fixed dates and modes, so zlib versions cannot change the bytes. `--marketplace` rewrites the marketplace pin for HEAD's zip.
- `tools/directory_check.mjs` replays the directory's rules on every pack, so a release never meets a refusal.
- `.github/workflows/release-plugin.yml`, on a published release: rebuilds the zip and tarball from the tag, refuses when the zip's SHA-256 differs from the default branch's marketplace pin or the tarball differs from the zip's `helper.json`, attaches both to the release, and writes the `plugin` branch.
- Versions: one SemVer number for `package.json`, `plugin.json`, the marketplace entry and the tag. `CHANGELOG.md` keeps one section per release.

## Living beside Bindwright

Both can register a server named `findwright`. Bindwright's setup registers its own copy; FindWright's setup offers to point the registration at its helper instead. The follow-up on Bindwright's side is to install FindWright from these releases (pinned version and SHA-256) instead of carrying a copy of `src/`, so the two never drift.
