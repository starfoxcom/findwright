# Git rules

## Commits

One logical change per commit. Never mix a feature with a refactor, or a fix with config.

```
<type>(<scope>): <imperative description>
```

- 72 characters max. Imperative verb: `add`, `fix`, `remove`, `update`, `refactor`, `extract`.
- `scope` is the system or layer touched.
- Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore` (build, CI, tooling, deps), `data` (app data, configs, assets), `style` (formatting only).
- No AI-attribution lines anywhere: no co-author trailers, "generated with" footers or session links in commits, PR titles, PR bodies or comments. `.claude/settings.json` turns off the harness's own trailers, and the `no-ai-attribution` hook catches the ones written by hand.

---

## Branches (Gitflow)

| Branch | From | Merges into |
|---|---|---|
| `main` | | Production. Every release commit is tagged. |
| `develop` | | Integration. Base for all work. |
| `feature/<name>` | `develop` | `develop` |
| `release/<version>` | `develop` | `main`, then cascade to `develop` |
| `hotfix/<name>` | `main` | `main`, then cascade to `develop` |

- Kebab-case names: `feature/user-auth-flow`.
- Never push directly to `main` or `develop`.
- The GitHub default branch is `main`, so always pass `--base develop` to `gh pr create` for work PRs.

### Keep branches current

When the base branch advances, merge it into your open branches before continuing (`git fetch origin`, then `git merge origin/develop` on the work branch, then push). Never rewrite a branch someone else has pulled.

### Scope

A branch changes one concern. A tangential bug gets its own branch. Before coding, list the directories the work will touch; anything outside the branch's scope becomes a prerequisite branch and PR that merges first.

### Check the branch before the first edit

Run `git branch --show-current` before editing. Switch or branch first, then edit. If you notice you edited on the wrong branch, stop and say so instead of stashing and moving the work silently.

---

## Merging

- Every PR merges with a merge commit: `gh pr merge <pr> --merge --delete-branch`. Keep each commit buildable, and read history with `git log --first-parent`.
- Release PRs (`develop` into `main`), hotfix PRs (into `main`) and cascade PRs (`main` into `develop`) always use `--merge`. Squashing them makes the two branches diverge and turns the next release into a conflict.
- After merging: `--delete-branch` removes the remote branch, but the local one only when it is checked out. Run `git branch -D <name>` if it remains, then confirm with `git branch`.
- Then, when Bindwright's helper is installed (`~/.bindwright/helper/node_modules/bindwright`, which setup installs), run `node "$HOME/.bindwright/helper/node_modules/bindwright/hooks/counts.mjs" send <repo root>` in the background. It sends nothing unless this computer turned on the anonymous review counts, and at most once in 24 hours, so a merge never waits on it.
- Re-run a failed CI workflow as a whole (or push again). Re-running only the failed job can leave a required check stuck.

---

## Pull requests

Write the body to a file and pass `--body-file <path>`. Inline bodies get truncated or mangled by the shell.

```
## What
<what the change does, outcome first, in a few plain sentences>

## Why
<the problem it solves, in a sentence or two>

## Notes (optional)
<non-obvious decisions, performance impact, manual steps>
```

No empty sections and no generic testing checklist. The body carries what the diff cannot show.

Write it the way a colleague explains the change to someone who has not seen it:

- Plain sentences joined with "so", "but", "since", one topic per paragraph. A list only for things a reader ticks off or picks from, such as steps or checks.
- Say what the change does for the person using it before naming a file, function or flag, and name one only where the reader has to go there.
- Numbers exact and inline: "from 12 s to 3 s", not "much faster".
- Say what is still open or was left out as plainly as what works.
- No hedging ("essentially", "basically"), no em dashes, no hype. The tone stays professional: no slang or swearing.

Review tiers, the verdict rule and CI watching live in `review-tiers.md` and `token-efficiency.md`.

---

## Releases

`releases.md` holds how releases are numbered and tagged. It loads when a session reads a changelog or a file that carries the version (`VERSION`, `package.json`, `pyproject.toml` and the like); read it before cutting a release or bumping a version.
It also holds the cascade: after a release or hotfix merges into `main`, a cascade PR carries it back into `develop`, and the work is done only when that PR merges. Read it before cutting a hotfix too.
A change to `.github/workflows/` starts on a `hotfix/<name>` branch from `main`, never from `develop`; `releases.md` says why.
So does a change to the issue forms in `.github/ISSUE_TEMPLATE/`.

## Dead code does not ship

Code with no remaining caller is deleted in the same PR that orphaned it. Check with the project's lint or dead-code tool, then judge the result: a symbol reached only through reflection, dependency injection, bindings or serialization is not dead. If a tool reports a false positive, record the exception where the tool reads it instead of silencing the tool.

## Definition of done

A feature is done when it works end to end in the running app, not when it compiles. CI green is necessary, not sufficient. When `.claude/skills/verify/SKILL.md` exists, run `/verify` before each commit of a change people can see or use.

