---
name: doctor
description: "Check that FindWright works on this computer and in this repo, and say in plain words what is wrong and how to fix each thing. Changes nothing."
---

# /findwright:doctor

A read-only health check. It changes nothing; it offers each fix and runs it only on a yes. `<helper>` is `$HOME/.findwright/helper/node_modules/findwright`.

## 1. Checks

Run each, and keep every one that fails as a finding with its fix:

1. **Node:** `node --version` shows 22.16 or later on the 22 line, or 24 or later (Node 23 lacks the SQLite full-text search FindWright needs). Also a finding: a newer release of the same major version in `https://nodejs.org/dist/index.json`, since an old patch leaves known security holes open; a major version outside long-term support is a note. Fix: `/findwright:update`, whose Node step installs the newest patch on Windows and names the installer elsewhere.
2. **Helper:** `<helper>/package.json` exists and its `version` is the `version` in `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`. The server brings it there in the background when a session starts, so a helper still behind a session later means that update failed: `node "<helper>/src/cli.mjs" follow` runs it again and prints why it fails. Fix: `/findwright:update`.
3. **Registration:** `claude mcp get findwright` names `<helper>/src/server.mjs`. Another copy (such as Bindwright's) is a note, not a failure: say which one runs. Missing is a finding. Fix: `/findwright:update`, which registers it.
4. **The server starts:** `node "<helper>/src/cli.mjs" coverage` inside a git repo prints the index's file counts, and `node "<helper>/src/cli.mjs" find setup` exits without an error. An error naming the meaning model is a finding. Fix: `/findwright:update`, which fetches the model. Any other error is a finding too: show it, and treat it as a bug in FindWright (§ 2). Outside a repo, skip it.
5. **Hook:** `node "<helper>/src/cli.mjs" home status`. With `hook` false and `others` empty, the hook is missing (a note: searches still work, they just are not routed). With both, two hooks answer each search: a finding, fixed with `node "<helper>/src/cli.mjs" home remove-hook`. The same status's `autoUpdate`, for a plugin from the wrights marketplace: `false` is a note (updates come from `/plugin`), `null` a note fixed with `home auto-update on`. The same status's `guidance`: `"missing"` is a finding, since sessions then do not know when to use FindWright or report the hit rate at close, and `"outdated"` a note, since the next session start rewrites it; both are fixed with `home install-guidance`.
6. **This repo's config:** when `.findwright/config.json` exists, it must parse as JSON. Fix: show the parse error and the line, and offer to correct that line; `/findwright:fit` writes the file again from the project when it is past saving. Inside a git repo, no config, or a config with no `rules` list, is a finding: the project was never fitted, so searches can miss its code by name. Fix: `/findwright:fit`.

## 2. Report

No findings: one line, with the plugin and helper versions. Otherwise one short line per finding, what is wrong and what to do, most serious first, leaving out what passed. Offer each fix that is a command or a skill, one at a time, on a yes.

When a finding looks like a bug in FindWright itself (a crash, an error from the server, a count that contradicts what the user sees), draft an issue with the error text, after taking out paths, names and anything private, show the user the full text, and give them the link https://github.com/starfoxcom/findwright/issues/new to file it themselves.
