---
type: ADR
description: Merge risk is computed from the repository's files rather than from checks an agent runs, and CI on the pull request is the verifier.
status: stable
created: 2026-08-21
owner: brianespinosa
related_issues: [71]
---

# ADR 006: Merge risk is static analysis, and CI is the verifier

## Context

The merge-risk score has seven factors. Two of them, F4 (test signal) and F5 (verification), were
supplied by the fix agent after it ran the repository's own scripts, and both were defined in
terms of that run: F4 said whether the tests passed, F5 said whether every script ran clean.

That definition collapses two situations a reviewer needs told apart. "This repository has no
tests" and "one check could not start on this machine" both scored 2, and the second is not a
property of the fix at all. The tooling-only field-test case is the worked example
([#71](https://github.com/SurveyMonkey/skills/issues/71)): a dev-only transitive pin under a build
tool, nothing in the repository importing it, six checks passing and `e2e` skipped for want of a
dev server. It rated High 7/14, the highest band the system has, and CI went green on the same
commit minutes later. Nothing about that change was high risk, and no rescoring after the fact
would have helped, because the score had already gone into the pull request body a human read.

Two further forces make this more than a mis-scored PR:

- **Volume.** This flow is built to fix alerts by the hundred, one subagent per package major
  line per repository. Running each repository's full check suite once per fix does not scale in
  wall-clock time or in tokens, and it duplicates work the repository's CI is already configured
  to do on every pull request.
- **The judgment it forces.** Running checks means classifying every failure as caused by the
  update or pre-existing, which requires a second worktree, a second full install, and a
  comparison run. That comparison is the single most error-prone judgment in the flow, and a
  failed base install silently invalidates it.

## Decision

**F4 and F5 are computed by `score-merge-risk.sh` from the repository's files, and no agent runs
the repository's checks.**

F4 asks whether anything tests the surface this fix touches, reusing F3's importing modules: a
module counts as covered when a test file imports it by a specifier whose last path segment is the
module's basename, when a `<basename>.test.*` / `<basename>.spec.*` sibling or
`__tests__/<basename>.*` entry sits beside it, or when a test file imports the package itself by
name. Where nothing imports the package at all, the question becomes what would catch a broken
tooling pin, which is the build script.

Where there *are* affected modules and `package.json` declares no `test` script, F4 is 2 whatever
the files look like. A test file nothing runs is not coverage, and the pull request this feeds has
no way to run it either.

F5 asks whether CI will run on the pull request, read out of `.github/workflows/*.yml` and
`*.yaml` with grep: 0 when a pull-request-triggered workflow runs a test, build, typecheck, check,
or lint step, 1 when such a workflow exists with no visible step, 2 when nothing triggers on a
pull request. `pull_request_target` counts alongside `pull_request`, because it also runs on pull
requests, which is the only thing the factor asks.

**CI on the pull request is the verifier.** The agent analyzes, scores, opens the pull request,
and moves on. A band that CI later contradicts is the repository's tests doing their job, not a
defect in the score: the score rates what could be known before the pull request existed, and the
check rollup rates what happened after. The two meet on the PR page, where the reviewer reads both
([ADR 008](008-prs-open-ready-for-review.md); before v0.8.3 they met in the orchestrator's
promotion phases, since deleted).

The factor count, the maximum of 14, the band thresholds and the three escalation rules are
unchanged. `verification_commands` is retired from the adapter contract ([ADR
001](001-ecosystem-adapter-contract.md)) and `common/run-check.sh` is deleted, along with the
`fail-preexisting` / `fail-caused` attribution discipline that existed only to feed F5.

## Consequences

**A fix that breaks the build now ships as a pull request, and CI reports it.** Previously a
`fail-caused` classification aborted the run before a pull request existed. This is the deliberate
trade: the failure is now visible in the place a human already looks, on a PR nobody has merged,
instead of in an agent's failure report.

**Repositories on another CI vendor score 2 on F5.** CircleCI, Buildkite, Jenkins and self-hosted
runners are not read. This flow opens GitHub pull requests and reads the GitHub check rollup, so a
GitHub Actions workflow is the one verifier the score can see before the pull request exists. The
honest reading of a 2 is "nothing here proves CI runs", which is what the score says.

**F4's specifier match is a basename heuristic.** Two modules sharing a basename in different
directories are not told apart, which overstates coverage rather than understating it. Resolving
that properly needs a module graph this script deliberately does not build.

**ADR 004's Haiku re-evaluation criteria shrink.** Criteria 1 and 3 were both about failure
attribution, which no longer exists in this flow. The `sonnet` pin stands on the judgment that
remains: interpreting install failures, choosing the override shape, and writing the pull request
prose.

**A repository's own git hooks still run, and this decision does not touch them.** What is decided
here is that no agent *chooses* to run a repository's checks in order to score them. A hook the
repository has attached to `git commit` or `git push` — lefthook, husky, `core.hooksPath` — is a
different mechanism: it fires automatically on the agent's own commit and push, on the
repository's terms, and it feeds no factor. Two field-test repositories
both ran their full pre-commit and pre-push suites on agent commits under this ADR, and that is
the intended behavior. Those hooks are never bypassed (no `--no-verify`), a hook that fails the
commit or push is a failure result at that phase quoting the hook's output, and nothing in the
repository is edited to make one pass. The agent definitions carry the rule at their
~~commit/push phases~~ **(amended: `fix-dependency.md` routes a failing pre-commit hook to phase
`push` too, since `commit` was never in the result enum —
[#89](https://github.com/SurveyMonkey/skills/issues/89))**
([#78](https://github.com/SurveyMonkey/skills/issues/78)); it is recorded here because the
gap that let it go unstated was this section reading as though ADR 006 had settled every question
about the repository's checks running.

**The score is reproducible from the repository alone.** Two runs on the same commit produce the
same band, where previously the band depended on what happened to be runnable on the machine.
