---
name: setup
description: "Install FindWright on this computer, register it with Claude Code and, inside a project, fit its index to that project. Use when the user asks to set up or install FindWright, or when its tools are missing."
---

# /findwright:setup

Sets FindWright up: a supported Node with every security fix, the helper (the part that runs on this computer), its meaning model, its registration with Claude Code and its guidance for the agent, the search hook and, inside a git repo, an index fitted to the project. Setup first checks what is in place without changing anything, then shows one plan of everything it will install or change and applies it on one yes. FindWright is on only when all of it is in place. When a requirement cannot be installed, or the user does not want it, stop and say FindWright stays off until it is there; there is no half-working mode.

`<helper>` is `$HOME/.findwright/helper/node_modules/findwright` in every FindWright skill, and `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`. `<home>` is the user's home folder, `$HOME`, written out in full in each command.

## 1. Check what is in place

Change nothing in this step; it only reads.

- **Node:** run `node --version`. FindWright needs Node 22.16 or later on the 22 line, or 24 or later, since it keeps its index in Node's built-in SQLite and needs its full-text search, which Node 23 and Node 22 before 22.16 lack. With a Node that qualifies, read Node's public release list, `https://nodejs.org/dist/index.json` (newest first; each entry has `version`, and `lts`, which is `false` for a release outside long-term support), for a newer release of the same major, which carries security fixes this one lacks. When the list cannot be read, note it for the plan.
- **Helper:** `node -p "require(process.argv[1]).version" "<helper>/package.json"`, against the `version` in `<plugin>/.claude-plugin/plugin.json`.
- **Registration:** `claude mcp get findwright`, and which `server.mjs` it runs.
- With a helper installed, **the rest of the computer:** `node "<helper>/src/cli.mjs" home status` prints `{"hook": true|false, "others": [...], "autoUpdate": ..., "guidance": ...}`, where `others` names other code-search hooks registered in the user's settings, such as Bindwright's `findwright-first.py`. Without a helper, it cannot be read yet: the plan lists the hook and auto-update as conditional, and steps 7 and 10 read it once the helper is in.
- Inside a git repo (`git rev-parse --show-toplevel`), **the project:** whether `.findwright/config.json` has a `rules` list.

**When Bindwright's setup hands over.** When this skill is followed as a hand-over from Bindwright's setup, that setup's plan already listed FindWright's part and got the user's yes: skip step 2, and apply every step below that step 1 found due, the search hook included: step 7 leaves it out when another code-search hook is registered.

## 2. The plan

When everything is in place, say so in one line, with the helper's version, and go on to step 9.

Otherwise, show one plan in plain words, in two groups, with what is already in place named in one line after them:

- **On this computer:**
  - Node, when it is missing, too old or behind on security fixes: on Windows, installed or updated through winget; on macOS and Linux, the installer from nodejs.org for the user to run, since installing there asks for their password. Say that Claude Code then restarts and setup runs again for the rest, since a running session does not see a program installed after it started.
  - The helper <version>, the part that builds and searches the index: downloaded from FindWright's GitHub release, checked against the SHA-256 the plugin pins, and installed into `~/.findwright/helper` for this user only, with no admin rights.
  - The meaning model, a small code model that ranks files by meaning as well as by words: checked, and downloaded from Hugging Face (32 MB) when it is not there yet.
  - The registration with Claude Code for every project on this computer, so the tools load in every session.
  - The guidance for the agent, `~/.claude/rules/findwright.md`: when to use which tool, when a fallback to Grep or Glob is allowed, and the hit rate to report when a session closes.
  - The search hook, which sends Grep, Glob and shell searches to FindWright in repos that have an index and lets everything else through; it backs up `settings.json` first. Leave it out of the plan when `others` names another code-search hook, since a second hook would answer every search twice, and say why. On a first install, say it goes in unless another code-search hook turns up once the helper can read the settings.
  - Auto-update for the wrights marketplace, only when `<plugin>` sits under `plugins/cache/wrights/` and `autoUpdate` is `null`, or on a first install, where it is read once the helper is in: new FindWright versions then install by themselves. A setting the user turned off stays off.
- **In this project**, inside a git repo with no `rules` list in its config: FindWright reads the project and writes the rules that name its code into `.findwright/config.json`, then builds the index in `.findwright/`, a folder that keeps itself out of git. It takes a few minutes.

Then ask one question, "Set all of this up?", with "Yes" first and recommended, "Yes, without the search hook" when the plan holds the hook, and "No". On "No", change nothing, say that FindWright stays off until setup runs again and gets a yes, and stop.

## 3. Node

Only when step 1 found Node missing, too old, on 23, or behind on security fixes.

- **Missing, too old or 23:** install the current long-term-support Node: on Windows, run `winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements`; on macOS and Linux, give the installer from nodejs.org for the user to run, since the distributions' own `nodejs` package is often too old. Then say to restart Claude Code (quit and reopen the desktop app or the editor it runs in, or start `claude` again in a new terminal window) and to run `/findwright:setup` again, which picks up from there. Stop here.
- **Behind on security fixes:** on Windows, run `winget upgrade --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements` (`OpenJS.NodeJS` in place of `OpenJS.NodeJS.LTS` when this Node is outside long-term support), and when it installs a newer Node, say to restart Claude Code and run `/findwright:setup` again, and stop. On macOS and Linux, give the installer for the newest release from nodejs.org for the user to run. Otherwise go on, naming the Node that runs (`where node` on Windows, `which -a node` elsewhere): when it comes from a version manager (nvm, fnm, volta), Homebrew or a manual install, say to update it with that tool; when it is winget's own, say winget does not offer the newest release yet. The next setup or doctor checks again.
- **This major is outside long-term support** (as Node 25 is): say in one line that it gets security fixes for a few months only and that the long-term-support installer is the safer choice, then go on.
- **The release list could not be read:** say so in one line and go on; the next setup or doctor reads it again.

## 4. The helper

Only when step 1 found it missing or at another version than the plugin's. Say in one line that the helper is being installed (or updated to <version>), then install exactly the release `<plugin>/helper.json` names under `node`, which the plugin pins by its SHA-256.

**With a helper already installed,** run `node "<helper>/src/cli.mjs" follow --plugin "<plugin>"` instead of the steps below. It downloads the release into a staging folder of its own, checks it, installs it there and swaps it in under the lock the helper's own update at session start takes, so two sessions never install over each other, then fetches the meaning model the new helper pins. It prints one line of JSON:

- `{"from", "to"}`: installed.
- `{"from", "to", "error"}`: it failed and the old helper stays. When the error says another update kept the helper locked, another session is installing it: run the same command again 30 seconds later. Any other error is a failure, handled by the rule below.
- `{"current", "pinned"}`: nothing was due, as when another session installed it a moment ago. When `current` is still not the plugin's version, the helper predates `--plugin` and read its pin elsewhere: use the steps below.

**Without one,** follow the steps. When any of them fails, delete `<download>`, show the failing command's last lines, say what failed, and that setup runs again once online when it could not reach the network, then stop, since the rest needs the helper:

1. Download the entry's `url` under its `file` name into a folder of this run's own, `<download>`, made with a command that picks a name no other run has and fails rather than reuse one: create `<home>/.findwright/helper` first, then `mktemp -d "<home>/.findwright/helper/download-XXXXXX"` on Linux, macOS and in Git Bash, or `(New-Item -ItemType Directory "<home>/.findwright/helper/download-$([guid]::NewGuid())").FullName` in PowerShell, and take `<download>` from the path it prints. Another session may install at the same moment, and a folder of its own keeps it from deleting or replacing the file this run installs from: `curl -fsSL -o "<download>/<file>" "<url>"`, typed `curl.exe` in Windows PowerShell, where `curl` names another command.
2. Check that the download's SHA-256 is the entry's `sha256`: `sha256sum` on Linux and in Git Bash, `shasum -a 256` on macOS, `Get-FileHash -Algorithm SHA256` in PowerShell. When it differs, the step fails: the download does not match the plugin.
3. Install it with no install scripts, then delete `<download>`: `npm install --prefix "<home>/.findwright/helper" --no-save --ignore-scripts --no-audit --no-fund "<download>/<file>"`.

Then read the version again: when it still is not the plugin's, the install failed, and the same rule applies.

## 5. The meaning model

Run `node "<helper>/src/cli.mjs" model`, saying in one line that it downloads 32 MB from Hugging Face when the model is not there yet. It checks each file against the SHA-256 the helper pins, loads it, and prints `{"model": ..., "folder": ...}`. On `{"error": ...}`, show the message, say that setup runs again once online when the download could not reach the network, and stop: the model is part of FindWright, like the helper, and find refuses to answer without it rather than quietly rank worse.

## 6. Register it with Claude Code

- **Not registered:** run `claude mcp add --scope user findwright -- node "<helper>/src/server.mjs"` with `<helper>` written out in full.
- **Registered with this helper's `server.mjs`:** nothing to do.
- **Registered with another copy** (an older Bindwright's helper shipped one at `~/.bindwright/helper/node_modules/bindwright/findwright/server.mjs`): say which copy runs now, and that the plugin's copy is the one this plugin keeps current, so setup switches to it: `claude mcp remove findwright --scope user`, then the `add` above.

Then write the guidance: run `node "<helper>/src/cli.mjs" home install-guidance`. It writes `rules/findwright.md` in Claude Code's config folder, a file FindWright owns and keeps current, and prints `{"guidance": <path>, "written": true|false}`.

## 7. The search hook

Only when the plan held the hook and the answer was "Yes", or on a hand-over from Bindwright's setup. Read `node "<helper>/src/cli.mjs" home status` again now that the helper is in, since on a first install step 1 had no helper to read it with. When `others` names another code-search hook, say which, and that a second hook would answer every search twice, so it stays out. Otherwise, when `hook` is false, run `node "<helper>/src/cli.mjs" home install-hook`. It backs up the settings file to `settings.json.bak` before the change and refuses a settings file that is not valid JSON; on `{"error": ...}`, show the message and say the hook is off until the settings file is fixed and setup runs again, then go on, since FindWright itself works without it.

## 8. Fit the index to this project

Only inside a git repo whose `.findwright/config.json` has no `rules` list: say in one line that FindWright is being fitted to this project, and follow `<plugin>/skills/fit/SKILL.md`. The plan's yes covers the fit, so save the config without asking again, always with a `rules` list (an empty one when the project needs none), and say what it covers. The first `coverage` run builds the index.

## 9. Anonymous usage counts

Asked once per computer: only when `node "<helper>/src/cli.mjs" counts status` prints `"asked": false`. Ask:

- **Share anonymous usage counts?** Once a day, each project on this computer whose kind the user picks sends four numbers about FindWright's searches more than an hour old (how many sessions searched, how many searches the session followed by opening a project file, how many of those answers named that file, and the answers' total size in bytes) and the start and end time of the span they cover, so the FindWright page can show results from real projects. A project goes in under a random id and a kind the user picks; no names, code, queries, file names, usernames or repo links leave the computer. The counter also keeps the country Cloudflare reads from the connection, and publishes only how many projects each country has. Offer "No" first and "Yes" second, neither marked recommended: it stays off unless they say yes.

Save the answer with `node "<helper>/src/cli.mjs" counts share on` (or `share off`).

Then, inside a git repo, when sharing is on and `counts status` run from the repo root prints `"kind": null`, ask:

- **What kind of project is this?** The page lists the top projects by kind only. Game, business app, developer tool, mobile app, website, other, or "leave this project out".

Save it from the repo root with `node "<helper>/src/cli.mjs" counts project <kind>`, the kind written `game`, `business-app`, `developer-tool`, `mobile-app`, `website` or `other`, or `none` to leave it out, which is remembered so no later run asks again. The counts cover the project's past sessions too, sent oldest first in daily batches.

## 10. Updates

FindWright keeps itself current. Claude Code's auto-update for the marketplace moves the plugin. When a session starts with a plugin that pins another helper, the search server installs that release in the background, checked against its SHA-256, then fetches the meaning model it pins; the next session runs the new helper and is told in one line that it happened, or why it could not, in which case the old helper keeps working.

Only when this plugin came from the wrights marketplace (`<plugin>` sits under `plugins/cache/wrights/`), by the `autoUpdate` that `home status` prints now that the helper is in:

- `null`: never set. Run `node "<helper>/src/cli.mjs" home auto-update on`, which backs up the settings file first. It is the same setting Bindwright uses, since both plugins come from wrights.
- `false`: the user turned it off. Leave it, and say in one line that updates then come from `/plugin`.
- `true`: nothing to do.

## 11. Finish

Say in a few lines what is in place: the Node version, the helper version, the meaning model, the registration, the guidance, the hook, auto-update on or off, the counts on or off, and for this project the config written or left out and its kind for the counts. Say that FindWright's tools and guidance load from the next session (or the tools after `/mcp` reconnects the servers), and that `/findwright:doctor` checks all of it whenever something seems off.
