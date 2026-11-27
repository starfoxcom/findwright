---
paths:
  - ".github/workflows/**"
  - ".github/scripts/review_gate.py"
  - ".github/scripts/setup-review-gate.sh"
  - ".github/review-gate.yml"
  - ".github/review-guide.md"
---

# Review workflow and gate

How a PR merges when CI cannot review it: one that edits the review workflow, the first PR that adds the review workflows, and one that repairs a broken gate. `review-tiers.md` holds the rest of the review rules.

## PRs that edit the review workflow

The review app refuses its token to a run whose copy of `claude-code-review.yml` differs from the default branch's copy, so a review on such a PR can never be posted, and it must never start on them. Triage never reviews `claude-code-review.yml`, which it skips by name, so a PR whose only other files are skippable (Markdown, images and fonts outside the always-reviewed paths) is non-reviewable: the `Review gate` check passes without a review. That makes two rules:

- An edit to `claude-code-review.yml` ships in a PR of its own. Anything reviewable in the same PR (`claude.yml`, another workflow, the gate's scripts, `.claude/`, a `CLAUDE.md`, code) starts the review, whose post job is then refused the app's token ("The bot token exchange failed three times"), and the PR can never merge; split it. Edits to `claude.yml` alone get a normal review: it runs from the default branch's copy.
- No AI reviews such a PR in CI, so it is reviewed before merge, one of two ways:
  - **Every commit in it was written in the maintainer's own sessions:** two fresh subagents review the exact head commit that will merge. Neither is a fork of the session that wrote the change, and each gets only the PR's diff and its own prompt. One follows the review steps and the binary verdict rule of the routine-review prompt taken from the base branch's copy of `claude-code-review.yml`, never the PR's own copy. It runs the pre-screen's mechanical checks itself, since the CI pre-screen report does not exist locally. The other reviews as the deep tier, briefed to review the whole diff at that SHA adversarially under the binary verdict rule; the author may add focus points but never narrows that scope. Neither reviewer posts to the PR, applies a label or writes the deep-review trigger phrase; each returns its verdict to the author. Once both give 🟢, a PR comment records the head SHA and both verdict lines, and the merge passes `--match-head-commit <sha>` so it goes through only while that SHA is still the head. Any new commit re-runs both.
  - **Anything else,** including a PR the maintainer opened that carries someone else's commits: it merges only after the maintainer has read its whole diff.

When such a PR merges into the default branch, an open PR whose review ran on the old copy is refused the same way, and re-running it reuses that copy and fails again. Wait until the new copy is on the PR's base branch (where that is not the default branch, once the cascade or release that carries it there merges), then merge the base branch into the PR's branch and push, which starts a run on the new copy.

### The first setup PR

The PR that first adds the review workflows has no gate on its base branch to pass: the `Review gate` check fails on it, and the review app refuses its token because the default branch holds no copy of `claude-code-review.yml` yet. So it targets the GitHub default branch, and it is reviewed and merged as the workflow-only path above, with one change: the routine reviewer takes its prompt from the PR's own `claude-code-review.yml`, the files setup wrote, since the base has none. `.github/scripts/setup-review-gate.sh` creates and repairs no ruleset while the default branch lacks `.github/scripts/review_gate.py`, and names any ruleset that already requires `Review gate`: that check comes off until the merge, by the maintainer in the repo's settings.
The default branch is `main`, so the PR never targets `develop`. Once it merges, cascade it into `develop` (push `develop` first if it exists only on this computer, so the script finds it on GitHub), then run `.github/scripts/setup-review-gate.sh` to protect both branches, and the same command with `--check` to confirm.

For any other failure, fix the cause.

## If the gate itself breaks

The gate runs the base branch's copy of `.github/scripts/review_gate.py` and `.github/review-gate.yml`, so a broken copy there fails the gate on every PR, the one that would fix it included. Only the maintainer recovers from that, and only for a PR that fixes those two files and changes nothing else but their tests and any copy the project keeps of them: it gets the two local 🟢 reviews of the section above, the maintainer takes `Review gate` off the branch's required checks (and `Evaluate review outcome`, where the branch still requires it, and `Claude On-Demand`, where a `checks: two` project requires it, since both wait on the same script) and merges it with `--match-head-commit <sha>`, then at once runs `.github/scripts/setup-review-gate.sh --branch <base>`, naming the PR's base branch (the one whose checks came off; `--branch` replaces the script's default branches), with `--require "<name>"` for each other check it took off, to require them again, and the same command with `--check` to confirm. Never for any other PR.
