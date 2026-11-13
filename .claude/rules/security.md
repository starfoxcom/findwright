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
