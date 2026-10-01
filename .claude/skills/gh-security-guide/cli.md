# gh-security: the CLI, the allow hook and the shared library

## Layout

Paths are relative to `plugins/gh-security/`, except `lib/`, which is the repository root's. The
plugin reaches it through the committed symlink `src/lib -> ../../../lib`
(`.claude/rules/type-ts.md`).

| Path | Scope |
|---|---|
| `scripts/gh-security.ts` | The one entry point: the Node-floor preamble, then the CLI |
| `src/cli/` | `registry.ts`, the subcommand map; `run.ts`, parse, dispatch, render, exit; `command.ts`, what a command is and the real io |
| `lib/envelope.ts` | The four ADR 001 outcomes as one typed result, and the exit codes |
| `lib/node-floor.ts` | The runtime floor, as a pure function over a version string |
| `lib/process.ts` | Runs one child with no shell and an optional time limit; never rejects |
| `lib/streams.ts` | stdout and stderr writers that go quiet on a broken pipe |
| `lib/env-prefix.ts` | The `env_prefix` seam |
| `lib/git.ts` | Git calls: `runGit`, `gitOut`, `gitOk`, `gitLines`, and repository queries |
| `lib/gh.ts` | The typed `gh` client |
| `src/state.ts` | The fix driver's state file, typed |
| `src/jq.ts` | The jq order, `unique`, `tostring`, `tonumber`, `//`, field reads and the major trim rule that `discover-alerts` and `classify-lines` share |
| `src/semver/` | `versions.ts`, comparison, delta and major distance; `ranges.ts`, the range evaluator and `rangeFacts` |
| `src/lockfiles/` | npm, pnpm and Yarn Berry parsers |
| `src/adapters/` | `adapter.ts`: the ADR 001 verbs as one in-process interface. It has the read verbs, `validate`, and the write verbs `install`, `shim` and `applyConstraint`. `node.ts`: the adapter for `npm` alerts. `registry.ts`: GitHub's advisory ecosystem to an adapter, with no CLI entry. `node/`: one file for each verb or group of verbs, one file for each pass of `apply-constraint.ts`, and the helpers. `attempt.ts` makes a throw `failed`. `manifest.ts` reads a `package.json`. `workspace-overrides.ts` reads the `pnpm-workspace.yaml` block. `jq-json.ts` reads and writes JSON values with the rules of jq. `npm-lock.ts` reads a `package-lock.json` for `applyConstraint` |
| `src/subcommands/` | The PreToolUse allow hook, discovery, preflight, scoring, rendering, the drivers |
| `scripts/common/` | The two bash scripts that stay: `detect-capacity.sh` and `notice-scan.sh` |
| `workflows/` | `fix-groups.mjs`, evaluated by the harness (ADR 010) |

One entry point rather than eighteen executables is also what turns the PreToolUse allow rule for
this plugin into one pattern for one path
([#16](https://github.com/SurveyMonkey/skills/issues/16)).

## The CLI

**A command is an exported handler, and the entry point adds nothing.** `src/cli/registry.ts`
maps a subcommand name to a `load` function that dynamically imports that handler, plus the one
line `--help` prints for it, so a command nobody asked for is never loaded. Adding a
command is an entry in that map and a file under `src/subcommands/`, never a change to
`scripts/gh-security.ts`. The entry point itself is four statements: the Node-floor check, which is
its only static import and its first statement, then the CLI, which `src/cli/run.ts` parses,
dispatches, renders and exits with.

**`--help`, `-h` and a bare invocation all print the command list**, one line per command, to
stdout, and exit 0. Nothing else is intercepted: a `--help` after a command name belongs to that
command.

**Exit codes are ADR 001's four, carried by the envelope** (`EXIT_CODES` in `lib/envelope.ts`,
read through `exitCodeFor`): 0 success, 1 error, 2 verb not implemented, 3 unsupported toolchain.
A success payload is JSON on stdout; a failure is `{"error": ...}` on stdout with the same message
in prose on stderr. An unknown command is the one deliberate exception to that split: it is not a
command's result, so its envelope goes to stderr as JSON and stdout stays empty, because a caller
reading stdout as this CLI's contract must never read "there is no such command" as a payload.
A command may also answer with silence, which is exit 0 and nothing written at all.
A handler may return a promise, and `run.ts` waits for it. A handler may also fail with a report
(`failedReport` in `src/cli/command.ts`). The report goes to stdout, the message goes to stderr,
and the exit code is 1. `pr-status` does this, so a caller reads the same JSON on stdout when a
URL failed.

**The allow hook is a subcommand.** `hooks/hooks.json` registers a `PreToolUse` hook on `Bash`
running `node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" allow-own-commands`, which reads the hook
JSON on stdin and answers `hookSpecificOutput.permissionDecision: "allow"` with a reason, so this
plugin's own commands do not prompt ([#16](https://github.com/SurveyMonkey/skills/issues/16);
whether a plugin skill's `allowed-tools` now covers them is #280).

It allows exactly one shape: `node <plugin root>/scripts/gh-security.ts <registered subcommand>
[args]`, where the entry point is resolved from where this plugin is installed
(`import.meta.url`, two directories up from `src/subcommands/`) and never from the command being
judged, and every remaining argument is drawn from one explicit character set (letters, digits,
and `. _ : / @ = + , -`) that contains no shell metacharacter. The installed location rather than
`CLAUDE_PLUGIN_ROOT`: the hooks reference documents that name as a placeholder expanded inside a
hook's `command` string and never states that the variable reaches the hook process's
environment, so a hook reading it would be silently inert wherever it is absent.
Validation is of the whole command, never a substring: chaining, command substitution,
redirection, a pipe, backgrounding, a subshell, a leading `cd` or environment assignment, an
unknown subcommand, a different plugin root, and the entry point appearing inside a longer command
all get no decision, which leaves the normal permission prompt exactly as it was.

**The decision is only ever an allow, and an allow never overrides a deny.** A user's own deny or
ask rule still wins, and this hook has no way to block anything: what it does not recognise it
says nothing about.

## Shared library

**Everything under `lib/` (the plugin's `src/lib`) is written once and imported everywhere.
Nothing later defines its own runner, client, or envelope** ([#217](https://github.com/SurveyMonkey/skills/issues/217)).

**The envelope is the contract between every layer.** ADR 001's four exit codes are four outcomes
carried in one typed value (`ok`, `failed`, `not-implemented`, `unsupported`), and only the entry
point turns one back into a stdout/stderr pair and a process exit code. The JSON is unchanged from
what the scripts emit: a success payload is the value itself at the top level, every failure is
`{"error": ...}`, and an unsupported toolchain additionally names itself in `unsupported`. An
outcome is a value rather than a control-flow event, which is what answers the one property the
process boundary gave for free: a crash the caller could see as an exit code (RFC 002).

**`lib/process.ts` runs a child process, and never rejects.** A child that fails, is killed at
its time limit, or never starts is an answer (`status`, `signal`, `timedOut`, `startFailure`,
`streamErrors`), not a throw. It is asynchronous. `lib/git.ts` runs git through it. `harness/parity.ts` is
synchronous, so it keeps a local runner.

**The `gh` client is SDK-style: one typed method per operation a command performs**, injected
into handlers and mocked one method at a time. Its API is the target stack's, with five methods:
`viewPullRequest` for `pr-status`, `viewDefaultBranch` for `detect-scope`, `listAdvisories` for
`check-advisories`, and `listDependabotAlerts` and `searchOpenPullRequests` for `discover-alerts`.
A method comes with the command that calls it. The last four are not in the target stack, and
`lib/gh.ts` names them as divergences. A method answers with the
value, or throws a `GhError` with gh's exit `status` and its words in `detail`. A command turns
that error into an envelope. Octokit is not the client, because nothing shipped imports anything
outside the plugin (ADR 012). `gh` stays the transport, because it already has the user's
authentication. The client takes no `env_prefix`; a caller that needs one wraps the client's `run`
option. Every reply is parsed and checked where it enters, and never given a default.

## Prescribed shapes are pre-approvable on their own

Write each command that a skill or agent prescribes so that a permission rule can approve it on
its own: literal paths, no variables, no conditionals, no redirections. Do not rely on a skill's
`allowed-tools` frontmatter to suppress a prompt. Do not rely on the allow hook for a command
outside the one shape it accepts. Until v0.8.2, a permissions preflight pre-approved the whole
plugin surface in one decision. v0.8.2 made `auto` the recommended default mode and removed the
preflight ([#86](https://github.com/SurveyMonkey/skills/issues/86)).
