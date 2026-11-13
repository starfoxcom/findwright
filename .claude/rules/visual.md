# Visual work

Applies to anything whose correctness depends on what a person sees: web or native UI, games, charts, design tools.

## One slice at a time

A slice is the smallest change a person can check with one short yes/no checklist. If you cannot write that checklist, the slice is too big (or has no visual surface, and this rule does not apply).

Build a visual feature in this order, checking each step before the next:

1. Data, with unit tests only.
2. A placeholder on the real surface (a visible dummy element) to prove it renders.
3. Real data shown plainly.
4. Real styling.
5. Live updates when the data or route changes.
6. Tests and cleanup.

When a step fails, the problem is in that step, and the previous one is the rollback point. Never bundle several visual systems into one PR.

## Iterate locally, push once

1. Commit on the feature branch and run tests plus a headless start. Report and stop.
2. The maintainer checks the visuals.
3. On a regression, keep iterating locally without pushing.
4. Once the maintainer confirms, push and open the PR, and add "Visual check confirmed <date>" to its Notes.

Silence is not approval. Do not push a visual slice until the maintainer says it looks right. Review fixes that do not change visuals push as usual.

## Checklists, never "check for regressions"

Give the maintainer concrete yes/no items tied to the change:

| Change | Checklist |
|---|---|
| Config flip, no intended visual change | The app starts, renders at every size, and logs no errors. |
| New visual element | One line per thing it newly shows or does. |
| Copy change | The new text appears where expected and fits without clipping. |
| Bug fix | "Do X, expect Y." |

## Reuse before building

Before creating a UI component, check the project's shared components. If a suitable one is missing, add it there first, then use it.

## Not covered

Pure logic with unit-testable results, refactors with no visual change, and docs or CI changes.
