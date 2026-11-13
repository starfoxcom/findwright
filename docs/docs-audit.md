# Docs and rules audit

How to sweep a repo for drift: docs that no longer match the code, comments that contradict it, rule breaches and code past the size limits. `/close-session` keeps the docs current day to day; run this sweep when that check has been skipped for a while, or before a release.

## Find

List findings per area (a folder or a module) before fixing any:

- **Stale docs:** a claim in `README.md`, `CLAUDE.md`, `docs/` or `.claude/rules/` about a behaviour, name, path, command or number the code no longer has. Search for each name and path the docs mention and check it still exists and does what they say.
- **Comments that contradict code:** a comment that describes behaviour the code beside it no longer has.
- **Rule breaches:** code that breaks a rule in `.claude/rules/`, such as `code-size.md` or `testing.md`.
- **Size limits:** the code-size check's report, when the project has one.

## Fix in area batches

- One area per PR, each with the full test suite green.
- A finding whose fix spans files outside the batch goes on the tracker as its own work item (an issue, or a `ROADMAP.md` item where the project plans in one) instead of being half-fixed. Fix it in its own batch.
- A finding that turns out to be a false positive gets its reason recorded where the next sweep will read it (an exceptions file the check reads, or a comment beside the code), so it is not raised again.

## Before pushing a batch

Search the living docs for every claim the diff changed: each renamed thing, moved path, changed command and changed number. A fix that leaves another doc saying the old thing is half done.

## Not in scope

Dated records stay as written: released changelog entries, dated research notes and decision records describe what was true when they were written.
