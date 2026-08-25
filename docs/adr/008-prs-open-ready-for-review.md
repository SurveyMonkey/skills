---
type: ADR
description: Fix and pin-removal PRs open ready for review, the phase 5 dispatch approval is the only checkpoint, and no phase acts on a pull request after it is created.
status: stable
created: 2026-08-24
owner: brianespinosa
related_issues: [65, 70, 87]
---

# ADR 008: Pull requests open ready for review

Supersedes [ADR 002](002-pr-draft-state-and-approval-flow.md). Returns
[RFC 001](../rfc/001-alert-orchestration.md) to its original decision, which ADR 002 had reversed.
Adopted in [#87](https://github.com/SurveyMonkey/skills/issues/87), which
[#65](https://github.com/SurveyMonkey/skills/issues/65) asked for first and was closed on the
argument this ADR answers.

## Context

ADR 002 had fix agents open drafts and gave the orchestrator two phases to lift them: phase 9 read
every PR's check rollup and auto-merge state and asked whether the batch could leave draft, phase
10 rebased and marked the approved ones ready. ADR 007 put the pin-removal PR through the same two
phases.

Three things were wrong with it, and the third is the one that settles it.

**The confirmation carried no information.** At the moment phase 9 asked, the user had not seen any
diff. Approval of a security fix comes from reading the PR, which happens on GitHub, where the
reviewers and CODEOWNERS a PR notifies are the people who decide it. A prompt between "the PR
exists" and "the PR is ready" duplicates that review without adding to it, and the answer is
always yes for anything the user intends to review at all. It cost an interaction per batch, plus
one per PR wherever auto-merge was armed, in a flow whose entire premise is fixing alerts by the
hundred on one upfront approval.

**A session that ended early left the work invisible.** Drafts request no reviewers and notify no
CODEOWNERS. Any run that stopped after phase 8's summary — a crashed session, a closed terminal, a
context limit — left N drafts sitting on open security alerts with nobody told. #65's closing
comment acknowledged this gap and treated it as a transient one; it is not. It is a property of
having any phase after the PRs exist, because any such phase can be skipped by the session ending.

**Draft-then-promote was itself the auto-merge exposure.** ADR 002's own field data:
a field-test fix PR opened as a draft, someone armed auto-merge on it while it sat, and the
skill's *promote* step marked it ready, which merged it unread the moment checks went green. ADR
002 read that as a reason to confirm armed PRs one at a time. But the skill's own action was the
last link in that chain, and the chain existed only because there was a promote step: this plugin
never arms auto-merge, and no PR can be armed before it exists.

## Decision

**Both agents open pull requests ready for review.** `gh pr create` carries no `--draft` in
`agents/fix-dependency.md` or `agents/audit-pins.md`. The merge-risk rating in the PR body carries
the caution signal, as RFC 001 first intended.

**Phase 5's dispatch approval is the checkpoint, and the only one.** It already gates everything
from worktree creation through `gh pr create`, which is every irreversible thing this flow does to
a repository. ADR 002 argued that a plan described in prose is not enough to approve real PRs
against real repositories. The answer is that the PR is precisely the artifact a human reviews, and
it is reviewed where review happens. Opening it does not merge it.

**No phase acts on a pull request after it is created.** The orchestrator's phase 9 and phase 10
are deleted rather than reworked, and ~~the phase that offered the next batch and the pin audit~~
**(amended in [ADR 009](009-decouple-pin-audit.md): renamed to the phase that offers only the next
batch, since the pin audit is no longer offered here at all)** is renumbered to 9. **No
`AskUserQuestion` after phase 5 is about a pull request**: what remains is phase 6's per-repo
permissions consent and the final phase's ~~two dispatch offers~~ **(amended in
[ADR 009](009-decouple-pin-audit.md): now one — the next batch — since the pin audit is no longer
offered here)**, none of which asks the user to decide anything about a PR that exists.
`/gh-security:audit-pins` loses the same tail.

**Merging and arming auto-merge are the human's, on GitHub, and are forbidden to every agent.**
Both agent definitions state it: never merge the PR, never enable auto-merge on it, never offer to
either. This replaces ADR 002's per-PR confirmation for armed PRs with something stronger, because
it removes the capability rather than gating it. Arming auto-merge on a PR is now a decision a
human makes on GitHub, no different in kind from clicking Merge, and nothing this plugin does
follows it. ~~`pr-status.sh` still *reports* `auto_merge.armed`, and the closing report says so and
names who armed it, because a PR that will merge itself is a fact the reader wants.~~ **Removed in
v0.8.4** ([#91](https://github.com/SurveyMonkey/skills/issues/91)): see the amendment below — the
prohibition above is unaffected.

**No CI prescription**, carried forward from ADR 002 unchanged. Some repositories run every
workflow on drafts, some gate expensive jobs until ready; both are the repository's business. This
system does not assume, require, or recommend either, and must never imply checks have passed when
it has not looked. One thing does improve on its own: where CI was gated on draft status, checks
now start when the PR is created rather than whenever somebody remembered to promote it.

**`mark-ready.sh` becomes `pr-status.sh`, read-only.** `promote` is deleted; the read-only `status`
verb survives as the whole script, verbless. Its callers are the orchestrator's closing report and
the standalone `/gh-security:audit-pins` command, both of which print check state and merge state
~~and auto-merge state~~ as **information, not a prompt**. Naming the file for a flow that no
longer exists would be worse than deleting it. **Amended in v0.8.4**
([#91](https://github.com/SurveyMonkey/skills/issues/91)): see the amendment below.

**The rebase-before-ready goes with it, deliberately.** ADR 002 added it because two fix PRs in one
repository edit the same overrides block, so once the first merges the second is behind. That
problem does not go away; it moves to the point where the second PR is merged, which is where
GitHub's own "Update branch" already handles it. A rebase this plugin performs the moment before
marking a PR ready never addressed a merge that happens hours later anyway, and
`gh pr update-branch` is one click on the page the reviewer is already on. A conflicted
machine-generated fix is still better regenerated than hand-resolved.

## Consequences

Reviewers and CODEOWNERS are notified when the PR is created, so there is no window in which
finished work is invisible, and no way for a session ending to leave a batch unannounced. That is
the whole point.

The user loses a checkpoint between the dispatch approval and N open PRs, which is exactly what ADR
002 added and what this reverses. What replaces it is the PR itself, and the dispatch approval still
gates every write.

**One thing the draft flag did that nothing here replaces: a draft cannot be merged by anything at
all.** Not GitHub auto-merge, not a Mergify- or Kodiak-class bot, not a repository workflow that
merges PRs carrying a label. The argument above answers the case where *this plugin's own promote
step* was the last link in that chain, and removing the step removes that link. It does not answer
a repository whose own automation merges a passing PR with nobody reading it; there, opening ready
is what lets the merge happen, and no instruction given to an agent constrains a workflow the
repository runs. So the blast radius of a bad approval is **not** unchanged: it is the same
branches, commits and PRs, plus whatever that repository merges on its own.

**The mechanical half of the control is the suite, and specifically not the permission catalog.**
That distinction is worth recording, because the catalog is the intuitive answer and it is the
wrong one: `preflight-permissions.sh`'s first rule (removed in v0.8.2,
[#86](https://github.com/SurveyMonkey/skills/issues/86)) was `Bash($PLUGIN_ROOT/scripts/*)`, a
blanket
pre-approval of every bundled script, and `mark-ready.sh` — the direct predecessor of
`pr-status.sh` — called `gh pr ready` from inside it. So the catalog pre-approved a mutating `gh`
call wholesale. It constrained what an **agent could type**, never what a **script could do**, and
the script it would have to constrain is the one this ADR is about. There are no `permissions.deny`
rules anywhere in this repository, so nothing there blocks a shape either.

What actually holds the line is `spec/pr_status_spec.sh`: its mock logs every `gh` call it sees,
including the ones it refuses, and an example asserts that a run invoked nothing but `pr view` and
`api`. That runs in CI on every push, and it survives error suppression — `gh pr merge --auto ||
true` fails it, where the catalog would have waved the same call through. The prose rule in the two
agent definitions states the intent; that assertion is what enforces it. A future edit that gives
this script a mutating call has to delete a test to ship.

`SKILL.md` loses roughly 60 lines of promotion policy: the offerability table and the per-PR versus
batch confirmation rules, both of which existed only to decide something. The honest readings of
check state are **relocated, not lost** — the `UNKNOWN` merge-state caution and the
provisional-`passed` caution both survive in the closing report, where they inform rather than
gate, because a report that says "3 of 5 checks finished" is useful even when nothing is being
decided.

ADR 002 is marked superseded and **left otherwise intact**, including its field data. That data is
the reason this ADR has to address auto-merge at all, and rewriting it would erase the evidence
that made the argument.

RFC 001's decision log now carries three entries for this question: PRs open ready, then drafts,
then ready again. The history says so rather than being rewritten, because the middle entry is what
produced the auto-merge finding.

## Amendment: pr-status.sh no longer reports auto-merge state

[Issue #91](https://github.com/SurveyMonkey/skills/issues/91) removed `auto_merge` reporting
entirely. This ADR's Decision described `pr-status.sh` reporting `auto_merge.armed` as the
successor to ADR 002's field data — a fact worth surfacing because a PR that merges itself is
something the reader wants to know. That reasoning held only as long as the field cost nothing to
produce. It did not: `allow_auto_merge()` added a per-repo `gh api repos/<nwo>` call — this
script's only `gh api` use — plus a bash-3.2 memo built out of newline-delimited strings because
there are no associative arrays, all to print a field nothing in this plugin acts on. With the
promotion phases gone, `auto_merge` was read, printed, and dropped by every caller; it was load-
bearing only when a `promote` step existed and promoting an armed PR *was* merging it.

`pr-status.sh` now drops `autoMergeRequest` from its `gh pr view --json` fields and emits no
`auto_merge` key at all. `status_entry` lost its `permitted` argument along with it. The only `gh`
call the script makes is `gh pr view`.

**Everything else in this ADR's Decision still holds.** PRs still open ready for review, phase 5's
dispatch approval is still the only checkpoint, and no phase acts on a pull request after it is
created. Most importantly, the prohibition is unchanged and was never in question: both agent
definitions still forbid merging a PR or arming auto-merge on it, and that rule removes the
capability rather than gating it — v0.8.4 removes only the *observation* of auto-merge state, never
the ability to act on it, which this plugin never had.
