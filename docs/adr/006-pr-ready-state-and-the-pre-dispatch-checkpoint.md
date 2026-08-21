---
type: ADR
description: "Fix PRs open ready for review; the checkpoint moves ahead of `gh pr create` into the dispatch approval, which discloses per repo where auto-merge is permitted."
status: stable
created: 2026-08-21
owner: brianespinosa
related_issues: [65]
---

# ADR 006: PR ready state and the pre-dispatch checkpoint

Supersedes [ADR 002](002-pr-draft-state-and-approval-flow.md), and with it returns
[RFC 001](../rfc/001-alert-orchestration.md) to its original decision that fix PRs open ready for
review. ADR 002's field data is the reason this ADR has to say more than "drop `--draft`".

## Context

ADR 002 opened fix PRs as drafts and had the orchestrator batch-promote them. Its argument was
sound on its own terms: batch approval had removed the only control point between "the user
approves a dispatch plan described in prose" and "N pull requests exist against real
repositories", and draft state put one back for the price of a single interaction per batch.

Two things it recorded turned out to be the decisive ones.

The first it named as a consequence and accepted: drafts do not request reviewers and do not
notify CODEOWNERS. On security work that cost is not symmetrical with the others. A fix sitting
unpromoted on a live Dependabot alert is not a cautious fix, it is invisible work: the people who
own the code never learn it exists, and the alert stays open while a finished remedy sits behind a
state that reads, to everyone who did not run the tool, as "not finished". The orchestrator's
summary can insist on the pending action, and it does, but only to the one person already in the
session.

The second it added during Phase 2, from the field: arsenalamerica/app#233 opened as a draft, had
auto-merge armed on it, and merged itself the moment checks went green, with nobody reading the
diff. That is a checkpoint failing in the direction it was built to prevent. It also shows what
draft state was actually worth: where auto-merge is armed, promotion *is* merging, so the
checkpoint was never between "PR exists" and "someone reads it" but between "PR exists" and
"merged".

Which leaves the reversal owing an answer to ADR 002's real question. Removing draft does not put
the control point back where batch approval had left it; that gap has to be filled deliberately.

## Decision

**Fix PRs open ready for review.** `gh pr create` carries no `--draft`. Reviewers are requested
and CODEOWNERS are notified at creation, which is the point of the change.

**The checkpoint moves ahead of `gh pr create`, into the dispatch approval.** Phase 5's approval
was already the point past which subagents run unattended; what changes is that it now carries the
whole consequence explicitly instead of describing a plan in prose. The plan states, before
anything is dispatched, that approving it creates N pull requests against the named repositories,
open for review, requesting reviewers, and it names the repos where auto-merge is permitted (see
below). There is no second gate after creation, and that is the honest version: the post-creation
gate ADR 002 relied on protected nothing on exactly the repositories where it mattered most.

Moving the checkpoint earlier makes it a better control point, not a weaker one. A checkpoint
before the irreversible act can prevent it. A checkpoint after it could only decide how loudly to
announce what had already happened.

**Auto-merge is disclosed before dispatch and reported after creation, and this system never arms
it.**

- *Before dispatch.* `allow_auto_merge` is a repository setting, readable before any PR exists, so
  it is available at the checkpoint where a per-PR `autoMergeRequest` is not. `pr-state.sh
  automerge <nwo>...` reports it per repo, and the dispatch plan names every repo that permits
  auto-merge with what that means in plain words: a PR opened there may be armed by the
  repository's own automation and merge itself on green with nobody reading the diff. Those repos
  are confirmed **per repo**, not inside the batch answer. "Open 6 PRs for review" and "open 2 PRs
  that may merge themselves" are different decisions and must not share a prompt.
- *After creation.* `pr-state.sh status` continues to report `auto_merge.armed` versus merely
  `permitted`, and the orchestrator's summary states, for every armed PR, that it will merge on
  green and gives the command that stops it (`gh pr merge --disable-auto <url>`). It reports;
  it does not disarm. Auto-merge on a repository is that repository's policy, and silently
  reversing someone's automation is the same class of overreach as resolving their conflicted
  overrides block.

**The fix agent never merges and never arms.** It creates one PR and returns. Nothing in this
system calls `gh pr merge`.

**No CI prescription** (carried forward from ADR 002, unchanged in substance). Repositories differ
in what they run and when; this system observes check state and never implies checks have passed
when it has not looked. Opening ready does change one thing for the better: where CI was gated on
draft status, checks now start at creation rather than at promotion.

**`mark-ready.sh` becomes `pr-state.sh`, and loses its `promote` verb.** Promotion is not a step
any more, and a script whose name describes a retired flow is a trap for the next reader. What
survives is real and was always the valuable half: two fix PRs in one repository edit the same
overrides block, so the second falls behind the moment the first merges, and Dependabot's own
merges race long batches the same way. The `rebase` verb rebases and reports, treats "already up
to date" in any phrasing as success, and **reports conflicts without resolving them**. It no
longer calls `gh pr ready` in any branch.

## Consequences

CODEOWNERS learn about a security fix when it is created. A run that ends without the user
returning to a summary still leaves reviewable, attributable work rather than a queue of drafts
only the session knew about.

The user approves PR creation instead of PR promotion. That is one interaction, in the same place
batch approval always was, and it is a strictly larger commitment than before, so the plan has to
say so in those terms. An orchestrator that lists groups and asks "proceed?" without naming the
pull requests it is about to open has not implemented this ADR.

Armed auto-merge is now surfaced twice, before and after, and stopped by neither. This is a
deliberate limit: the repository owns its merge policy, the disclosure is what this system owes
the user, and a user who does not want a PR merging itself has the repo setting, the pre-dispatch
per-repo confirmation, and the disarm command. What is no longer true is the ADR 002 situation
where a "checkpoint" quietly implied a human read that never happened.

Phase 9's offerability table loses its subject: with nothing to promote, check state, F4/F5, and
armed auto-merge stop gating an action and become a report. That is a real loss of leverage over
an unverified fix, and it is paid for by review notification arriving at all. The F4/F5 signals
still carry their weight in the merge-risk rating on the PR body, which is now read by the people
CODEOWNERS routes it to rather than by the orchestrator alone. The phase's remaining obligation is
to say plainly which fixes nobody verified, in the summary and on the PR.

`pr-state.sh` still duplicates part of the `gh:rebase-prs` skill, for the reason ADR 002 gave: a
plugin cannot depend on another plugin.
