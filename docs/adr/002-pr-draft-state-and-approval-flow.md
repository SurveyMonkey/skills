---
type: ADR
description: Fix PRs open as drafts and the orchestrator batch-promotes them, with per-PR confirmation where auto-merge is armed.
status: stable
created: 2026-07-26
owner: brianespinosa
related_issues: [4, 5, 70]
---

# ADR 002: PR draft state and the approval flow

Drives [RFC 001](../rfc/001-alert-orchestration.md). Supersedes the RFC's original decision that
fix PRs open ready for review. Adopted in Phase 1
([#4](https://github.com/SurveyMonkey/skills/issues/4)); the orchestrator half lands in Phase 2
([#5](https://github.com/SurveyMonkey/skills/issues/5)).

## Context

v0.1.0's `fix-alert` command stops before committing and asks "Ready to ship?". That works for one
package per invocation and does not survive parallelism: N subagents pausing for N confirmations
serializes the human and defeats the point of running them concurrently.

RFC 001 replaced it with a single upfront batch approval, and decided PRs would open ready for
review with the merge-risk rating carrying the caution signal. Reviewing that decision while
building Phase 1 exposed the problem: between "user approves the dispatch plan" and "N pull
requests exist against real repositories" there is no checkpoint at all. The user approves a plan
described in prose and next sees finished PRs. Batch approval solved the serialization problem by
removing the control point rather than relocating it.

## Decision

Fix agents open pull requests **as drafts** and return the URLs. The orchestrator collects them,
presents the summary table, and asks whether to mark them ready. On confirmation it marks them
ready; the user can also decline for individual PRs and handle them by hand.

Phase 1 adopts the single-PR form now: `fix-alert.md` drops its pre-commit pause, commits, pushes,
opens a draft, and asks whether to mark it ready.

Draft state is the checkpoint. It is cheap, it is visible in the GitHub UI, and it is
independently meaningful to anyone who stumbles on the PR without the conversation.

**No CI prescription.** Some repositories run every workflow on drafts, some gate expensive jobs
such as e2e until ready. Both are reasonable and both are the repository's business. This system
does not assume, require, or recommend either, and the orchestrator must not imply checks have
passed when it has not looked.

**Rebase before marking ready, from Phase 2 onward.** Two fix PRs in one repository both edit the
same overrides block, so once the first merges the second's rebase conflicts. `mark-ready.sh`
(Phase 2) rebases first, treats "already up to date" as success, marks ready only on a successful
rebase, and **reports conflicts without resolving them**. Resolving a conflicted overrides block
is judgment, which a script should refuse to guess at.

Phase 1 needs none of this: a branch cut from a freshly pulled default branch is never behind, so
marking ready is a bare `gh pr ready`.

## Consequences

The user regains a checkpoint that batch approval had removed, without the serialization that
made per-PR confirmation unacceptable. One interaction covers a whole batch.

Drafts do not request reviewers and do not notify CODEOWNERS, so a batch nobody marks ready is
invisible work. The orchestrator's summary must state the pending action explicitly rather than
listing URLs and stopping.

Where CI is gated on draft status, checks begin at mark-ready, so green checks arrive after the
orchestrator has finished. That is the repository's configuration working as intended, not
something for this system to correct.

Phase 1 gains a behavior change beyond pure script extraction, which #4 otherwise avoided. The
alternative was worse: Phase 1's verification opens draft PRs on four real repositories, so
keeping the old pause would have meant testing a flow no shipped code path performs.

`mark-ready.sh` duplicates part of the existing `gh:rebase-prs` skill. A plugin cannot depend on
another plugin, so the duplication is unavoidable; the expectation is that `gh:rebase-prs`
eventually evolves toward the shape this RFC is driving.

**Draft state is a checkpoint only where promotion and merge are distinct steps** (added during
Phase 2, from field data). arsenalamerica/app#233 was opened as a draft by the v0.2.0 flow, had
auto-merge enabled on it, and merged itself the moment checks went green; nobody read the diff
between "promote" and "merged". Where auto-merge is armed on a PR, promoting *is* merging, the
merge-risk rating calibrates nobody, and a batch promotion would merge N changes on one
confirmation. The decision above stands; what it demands of Phase 2's implementation is that
`mark-ready.sh status` reports auto-merge as armed on the PR versus merely permitted by the
repository, and that the orchestrator confirms armed PRs **per PR** — stating that promotion
merges on green — while everything else keeps the one-batch offer.

**Promotion is not gated on pending checks** (added after a 58-group batch run, issue #70).
`promote` rebases first if the PR is behind (`gh pr update-branch --rebase`, mark-ready.sh:204)
and only then lifts the draft flag (`gh pr ready`, mark-ready.sh:226); it merges nothing. A rebase
pushes a new head, which restarts CI, and a PR that was already current keeps whatever checks were
already running. Either way, waiting for pending checks before offering promotion bought nothing:
the orchestrator still had to re-run `status` and promote the stragglers separately once checks
caught up. Phase 9 now offers `pending` alongside `none`, stating plainly what stage the checks
are in and that promoting is what starts or surfaces whatever CI exists. What still blocks or
qualifies the offer is unchanged: failing checks block outright, armed auto-merge still needs a
per-PR confirmation because promoting it merges on green, and a rebase conflict is still reported
rather than resolved. The merge-risk band is not an input to this decision either way: since
[ADR 006](006-merge-risk-is-static-analysis.md) no agent runs the repository's checks, so there is
no "unverified" group for `pending` to interact with, and CI on the draft is the only verifier.
