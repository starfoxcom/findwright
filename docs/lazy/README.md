# Lazy-loaded rules

Rules in this directory are **not** eager-loaded into every Claude Code session. They live here until the system / milestone / topic they describe goes active — at which point they get promoted to `.claude/rules/` (eager) for the duration that work is hot, then demoted back here when the work is done.

## Why

Every line in `.claude/rules/` costs tokens **per session, every session**, whether or not the session touches that rule. Rules describing systems not yet under active implementation are net-negative — they crowd out hot rules and consume budget for content the model can't act on right now.

## Promotion / demotion criteria

A simple bucket model based on session-hit frequency:

| Bucket | Hit rate | Action |
|---|---|---|
| **HOT** | Hit in ≥ 3 of last 10 sessions | Keep in `.claude/rules/` |
| **WARM** | Hit in 1–2 of last 10 sessions | Keep eager IF foundational (architecture, input, settings); otherwise demote |
| **COLD** | Hit in 0 of last 10 sessions | Move to `docs/lazy/`, leave a one-line pointer in `CLAUDE.md` under "Lazy-loaded rules" |

When promoting back to eager: `git mv docs/lazy/<rule>.md .claude/rules/<rule>.md` + remove the pointer line from CLAUDE.md.

## How to point to a lazy rule from CLAUDE.md

In `CLAUDE.md`, under a "Lazy-loaded rules" section, list each with a one-line description:

```markdown
**Lazy-loaded rules** (fetch when the milestone goes active):
- `docs/lazy/<name>.md` — one-line summary of what it covers + when it becomes relevant
```

## Audit cadence

Re-run an audit at any of:

- **Every milestone transition** (M2 → M3, etc.). Rules cold in the previous milestone may go hot.
- **After any session where you notice rule bloat** ("Claude keeps reciting a rule we never touch").
- **Every ~10 new sessions** as a routine sanity check.

The audit script (if you build one) reads session transcripts and counts referenced hits per rule. A reference implementation lives at `tools/rules_audit/audit.py` in projects that built one.

---

## Lazy rules currently in this directory

(none yet — list them here as you demote them from `.claude/rules/`)
