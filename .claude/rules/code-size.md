---
paths:
  - "**/*.{js,mjs,cjs,py}"
---

# Code size

Soft limit: the reviewer mentions it, nothing is owed. Hard limit: a blocking finding unless the code falls under an exception below. Lines are physical lines including blanks and comments; a function counts from its signature to its closing brace.

## Every language

| Construct | Soft | Hard |
|---|---|---|
| Nesting depth | 4 | 6 |
| Parameters | 5 | 8 |
| Cyclomatic complexity per function | 15 | 25 |
| Inline lambda or closure | 15 lines | 40 lines |

## Per language

Keep the rows for this project's languages and delete the rest.

| Language | File | Function | Line length |
|---|---|---|---|
| JavaScript / TypeScript | 400 / 800 | 50 / 100 | 100 / 120 |
| Python | 500 / 1 000 | 50 / 100 | 100 / 120 |

Values are soft / hard. Test files may run 1.5 times the file limit.

## Exceptions

1. Generated or vendored code: out of scope.
2. Declarative data (tables, schemas, translation files): no file limit.
3. Test batteries of many small cases: file limit only.
4. A hot loop kept in one function for measured performance: allowed past soft with a comment stating the measurement. Never past hard.

## Working the rule

New code meets the table from its first commit. A new file or function that would pass the hard limit is designed smaller before it lands: extract functions, split the file, flatten nesting with early returns. Existing code over the limit shrinks when it is next substantially changed, not in drive-by edits.

## The check

`.github/scripts/size_check.py` measures the mechanical rows of these tables on every PR (`.github/workflows/size-check.yml`): file and line length, and each function's length, complexity and parameters. Breaches the project had when the check was set up are recorded in `.github/size-check/baseline.txt` and may only shrink; any new hard breach fails the PR. Delete a baseline line once its code complies; the check fails until you do, so a leftover line cannot excuse the next breach. A breach under one of the exceptions above goes in `.github/size-check/exceptions.txt` with its reason. `--report` lists every finding, soft ones included. Edit the tables here, not in the script: it reads them from this file.
