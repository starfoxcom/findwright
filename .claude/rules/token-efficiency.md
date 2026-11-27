# Token efficiency

## Find before you read

Locate a symbol before opening a file, then read only the function or section you need. `/find` (`.claude/skills/find/SKILL.md`) holds the lookup sequence for this project's code-research tool, **FindWright**, and when to fall back to Grep, Glob and Read.

Enable an MCP server only while the work needs it. Every enabled server adds its tool definitions to every message.

## Shell commands

- One command per call where you can. Permission rules match the whole command string, so `&&` chains prompt more and fail in confusing ways.
- Never retry a timed-out command with the same timeout. Builds and installs start at 420 000 ms. The first two retries add 180 000 ms each (600 000, then 780 000); every later retry adds 120 000 ms.

## Agent calls

Leave `model` and `effort` out of `Workflow` and agent calls, so they run on the session's model and effort. A pinned value overrides the person's choice.

When the `builder` agent is installed (`~/.claude/agents/builder.md`), hand it each feature or fix of about 20 lines or more that a test can prove: a brief with the goal, the files and the test command. It runs on a small, cheap model at the model and effort its own file pins, in this folder, so the project's rules still apply. Keep design, debugging an unknown cause and edits of a few lines in the main session. When it reports back, run the tests yourself, read the whole diff and check the result where it shows (the browser, the running app) before trusting it; the main session does every commit and push.

For a job that changes a web page, add the layout check to the brief's test command: `node "$HOME/.bindwright/helper/node_modules/bindwright/hooks/layout-check.mjs" <page URL>`, from the helper Bindwright's setup installs. It opens the page headless at phone and desktop width and fails on overlapping elements, text that overflows its box and sideways scroll, the misses a builder cannot see; it needs Node 22+ and Chrome, Chromium or Edge. Mark a deliberate overlap with `data-layout-ignore`.

## Watching CI

After every push, watch the PR's checks; never use `gh run watch`. When the `ci-watch` mod is loaded, it watches the PR after `git push` or `gh pr create` and wakes the session once all checks settle; follow the mod and start no second watcher. Otherwise follow `docs/ci-watching.md`, which holds the Monitor and background-loop watchers.

When everything is green, merge per `git.md` § Merging. On a red check, read the failing log (`gh run view <id> --log-failed`), fix it on the branch and push. Ask first only when the failure is ambiguous (flaky test, infrastructure outage, or the test and the change disagree about intended behavior).

### Fast path for docs-only PRs

Diffs of only Markdown, images and fonts outside the always-reviewed paths (the gate's own files, any `.claude/` folder, any `CLAUDE.md` or `AGENTS.md`, and `triage.always_review` in `.github/review-gate.yml`) pass the `Review gate` check without a review in about 30 seconds. Skip the monitor: wait about 90 seconds, check `gh pr view <pr> --json mergeable,mergeStateStatus`, then merge per `git.md` § Merging:

- `MERGEABLE` and `CLEAN`: merge.
- `BLOCKED` on a required approval: a reviewer other than the author approves it; until then, wait.
- Anything else: stop and report the state. Never merge past a rule.

Approval to open the PR covers this merge. A PR that changes `.github/workflows/claude-code-review.yml` gets no AI review in CI; it merges only as `review-workflow.md` describes.

## Long sessions

Run the close-session ritual only when the maintainer asks for it, or when every task of the session is done and nothing is left to work on.

When responses slow down or degrade, the same file keeps getting re-read, or system reminders pile up, stop and reframe from the task list rather than push on.

## Scratch and build output

Scratch files, test copies and captures go in the session's scratchpad, or in the project's git-ignored build folder, never in a fixed folder such as `C:/tmp` or `/tmp`. The CLI deletes a session's scratchpad together with its transcript once both are older than `cleanupPeriodDays`, so anything worth keeping moves into the project before the session ends.

A script that starts a browser with a profile folder of its own (`--user-data-dir`) stops that browser and deletes the folder on every exit path, errors, timeouts and stop signals included, and its next run clears what a run killed outright left behind: each profile can reach a gigabyte, and a browser whose script died keeps running, so forgotten runs fill the disk long before the scratchpad is freed.
