# CLAUDE.md

Guidance for Claude Code in this repository. Rules in `.claude/rules/` load on their own; this file holds what they do not.

## Project

**findwright**: A code index and search tool that adapts to each project: regex search over every file, symbols from built-in extractors and per-project rules, served over MCP.

- **Stack:** JavaScript (ES modules) on Node 22.13+, using the built-in `node:sqlite`; no runtime dependencies
- **Repo:** https://github.com/starfoxcom/findwright
- **Branches:** `main` holds tagged releases; `develop` is where work lands. See `.claude/rules/git.md`.
- **Commands:** test `npm test`. There is no linter or type checker yet.

Work is tracked in GitHub issues: `.claude/rules/tracker.md` says where each item's state lives and how to read and update it.

## Language

- Talk to me in **English**.
- Code, comments, identifiers and technical docs are in **English**. User-visible strings go through the localization layer when the project has one.

## Code research

Find code with `/find` before reading files. This project uses **FindWright**; `/find` has the lookup sequence and the only cases where Grep and Glob are allowed. `/close-session` reports how often each was used.

## Sessions

- **Start:** `/start-session` reads the current state, proposes a plan and waits for approval before changing code.
- **During:** track multi-step work per `.claude/rules/task-tracking.md`.
- **End:** `/close-session` checks what is really finished, commits, and opens or merges the PR.

## Rules loaded on demand

Rules that matter only at certain milestones live in `docs/lazy/` and do not load automatically. `docs/lazy/README.md` lists them and when to read each.

## Memory

Project memory lives in `~/.claude/projects/<project-slug>/memory/`, indexed by `MEMORY.md`. Save what the repo cannot tell a future session (decisions, preferences, pointers to outside resources), never what the code or git history already records.
