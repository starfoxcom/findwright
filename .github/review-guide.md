# Review guide

The project's own part of the review prompt. Both review tiers read this file from the PR's base branch, so a PR cannot change the guide its own review follows, and every change to it gets a review.

## About this project

**findwright**: A code index and search tool that adapts to each project: regex search over every file, symbols from built-in extractors and per-project rules, served over MCP.

## Project invariants to verify (in priority order)

Replace these starting points with the rules a change here must never break, highest risk first.

1. **Contract stability**: public APIs, file formats and schemas change only on purpose, with every caller and stored file still handled.
2. **Shared code**: a change to a shared utility keeps working for every caller, not only the one the PR needed.
3. **Tests earn their place**: a new test that misses rules 1 to 3 of `.claude/rules/testing.md` § When a test earns its place is a blocking finding.
4. **Clean code**: a breach of `.claude/rules/clean-code.md` (history or planning codes in comments, cryptic names, copied helpers) in lines the PR adds or changes is a blocking finding.

## Also escalate when the diff includes

These escalate on their own: the gate's own files (`.github/scripts/**`, `.github/review-gate.yml`, this guide, the review workflows and the project's check folder) and the trigger paths and patterns in `.github/review-gate.yml` (`escalate.*`). List here the changes that need a reviewer's judgment to spot, for example:

- Changes to how data is saved or loaded
- New code on a trust boundary (user input, network, plugins)
