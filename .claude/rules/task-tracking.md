# Task tracking

Any turn that will take three or more steps starts with `TaskCreate`, before the first work tool call. That covers the session plan once approved, any request with several items, multi-file refactors, and autonomous runs ("do what you think is best"). Skip it only for a single trivial action or pure conversation; when unsure, make the list.

- Mark a task `in_progress` the moment you start it and `completed` the moment it is done. Never work ahead of the list or batch status updates.
- One task in progress at a time. When work runs in parallel (a background agent, a build), the task being worked on stays in progress and the others go on hold with what they wait on.
- A step discovered mid-run becomes a task immediately.
- Before each commit, put what it does on the task it belongs to, and check that every open task's text and hold still say what is true now. The tasks mod holds a commit until the list has changed since the last one, while more than one task is in progress, and while a hold has gone more than 6 hours without being set again: setting it again, in words that say what is true now, is how a session confirms it still holds.
- For work split across several PRs, create one task per PR up front and chain them with `TaskUpdate({ taskId, addBlockedBy: [...] })` so the list follows the merge order.
- Autonomous runs still stop at visual checkpoints (`visual.md`) when a batch changes what people see.

If `TaskCreate` is not available (older builds, current models without `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, or `CLAUDE_CODE_ENABLE_TASKS=0`), use the tasks mod's `mcp__tasks__taskmod_create`, `mcp__tasks__taskmod_update`, `mcp__tasks__taskmod_list` and `mcp__tasks__taskmod_get` when the session has them, which work the same way; otherwise use `TodoWrite` and express order by position. If neither tool exists, keep a numbered checklist in chat, update it every turn, and say once that the task tools are missing.
