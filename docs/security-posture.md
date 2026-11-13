# Security posture: findwright

Internal record of what this project defends, which controls are live and which are owed. `.claude/rules/security.md` holds the everyday rule; this file holds the facts it points to. In a private repo, fill in the tables here, delete the rows that do not apply, and update the file at each review below.

In a public repo, fill in a copy kept somewhere private (a private repo, wiki or vault) and commit only this empty template: the open hardening items and the list of what is not defended map exactly where to attack.

## What we defend against

Rank the threats by expected loss, not by how alarming they sound. Common ones:

| Threat | Likelihood | What it costs us | Main control |
|---|---|---|---|
| An account that reaches the source or the release pipeline is taken over | | Full source, the ability to ship as us | Phishing-resistant two-factor sign-in, the inventory below |
| A secret ships in a build or the repo | | Whatever the secret opens | Secrets stay server-side; secret scanning |
| A shipped build is unpacked and read | | Readable code and assets | Nothing secret ships; the hardening list below |
| A build is repackaged and resold | | Sales, reputation | Trademark, takedown notices |
| A download or plugin carries a payload to users | | Users' machines and trust | Signed downloads, untrusted-input parsing |

## Credential inventory

Every door to the source, the build pipeline and the release channels. They are not one door: hardening one account leaves the others open.

| Door | What it opens | Where it lives | Who can read it | Rotation |
|---|---|---|---|---|
| Code host account | The repo, its history, CI secrets | | | |
| Cloud file sync of the working copy | The full working tree, `.git` included | | | |
| Store or publisher account | Shipping a build under our name | | | |
| CI secrets | Whatever each secret opens | | | |
| Developer machines | The working tree and cached sign-ins | | | |
| Third-party apps and access tokens | Whatever scope was granted | | | |

## Account hardening

- [ ] Phishing-resistant two-factor sign-in (security key or passkey) on every account in the inventory. SMS codes removed.
- [ ] Authorized third-party apps and access tokens reviewed; anything unused or unknown revoked.
- [ ] One backup behind a credential that none of the accounts above shares.
- [ ] A copyright notice at the repo root, so a takedown request has a dated claim to cite.

## What ships in each build

| Build | Contents | Who receives it | Readable by |
|---|---|---|---|
| | | | Anyone who has it |

## Hardening at export

Each item filters casual extraction; none stops a determined reader.

- [ ] No debug symbols, source maps or internal logs in release builds.
- [ ] No `.env` files, test keys or sample credentials packed into a build.
- [ ] Internal strings (debug labels, assert messages) stripped where the toolchain allows.
- [ ] Builds that leave trusted hands (betas, demos, press) carry a mark that names the recipient.

## Downloads and plugins

Everything the app fetches or loads at run time, and how each is verified:

| What | From where | Verified by |
|---|---|---|
| | | |

## What we deliberately do not defend

Name what is not worth the cost (the concept, readable data meant for modders, determined reverse engineering), so effort goes where it pays.

## Review cadence

- At each milestone close: the inventory and the token review.
- Before any build leaves trusted hands: the export list.
- After any account compromise or near miss: at once, with what happened.
