# gh-security: env_prefix

## `env_prefix` is an opaque, optional seam

`env_prefix` is **a command prefix the environment requires for repo-targeted commands**. The
plugin never names an environment manager, probes the filesystem for one, or invents a prefix of
its own, and it never assumes per-directory environments exist at all. **Where a prefix comes from
is the user's environment's concern** — a workspace- or user-level CLAUDE.md or rules file saying
commands in that tree need one — and the dispatcher passes verbatim whatever the session context
supplies.

**The opacity is the agent's, not the dispatcher's.** The dispatcher does have to recognize a
context statement, and to instantiate the prefix against a directory where the statement takes one
(`resolve-alerts` SKILL.md phase 1: the checkout itself, which always exists because nothing is ever cloned). That
happens once, before the repo's first command. From then on the prefix is a literal string that is
threaded and prepended and never re-derived, by the dispatcher or by any agent it dispatches.
Absent any such context there is no prefix and nothing extra happens, which is the ordinary
single-login case ([#135](https://github.com/SurveyMonkey/skills/issues/135)).

The contract is one optional dispatch field. The dispatcher — `resolve-alerts` SKILL.md phase 1,
once per checkout in scope, or the `audit-pins` command's step 1 — resolves
`env_prefix` from session context, runs its own `gh`/`git`/script invocations for that repo under
it, and carries it in the dispatch payload. Each agent then prepends it verbatim to every `gh`,
`git`, package-manager, and adapter-script invocation — composed **after** the command's own `cd`
locator, because the prefix injects environment without changing directory — and runs those
commands bare when the field is absent. It wraps a command, not a shell builtin, so it can never
stand in for a `cd`. `check-advisories.sh` makes its own `gh` call, so it takes the same wrapping.
The ported commands `pr-status` and `check-advisories` take `--env-prefix` and wrap their `gh` calls
with it. The ported command `detect-scope` takes `--env-prefix` and wraps its `gh`, `git` and `ssh -G`
calls with it. The ported command `discover-repos` runs `git` and takes no `--env-prefix`. The ported
command `discover-alerts` takes `--env-prefix` and wraps its `gh` calls with it. The ported command
`classify-lines` takes `--env-prefix` and wraps its `git` calls with it. Its adapter verbs run in
process and start no child. The command `prepare-checkout` takes `--env-prefix` and gives it to
each step: `detect-scope`, the namespace probe, `discover-alerts` and `classify-lines`. So each
`git` and `gh` child of each step runs under it. The command `merge-envelopes` starts no child and
takes no `--env-prefix`.
The command `preflight-repo` takes `--env-prefix` and wraps the registry probe with it, after the
`cd` to the root. The worktree exclude runs bare, and `detect` runs in process. The command
`build-dispatches` starts no child. It reads one prefix for each checkout from a file, and puts it
in the payload of each group of that checkout, or leaves the key out.
The ported command `fix-group setup` takes `--env-prefix` and records it
in the state. Each phase wraps its `git` calls with it, and the package-manager calls that its
adapter verbs start. `detect` runs in process and reads the PATH of the command, not the PATH
under the prefix (a declared difference in the header of `fix-group.ts`).

The failure class this guards against is manager-agnostic: per-directory environment tools load
through interactive shell hooks that non-interactive tool shells never run, so a bare `gh`, `git`,
or install resolves whatever identity or registry token the shell defaults to. The symptoms are
misleading rather than obvious, which is why this is a contract and not a tip: bare `gh` reports
"please run gh auth login" on a correctly configured machine, bare `git fetch` reports
**`repository not found`** (reads as a renamed or deleted repo, not an auth context), bare
`git commit` fails on a missing author identity, and a bare package-manager install 401s against
the wrong registry token. Following an agent definition literally without the wrapping fails at
phase 1 ([#33](https://github.com/SurveyMonkey/skills/issues/33)).

**An absent prefix has two causes and only one of them is benign**: the environment genuinely
needs none, or session context stated one and the dispatcher did not recognize it. Any of the
symptoms above is the signal to re-read session context for a prefix you missed, before concluding
that this repo's commands belong bare.
