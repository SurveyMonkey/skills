---
paths:
  - "**/plugins/gh-security/**"
  - "docs/gh-security/**"
---

# gh-security

The plugin's conventions, domain rules, adapter contract and testing policy are one document:
[`docs/gh-security/GUIDE.md`](../../docs/gh-security/GUIDE.md). Read it before you change anything
under `scripts/`, `src/`, `agents/`, `skills/` or `workflows/`. It is the requirements document
for the TypeScript port. Where the code disagrees with it, the document wins
([RFC 002](../../docs/rfc/002-typescript-port.md)).

It is not in the plugin directory, because the plugin ships only its run-time files
(`.claude/rules/path-plugins.md`). This rule gives it the reach it had there. It is a `Reference`
doc, so it carries the OKF frontmatter of `.claude/rules/path-docs.md`.
