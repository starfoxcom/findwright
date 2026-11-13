---
name: update
description: "Bring FindWright's helper up to the plugin's version and check its registration and search hook. Use after the plugin updates, or when a notice says the helper is behind."
---

# /findwright:update

The plugin and its helper move in step: each plugin version pins one helper release by its SHA-256. This skill brings the helper to the plugin's version.

1. Run steps 1 to 3 of `${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md`: Node 22.16 or later (or 24 and up) with every security fix, then the helper, updated to the plugin's version, then the meaning model the new helper pins.
2. Once the new helper is in, read the sections of `<helper>/CHANGELOG.md` for every version after the old helper's, and say, newest first, what is new, changed and fixed, plus anything the user may want to act on.
3. Run step 4 and step 5 of the setup skill, so the registration and the hook point at this helper.

When the helper is already at the plugin's version, say so in one line with the version, run the checks of step 3, and stop.
