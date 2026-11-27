# CLAUDE.md

Guidance for Claude Code in this repository. Rules in `.claude/rules/` load on their own; this file holds what they do not.

## Project

**findwright**: A code index and search tool that adapts to each project: regex search over every file, symbols from rules the agent writes for each project, served over MCP.

- **Stack:** JavaScript (ES modules) on Node 22.16+ or 24+ (Node 23 lacks SQLite full-text search), using the built-in `node:sqlite`; no runtime dependencies
- **Repo:** https://github.com/starfoxcom/findwright
- **Branches:** `main` holds tagged releases; `develop` is where work lands. See `.claude/rules/git.md`.
- **Commands:** test `npm test`. There is no linter or type checker yet.

Work is tracked in GitHub issues: `.claude/rules/tracker.md` says where each item's state lives and how to read and update it.

## Language

- Talk to me in **English**.
- Code, comments, identifiers and technical docs are in **English**. User-visible strings go through the localization layer when the project has one.

## Sessions

- **Start:** `/start-session` reads the current state, proposes a plan and waits for approval before changing code.
- **End:** `/close-session` checks what is really finished, commits, and opens or merges the PR.

## Memory

Each memory entry carries the date it was written or last confirmed (`written:`) and where it came from (`source:`) in its front matter, so the monthly pruning pass can find the stale ones.
