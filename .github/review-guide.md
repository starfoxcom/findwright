# Review guide

The project's own part of the review prompt. Both review tiers read this file from the PR's base branch, so a PR cannot change the guide its own review follows, and every change to it gets a review.

## About this project

**findwright**: A code index and search tool that adapts to each project: regex search over every file, symbols from rules the agent writes for each project, served over MCP.

## Project invariants to verify (in priority order)

Replace these starting points with the rules a change here must never break, highest risk first.

1. **Contract stability**: public APIs, file formats and schemas change only on purpose, with every caller and stored file still handled.
2. **Shared code**: a change to a shared utility keeps working for every caller, not only the one the PR needed.
3. **Tests earn their place**: a new test that misses rules 1 to 3 of `.claude/rules/testing.md` § When a test earns its place is a blocking finding.
4. **Clean code**: a breach of `.claude/rules/clean-code.md` (history or planning codes in comments, cryptic names, copied helpers) in lines the PR adds or changes is a blocking finding.

## Checklist

Mistakes this project has made more than once. Each item names a trigger the diff shows: check only the items whose trigger this diff matches, and skip the rest. A failed check is a blocking finding. A finding that comes up in a second PR becomes an item here, with the PRs it came from. Replace the example with the project's own.

| Trigger in the diff | Check | Source |
|---|---|---|
| A file that the project keeps a generated copy of changes | The copy is regenerated in the same commit | (the PRs where it broke) |

## Bindwright template text

The pre-screen's `bindwright_templates.py` lists the changed files whose text equals what the Bindwright release recorded in `.bindwright/pristine.json` writes for this project, unedited. Their text is reviewed in Bindwright's own repo, so a finding in the content of a listed file does not count toward this verdict: put it under a heading of its own, "Upstream: Bindwright template text", with the file and line, and the author reports it with `/bindwright:report`. Write each line there as plain text: none opens with 🔴 or the word "Blocking", or puts either right after a short label, since the gate reads such a line as blocking wherever it sits. When every finding is upstream, the verdict is 🟢. How this project's own files fit a listed file (a rule it contradicts, a path or command it names that the repo lacks) is this PR's finding and blocks as usual, and so is anything the PR removes from a listed file by returning it to the template text, such as the project's own hardening of a workflow or hook. A file the check does not list gets the normal review.

## Also escalate when the diff includes

These escalate on their own: the gate's own files (`.github/scripts/**`, `.github/review-gate.yml`, this guide, the review workflows and the project's check folder) and the trigger paths and patterns in `.github/review-gate.yml` (`escalate.*`). List here the changes that need a reviewer's judgment to spot, for example:

- Changes to how data is saved or loaded
- New code on a trust boundary (user input, network, plugins)
