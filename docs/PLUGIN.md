# FindWright as a plugin: design

FindWright ships as its own Claude Code plugin, installed from its own marketplace and from Anthropic's plugin directory, with its own releases and page. Until now it shipped only inside Bindwright's helper (`helper/findwright/` there, a copy of `src/`).

## The constraint that shapes it

The plugin directory accepts from an organization that is not Verified only Markdown, text, JSON, YAML and images: no scripts, no package manager files, no hooks, no MCP servers and no skill frontmatter keys beyond `name`, `description`, `disable-model-invocation` and `argument-hint`. Bindwright met the same rule in its v3.0.0 and split into a skills-only plugin plus a helper the plugin pins by SHA-256. FindWright takes the same shape.

## Shape

- **The plugin** (`plugin/` in this repo, packed into `findwright-X.Y.Z.zip`):
  - `.claude-plugin/plugin.json` and `.claude-plugin/icon.png`.
  - `README.md`.
  - `helper.json`: the helper tarball's file name, release URL and SHA-256, written by the packer.
  - Skills: `setup`, `update`, `doctor`, `remove`, `fit` (writes the project's rules, from the reference rule sets in `skills/fit/reference/`), and `find` (the lookup sequence: `find`, then `search`, `symbols` and `outline`).
- **The helper** (`findwright-X.Y.Z.tgz`, attached to each release): `package.json`, `src/`, `hooks/findwright-first.mjs`, `README.md`, `LICENSE`, `CHANGELOG.md`. No dependencies and no install scripts. Setup installs it with `npm install --prefix ~/.findwright/helper --no-save --ignore-scripts --no-audit --no-fund <file>`, so it lands at `~/.findwright/helper/node_modules/findwright/`.
- **The marketplace**: the shared `wrights` marketplace ([starfoxcom/wrights](https://github.com/starfoxcom/wrights)) lists `findwright` beside Bindwright, with an `archive` source naming the release zip and its SHA-256. Each release opens a pull request there that moves the entry.
- **The `plugin` branch**: the packed plugin of the newest release at its root, one commit per release, which the directory listing follows. Each of those commits is tagged `findwright--vX.Y.Z`, so a marketplace that sources the branch can resolve a version range.

## What setup does

Each skill's `SKILL.md` under `plugin/skills/` is the source for what it does; this list says what each setup step touches.

1. Reads what is in place and changes nothing: Node 22.16 or later (or Node 24 and up), whose built-in SQLite has full-text search, which Node 23 lacks, and whether `nodejs.org/dist/index.json` lists a newer patch of the same line; the helper's version; the registration; the hook, guidance and auto-update (`findwright home status`); and in a git repo, whether `.findwright/config.json` has a rules list.
2. Shows one plan of everything it will install or change, on the computer and in the project, and applies it on one yes; a no changes nothing. Bindwright's setup runs this one after its own, so the user sees FindWright's plan there too.
3. Installs a missing or too old Node with winget on Windows, or gives the nodejs.org installer elsewhere, then stops for a restart. A newer patch of the same line is installed the same way, since an old patch leaves known security holes open. A line outside long-term support gets a note.
4. When `~/.findwright/helper/node_modules/findwright/package.json` is missing or holds another version than the plugin, installs the release `helper.json` names. With a helper already there, `findwright follow --plugin <plugin folder>` does it in a staging folder of its own and swaps it in under the lock the background update takes, so two sessions never install over each other. Without one, setup downloads the file into a folder of its own run (`mktemp -d`, or a GUID-named folder in PowerShell), checks its SHA-256 and installs it as above.
5. Installs the meaning model with `findwright model`, which downloads it and checks the pinned SHA-256; find returns an error naming setup without it.
6. Registers the server for the user: `claude mcp add --scope user findwright -- node "<home>/.findwright/helper/node_modules/findwright/src/server.mjs"`. When a `findwright` server is registered already (an older Bindwright's copy), it says which copy runs now and switches to the plugin's one. Then writes the agent guidance with `findwright home install-guidance`.
7. Adds the search hook when the plan's yes included it, which sends Grep, Glob and shell searches to FindWright in repos that have an index: `findwright home install-hook` merges it into `~/.claude/settings.json` (backup first, refusing a file that is not valid JSON). When another code-search hook is registered, the plan leaves this one out, since two would answer every search twice.
8. In a git repo with no rules list in `.findwright/config.json`, fits the index to the project with the `fit` skill.

`update` keeps the helper at the plugin's version and fits a repo that has no rules, `doctor` checks the parts and says each fix, and `remove` takes the parts back out, each on a yes. Indexes in projects (`.findwright/`) stay unless the user asks.

## Building and releasing

- `tools/pack.mjs` builds the zip and the tarball from the files git stores at a ref, never the working tree, so every machine and CI get the same bytes whatever the line endings. Entries are stored uncompressed with fixed dates and modes, so zlib versions cannot change the bytes. `--marketplace FILE` rewrites the `findwright` entry of a marketplace file, a checkout of the wrights repo, to pin the ref's zip.
- `tools/directory_check.mjs` replays the directory's rules on every pack, so a release never meets a refusal.
- `.github/workflows/release-plugin.yml`, on a published release: rebuilds the zip and tarball from the tag, refuses when the zip's SHA-256 differs from the pin on the wrights marketplace's main branch or the tarball differs from the zip's `helper.json`, attaches both to the release, and writes the `plugin` branch.
- Versions: one SemVer number for `package.json`, `plugin.json`, the wrights marketplace entry and the tag. `CHANGELOG.md` keeps one section per release.

## Living beside Bindwright

Bindwright installs this plugin from the `wrights` marketplace and leaves the registration to `/findwright:setup`, so the two never carry different copies. An older Bindwright registered its own copy under the name `findwright`; FindWright's setup switches that registration to its helper.
