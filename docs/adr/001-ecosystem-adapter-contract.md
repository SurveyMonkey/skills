# ADR 001: Ecosystem adapter contract

## Status

Accepted

Drives [RFC 001](../rfc/001-alert-orchestration.md). Landed in Phase 1
([#4](https://github.com/SurveyMonkey/skills/issues/4)).

## Context

RFC 001 moves the deterministic surface of `gh-security` out of command prose and into scripts,
and isolates ecosystem-specific behavior behind an adapter so `npm` and `pip` alerts can share one
orchestrator. The RFC names the verbs (`detect`, `why`, `apply_constraint`, `install`, `validate`,
`list_pins`, `verification_commands`, `compare_versions`) but not how adapters are invoked, what
they return, or how failure is signalled. Phases 2 through 6 all build against this, so the
operational details need settling before the second adapter exists rather than after.

Two things pushed specific decisions here.

**A latent bug in v0.1.0.** The shipped yarn lockfile validation was:

```bash
grep -A1 "^\"?<package>@" yarn.lock | grep version | sort -u
```

Without `-E` the `?` is a literal character, so the pattern can never match. Against a real Yarn
Berry lockfile it returns zero lines while the package plainly exists, and zero matches were read
as "validated." Every yarn repository this plugin touched received a validation claim backed by
nothing. Any contract that lets "found nothing" mean "all clear" can reproduce this.

**Version comparison is not portable across ecosystems.** semver and PEP 440 disagree about
prerelease ordering, and PEP 440 additionally has epochs and post-releases. A shared comparator
would have to be wrong for one of them.

## Decision

**Invocation.** Adapters are executables at `scripts/ecosystems/<name>.sh`, invoked as
`<adapter> <verb> [args]`, run from the repository root. JSON on stdout, human-readable detail on
stderr. `select-adapter.sh` resolves ecosystem to adapter path; nothing else hardcodes it.

**Exit codes** distinguish four outcomes, because callers respond differently to each:

| Code | Meaning | Caller response |
|---|---|---|
| 0 | Success | Continue |
| 1 | Error | Report and stop |
| 2 | Verb not implemented | Feature not built yet; not a failure |
| 3 | Unsupported toolchain | Report and stop; this is a configuration fact, not a bug |

Code 3 exists so bun and Yarn Classic are *reported* rather than crashing, matching how the RFC
treats unsupported ecosystems. Its payload carries `unsupported` and points at
`.github/CONTRIBUTING.md`.

**Empty results are never implicitly successful.** `resolved_versions` returns `present` and
`lockfile_entries` alongside `versions`. If the lockfile parses to zero entries at all, the
adapter exits 1 rather than returning an empty list: that means the parser failed, not that the
repository has no dependencies. A package genuinely absent from a populated lockfile returns
`present: false` with a non-zero `lockfile_entries`. This is the direct countermeasure to the
v0.1.0 bug.

**`resolved_versions` is a verb, and `validate` composes on it.** The RFC lists only `validate`.
Splitting them serves two callers: the merge-risk baseline needs to enumerate versions *before*
any constraint exists to check against, and `validate` needs the same enumeration plus a
predicate. One parser, two consumers.

**Adapters parse lockfiles rather than querying the package manager.** `npm ls --json` and
`yarn info --json` are available and would be less code, but the lockfile is the artifact the PR
commits, and parsing it works before any install has run, which the pre-fix baseline requires.

**Version comparison stays inside the adapter.** `compare_versions` is a verb, not a shared helper
in `common/`. The node adapter implements semver in jq; Phase 6's Python adapter will implement
PEP 440 behind the same verb. Callers that need to rank versions, including
`discover-alerts.sh`, route through the adapter rather than sorting themselves.

**`list_pins` is reserved but unimplemented.** It is part of the contract and returns exit code 2
until Phase 4 ([#7](https://github.com/SurveyMonkey/skills/issues/7)), whose pin audit is its only
consumer. Declaring the verb now keeps the contract complete; implementing it now would land code
with no caller and no way to verify it.

**Dependencies are `bash`, `jq`, and `gh`.** No `node`, no `npx`. Node has no built-in semver, so
using it would mean `npx semver` and a cold-cache network fetch in the middle of a security fix.
Scripts target bash 3.2, the macOS default.

## Consequences

Phases 2 through 6 write agent prompts against verbs rather than package-manager specifics, and
Phase 6 adds Python without touching the orchestrator or the subagents. That is the payoff, and
it is also the bet: if the verb set is wrong, every phase pays for it.

The four exit codes mean callers must check more than zero-or-not. Treating 2 and 3 as generic
failures produces misleading output ("error" when the honest answer is "not built yet" or "not
supported"), so the command prose spells out the response to each.

Lockfile parsing is per-format work: three parsers in the node adapter alone (npm's JSON,
pnpm v9's YAML, Yarn Berry v8's YAML), and a new lockfile format is a code change rather than a
new flag. Accepted deliberately in exchange for working before install and validating the
committed artifact.

`compare_versions` will be implemented more than once across adapters. That duplication is the
point: a single implementation could not be correct for both semver and PEP 440.

Until [#10](https://github.com/SurveyMonkey/skills/issues/10) adds a test harness, the contract is
verified only against real repositories. The bug this ADR is partly a reaction to is exactly the
kind a fixture test catches on day one and a real-repo run can miss for months.
