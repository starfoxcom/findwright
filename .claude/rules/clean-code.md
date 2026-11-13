---
paths:
  - "**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rs,java,kt,kts,cs,c,cc,cpp,h,hpp,swift,dart,rb,php,gd,lua,ex,exs,scala}"
---

# Clean code

A developer who just arrived opens any file and understands it at once, even with the comments stripped. Size limits live in `code-size.md` and dead code in `git.md`; this file covers the rest. Generated or vendored code is out of scope.

## The newcomer test

Before committing, read the change as someone who knows the product but none of its planning history. Every name says what the thing is, every function does the one job its name states, and a comment adds only what the code cannot show. If a sentence needs a codename, a date or a past measurement to make sense, it fails.

## Comments

- Say what the code does now and the constraint it cannot show: units, invariants, who owns a thread, a data format, why a value is this value. Never restate the line below.
- One line by default. A block comment is for a data format, a contract between systems or an algorithm that is not obvious. A comment longer than the code it explains means the code or its name should change instead.
- No history: no "was", "used to", "previously", "replaces", "added for", dated measurements or the story of a bug hunt. The commit message, the PR and the docs hold that.
- A tuning value states the limit, not the session that found it: "past 16 rebuilds a frame the render thread stalls", not "twenty measured a 100 ms stall on Tuesday". A measurement `code-size.md` asks for is stated the same way, as the limit it shows.
- A comment changes with its code. A comment that no longer matches the code is a bug.
- Public surface gets a doc comment in the language's own form. Private helpers with clear names need none.

## Names

- Spell names out where a full word fits: `chunk_coord`, not `cc`. Domain-standard short forms stay: `x`, `y`, `i`, `j`, `dx`, and the symbols of a formula its header defines.
- No planning codes in code: milestone or slice tags, issue or PR numbers, dates that tag when work happened, and review-round references never appear in comments, identifiers or strings. One exception: a skipped test or a temporary workaround links the issue that tracks its removal, or names its title where a project check bans issue numbers in code. Name a system by what it does. Real file paths are fine; they are pointers, not tags.
- Booleans read as questions (`is_loaded`, `has_mesh`), functions as verbs (`build_mesh`), and one concept keeps one name across files.

## Structure

- One job per function and per class. A class whose methods split into separate groups becomes helpers behind the same surface.
- No copies. The second copy of a helper is the moment to share it; a parameter or a generic replaces two near-identical bodies. A mutant check in a test (`testing.md`) is a deliberate copy, not a duplicate.
- Straight-line logic: no set-then-undo (turn a flag on, write through it, turn it off); write the end state directly. Prefer early returns to deep nesting.
- Match the file: follow the surrounding code's naming, comment density and idiom.

Review blocks a breach. `docs/comment-audit.md` holds the method for trimming the comments of existing code to this rule.
