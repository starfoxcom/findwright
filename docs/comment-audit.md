# Comment audit

How to bring the comments of existing code in line with `.claude/rules/clean-code.md` without changing what the code does. Run it once after adopting the rule, then whenever an area's comments have drifted.

## Method

1. Pick one area (a folder or a module), not the whole repo.
2. In each file, cut what the rule rules out: history, planning codes, dates, dated measurements, comments that restate the line below, and blocks that could be one line. Keep units, invariants, formats, ownership and the reason a value is what it is.
3. Rewrite a comment that no longer matches its code so it says what the code does now. If the fix is a rename, that belongs in a separate change; this pass touches comments only.
4. Run the guard below, then the full test suite.
5. One area per PR, so each review stays small.

## The guard: the code stays the same

A comment pass must not change what the code does. Check it before committing:

- Where the language has a parser or tokenizer at hand, strip the comments from each changed file, before and after, and compare the two results (Python's `ast.dump(ast.parse(source))` drops `#` comments, once the docstring is removed from the module and from every class and function; a JavaScript minifier with comments off; `gcc -fpreprocessed -dD -E -P` for C and C++). A difference means code changed.
- Then read the whole diff yourself. No script sees everything: a docstring the program reads (help text, a grammar, a doctest), a directive that looks like a comment, a block comment that opens or closes, or a multi-line string can all hide a change.

A diff that changes code goes back to step 3: whatever changed in the code moves to its own PR.

## What stays

- Doc comments on public surface, updated rather than removed.
- Pointers to real files (`docs/<topic>.md`) where the full story lives.
- Anything a program or tool reads, even when it looks like a comment or docstring: directives (`# noqa`, `// eslint-disable-next-line`, `#pragma`, `//go:embed`), doctest examples, and docstrings used as help text or grammar. They are code to whatever reads them.
