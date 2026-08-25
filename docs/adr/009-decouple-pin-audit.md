---
type: ADR
description: The pin audit no longer rides along in a resolve-alerts run; it is reached only through /gh-security:audit-pins, which preflights for the repo's own open security-labeled PRs and stops if any exist.
status: stable
created: 2026-08-24
owner: brianespinosa
related_issues: [108, 107]
---

# ADR 009: Decouple the pin audit from resolve-alerts

Amends the ride-along dispatch [ADR 007](007-pin-removal-prs.md) and RFC 001 built the audit into,
without superseding or deprecating either: the pin-removal PR mechanics ADR 007 decided (mode
input, the combined-test attempts, the plugin-owned branch) are unchanged and still stand, and ADR
007 stays `stable`. What changes is where the audit is dispatched from.

## Context

`resolve-alerts` queued one `audit-pins` agent behind every fix in the batch, dispatched into the
first free slot once the fixes were flowing, against the one repo the top-ranked group named. That
put two flows in the same run editing the same artifact from opposite directions: fix agents add or
tighten entries in the repository's `pnpm.overrides` / `resolutions` / `overrides` block, and the
audit removes entries from the same block, each on its own branch against the same base.

Run together, a conflict is not an edge case; it is the construction. Any run that opens at least
one fix PR and one removal PR has produced order-dependent edits to the same block: whichever PR
merges first invalidates or conflicts with the other, and the audit's own verdicts were computed
against a `main` that the batch's own fix PRs had not yet reached.

Field evidence from a real `resolve-alerts` run against the field-test repository: the field test's audit PR removed 8 override keys that four of the same batch's own unmerged
fix PRs were tightening or widening. Every one of the audit's verdicts
was accurate against `main` at the moment it ran; every one was invalidated or put in conflict by
the fix PRs the same run had just opened. [Issue #107](https://github.com/SurveyMonkey/skills/issues/107)
proposed surfacing the overlap or scoping the audit away from batch-touched keys — a mitigation that
still lets the two flows collide, just with a warning attached.

## Decision

**The audit does not run inside `resolve-alerts` at all.** `resolve-alerts` does fix pooling only:
no phase asks an audit-mode question, no phase queues or dispatches an `audit-pins` agent, and no
phase reports audit findings. Phase 8's closing report points at `/gh-security:audit-pins` as
separate follow-up work, to be run once this run's fix PRs have landed, and says why: the
overrides-block conflict this ADR documents.

**`/gh-security:audit-pins` is the only entry point that dispatches the audit**, exactly as it
already did standalone; nothing about its own mechanics changes.

**The audit preflights for open security work before it runs.** Before dispatching the agent, the
command checks the target repository for open pull requests carrying the `security` label — the
label this plugin's own fix PRs carry (`gh pr list --repo <nwo> --label security --state open`). If
any exist, the command reports them by number and title, explains that the audit's verdicts are
computed against the default branch and that removing a pin an unmerged fix PR is still tightening
produces exactly that inversion demonstrated, and **stops**. There is no proceed-anyway branch:
a user who wants to run the audit regardless says so in conversation, and no skill machinery is
needed for that.

## Consequences

**A `resolve-alerts` run no longer produces audit findings.** Its closing report is fixes only; a
repository's stale pins are surfaced only by running the audit separately.

**The audit needs its own invocation.** What used to arrive "for free" behind a fix batch is now a
deliberate second step, run via `/gh-security:audit-pins` after the fix PRs from a batch have
landed. This is the point of the change: the audit doing less automatically is what stops it from
acting on a moving target.

**The preflight makes audit-after-fixes the enforced order**, not just documented advice. A user
who runs the audit against a repo carrying open security fixes is told to merge or close them
first and the run stops there, so that inversion scenario cannot recur silently — it now requires an
explicit decision to proceed with fixes still open, made in conversation rather than through a
skill option.

**`resolve-alerts`' plan and summary lose the audit-mode question and the audit findings section.**
Phase 4's approval is fix-only from here; the "one approval covers the batch and the audit's mode"
language ADR 007 introduced no longer describes anything this skill does. Phase 8 keeps its other
offer — the groups declined at phase 3 — unchanged.

**`fix-dependency` and `audit-pins` no longer run concurrently in the same repository by
construction.** They still might, in the narrow window between the preflight's check and a fresh
`resolve-alerts` run being kicked off against the same repo — the preflight is a point-in-time
check, not a lock — so both agent definitions keep their repo-global git-state rules
(no `.git/info/exclude` write, no `git worktree prune`, no `git gc`) as defense in depth rather than
as the sole guard.
