# Review tiers

Every PR gets an AI review with a pass or block verdict, run by `.github/workflows/`. Local sessions never start the CI reviews themselves; the one local review is the workflow-only PR path in `review-workflow.md`.

| Tier | Starts when | Model |
|---|---|---|
| Routine | Every PR with reviewable files (`claude-code-review.yml`) | `claude-fable-5-2` at low effort; backup `claude-opus-5-5` at high |
| Deep | A comment starting with `@claude review this PR` (`claude.yml`) | `claude-fable-5-2` at medium effort; backup `claude-opus-5-5` at high |

Both tiers report into one check, `Review gate`: it passes when the routine verdict is 🟢 and, once a deep review is asked for, the deep verdict is 🟢 too. That check, beside any other checks the project requires, is required on protected branches, and branch protection has no bypass actors; `.github/scripts/setup-review-gate.sh` sets this up, along with the merge methods each branch allows: the saved style, and under gitflow merge commits alone on main and merge commits beside the style on develop (`--check` only reports what is missing). With a single maintainer, require zero approvals so the gate alone decides, since authors cannot approve their own PRs. With more people, also require one approval from someone other than the author. Docs-only and other non-reviewable diffs pass automatically in about 30 seconds.

The gate's settings live in `.github/review-gate.yml` (models, runner, the project's own pre-screen checks, trigger paths and always-reviewed paths), and the project's part of the review prompt lives in `.github/review-guide.md`. Both are read from the PR's base branch, so a PR cannot change the rules of its own review. Model pins change only after a side-by-side comparison of candidate models on the same saved PRs, never just because a newer model exists.

## The verdict rule (both tiers)

- 🟢 LGTM only when the review is fully clean: no caveats, no nits, no "non-blocking" findings.
- 🔴 Blocking when any real finding exists, however it is framed. "LGTM with caveats" is 🔴.
- Style preferences and speculative future-proofing are dropped, not listed as minor.
- Findings in Bindwright's own template text, listed under "Upstream: Bindwright template text" as `.github/review-guide.md` says, are not this PR's: they go upstream and leave the verdict as it is. Only the files the pre-screen report itself lists count; a review without that report treats none as listed.

A 🟢 that carries findings lets them merge and come back later as the same review.

## Deep review triggers

The routine reviewer escalates automatically: it adds the `needs-deep-review` label and posts the `@claude review this PR` comment when the diff touches the gate's own files, the trigger paths and patterns in `.github/review-gate.yml` (`escalate.*`), or the list below. While that label is on the PR, every push gets a deep review, and the gate waits for its 🟢.

Escalate on risk, not size:

- Parsing, encoding or serialization logic
- Threading, locking, async coordination
- Schedulers, graph or DAG algorithms
- New public API surface
- Save or load formats, schema migrations
- Authentication, authorization, secrets, cryptography
- Anything that crosses a trust boundary (user input, network, plugins)

Skip escalation for docs, CI or settings tweaks, version bumps, mechanical refactors, test-only changes and one-line fixes. Fit the list to the project's risk: paths and added-line patterns go in `.github/review-gate.yml` (`escalate.paths`, `escalate.patterns`), changes that need judgment to spot go in `.github/review-guide.md` under "Also escalate when the diff includes". Keep this list in step with both.

## After a 🔴

Fix on the same PR branch and push; the review re-runs. Then search the codebase for the same mistake elsewhere and fix every copy in that commit, because the reviewer only sees the diff. When the same finding already came up on an earlier PR, add it to the checklist in `.github/review-guide.md` in the same PR: a trigger the diff shows, the check, and both PRs. A PR that must hold only its own files (a review workflow edit or a gate repair, `review-workflow.md`) leaves the item to the next PR. Every later review then checks it whenever the trigger matches.

## What a finding blocks on

A finding belongs to the PR when the PR causes it: a regression from the base branch, or a break of what the PR says it does. A gap the base branch already has, or one the comparable community tool shares (for a workflow, the official action it pins), is not the PR's finding. It goes into a follow-up issue instead of the verdict. The review still covers the whole diff; this only decides what blocks.

- Write this bar into every reviewer prompt from the first round, local or CI, before any finding arrives.
- When a review reports, sort each finding against the bar before touching code. Fix only what passes it, plus the other copies of that same mistake (§ After a 🔴), with the smallest change, and add no features while fixing.
- A round is green only when the PR merges at its head. One whose checks all passed but was followed by another push instead, for a conflict with its base or any other reason, counts red.
- Research before the PR opens, and again before the fix of every red round: look up at least five ways others solved the same problem, compare them against each other, and build on the simplest one that removes the whole class. One search is a guess, and a fix written before the research tends to patch the next finding instead of the class.
- The 10th red round in a row is the hard stop: close the PR without merging, then rebuild the change from its base branch in a new PR, with that round's findings fixed in the rebuild and a `Rebuilds #<old number>` line in its body. The new PR starts its own count.
- A PR closed unmerged for good carries a label that says why: `dropped: no fix` when no fix was found, `dropped: not needed` when it has no reason left to exist. Create each label once with `gh label create`. The review counts read the line and the labels.

Without the bar, each fix adds surface for the next round to find, and the rounds never converge.

## Review workflow edits, the first setup PR and a broken gate

`review-workflow.md` holds how three kinds of PR merge when CI cannot review them: one that edits `claude-code-review.yml`, the first PR that adds the review workflows, and one that repairs a broken gate. It loads when a session reads a workflow or gate file. Read it before opening or merging a PR that edits `claude-code-review.yml`, a PR into a repo whose default branch does not hold `.github/scripts/review_gate.py` yet (its first setup PR), and any PR while `Review gate` fails on every PR, this one included.

## Local session's job

Push, open the PR, watch the checks (see `token-efficiency.md`), and merge once every check has settled, the `Review gate` is 🟢 and every other required check passes. A PR whose base branch was changed, such as a stacked PR retargeted after its parent merged, starts no checks: push a commit, an empty one if nothing else changed. Push one the same way to run the review again after a fix that touches only the PR body. If `needs-deep-review` appears but no deep review starts within a few minutes, report it instead of starting one yourself.
