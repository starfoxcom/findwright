---
name: update
description: "Bring FindWright's helper up to the plugin's version and check its registration and search hook. Use after the plugin updates, or when a notice says the helper is behind."
---

# /findwright:update

The plugin and its helper move in step: each plugin version pins one helper release by its SHA-256. The search server brings the helper to the plugin's version by itself, in the background, when a session starts; this skill does it on demand, says what changed, and checks the rest of the setup. Running it is the yes to bringing those parts current, so it shows no plan.

1. Run step 1 of `${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md`, which reads what is in place, then its steps 3 to 5: Node 22.16 or later (or 24 and up) with every security fix, the helper, updated to the plugin's version, and the meaning model the helper pins.
2. Once a new helper is in, read the sections of `<helper>/CHANGELOG.md` for every version after the old helper's, and say, newest first, what is new, changed and fixed, plus anything the user may want to act on.
3. Run step 6 of the setup skill, so the registration and the guidance point at this helper. Then read `home status`: when `hook` is false and `others` is empty, ask "Add the search hook, which sends Grep, Glob and shell searches to FindWright in indexed repos?", with "Yes" first, and on a yes run `node "<helper>/src/cli.mjs" home install-hook`, handling an error as setup's step 7 says.
4. Inside a git repo whose `.findwright/config.json` has no `rules` list, run step 8 of the setup skill, which fits FindWright to the project.

When the helper is already at the plugin's version, say so in one line with the version, run the checks of step 3, and stop.
