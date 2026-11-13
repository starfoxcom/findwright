# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-13

### Breaking
- Find needs the meaning model: without it, or when it does not match its checksum, find says so and points at setup instead of quietly ranking by words alone. The model is no longer downloaded on the first search, and there is no setting that turns meaning search off. Run `/findwright:setup`, or `findwright model` from a shell, once to install it.
- FindWright now asks for Node 22.16 or later (or Node 24 and up), the first releases whose built-in SQLite has the full-text search the index needs, and says so plainly on an older Node instead of failing with "no such module: fts5". It used to claim 22.13, where every search failed. Node 23 never had it. Update Node if yours is older.

### Added
- FindWright installs as a Claude Code plugin of its own, from its marketplace (`/plugin marketplace add starfoxcom/findwright`) and later from the plugin directory, without Bindwright. `/findwright:setup` installs the helper the plugin pins by SHA-256 into `~/.findwright/helper`, registers the server for every project, offers the search hook and fits the index to the project; `/findwright:update`, `/findwright:doctor` and `/findwright:remove` keep it current, check it and take it back out.
- The search hook in Node (`hooks/findwright-first.mjs`) and `findwright home status|install-hook|remove-hook`, which add it to and take it out of the user's settings with a backup first.
- Each published release carries the plugin zip and the helper tarball, both rebuilt from the tag so their SHA-256 matches the pins, and writes the `plugin` branch the directory installs from.
- Tests run on Linux and Windows for every pull request, on the newest patch of Node 22, Node 24 and the current LTS.
- Setup and the doctor say when your Node is behind on security fixes, and setup installs the newest patch (with winget on Windows, through the nodejs.org installer elsewhere). A Node outside long-term support gets a note.
- `findwright model` downloads the meaning model, checks it against its pinned SHA-256 and loads it; setup runs it.
- Opt-in anonymous usage counts: setup asks once per computer, "No" first. Each project whose kind you pick sends four daily sums from its searches (sessions that searched, scored searches, hits and answer bytes) under a random id to the `counter/` Worker, whose totals the page will show. `findwright counts share off` stops every send.
- The project is set up with Bindwright: rules, session skills, review workflows and the size check.

### Changed
- Setup installs everything FindWright needs once you run it, saying what each step installs instead of asking again, and stops with FindWright off when a requirement is missing. It switches the registration to the plugin's own copy of the server.

---

## How to maintain this file

- Add entries under `[Unreleased]` as you work.
- On release: rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD` and start a new `[Unreleased]` block above it.
- Categories (use as needed): **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, **Security**.
- One bullet per user-visible change. Skip refactors with no user-visible effect.
- Link issue/PR numbers when relevant: `- Added X behavior ([#42](link))`.
