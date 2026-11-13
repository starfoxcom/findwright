---
name: start-session
description: Start a work session. Reads the project state and git state, then proposes a plan and waits for approval. Use at the start of every session, or when the user says "session start", "let's start" or "ready to work".
---

# /start-session

Planning only. Create no branches and change no files in this turn, apart from the session's purpose note in step 4 where it applies.

## 1. Read

- The tracker, with the commands in `.claude/rules/tracker.md`: the open items (in progress first, then the next in queue, and items on hold apart with what each waits on), and the newest project status update. An item's `### Current state` is the last session's hand-off; it outranks anything re-derived from git.
- `.bindwright/pending-tracker.md`, if it exists: writes an offline close could not post (`tracker.md`). Read them as part of the hand-off, post them once the plan is approved, then delete the file.
- Ask of that status update: is its colour still true, given the board and what this session finds? If not, the colour has changed: say so in the report, and post the new update once the plan is approved.
- `.bindwright/handoff.md`, if it exists: the last session's pointers in this checkout. Read it first, then the issues it names; where they disagree, the issues win.
- `.bindwright/session-steps.md` if it exists: its "Extra start steps" run after the git checks below.

If the focus is unclear from the user's message or the current branch, ask before reading further.

## 2. Check git

Run these as separate calls, in parallel:

- `git status`
- `git branch --show-current`
- `git log --oneline -10`
- `git fetch --prune origin`, then `git rev-list --count HEAD..origin/develop` (how far behind the current branch is)
- `gh pr list --author @me --state open`

Then run the extra start steps, if any.

Last, Bindwright's own check. In `plugins/installed_plugins.json` in the Claude config folder (`$CLAUDE_CONFIG_DIR`, or `~/.claude`), take the `bindwright` install that applies here: the one whose `projectPath` is this repo root, otherwise the one with `scope` `managed` or `user`; never one whose `projectPath` names another folder. Skip the step when the most specific settings file that sets that plugin's `enabledPlugins` entry (the managed settings an administrator installs, then `.claude/settings.local.json`, then `.claude/settings.json`, then `settings.json` in the config folder) sets it to `false`: a plugin turned off in `/plugin` stays installed. Otherwise run `node "$HOME/.bindwright/helper/node_modules/bindwright/hooks/notice.mjs" --plugin "<installPath>"` from the repo root. At most once a day it prints a line when the plugin, its helper or this repo's Bindwright files are behind; put any line it prints at the top of the report. It prints nothing otherwise. Run it outside the Bash sandbox when one is on: inside it the opt-in counts send cannot reach the network. A missing or unreadable file, plugin, helper or Node skips the step without a word, with one exception: when a `bindwright` install applies here and is not turned off, the helper is missing, and `bindwright/counts.json` in the Claude config folder holds `"share": true` with an entry for this repo whose `kind` is set, put one line at the top of the report instead: this computer turned the review counts on, but they are not being sent while Bindwright's helper is missing, and `/bindwright:setup` installs it again.

## 3. Report, in this order

1. **Project status:** current focus, open work, blockers.
2. **Git status:** current branch, uncommitted changes, how far behind `develop` it is, open PRs. If `develop` has moved ahead, propose merging it in before resuming: `git fetch origin`, then `git merge origin/develop` on the work branch.
3. **Branch:** if the work needs a new branch, propose its name per `git.md` and ask before creating it.
4. **Areas touched:** the directories the plan will change. Anything outside the branch's scope becomes a prerequisite branch that lands first; name it.
5. **Plan:** the ordered steps, with dependencies. Three to seven steps; split anything larger into another session.

## 4. Stop

When the session-title hook named a purpose file at the start of this session (Bindwright's global `session-title` extra), write this session's purpose to that file before ending the turn: what the plan works on, in 10 words at most and as few as will do, without the project's name. That is the one file this turn writes. From the next prompt, the one that approves the plan, the session's title reads `<Project> - <purpose>`. Rewrite the file when the user corrects the plan or the session's focus changes.

End the turn after the report. Once the user approves or corrects the plan, create the tasks per `.claude/rules/task-tracking.md` and start.

Produce every section even when a branch with work in progress is already checked out.
