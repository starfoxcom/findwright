---
name: setup
description: "Install FindWright on this computer, register it with Claude Code and, inside a project, fit its index to that project. Use when the user asks to set up or install FindWright, or when its tools are missing."
---

# /findwright:setup

Sets FindWright up: a supported Node with every security fix, the helper (the part that runs on this computer), its meaning model and its registration with Claude Code, then offers the search hook and, inside a git repo, to fit the index to the project. Running setup is the yes to everything FindWright needs to work: say what each step installs, then install it, without asking again. FindWright is on only when all of it is in place. When a requirement cannot be installed, or the user does not want it, stop and say FindWright stays off until it is there; there is no half-working mode.

`<helper>` is `$HOME/.findwright/helper/node_modules/findwright` in every FindWright skill, and `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`.

## 1. Node

Run `node --version`. FindWright needs Node 22.16 or later on the 22 line, or 24 or later, since it keeps its index in Node's built-in SQLite and needs its full-text search, which Node 23 and Node 22 before 22.16 lack. When Node is missing or older, or is 23, say so in one line and install it: on Windows, run `winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements`; on macOS, `brew install node@<major>` for the newest long-term-support major in Node's release list (below) when Homebrew is there; elsewhere, and on Linux, where installing asks for the user's password, give the installer from nodejs.org for the user to run, since the distributions' own `nodejs` package is often too old. Then say to restart Claude Code, since a running session does not see a program installed after it started, and to run `/findwright:setup` again. Stop here.

Then check that this Node has every security fix. FindWright supports long-term-support lines only. Read Node's public release list, `https://nodejs.org/dist/index.json` (newest first; each entry has `version` and `lts`, which is `false` for a release outside long-term support).

- **A long-term-support line, behind on patches** (the list has a newer release of this major): say in one line that Node <version> is behind on security fixes and <newest> is out, and install it: on Windows, `winget upgrade --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements`; on macOS, `brew upgrade node@<major>` when Homebrew is there; elsewhere, give the installer from nodejs.org for the user to run. When the upgrade installs a newer Node, say to restart Claude Code and run `/findwright:setup` again, and stop. When it installs nothing newer, because the package manager has not caught up with nodejs.org, say so in one line and go on: this is the newest Node that installer has, and the next setup or doctor checks again.
- **Not a long-term-support line** (this major's releases all have `lts` false, as Node 25 does): say so, and install the newest long-term-support major as in the first paragraph. Then say to restart Claude Code and run `/findwright:setup` again, and stop. When `node --version` still shows the other line after that restart, an older install comes first on the PATH: say which (`where node` on Windows, `which -a node` elsewhere) and stop, since FindWright stays off on a line without long-term support.
- **When the list cannot be read:** say so in one line and go on with the version checks above only; the next setup or doctor reads the list again.

## 2. The helper

The helper is ready when `node -p "require(process.argv[1]).version" "<helper>/package.json"` prints the `version` in `<plugin>/.claude-plugin/plugin.json`. When it is missing or holds another version, say in one line that the helper, the part that builds and searches the index, is being installed (or updated to <version>) for this user only, with no admin rights, then install exactly the file `<plugin>/helper.json` names under `node`, which the plugin pins by its SHA-256:

1. Create `$HOME/.findwright/helper/` and download the entry's `url` into it under its `file` name: `curl -fsSL -o "$HOME/.findwright/helper/<file>" "<url>"`, typed `curl.exe` in Windows PowerShell, where `curl` names another command.
2. Check that the download's SHA-256 is the entry's `sha256`: `sha256sum` on Linux and in Git Bash, `shasum -a 256` on macOS, `Get-FileHash -Algorithm SHA256` in PowerShell. When it differs, delete the file, say the download does not match the plugin, and stop.
3. Install it with no install scripts, then delete the file: `npm install --prefix "$HOME/.findwright/helper" --no-save --ignore-scripts --no-audit --no-fund "$HOME/.findwright/helper/<file>"`.

Read the version again. When the install fails, show its last lines and stop: the rest needs the helper. When it could not reach the network, say to run setup again once online.

## 3. The meaning model

FindWright ranks files by meaning as well as by words, with a small code model. Say in one line that it downloads 32 MB from Hugging Face, then run `node "<helper>/src/cli.mjs" model`. It checks each file against the SHA-256 the helper pins, loads it, and prints `{"model": ..., "folder": ...}`. On `{"error": ...}`, show the message and stop: FindWright's find refuses to answer without the model rather than quietly rank worse. A user who does not want the model turns meaning search off for good with the environment variable `FINDWRIGHT_MEANING=off` in the registration below (`claude mcp add` takes it as `-e FINDWRIGHT_MEANING=off`); say that this is the off switch, not a lighter mode.

## 4. Register it with Claude Code

Run `claude mcp get findwright`.

- **Not registered:** say it is being registered for every project on this computer, then run `claude mcp add --scope user findwright -- node "<helper>/src/server.mjs"` with `<helper>` written out in full.
- **Registered with this helper's `server.mjs`:** nothing to do.
- **Registered with another copy** (Bindwright's helper ships one at `~/.bindwright/helper/node_modules/bindwright/findwright/server.mjs`): say which copy runs now, and that the plugin's copy is the one this plugin keeps current, so setup switches to it: `claude mcp remove findwright --scope user`, then the `add` above.

Say that the tools load from the next session, or after `/mcp` reconnects the servers.

## 5. The search hook

The hook sends Grep, Glob and shell searches to FindWright in repos that have an index, and lets everything else through. Run `node "<helper>/src/cli.mjs" home status`. It prints `{"hook": true|false, "others": [...]}`, where `others` names other code-search hooks registered in the user's settings, such as Bindwright's `findwright-first.py`.

- `hook` true: nothing to do.
- `others` not empty: say which, and that a second hook would answer every search twice, so leave it out.
- Otherwise ask, "Add the search hook, which sends searches to FindWright in indexed repos?", "Yes" first. On a yes, run `node "<helper>/src/cli.mjs" home install-hook`. It backs up the settings file to `settings.json.bak` before the change and refuses a settings file that is not valid JSON; on `{"error": ...}`, show the message and say the hook is off until it is fixed, then go on: FindWright itself works without it, and a later `/findwright:setup` adds it.

## 6. Fit the index to this project

Only inside a git repo (`git rev-parse --show-toplevel`). Ask, "Fit FindWright's index to this project now? It takes a minute.", "Yes" first. On a yes:

1. Run `node "<helper>/src/cli.mjs" coverage` from the repo root. The first run builds the index in `.findwright/`, which keeps itself out of git.
2. Read which file kinds and files yield no symbol. For each group the work cares about, propose an entry for `.findwright/config.json`: `kinds` maps globs to a built-in extractor (`{ "*.mdc": "markdown" }`); `rules` adds a pattern whose `name` group names a symbol (`{ "globs": ["**/*.sql"], "kind": "table", "pattern": "^create table (?<name>\\w+)" }`). Licenses, lock files and ignore lists need nothing: full-text search still covers them.
3. Show the proposed file and write it on a yes, then run `coverage` again and say how many files gained symbols.

## 7. Finish

Say in a few lines what is in place: the Node version, the helper version, the meaning model, the registration, the hook, and for this project the config written or left out. Say that `/findwright:doctor` checks all of it, `/findwright:update` keeps the helper at the plugin's version, and `/findwright:remove` takes it back out.
