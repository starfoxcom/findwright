---
name: setup
description: "Install FindWright on this computer, register it with Claude Code and, inside a project, fit its index to that project. Use when the user asks to set up or install FindWright, or when its tools are missing."
---

# /findwright:setup

Sets FindWright up: a supported Node with every security fix, the helper (the part that runs on this computer), its meaning model and its registration with Claude Code, then offers the search hook and, inside a git repo, fits the index to the project. Running setup is the yes to everything FindWright needs to work: say what each step installs, then install it, without asking again. FindWright is on only when all of it is in place. When a requirement cannot be installed, or the user does not want it, stop and say FindWright stays off until it is there; there is no half-working mode.

`<helper>` is `$HOME/.findwright/helper/node_modules/findwright` in every FindWright skill, and `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`. `<home>` is the user's home folder, `$HOME`, written out in full in each command.

## 1. Node

Run `node --version`. FindWright needs Node 22.16 or later on the 22 line, or 24 or later, since it keeps its index in Node's built-in SQLite and needs its full-text search, which Node 23 and Node 22 before 22.16 lack. When Node is missing or older, or is 23, say so in one line and install the current long-term-support Node: on Windows, run `winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements`; on macOS and Linux, give the installer from nodejs.org for the user to run, since installing there asks for their password and the distributions' own `nodejs` package is often too old. Then say to restart Claude Code, since a running session does not see a program installed after it started, and to run `/findwright:setup` again. Stop here.

Then check that this Node has every security fix. Read Node's public release list, `https://nodejs.org/dist/index.json` (newest first; each entry has `version`, and `lts`, which is `false` for a release outside long-term support).

- **A newer release of this major is listed:** say in one line that Node <version> is behind on security fixes and <newest> is out, and install it. On Windows, run `winget upgrade --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements` (`OpenJS.NodeJS` in place of `OpenJS.NodeJS.LTS` when this Node is outside long-term support), and when it installs a newer Node, say to restart Claude Code and run `/findwright:setup` again, and stop. On macOS and Linux, give the installer for <newest> from nodejs.org for the user to run. Otherwise go on, naming the Node that runs (`where node` on Windows, `which -a node` elsewhere): when it comes from a version manager (nvm, fnm, volta), Homebrew or a manual install, say to update it with that tool; when it is winget's own, say winget does not offer <newest> yet. The next setup or doctor checks again.
- **This major is outside long-term support** (as Node 25 is): say in one line that it gets security fixes for a few months only and that the long-term-support installer above is the safer choice, then go on.
- **The list cannot be read:** say so in one line and go on; the next setup or doctor reads it again.

## 2. The helper

The helper is ready when `node -p "require(process.argv[1]).version" "<helper>/package.json"` prints the `version` in `<plugin>/.claude-plugin/plugin.json`. When it is missing or holds another version, say in one line that the helper, the part that builds and searches the index, is being installed (or updated to <version>) for this user only, with no admin rights, then install exactly the file `<plugin>/helper.json` names under `node`, which the plugin pins by its SHA-256:

1. Create `<home>/.findwright/helper/` and download the entry's `url` into it under its `file` name: `curl -fsSL -o "<home>/.findwright/helper/<file>" "<url>"`, typed `curl.exe` in Windows PowerShell, where `curl` names another command.
2. Check that the download's SHA-256 is the entry's `sha256`: `sha256sum` on Linux and in Git Bash, `shasum -a 256` on macOS, `Get-FileHash -Algorithm SHA256` in PowerShell. When it differs, delete the file, say the download does not match the plugin, and stop.
3. Install it with no install scripts, then delete the file: `npm install --prefix "<home>/.findwright/helper" --no-save --ignore-scripts --no-audit --no-fund "<home>/.findwright/helper/<file>"`.

Read the version again. When the install fails, show its last lines and stop: the rest needs the helper. When it could not reach the network, say to run setup again once online.

## 3. The meaning model

FindWright ranks files by meaning as well as by words, with a small code model. Say in one line that it downloads 32 MB from Hugging Face, then run `node "<helper>/src/cli.mjs" model`. It checks each file against the SHA-256 the helper pins, loads it, and prints `{"model": ..., "folder": ...}`. On `{"error": ...}`, show the message and stop: the model is part of FindWright, like the helper, and find refuses to answer without it rather than quietly rank worse. When the download could not reach the network, say to run setup again once online.

## 4. Register it with Claude Code

Run `claude mcp get findwright`.

- **Not registered:** say it is being registered for every project on this computer, then run `claude mcp add --scope user findwright -- node "<helper>/src/server.mjs"` with `<helper>` written out in full.
- **Registered with this helper's `server.mjs`:** nothing to do.
- **Registered with another copy** (Bindwright's helper ships one at `~/.bindwright/helper/node_modules/bindwright/findwright/server.mjs`): say which copy runs now, and that the plugin's copy is the one this plugin keeps current, so setup switches to it: `claude mcp remove findwright --scope user`, then the `add` above.

Then write FindWright's guidance for the agent, which every session reads: when to use which tool, when a fallback to Grep or Glob is allowed, and the hit-rate step when a session closes. Run `node "<helper>/src/cli.mjs" home install-guidance`. It writes `rules/findwright.md` in Claude Code's config folder, a file FindWright owns and keeps current, and prints `{"guidance": <path>, "written": true|false}`. Say in one line where it went.

Say that the tools and the guidance load from the next session, or the tools after `/mcp` reconnects the servers.

## 5. The search hook

The hook sends Grep, Glob and shell searches to FindWright in repos that have an index, and lets everything else through. Run `node "<helper>/src/cli.mjs" home status`. It prints `{"hook": true|false, "others": [...], "autoUpdate": ...}`, where `others` names other code-search hooks registered in the user's settings, such as Bindwright's `findwright-first.py`.

- `hook` true: nothing to do.
- `others` not empty: say which, and that a second hook would answer every search twice, so leave it out.
- Otherwise ask, "Add the search hook, which sends searches to FindWright in indexed repos?", "Yes" first. On a yes, run `node "<helper>/src/cli.mjs" home install-hook`. It backs up the settings file to `settings.json.bak` before the change and refuses a settings file that is not valid JSON; on `{"error": ...}`, show the message and say the hook is off until it is fixed, then go on: FindWright itself works without it, and a later `/findwright:setup` adds it.

## 6. Fit the index to this project

Only inside a git repo (`git rev-parse --show-toplevel`). FindWright names a project's code with the rules in its config: when `.findwright/config.json` has no `rules` list, say in one line that FindWright is being fitted to this project, which takes a few minutes, and follow `<plugin>/skills/fit/SKILL.md`. Running setup is the yes to the fit, so save the config without asking again, always with a `rules` list (an empty one when the project needs none), and say what it covers. When the config already has rules, say so and leave them. The first `coverage` run builds the index in `.findwright/`, which keeps itself out of git.

## 7. Anonymous usage counts

Asked once per computer: only when `node "<helper>/src/cli.mjs" counts status` prints `"asked": false`. Ask:

- **Share anonymous usage counts?** Once a day, each project on this computer whose kind the user picks sends four numbers about FindWright's searches more than an hour old (how many sessions searched, how many searches the session followed by opening a project file, how many of those answers named that file, and the answers' total size in bytes) and the start and end time of the span they cover, so the FindWright page can show results from real projects. A project goes in under a random id and a kind the user picks; no names, code, queries, file names, usernames or repo links leave the computer. The counter also keeps the country Cloudflare reads from the connection, and publishes only how many projects each country has. Offer "No" first and "Yes" second, neither marked recommended: it stays off unless they say yes.

Save the answer with `node "<helper>/src/cli.mjs" counts share on` (or `share off`).

Then, inside a git repo, when sharing is on and `counts status` run from the repo root prints `"kind": null`, ask:

- **What kind of project is this?** The page lists the top projects by kind only. Game, business app, developer tool, mobile app, website, other, or "leave this project out".

Save it from the repo root with `node "<helper>/src/cli.mjs" counts project <kind>`, the kind written `game`, `business-app`, `developer-tool`, `mobile-app`, `website` or `other`, or `none` to leave it out, which is remembered so no later run asks again. The counts cover the project's past sessions too, sent oldest first in daily batches.

## 8. Updates

FindWright keeps itself current. Claude Code's auto-update for the marketplace moves the plugin. When a session starts with a plugin that pins another helper, the search server installs that release in the background, checked against its SHA-256, then fetches the meaning model it pins; the next session runs the new helper and is told in one line that it happened, or why it could not, in which case the old helper keeps working.

Only when this plugin came from the wrights marketplace (`<plugin>` sits under `plugins/cache/wrights/`): read `autoUpdate` from the `home status` of step 5.

- `null`: never set. Turn it on, since it is on by default: run `node "<helper>/src/cli.mjs" home auto-update on`, and say in one line that new FindWright versions now install by themselves, a few minutes into a session, and that `home auto-update off` turns that off. It backs up the settings file first. It is the same setting Bindwright uses, since both plugins come from wrights.
- `false`: the user turned it off. Leave it, and say in one line that updates then come from `/plugin`.
- `true`: nothing to do.

## 9. Finish

Say in a few lines what is in place: the Node version, the helper version, the meaning model, the registration, the guidance, the hook, auto-update on or off, the counts on or off, and for this project the config written or left out and its kind for the counts. Say that `/findwright:doctor` checks all of it, `/findwright:update` brings the helper to the plugin's version on demand, and `/findwright:remove` takes it back out.
