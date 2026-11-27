---
paths:
  - "**/CHANGELOG.md"
  - "**/CHANGES.md"
  - "**/HISTORY.md"
  - "**/VERSION"
  - "**/package.json"
  - "**/pyproject.toml"
  - "**/Cargo.toml"
  - "**/pubspec.yaml"
  - "**/*.csproj"
  - "**/build.gradle*"
  - ".github/workflows/**"
  - ".github/scripts/version_check.py"
---

# Releases

How releases are numbered and tagged, and, where the project keeps release branches, how each release reaches them all. `git.md` holds the rest of the git rules.

## Versioning

Size each release by what its users must do:

- **Major:** they must act, or something they use stops working: a command, option or API removed or renamed with no old name kept, a file or save format that old data cannot load, a raised minimum OS, runtime or tool version.
- **Minor:** new features, or changed defaults that keep everything working.
- **Patch:** fixes only.

When a release tool sets the version and the tag, feed it the way its configuration reads and never bump or tag by hand. Otherwise bump every file that carries the version together, and tag the release commit in the style the existing tags use. With a changelog, each change a user must act on goes under `### Breaking`. A project that does not version its releases skips this section.

`.github/scripts/version_check.py <version>` reads the commits since the last release and refuses a version smaller than they need, or a changelog section that does not match it. Run it before each `git tag <version>`, `gh release create <version>` and `gh pr create` from a `release/<version>` branch; where the guard hooks live in the repo, a hook runs it on those commands by itself. Pick the version and the sections it names; never tag around it.

## Cascade after every merge into `main`

GitHub does not copy `main` back into `develop`. After a hotfix or release merges:

```bash
git fetch origin
git checkout -b chore/cascade-<name> origin/develop
git merge --no-ff origin/main -m "chore: cascade <name> into develop"
git push -u origin chore/cascade-<name>
gh pr create --base develop --title "chore: cascade <name> into develop" --body-file <file>
```

The hotfix or release is done only when the cascade PR is merged and its branch deleted.

## Workflow file changes

Review workflows triggered by comments or schedules run the copy on the GitHub default branch, and the review app refuses its token to a run whose copy of the review workflow differs from that copy, so its review is never posted.
Because `main` is the default branch, a change to `.github/workflows/` lands on `main` first as a `hotfix/<name>` PR, then cascades to `develop`. A workflow change made on a feature branch fails the review check.

Issue forms and templates (`.github/ISSUE_TEMPLATE/`) follow the same path: GitHub reads them only from the default branch, so a change merged into `develop` stays invisible to everyone opening an issue until the next release. Land it as a `hotfix/<name>` PR too.
