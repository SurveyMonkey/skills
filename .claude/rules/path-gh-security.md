---
paths:
  - "**/plugins/gh-security/**"
---

# gh-security

The plugin's conventions, domain rules, adapter contract and testing policy are one document:
[`plugins/gh-security/docs/CLAUDE.md`](../../plugins/gh-security/docs/CLAUDE.md). Read it before
changing anything under `bin/`, `src/`, `scripts/`, `agents/`, `skills/` or `workflows/`. It is
the requirements document for the TypeScript port, so where the code disagrees with it, the
document wins ([RFC 002](../../docs/rfc/002-typescript-port.md)).

It is not a `CLAUDE.md` at the plugin root, where it would load as directory context on its own,
because `claude plugin validate --strict` refuses one there ("CLAUDE.md at the plugin root is not
loaded as project context") and `scripts/check.sh validate` gates on that. This rule is what gives
the document the same reach.
