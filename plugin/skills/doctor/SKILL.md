---
name: doctor
description: "Check that FindWright works on this computer and in this repo, and say in plain words what is wrong and how to fix each thing. Changes nothing."
---

# /findwright:doctor

A read-only health check. It changes nothing; it offers each fix and runs it only on a yes. `<helper>` is `$HOME/.findwright/helper/node_modules/findwright`.

## 1. Checks

Run each, and keep every one that fails as a finding with its fix:

1. **Node:** `node --version` shows 22.16 or later on the 22 line, or 24 or later (Node 23 lacks the SQLite full-text search FindWright needs). Also a finding: a newer release of the same major version in `https://nodejs.org/dist/index.json`, since an old patch leaves known security holes open; a major version outside long-term support is a note. Fix: step 1 of `${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md`, which installs the newest patch.
2. **Helper:** `<helper>/package.json` exists and its `version` is the `version` in `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`. Fix: `/findwright:update`.
3. **Registration:** `claude mcp get findwright` names `<helper>/src/server.mjs`. Another copy (such as Bindwright's) is a note, not a failure: say which one runs. Missing is a finding. Fix: step 4 of the setup skill.
4. **The server starts:** `node "<helper>/src/cli.mjs" coverage` inside a git repo prints the index's file counts, and `node "<helper>/src/cli.mjs" find setup` exits without an error. An error naming the meaning model is a finding, unless the registration sets `FINDWRIGHT_MEANING=off`. Fix: step 3 of the setup skill. Outside a repo, skip it.
5. **Hook:** `node "<helper>/src/cli.mjs" home status`. With `hook` false and `others` empty, the hook is missing (a note: searches still work, they just are not routed). With both, two hooks answer each search: a finding, fixed with `node "<helper>/src/cli.mjs" home remove-hook`.
6. **This repo's config:** when `.findwright/config.json` exists, it must parse as JSON. Fix: show the parse error and the line.

## 2. Report

No findings: one line, with the plugin and helper versions. Otherwise one short line per finding, what is wrong and what to do, most serious first, leaving out what passed. Offer each fix that is a command or a skill, one at a time, on a yes.

When a finding looks like a bug in FindWright itself (a crash, an error from the server, a count that contradicts what the user sees), draft an issue with the error text, after taking out paths, names and tokens, show the user the full text, and give them the link https://github.com/starfoxcom/findwright/issues/new to file it themselves.
