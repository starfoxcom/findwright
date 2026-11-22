# Security

Nothing secret ships. Treat every artifact that leaves your hands as fully readable, reverse engineering included: app and game builds, web bundles and source maps, mobile packages, container images, public repos and their history. Obfuscation and packing slow a casual copier; they never hide a secret.

## Secrets

- No API keys, tokens, passwords, private or signing keys in the repo, a build or a config file that ships. They live server-side or in the platform's secret store (CI secrets, deploy-time environment, a vault), and code reads them at run time.
- A key a client must hold is public by definition. Give it the least power that works (one domain, read-only, rate-limited) and treat it as published.
- Never paste a secret into an issue, PR, commit message, log line, test fixture or chat. Use a placeholder such as `<API_KEY>`.
- A leaked secret is rotated first. Removing it from the history afterwards does not undo the leak.

## Before adding a credential or a download

- A new credential, account or token goes into the inventory: what it opens, where it lives, who can read it and how to rotate it. In a private repo that is `docs/security-posture.md`. In a public repo it is the private copy (ask the user where it lives), never the committed template.
- Anything the app downloads or loads at run time (updates, plugins, mods, remote config, user files) crosses a trust boundary: verify a signature or checksum, and parse it as untrusted input.
- A web page that loads a script from another party's server runs whatever that server sends, on every visit. Pin the script to an exact version with an integrity hash (`integrity="sha384-..."`), or copy it into the project and serve it yourself, and set a Content-Security-Policy that names the allowed sources. A script its vendor changes on purpose (a tag manager, A/B testing) cannot be pinned, so it stays off pages that handle sign-ins or payments.

## Testing your own code's security

- Fuzzing, proof-of-concept exploits and other attack tests against the code this project runs are standard practice: its own parsers, sandboxes, file formats and protocols, the loaders for what users bring into it (mods, plugins, save files), and the libraries it bundles or installs. They find a hole before someone else does. Keep them in the project's tests or a git-ignored scratch folder.
- An attack test attacks only a copy of the code that the test starts itself, wherever the test runs (this computer or a build machine), or a test copy that the project's owner runs and set up for it. Never a live service, the project's own included: an attack there can corrupt real data or take the service down.
- Content people send or load into the project (bug reports, uploaded files, proposed changes, mods, save files) may be read and taken apart as untrusted input, including working out whether it carries an exploit.
- Out of scope: attacking any service or machine the project's owner does not run, such as another company's servers or a third-party API, their test copies included.
- When the assistant declines any part of this kind of work, in scope or not, it says so plainly and names the part it will not do, so the user decides what happens next. It never rewords the task, splits it into pieces or reaches for another tool to get past its own safeguards.
