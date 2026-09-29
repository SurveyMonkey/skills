# RFCs: the detail

## When to write one

An RFC is the engineering counterpart to a PRD. It is a reviewed proposal that drives a
longer-running technical initiative. Reach for one when the work is **broader than a single
ADR**. This means it spans multiple decisions, files, or phases.

An RFC also needs **alignment before the team builds** (alternatives and trade-offs matter). An
ADR records one decision after the fact. An RFC proposes an initiative and gathers feedback
before the team commits.

**Not sure which?** One decision → ADR. Product ambiguity or stakeholder-facing → PRD. A
multi-decision technical change that needs buy-in → RFC.

## Frontmatter keys

`type`, `description`, `status`, `created`, and `owner` are required.

**RFCs track execution by milestone, not by issue.** An RFC spans many issues over its life, so
an issue list in frontmatter churns on every issue opened or closed. Group the execution issues
under milestone(s), and reference those in `related_milestones` (formats in [okf.md](okf.md)).
`related_issues` is deliberately not part of the RFC contract. Individual issues that deserve
mention belong in the body's Related section.

**`related_adrs` is the RFC-only key**: the ADRs this RFC's execution produced. Keep it current
as decisions land. It lets a reader trace the initiative to what the team actually settled.

An RFC is `draft` while the team writes it, and while it is in review. It becomes `stable` once
accepted, and it stays `stable` through implementation. This collapses the old `in-review` and
`implemented` distinctions. Put either detail in the body when it matters.

## Sections

In order. Omit one only when it genuinely does not apply:

- **Summary**: the problem, and why the team must solve it, in one paragraph that stands alone.
  Name the proposal only after the problem stands on its own. A Summary that opens with the
  solution skips the step reviewers are there for.
- **Motivation**: the problem, what is insufficient today, and why now.
- **Goals / Non-Goals**: what success is, and what this explicitly does not attempt.
- **Proposed Approach**: the design, with diagrams where they help.
- **Alternatives Considered**: the options weighed, and why they lost. An RFC without this is an
  ADR in costume.
- **Trade-offs & Risks**: what this costs and how it can fail.
- **Rollout / Migration Plan**: phased steps, and how the current state moves.
- **Open Questions**: unresolved points, whether they block progress or are deferred.
- **Decisions & Follow-ups**: decisions that graduate into ADRs, work that becomes issues,
  guidance that becomes a skill or rule.
- **Related**: milestones, issues, PRs, ADRs, PRDs.

## Naming and shape

An RFC is **either a single file or a directory**. Either way, it uses `NNN-kebab-slug`: a
zero-padded sequential number plus a slug.

- **Single file**: `docs/rfc/NNN-kebab-slug.md`. This is the default. Most RFCs need nothing
  more.
- **Directory**: `docs/rfc/NNN-kebab-slug/`. The RFC sits at `README.md`, with supporting assets
  (diagrams, exports, extra `.md` files) alongside it.

Start as a file. **Promote to a directory** when the RFC needs supporting artifacts. The folder
then takes the file's name, minus `.md`. The content moves to `README.md` inside it, and assets
sit alongside. The number and slug never change across the promotion.

## Problem statements

A problem statement describes a symptom or harm, with evidence. This evidence is something users
or operators experienced, or a concrete, argued risk of it. The absence of a tool or capability is
not a problem statement. "We have no X" restates the proposal as its own absence. This makes the
proposal the only possible answer, by construction.

**Litmus test:** ask what solutions, other than the proposed one, could satisfy the Summary. If
the answer is none, it is a gap statement. Rewrite it in terms of the underlying symptom. Then let
Proposed Approach and Alternatives Considered argue for the answer.

The test also applies mid-review. If reviewers drop a motivation and the proposal survives
unchanged, the document justifies a pre-chosen solution. Reopen the question. Do not just swap in
a new motivation.

## Composition with ADRs and rules

An RFC drives an initiative. It does not replace the artifacts the initiative produces.

- **Point decisions become ADRs.** Each hard decision made while the team executes gets a short
  ADR that links back to the RFC. The RFC records *why the team does this*. The ADRs record
  *what the team settled on*.
- **Durable guidance becomes a skill or rule.** Guidance that engineers apply day to day
  graduates out of the RFC. It becomes a skill or a rule instead, enforced at the point of work
  rather than buried in prose.
- **A decision not to do it is still a decision, and it is also an ADR.** This is the record that
  the Declined proposals section in [okf.md](okf.md) requires. It comes before you delete a
  declined RFC, or a section cut from one.
- The RFC's exploration does not move into the ADR with it. Keep what was decided, why, and the
  constraints. Let the PR hold the design instead. A parked design's cost analysis and
  implementation detail rest on assumptions. Those assumptions will be false for whoever revisits
  the design later. So if you preserve that detail, it reads as a head start, and in fact it is a
  trap.

The process works this way: scope shrinks mid-review, and that is not a loss. An RFC shrinks as
review lands. The team deletes the parts that lose. An ADR stands behind them, if the decision
deserves a record at all.

## Amending a stable RFC

A `stable` RFC does not freeze. The team edits it while its phases execute. Two rules keep that
honest.

**Amend in place. Do not spawn an ADR for every change.** Scope reductions, dropped support, and
settled facts go into the RFC's own **Decisions & Follow-ups**. Reserve ADRs for decisions a
later phase has to *build against*. The heuristic: if a change affects what gets built, it is an
RFC amendment. If it changes how something must be built, it is an ADR.

**When you reverse a decision the RFC already records, strike it through and annotate it, rather
than remove it.** The reasoning for the reversal is the valuable part. A silently rewritten RFC
cannot be audited.

```markdown
- ~~PRs open ready for review, not as drafts.~~ **Revised during Phase 1** ([ADR 002](...)):
  PRs open as drafts. Opening ready left no checkpoint between approving a plan and N pull
  requests existing.
```

Update the body text at the same time, so the prose and the decisions list do not disagree. Also
keep `related_adrs` / `related_milestones` frontmatter current, as new artifacts appear.

## PR checklist

- **New multi-decision initiative that needs buy-in?** Author the RFC before the rearchitecture
  starts.
- **Summary states a problem, not a gap?** Apply the litmus test in Problem statements above.
- **RFC accepted?** Set `status: stable`. Group the execution issues under milestone(s), linked
  in `related_milestones`. Spawn ADRs as decisions land, and link them in `related_adrs`.
- **RFC superseded?** Set the old one's `status: deprecated`, and link the replacement from its
  body. Do not delete it.
- **RFC declined, or a chunk of one cut in review?** Record the outcome in an ADR and delete the
  RFC, or the cut section, in the same PR. See Composition with ADRs and rules above.
