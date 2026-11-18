# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.1] - 2026-11-18

### Fixed
- `findwright hits`, the saving estimate and the usage counts read session transcripts from Claude Code's config folder, so they find the sessions on a computer that sets `CLAUDE_CONFIG_DIR`. They always looked in `~/.claude/projects` ([#86](https://github.com/starfoxcom/findwright/issues/86)).
- A relative `CLAUDE_CONFIG_DIR` is used as given, the way Claude Code reads it, so the guidance file, the plugin pin and the settings file are the ones in the folder Claude Code uses. 2.2.0 took it only as an absolute path and fell back to `~/.claude`, where Claude Code never looked. An empty value still means `~/.claude` ([#89](https://github.com/starfoxcom/findwright/issues/89)).
- When the helper updates itself, the step that puts the new copy in place holds a lock that the operating system drops when the process holding it ends, so a run stopped during that step leaves no lock behind. Two runs that started together right after one was stopped could both take over the old lock and move the helper's folders at the same time ([#82](https://github.com/starfoxcom/findwright/issues/82)).

## [2.2.0] - 2026-11-18

### Added
- The helper follows its plugin. When a session starts, the search server reads which helper release the installed plugin pins, and when that is another version than its own, it installs that release in the background, so the session never waits: it downloads the release, checks it against the pinned SHA-256, installs it the way setup does into a folder of its own, puts it in place only once it is complete, then fetches the meaning model the new helper pins. The next session runs the new helper and is told in one line that it happened, or why it could not, in which case the old helper keeps working. `findwright follow` does the same from the shell. A helper from before this release needs one `/findwright:update` to get it ([#80](https://github.com/starfoxcom/findwright/issues/80)).
- Setup turns on Claude Code's auto-update for the wrights marketplace when FindWright came from it, so new versions install without `/plugin`. A setting already turned off stays off. `findwright home auto-update on|off` changes it, and `home status` reports it ([#80](https://github.com/starfoxcom/findwright/issues/80)).
- FindWright brings its own guidance for the agent, so it works the same with or without Bindwright. Setup writes `rules/findwright.md` in Claude Code's config folder, which every session reads: use FindWright's tools for code research, fall back to Grep or Glob only after two differently worded queries found nothing (marking a shell search with `# FINDWRIGHT_BYPASS: <reason>`), and report the hit rate and the estimated saving when a session closes. The file is FindWright's alone: update and the search server keep it current, and `/findwright:remove` deletes it. `findwright home install-guidance|remove-guidance` does the same from the shell, and `home status` reports it ([#84](https://github.com/starfoxcom/findwright/issues/84)).

## [2.1.0] - 2026-11-17

### Added
- `findwright hits` estimates what the session's searches saved, in dollars, split between the main session and the helper sessions it started (`"saved": {"main": 0.76, "helpers": 0.12, ...}`). A search that names the file the session opens next saves the extra model turns a miss costs before the file turns up. That cost is measured afresh from the transcripts of the project's ten newest sessions that searched, helpers included, per model and effort of the turn that searched, and each turn is priced at its own model's published rates, cache reads and writes and fast mode included. Only those turns count, not what their output adds to later turns, so the figure errs low. Until a missed search has been recorded, it says so instead of guessing ([#70](https://github.com/starfoxcom/findwright/issues/70)).
- The plugin names its icon in `plugin.json`, so the plugin directory can show it on the listing ([#73](https://github.com/starfoxcom/findwright/issues/73)).

### Security
- The index keeps secrets out. Files that hold them by nature (`.env` files other than templates such as `.env.example`, private keys, key stores, `.netrc` and other credential files) are no longer indexed, and tokens with a known shape (AWS, GitHub, GitLab, Slack, Stripe, Google, Anthropic, OpenAI, npm, PyPI and Hugging Face keys, the body of a private key between its BEGIN and END lines, and JSON web tokens) are stored as `[masked]`, so search and find never hand them back. A search for such a token finds nothing; the line around it keeps its place. A password or a token with no known shape in an ordinary file is still indexed. The index also wipes the text of a file it drops or re-reads, from the index file and its write-ahead log, and an index built by an earlier release has the text it had already freed wiped at its first refresh ([#62](https://github.com/starfoxcom/findwright/issues/62)).

### Fixed
- A tool called with an argument it does not take, without one it needs, or with one of the wrong type now says which argument and what it expects (`outline has no argument \`file\`; it takes \`path\` (a string)`), and the call never reaches the index. It used to fail with a raw database error such as "Provided value cannot be bound to SQLite parameter 1" ([#64](https://github.com/starfoxcom/findwright/issues/64)).

## [2.0.1] - 2026-11-15

### Fixed
- A function whose signature wraps over several lines gets its whole body as its range. An `indent` rule ended a Python function at its signature's closing line (`) -> Result:` sits at the `def`'s own indent), and a `brace` rule gave a C or C++ function wrapped over more than three lines no block at all. The lines inside brackets a symbol's line leaves open now continue that line, as Python reads them, and a brace symbol waits for its `{` while its parameters are open. A rule fitted with a `comment` pattern to work around this can drop it ([#58](https://github.com/starfoxcom/findwright/issues/58)).

## [2.0.0] - 2026-11-14

### Breaking
- FindWright has no built-in languages any more: every symbol comes from the rules in the project's `.findwright/config.json`, and the `kinds` setting is gone. A project with no rules still gets full-text and meaning search, but no symbols until `/findwright:fit` writes its rules, which setup and update do for you. A `.template` file is no longer read as the file it renders to: give its rules a glob for it, as the fit does. JSON keys now come from the JSON rule set, which reads each line within a budget set by its length, so a very long line packed with keys, such as minified JSON, names its first keys and leaves out every key after that point in the file, where the old reader named them all. `coverage` now counts files per type (their extension) under `types` ([#49](https://github.com/starfoxcom/findwright/issues/49)).
- FindWright installs from the shared `wrights` marketplace: `/plugin marketplace add starfoxcom/wrights`, then `/plugin install findwright@wrights`. The `findwright` marketplace in this repo is gone, so a computer that installed `findwright@findwright` removes it (`/plugin uninstall findwright@findwright`, then `/plugin marketplace remove findwright`) and installs from `wrights` ([#45](https://github.com/starfoxcom/findwright/issues/45)).

### Added
- Rules in `.findwright/config.json` can give a symbol its structure: `end` says where its block ends (a closing brace, a JSON value's bracket, indentation, the next heading, or a closing pattern), so `outline` and search results show its range; `nest` names it under the symbol that holds it (`jobs.review.steps`, `Grid::build`); `comment` lets an indented block read past the language's comment lines; `group`, `except`, `inside` and `outside` keep a rule off lines it should not name ([#49](https://github.com/starfoxcom/findwright/issues/49)).
- `/findwright:fit` fits the index to a project: it reads what the repo holds, starts from reference rule sets for Markdown, YAML, JSON, JavaScript and TypeScript, Python, CSS, HTML, shell, C and C++, HLSL, Dart and GDScript, writes rules for the rest, and tries them before saving. `findwright try <rules.json>` runs draft rules over the repo without writing anything ([#49](https://github.com/starfoxcom/findwright/issues/49)).
- `/findwright:setup` and `/findwright:update` fit the index to a project that has no rules, without asking, and a session that starts in such a project, or in one whose last few sessions since its rules last changed found the file less often than the goal, is told to run `/findwright:fit`, and so is a session whose `coverage` call shows files with no symbol. `/findwright:doctor` reports a project with no rules ([#49](https://github.com/starfoxcom/findwright/issues/49)).

### Fixed
- A session that kept running an older FindWright after an update no longer rebuilds the index a newer copy wrote with its old settings. The index records the version that built it, and an older copy refuses it with a note to restart the session ([#49](https://github.com/starfoxcom/findwright/issues/49)).
- A rule reads every line in full instead of skipping a line longer than 400 characters, so a JSON file of long values keeps its keys. Block ends are found in one pass over the file, and the repeat matches on one line are limited, so a long or hostile file costs time in proportion to its size: a minified line yields its first matches only, and a nesting rule names nothing after the first line it cuts short, so a path is never wrong.
- The setup skill's helper install line writes the home folder as a placeholder instead of an environment variable, since the plugin directory holds a plugin whose skill text puts a variable beside a network command. The directory check now counts `npm`, `npx` and `fetch` as network commands and "key" and "auth" as credential words, so a line like that fails the pack.
- The plugin's homepage points at the README while the FindWright page is not published, so its listing links to a page that exists.

## [1.1.0] - 2026-11-13

### Added
- With usage counts turned on, a session started in a repo whose last send failed now says so, once a day, until a send gets through. A send that kept failing used to go unnoticed ([#35](https://github.com/starfoxcom/findwright/issues/35)).

### Fixed
- A glob starting with `!` in `search`, `find` and `symbols` (`!CHANGELOG.md`) now leaves out the files it matches, as it does in ripgrep. It used to be read as a file name, matched nothing, and the search answered "No matches." for text the repo holds ([#33](https://github.com/starfoxcom/findwright/issues/33)).

## [1.0.2] - 2026-11-13

### Fixed
- With usage counts turned on, a session that stays open for days now sends them once a day. The send used to run only when a session started, so a long session sent nothing until the next one. The server now checks before each search whether a day has passed since the last try.
- The plugin's skills no longer put an environment variable or a word like "tokens" on the same line as a web address or a download command. The plugin directory's scan reads such a line as using a credential from the user's computer and holds the plugin back. The pack now refuses those lines.

## [1.0.1] - 2026-11-13

### Fixed
- A new rule or file kind in `.findwright/config.json` now applies to every file at the next search. It used to reach only files that changed afterwards, so setup's fit-the-index step showed no new symbols.

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
