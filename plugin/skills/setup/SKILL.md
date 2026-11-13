---
name: setup
description: Install FindWright on this computer, register it with Claude Code and, inside a project, fit its index to that project. Use when the user asks to set up or install FindWright, or when its tools are missing.
---

# /findwright:setup

Sets FindWright up in three parts, each after a yes: the helper (the part that runs on this computer), its registration with Claude Code, and the search hook. Inside a git repo it then offers to fit the index to the project. Nothing outside the helper folder and the settings it names changes without a yes.

`<helper>` is `$HOME/.findwright/helper/node_modules/findwright` in every FindWright skill, and `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`.

## 1. Node

Run `node --version`. FindWright needs Node 22.16 or later on the 22 line, or 24 or later, since it keeps its index in Node's built-in SQLite and needs its full-text search, which Node 23 and Node 22 before 22.16 lack. When Node is missing or older, or is 23, say so in one line and give the install for the user's system: on Windows, offer to run `winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements` on a yes; on macOS, `brew install node` or the installer from nodejs.org; on Linux, the installer from nodejs.org, since the distributions' own `nodejs` package is often too old. Then say to restart Claude Code, since a running session does not see a program installed after it started, and to run `/findwright:setup` again. Stop here.

Then check that this Node has every security fix. Read Node's public release list, `https://nodejs.org/dist/index.json` (newest first; each entry has `version` and `lts`, which is `false` for a release outside long-term support). When the list has a newer release of the same major version, say in one line that Node <version> is behind on security fixes and <newest> is out; when this major version's releases all have `lts` false, say it is not a long-term-support line and recommend the newest LTS. Offer the upgrade: on Windows, run `winget upgrade --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements` on a yes; on macOS, `brew upgrade node` or the installer from nodejs.org; on Linux, the installer from nodejs.org. Setup can go on without it, but say an old patch leaves known holes open. When the list cannot be read, say so in one line and go on.

## 2. The helper

The helper is ready when `node -p "require(process.argv[1]).version" "<helper>/package.json"` prints the `version` in `<plugin>/.claude-plugin/plugin.json`. When it is missing or holds another version, ask: "FindWright needs its helper, the part that builds and searches the index, installed for your user only, with no admin rights. Install it now?", with "Yes" first (say "update it to <version>" when an older one is there). On a yes, install exactly the file `<plugin>/helper.json` names under `node`, which the plugin pins by its SHA-256:

1. Create `$HOME/.findwright/helper/` and download the entry's `url` into it under its `file` name: `curl -fsSL -o "$HOME/.findwright/helper/<file>" "<url>"`, typed `curl.exe` in Windows PowerShell, where `curl` names another command.
2. Check that the download's SHA-256 is the entry's `sha256`: `sha256sum` on Linux and in Git Bash, `shasum -a 256` on macOS, `Get-FileHash -Algorithm SHA256` in PowerShell. When it differs, delete the file, say the download does not match the plugin, and stop.
3. Install it with no install scripts, then delete the file: `npm install --prefix "$HOME/.findwright/helper" --no-save --ignore-scripts --no-audit --no-fund "$HOME/.findwright/helper/<file>"`.

Read the version again. On a no, or when the install fails, show the install's last lines and stop: the rest needs the helper. When it could not reach the network, say to run setup again once online.

## 3. Register it with Claude Code

Run `claude mcp get findwright`.

- **Not registered:** ask, "Register FindWright for every project on this computer?", "Yes" first. On a yes, run `claude mcp add --scope user findwright -- node "<helper>/src/server.mjs"` with `<helper>` written out in full.
- **Registered with this helper's `server.mjs`:** nothing to do.
- **Registered with another copy** (Bindwright's helper ships one at `~/.bindwright/helper/node_modules/bindwright/findwright/server.mjs`): say which copy runs now, and that the plugin's copy is the one this plugin keeps current. Offer to switch: `claude mcp remove findwright --scope user`, then the `add` above. On a no, leave it.

Say that the tools load from the next session, or after `/mcp` reconnects the servers.

## 4. The search hook

The hook sends Grep, Glob and shell searches to FindWright in repos that have an index, and lets everything else through. Run `node "<helper>/src/cli.mjs" home status`. It prints `{"hook": true|false, "others": [...]}`, where `others` names other code-search hooks registered in the user's settings, such as Bindwright's `findwright-first.py`.

- `hook` true: nothing to do.
- `others` not empty: say which, and that a second hook would answer every search twice, so leave it out.
- Otherwise ask, "Add the search hook, which sends searches to FindWright in indexed repos?", "Yes" first. On a yes, run `node "<helper>/src/cli.mjs" home install-hook`. It backs up the settings file to `settings.json.bak` before the change and refuses a settings file that is not valid JSON; on `{"error": ...}`, show the message and go on without the hook.

## 5. Fit the index to this project

Only inside a git repo (`git rev-parse --show-toplevel`). Ask, "Fit FindWright's index to this project now? It takes a minute.", "Yes" first. On a yes:

1. Run `node "<helper>/src/cli.mjs" coverage` from the repo root. The first run builds the index in `.findwright/`, which keeps itself out of git.
2. Read which file kinds and files yield no symbol. For each group the work cares about, propose an entry for `.findwright/config.json`: `kinds` maps globs to a built-in extractor (`{ "*.mdc": "markdown" }`); `rules` adds a pattern whose `name` group names a symbol (`{ "globs": ["**/*.sql"], "kind": "table", "pattern": "^create table (?<name>\\w+)" }`). Licenses, lock files and ignore lists need nothing: full-text search still covers them.
3. Show the proposed file and write it on a yes, then run `coverage` again and say how many files gained symbols.

## 6. Finish

Say in a few lines what is in place: the helper version, the registration, the hook, and for this project the config written or left out. Say that `/findwright:doctor` checks all of it, `/findwright:update` keeps the helper at the plugin's version, and `/findwright:remove` takes it back out.
