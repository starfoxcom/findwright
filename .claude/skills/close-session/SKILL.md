---
name: close-session
description: Close a work session. Verifies what is really finished, commits, lands the work, cleans up and hands off to the next session. Use when the maintainer asks for it, or when every task of the session is done.
---

# /close-session

Run the steps in order without asking between them. Stop and ask only before a force-push, deleting a branch that holds unmerged work, or rewriting history someone else has pulled. If `.claude/rules/visual.md` exists and this session changed what people see, do not push until the maintainer has confirmed the visual check.

## Verify what is done

Only when this session claims a feature or milestone complete. Re-read its definition of done (its issue, ROADMAP, design doc or PR description) and mark each item:

- ✅ **verified**: seen working in the running app, with the commit, the screen or route, and a screenshot or log where it applies;
- ⚠️ **partial**: works in some cases; list the gaps;
- ❌ **unmet**: open a follow-up and stop claiming completion.

When `.claude/skills/verify/SKILL.md` exists, say for each change people can see or use whether `/verify` passed before its last commit; one it never ran before is ⚠️ at best.

One ❌ means the feature is not complete. If an item stopped making sense mid-way, change the definition of done in its own commit first; never quietly call a gap "deferred".

## Derived docs

Update `README.md` or `CLAUDE.md` when this session changed what they describe, and say which sections changed.

Then check the living docs are still current: for each behaviour, name, path, command or number the session's diff changed, search `README.md`, `CLAUDE.md`, `docs/` and `.claude/rules/` for the old wording, and fix every claim that no longer holds. Dated records (released changelog entries, dated notes) stay as written. `docs/docs-audit.md` covers a full sweep.

## The code-search tool's own close step

When the guidance FindWright installed for the agent names a step for the end of a session, such as a report on how its searches did, run it here.

## The reply style's close step

When `~/.claude/hooks/reply-style.py` exists, run it with `--report` (with `python3`, or `python` on Windows). It prints `{goal, sessions, assess, worst}`: `sessions` are the newest sessions that measured five replies or more, newest first, each with its `rate` in percent. Say in one line how this session's replies did against the goal: the latest restated reply style names this session's count once it has measured a reply ("held in N of M replies of this session", or "This session so far: N of M"), counted up to the reply before that prompt. When it names none, say no reply was measured yet. Never give a figure it names for "the last session" as this one's. When `assess` is true, the last three sessions all fell short: name `worst`, the rule they broke most, with its count, and propose a change to the reply style's text in `~/.claude/output-styles/` that would prevent it; change the file only on the user's yes.

## Pruning pass

Rules, tests and memory only ever grow, and a long rule file is where a session reads past a rule. So at most once a month, offer to prune, here or at `/start-session`, whichever runs first. The date of the last pass, offered or run, lives in this clone's git config, which its worktrees share and no commit carries: `git config --local bindwright.lastPruning` prints it, and `git config --local bindwright.lastPruning <YYYY-MM-DD>` sets it. When it prints nothing, set today's date and skip this step, so the first offer comes a month after the first close that runs it; when it is less than 30 days old, skip this step. Otherwise ask once: "It has been a month: look for rules, tests and memory entries nothing uses any more?" On a no, set today's date and go on.

On a yes, list the candidates, each with one line on why:

- Rule text in `.claude/rules/` and `CLAUDE.md` that repeats another file, or names a file, command or setting that no longer exists.
- Tests that are skipped for good, or that fail for the same reason as another test in their file (`.claude/rules/testing.md`, rule 2).
- Memory entries in `~/.claude/projects/<project-slug>/memory/` that name a file or function that no longer exists, repeat another entry, or say what the repo's rules already say.
- Memory entries whose `written:` date is more than 90 days old, to confirm and re-date or drop, and entries with no `written:` date, to date from their `source:` or drop.

This is a report only: write nothing for it, in the repo, the tracker or anywhere else, and leave what to do with each candidate to the user. Then set today's date.

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

After the commit and PR, so the state records how they ended. For each issue this session worked on, rewrite its `### Current state` per `.claude/rules/tracker.md`: where the work stands, decisions made and why, what the next session should do first. Work without an issue gets one now with the "New item" command, a branch with no PR included. Rules and conventions stay in `.claude/rules/`; session figures (the code-research count, context use) stay in the chat. Leave out the history of the assistant's own setup (a rule, hook or plugin that changed along the way) unless changing it was the work.

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
