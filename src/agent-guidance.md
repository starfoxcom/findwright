# FindWright

FindWright's setup writes this file and its updates keep it current; `/findwright:remove` takes it out, and an edit here is replaced at the next update.

## Code research

Inside a git repo, find code with FindWright's tools before reading files, and start no Explore or other agent for code research while they are available:

- `find` with a plain-English question, a name, or both: the files that answer it, best first.
- `search` with one or more regexes, `globs` and `context` lines, over every file the repo tracks: code, Markdown, config and templates.
- `symbols` to look a name up by kind, then `outline` for a file's symbols and line ranges, to read only the part needed.
- `coverage` when a file seems missing. When files the work searches yield no symbol, run `/findwright:fit`.

The tools are read-only, so call them concurrently. The index updates itself on every call. `/findwright:find` holds the full sequence and how to cite a find.

Fall back to Grep, Glob or an agent only when FindWright returned nothing usable for two differently worded queries, the target is not code, or its tools are missing from the session, and say which. A shell `grep` or `rg` then carries the comment `# FINDWRIGHT_BYPASS: <reason>`, so the search hook lets it through.

## When a session closes

When the user wraps a session up or a close-session step runs, in a repo with a `.findwright/` folder, run `node "{{HELPER}}/src/cli.mjs" hits` from the repo root. It scores the session's FindWright searches (a hit when the file the session opened next was in the answer), records the figure and prints `{rate, scored, goal, assess}`, with `saved` when it can price them.

- Report the rate against the goal.
- With `saved.main` set, add one line: "and you saved an estimated $<main> in the main session and $<helpers> in helper sessions", said as an estimate that counts only the extra turns a missed search costs, so it errs low. With `saved.main` null, say the saving is not measurable yet and give `saved.why`. Name each model in `saved.unpriced` as left out of the estimate.
- When `assess` is true, the last three sessions all fell short: run `node "{{HELPER}}/src/cli.mjs" assess`, explain each cause and suggested change in plain words, and change `.findwright/config.json` only on the user's yes.
