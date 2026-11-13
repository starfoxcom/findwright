# Task tracking

Any turn that will take three or more steps starts with `TaskCreate`, before the first work tool call. That covers the session plan once approved, any request with several items, multi-file refactors, and autonomous runs ("do what you think is best"). Skip it only for a single trivial action or pure conversation; when unsure, make the list.

- Mark a task `in_progress` the moment you start it and `completed` the moment it is done. Never work ahead of the list or batch status updates.
- One task in progress at a time, unless the work is explicitly parallel.
- A step discovered mid-run becomes a task immediately.
- For work split across several PRs, create one task per PR up front and chain them with `TaskUpdate({ taskId, addBlockedBy: [...] })` so the list follows the merge order.
- Autonomous runs still stop at visual checkpoints (`visual.md`) when a batch changes what people see.

If `TaskCreate` is not available (older builds, or `CLAUDE_CODE_ENABLE_TASKS=0`), use `TodoWrite` and express order by position. If neither tool exists, keep a numbered checklist in chat, update it every turn, and say once that the task tools are missing.
