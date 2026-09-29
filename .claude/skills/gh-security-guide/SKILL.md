---
name: gh-security-guide
description: The gh-security plugin's domain rules and conventions, which are the requirements for its TypeScript port. Covers the adapter contract, the CLI and its allow hook, git and worktree rules, env_prefix, the fix and pin-audit drivers, override scoping, judging a removal, reading declarations from the lockfile, and the bash rules during the port. Use before you change, review or port anything under plugins/gh-security/.
---

# gh-security guide

These files are the requirements. Where the code disagrees with them, the files win (RFC 002).
Read only the file for your task.

- [core.md](core.md): agents decide and commands do, the process seams, the adapter contract, the
  rule that matters most, and the supported toolchains. Read it first for any change.
- [cli.md](cli.md): the path table, the CLI's help and exit behavior, the allow hook, the shared
  library, and why prescribed commands must be pre-approvable. Read it before you add or change a
  command or a prescribed shape.
- [git.md](git.md): where each prescribed git shape runs, repo-global git state, and why no Bash
  snippet may depend on the previous call. Read it before you change a git call or a worktree step.
- [env-prefix.md](env-prefix.md): the optional command prefix a session may require. Read it before
  you add a `gh`, `git`, package-manager or adapter call.
- [fix-driver.md](fix-driver.md): the fix driver's state file, cleanup, escapes and ladder, and one
  group per package major line. Read it before you change the fix flow.
- [audit-driver.md](audit-driver.md): the pin-audit driver's removal edit, pin identity, payload
  validation and step guards. Read it before you change the pin audit.
- [override-scoping.md](override-scoping.md): how each package manager scopes an override key,
  and why `validate --baseline` detects collateral moves. Read it before you change how a
  constraint is written or validated.
- [removal.md](removal.md): the whole-tree resolution map, what a parser owes, package identity,
  and the advisory verdicts. Read it before you change how a removal or a lockfile parse is judged.
- [lockfile.md](lockfile.md): why a parent's declaration comes from the lockfile, never from
  `node_modules/`. Read it before you change `why`, `apply_constraint` or `declared_ranges`.
- [bash.md](bash.md): the jq 1.7, bash 3.2 and POSIX-regex targets for the bash that remains, and
  why parity licenses a deletion. Read it before you change a `.sh` file or delete one.
