# Test-suite audit

How to check an existing suite against `.claude/rules/testing.md` § When a test earns its place. Run it when the suite feels slow or bloated, or once after adopting the rule. The aim is fewer tests with no loss of a guard a user would notice.

## Scan

List candidates per rule before judging any of them:

- **Near copies (rule 2):** tests in one file whose bodies are almost the same text.
- **Mutant checks (rule 4):** tests that rebuild an old or wrong version of a formula and assert it fails.
- **Seeded sweeps (rule 5):** tests that loop over random or generated input.
- **Benchmarks (rule 6):** tests that time code, or fail on a time budget.
- **Pinned internals (rule 3):** tests that assert a private constant, a size, a call count or a layout.

A short script that reads the test files is enough; keep it out of the repo.

## List A: mutant checks kept only when the old version was real

For each mutant check, find where it came from: `git log -S<test name> --reverse -- <test folder>` names the commit that first added it, even across file moves or splits.

- **Keep** it when it sits on a codec, fixed-point math or determinism, when it was added or later changed by a `fix` commit, or when the old version it rebuilds once shipped: search the source history for the line it removes.
- **Delete** it when the old version was invented: added in the same commit as the formula, or by a `feat`, `perf`, `refactor` or `test` commit, and never in the source.
- When in doubt, it stays. Record each borderline call and why.

The plain test the mutant paired with stays either way.

## List B: fold only tests of the same shape

Merge near copies into one table only when they make the same assertion on different input.

- Every row gets a name, so a failure says which case broke.
- Every row checks the whole outcome, never less than the tests it replaces. Folding often makes rows stricter.
- Keep tests apart when each guards a different function or path: a table would hide which one broke.
- Trace each old test to its row before deleting it.

## List C: keep sweeps that reach input no table can list

A seeded sweep stays when it covers input a boundary table cannot list (codecs, determinism, range invariants over a large space). It goes when a table already covers the same boundaries. Benchmarks move to their own command, outside the pass or fail suite.

## Landing the changes

- Small PRs, one list or one area at a time, each with the full suite green.
- Record the findings (counts per rule, what was deleted or folded, the borderline calls) in the PR body or a dated note, so the next audit starts from them.
- Checking rule 1 (does each test guard something a user would notice) means reading every test. Do it area by area, after the mechanical lists land.
