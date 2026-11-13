---
paths:
  - "README*"
  - "CHANGELOG*"
  - "docs/**"
  - "**/*.{arb,po,strings,xliff,resx}"
  - "**/{i18n,l10n,locales,lang}/**"
---

# Shipped text

Text a user reads (UI strings, docs, README, changelog, release notes, marketing copy, error messages) must read like a person wrote it. Code comments the compiler strips are out of scope.

- **No em dashes or en dashes.** Use a comma, parentheses, a colon, or two sentences.
- **No filler words:** "it's worth noting", "essentially", "robust", "seamless", "leverage", "delve", "comprehensive", "a testament to", "streamline", "empower", "elevate". The same applies to their equivalents in other languages the project ships.
- **No stock patterns:** forced groups of three, "not just X but Y", "it's not X, it's Y", closing summaries that repeat the paragraph.
- **Keep accuracy and the reason.** Plain is not bare: a first-time reader should understand what to do and why.

Before committing user-facing text, read it aloud. If it sounds like a press release, rewrite it.
