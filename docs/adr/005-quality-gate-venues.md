---
type: ADR
description: The quality gates run from one entry point, split across git hooks by cost (fast gates pre-commit, the suite pre-push) and all enforced in CI on ubuntu plus macOS with pinned tool versions, with the plugin version gate running in CI alone because only there is its comparison base unambiguous.
status: stable
created: 2026-08-20
owner: brianespinosa
related_issues: [10, 143]
---

# ADR 005: Quality gate venues and automation

## Context

Three quality gates exist for this repo and, until this decision, all of them ran only when
someone remembered to run them: the shellspec suite (577 examples before this change, 605 with
it; roughly two minutes serial and well under one with `--jobs 8` on an M-series laptop, both
machine-dependent), ShellCheck over every shell file (~2s), and
`claude plugin validate --strict` over the marketplace and plugin manifests (~2s). Nothing
enforced any of them, on a repository whose whole purpose is other people installing plugins from
its default branch. The forcing example is recorded in
[#10](https://github.com/SurveyMonkey/skills/issues/10): shipped v0.1.0 yarn validation carried a
grep whose pattern could never match, zero matches read as "validated", and no gate existed to
catch it.

Each gate catches a class the other two cannot. ShellCheck sees shell defects but not a correct
command doing the wrong thing; the suite sees behavior but never reads the manifests; a malformed
`marketplace.json` breaks installation for every user while both script gates stay green.

A fourth class was added to this ADR later, from
[#143](https://github.com/SurveyMonkey/skills/issues/143): correct, tested, valid plugin code
that no installed plugin ever receives, because
`plugin.json` still carries the version users already have. Nothing above reads a version, and
nothing else in the repo does either, so this failure is invisible to a fully green run.

Three facts, verified while deciding rather than assumed, constrain the venues:

1. **shellspec exits 0 having run zero examples, and a skipped example is equally green.** A bare
   `shellspec` step reports "tests passed" for a suite that never ran, if `spec/` is orphaned or
   `--require spec_helper` stops resolving; and a suite whose `Skip if` predicates invert
   converts executed examples to skips with no change in the total count.
2. **The bash 3.2 parse gate skips on Linux.** `spec/bash32_parse_spec.sh` can only run where
   `/bin/bash` is 3.x, which no ubuntu runner provides, and a skip is green.
3. **Local and CI disagree by default.** `.shellspec` sets `--shell sh`, which is bash 3.2.57 on
   macOS and dash on ubuntu, and dash cannot run the bash-shebanged scripts at all (proven by the
   first run: `set -o pipefail` is not a dash option, issue #57); ubuntu-latest preinstalls
   ShellCheck 0.9.0 against 0.11.0 locally; the Claude CLI self-updates.

## Decision

**One entry point.** `scripts/check.sh` (repo root; dev tooling, not shipped plugin code) is the
single home of every gate's target list. The hooks, the workflow, and humans all call it. Targets
are discovered (`git ls-files`, `plugins/*/` enumeration, `spec/*_spec.sh`), never written down,
and **empty discovery is a hard failure in every gate**, including a floor on *executed*
examples (total minus skips) read from the shellspec summary, because of fact 1.

**Local hooks split by cost.** Committed `.githooks/`, activated once per clone with
`git config core.hooksPath .githooks` (a relative path, so the hooks follow linked worktrees).
`pre-commit` runs the two ~2s gates; the suite runs in `pre-push` (parallel, since a human is
waiting). A 39s pre-commit hook trains people to `--no-verify`, and a hook routinely bypassed is
worth less than no hook. A commit touching nothing the gates read skips them; a missing tool
warns loudly, names the install command, states that CI enforces, and continues. Neither is a
silent skip.

**CI enforces every gate**, in `.github/workflows/gates.yml`, because hooks can be uninstalled,
skipped, or absent on a fresh clone. Jobs `lint`, `validate`, and `spec` give per-gate failure
attribution; an aggregate `gates` job exists to become the single required status check once a
record of real runs exists. The spec job is a **matrix of ubuntu and macOS**: ubuntu runs the
suite under modern bash 5.x (`CHECK_SPEC_SHELL=bash`, because dash was never a supported target,
per fact 3), macOS is the only runner that can execute the bash 3.2 parse gate, and its leg sets
`REQUIRE_BASH32=1` so that gate failing to run fails the job rather than skipping green (facts 2
and 3).

**Tool versions are pinned in CI and asserted after install**, to the versions the hooks run
locally: ShellCheck 0.11.0 from the release tarball, shellspec 0.28.1 installed from its tag ref,
the Claude CLI by version with `DISABLE_AUTOUPDATER=1` (without which the pin is cosmetic). The
pins are not equivalent: the Claude installer script is fetched from a mutable URL, so for it the
post-install `--version` assertion is the pin's only enforcement. The suite runs serial in CI:
parallel is safe by construction (per-specfile workers, per-file workdirs, per-example scratch
dirs), but shellspec's reducer can truncate the report when a worker crashes, and the enforcement
boundary optimizes for a legible report over 90 saved seconds.

**No `paths:` filters on the workflow, ever, while `gates` is a required check.** A PR touching
no matching path would never produce the check and could never merge.

**A fourth gate, `version`, runs in CI only.** A plugin's version lives in its own `plugin.json`
and nowhere else, so a change shipped without bumping it reaches no user while all three gates
above stay green; that omission has no other detector. `scripts/check.sh version` compares the
committed manifest at `HEAD` against the same manifest at a comparison base, for every plugin the
range `base..HEAD` touched, and both venues supply a base where the answer is unambiguous: the
pull request whose base ref *is* the default branch (base: the merge base against
`origin/<default>`, which is what merging the branch would put on the default branch) and the push
that lands on the default branch (base: the push event's `before` sha, so the range is exactly
what landed). Where it does not run, it says so: a stacked pull request skips with the reason
printed, and the skip is a step exiting 0 rather than an `if:` on the job, because `gates` needs
that job's result and a skipped need is not a success.

It is deliberately absent from `fast` and from the hooks, unlike the other three. A hook's base
would be whatever `origin/<default>` last fetched, so the verdict would turn on how recently the
developer fetched, and fetching inside a gate is out of the question; a mid-work commit also
legitimately carries no bump, since bumping is a release act rather than a commit act. Base
resolution outside CI still refuses rather than guesses: `CHECK_VERSION_BASE` wins if set, then
`origin/HEAD`, then a single one of `origin/main` / `origin/master` with a note on stderr saying
`origin/HEAD` is unset (a repository set up with `git remote add` never has it, and refusing there
would punish a clone that did nothing wrong), and none or both is a hard failure naming both
remedies.

One consequence is accepted rather than engineered around: **one pull request in a stack carries
the bump**, so a layer below it fails a rule it cannot satisfy alone. Layers above the bump carry
it and pass. Restricting the pull-request venue to base-ref-is-the-default-branch removes the
noise for every layer but the bottom one, which is genuinely flagged, and correctly: merged alone
it would put plugin changes on the default branch at a version users already have. The remedies
are to merge the stack as a unit or to put the bump in the bottom layer. No bypass mechanism
exists, and none should: a gate whose whole purpose is catching an omission cannot ship with a
switch for omitting it.

lefthook, proposed on #10, is not used: it adds a dependency to a repo whose stated constraint is
`bash`, `jq`, and `gh`, and `core.hooksPath` does the job with none.

## Consequences

- The gate definitions cannot drift between venues, because there is only one definition. The
  cost is that `scripts/check.sh` is itself load-bearing: its refusal paths are covered by
  `spec/check_sh_spec.sh`, and it is included in its own lint and bash 3.2 parse targets.
- Hooks remain bypassable and opt-in per clone. That is accepted: CI is the boundary, and as of
  2026-08-21 it is an enforced one: `gates` is a required status check on the default branch via
  the repository's `protect-default` ruleset, pinned to the GitHub Actions app so no other
  integration can satisfy the context by publishing a status of the same name. The ruleset also
  blocks deletion and non-fast-forward pushes and requires a squash-merged pull request, with no
  bypass actors, so `main` takes no direct pushes from anyone. Marking it required was the
  separate repo-settings action this ADR anticipated, taken once a run record existed; the
  `paths:` filter prohibition above is load-bearing from that moment, because a PR filtered out of
  the workflow would never produce the check and could never merge.
- The version gate has no local venue, so a forgotten bump is learned about on the pull request
  rather than at commit time. That is the cost of a base nobody has to keep fetched; running
  `./scripts/check.sh version` by hand (it is part of `all`) is always available.
- The three pins need manual bumps, and CI will not notice when a newer Claude CLI would reject
  these manifests, which is what users actually run. Bumping the pins periodically is deliberate
  maintenance, not drift.
- The bash 3.2 gate depends on GitHub continuing to provide a macOS runner whose `/bin/bash` is
  3.2. If that changes, `REQUIRE_BASH32=1` makes the change loud instead of silent.
- Dependabot alerts are enabled on this repo while security updates are not, and
  `spec/fixtures/` deliberately pins vulnerable versions. An alert pointing into `spec/fixtures/`
  is about a specimen: do not "fix" the fixture, per root `CLAUDE.md` (a shape found in the wild
  is the specimen).
