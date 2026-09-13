---
paths:
  - "**/plugins/gh-security/**"
---

# gh-security

The plugin's conventions, domain rules, adapter contract and testing policy are one document:
[`plugins/gh-security/docs/GUIDE.md`](../../plugins/gh-security/docs/GUIDE.md). Read it before
changing anything under `bin/`, `src/`, `scripts/`, `agents/`, `skills/` or `workflows/`. It is
the requirements document for the TypeScript port, so where the code disagrees with it, the
document wins ([RFC 002](../../docs/rfc/002-typescript-port.md)).

It is not named `CLAUDE.md`. At the plugin root, where it would load as directory context on its
own, `claude plugin validate --strict` refuses that name ("CLAUDE.md at the plugin root is not
loaded as project context") and `scripts/check.sh validate` gates on it; anywhere else inside the
plugin the name would promise memory semantics the file does not have. This rule is what gives the
document the same reach. It is agent context rather than a knowledge doc, so it carries no OKF
frontmatter, which is what [`path-docs.md`](path-docs.md) exempts `CLAUDE.md` and its kind from
wherever they sit.
