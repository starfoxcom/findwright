---
name: find
description: Locate code before reading or editing it. Use whenever the user asks "where is X", "what calls Y", "find usages of Z", or whenever you need to find a symbol, function, type or pattern yourself.
---

# /find

The lookup sequence for this project's code-research tool, **FindWright** (https://github.com/starfoxcom/findwright). Follow it in order and stop at the first useful result. Read only the range you found, never the whole file.

## Sequence

Follow `/findwright:find`, which the FindWright plugin ships: it holds FindWright's lookup sequence and the cases where Grep and Glob are allowed. When `/findwright:find` is not available, since FindWright is not installed on this computer, use Grep, Glob and Read.

## Citing

Name the call that found it, in one line:

> Found `parseHeader` via `<call>` at `src/codec/header.ts:42`.
