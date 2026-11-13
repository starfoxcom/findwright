---
name: close-session
description: Close a work session. Verifies what is really finished, commits, lands the work, cleans up and hands off to the next session. Use when the maintainer asks for it, or when every task of the session is done; never just because the context is filling up.
---

# /close-session

Run the steps in order without asking between them. Stop and ask only before a force-push, deleting a branch that holds unmerged work, or rewriting history someone else has pulled. If `.claude/rules/visual.md` exists and this session changed what people see, do not push until the maintainer has confirmed the visual check.

## Verify what is done

Only when this session claims a feature or milestone complete. Re-read its definition of done (its issue, ROADMAP, design doc or PR description) and mark each item:

- ✅ **verified**: seen working in the running app, with the commit, the screen or route, and a screenshot or log where it applies;
- ⚠️ **partial**: works in some cases; list the gaps;
- ❌ **unmet**: open a follow-up and stop claiming completion.

One ❌ means the feature is not complete. If an item stopped making sense mid-way, change the definition of done in its own commit first; never quietly call a gap "deferred".

## Derived docs

Update `README.md` or `CLAUDE.md` when this session changed what they describe, and say which sections changed.

Then check the living docs are still current: for each behaviour, name, path, command or number the session's diff changed, search `README.md`, `CLAUDE.md`, `docs/` and `.claude/rules/` for the old wording, and fix every claim that no longer holds. Dated records (released changelog entries, dated notes) stay as written. `docs/docs-audit.md` covers a full sweep.

## Code-research count

Run `python3 .claude/scripts/research-adherence.py` from the repo root (`python` on Windows). It reads the transcript and compares calls to FindWright with plain code searches that carry no bypass marker: Grep and Glob calls, and shell commands that start with a recursive search. Searches of docs, logs and data, and filters on another command's output, do not count. Report its line. Below 70% means the next session starts by finding out why.

## FindWright hit rate

When `$HOME/.bindwright/helper/node_modules/bindwright/findwright/cli.mjs` exists and `node --version` shows 22.13 or later, run `node "$HOME/.bindwright/helper/node_modules/bindwright/findwright/cli.mjs" hits` from the repo root; otherwise say the hit rate is not recorded on this computer, and why, and go on. It scores this session's FindWright searches (a hit when the file the session opened next was in the answer), records the figure in `.findwright/hits.jsonl` and prints `{rate, scored, goal, assess}`. Report the rate against the goal (90% unless `.findwright/config.json` sets `goal`). When `assess` is true, the last three sessions all fell short: run the same command with `assess`, explain each cause and suggested change in plain words, and apply a change to `.findwright/config.json` only on the user's yes.

## Project steps

If `.bindwright/session-steps.md` lists "Extra close steps", run them now, except those marked *after the hand-off*: they run at the end, before the last message.

## Commit and PR

Stage the session's files by name, never `git add -A` or `git add .`. A file `git status` lists that this session did not change stays out of the commit; name it in the last message. Then take the first row that matches:

| Situation | Do |
|---|---|
| Branch goal not finished | Commit the work. No PR. |
| `hotfix/*` finished | PR to `main`. After it merges, open the cascade PR: a `chore/cascade-<name>` branch from `origin/develop` that merges `origin/main` with `--no-ff`, into `develop`. Done only when the cascade merges. |
| `release/*` finished | Same as a hotfix: PR to `main`, tag the release commit, then cascade. |
| Any other branch finished | Commit, open a PR to `develop`, watch the checks, merge once every check has settled and the required ones pass. |

Commit and PR format, `--body-file`, merge style and branch cleanup are in `git.md`; watching checks is in `token-efficiency.md`. Run each post-merge command as its own call.

## Hand-off in the tracker

After the commit and PR, so the state records how they ended. For each issue this session worked on, rewrite its `### Current state` per `.claude/rules/tracker.md`: where the work stands, decisions made and why, what the next session should do first. Work without an issue gets one now with the "New item" command, a branch with no PR included. Rules and conventions stay in `.claude/rules/`; session figures (the code-research count, context use) stay in the chat.

Then post a project status update only when this session completed a milestone or a major arc of one, changed the health colour, or changed the plan; `tracker.md` § Project status updates has the shape. Most sessions post none.

## Hand-off file

Rewrite `.bindwright/handoff.md`. It stays in this checkout, out of git: the first time, add the line `.bindwright/handoff.md` to the file `git rev-parse --git-path info/exclude` prints (a worktree shares it with its main checkout, but keeps its own hand-off file). It only points at the tracker, in at most ten lines, and never restates an issue's state:

```
# Hand-off (YYYY-MM-DD HH:MM)
- Worked on: #12 (PR #40 waiting on review), #15
- Start with: #13
- Open question: <one line, or none>
```

## Steps after the hand-off

Run the extra close steps marked *after the hand-off*, if any: they read this session's finished work and its hand-off.

## Last message

> **Session closed.** Everything is committed; [PR #N merged and branches deleted | branch pushed, PR #N waiting on checks | work committed locally on `<branch>`]. Start a fresh conversation for the next session.
