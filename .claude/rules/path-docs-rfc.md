---
paths:
  - "**/docs/rfc/**"
---

# Requests for Comments (RFCs)

An RFC is the engineering counterpart to a PRD: a reviewed proposal driving a longer-running technical initiative. Reach for one when the work is **broader than a single ADR** (spanning multiple decisions, files, or phases) and needs **alignment before building** (alternatives and trade-offs matter). An ADR records one decision after the fact; an RFC proposes an initiative and gathers feedback before committing.

**Not sure which?** One decision → ADR. Product ambiguity or stakeholder-facing → PRD. A multi-decision technical change needing buy-in → RFC.

Shared frontmatter requirements — `type`, `description`, the status model, trust, actors, shared keys — are in `path-docs.md`. This rule adds only what is specific to RFCs.

## Naming and shape

An RFC is **either a single file or a directory**, using `NNN-kebab-slug` either way (zero-padded sequential number plus slug):

- **Single file** — `docs/rfc/NNN-kebab-slug.md`. The default; most RFCs need nothing more.
- **Directory** — `docs/rfc/NNN-kebab-slug/` with the RFC at `README.md` and supporting assets (diagrams, exports, extra `.md` files) colocated.

Start as a file. **Promote to a directory** when the RFC needs supporting artifacts: the folder takes the file's name minus `.md`, the content moves to `README.md` inside it, and assets sit alongside. The number and slug never change across the promotion.

## Frontmatter

On the single file, or on the directory's `README.md`:

```yaml
---
type: RFC
description: <one line>
status: draft            # draft | stable | deprecated
created: YYYY-MM-DD
owner: <github-handle>
related_milestones: []   # milestones grouping this RFC's execution work
related_adrs: []         # ADR numbers spawned by this RFC's decisions
---
```

`type`, `description`, `status`, `created`, and `owner` are required.

**RFCs track execution by milestone, not by issue.** An RFC spans many issues over its life, so an issue list in frontmatter churns on every issue opened or closed. Group the execution issues under milestone(s) and reference those in `related_milestones` (formats in `path-docs.md`); `related_issues` is deliberately not part of the RFC contract. Individual issues worth calling out belong in the body's Related section.

**`related_adrs` is the RFC-only key**: the ADRs this RFC's execution produced. Keep it current as decisions land — it is how a reader gets from the initiative to what was actually settled.

An RFC is `draft` while it is being written *and* while it is in review; `stable` once accepted, staying `stable` through implementation. This collapses the old `in-review` and `implemented` distinctions — put either in the body when it matters.

## Sections

In order; omit one only when it genuinely does not apply:

- **Summary** — the problem and why it needs solving, in one paragraph readable standalone. Name the proposal only after the problem stands on its own; a Summary that opens with the solution has skipped the step reviewers are there for.
- **Motivation** — the problem, what is insufficient today, why now.
- **Goals / Non-Goals** — what success is, and what this explicitly does not attempt.
- **Proposed Approach** — the design, with diagrams where they help.
- **Alternatives Considered** — the options weighed and why they lost. An RFC without this is an ADR wearing a costume.
- **Trade-offs & Risks** — what this costs and how it can fail.
- **Rollout / Migration Plan** — phased steps; how existing state moves.
- **Open Questions** — unresolved points, blocking or deferred.
- **Decisions & Follow-ups** — decisions that graduate into ADRs, work that becomes issues, guidance that becomes a skill or rule.
- **Related** — milestones, issues, PRs, ADRs, PRDs.

## Problem statements

A problem statement describes a symptom or harm, with evidence — something users or operators experienced, or a concrete, argued risk of it. The absence of a tool or capability is not a problem statement: "we have no X" is the proposal restated as its own absence, and it makes the proposal the only possible answer by construction.

**Litmus test:** ask what solutions other than the proposed one could satisfy the Summary. If the answer is none, it is a gap statement — rewrite it in terms of the underlying symptom, and let Proposed Approach and Alternatives Considered argue for the answer.

The test also applies mid-review: if a motivation is dropped during review and the proposal survives unchanged, the document is justifying a pre-chosen solution. Reopen the question instead of swapping in a new motivation.

## Composition with ADRs and rules

An RFC drives an initiative; it does not replace the artifacts the initiative produces.

- **Point decisions become ADRs.** Each hard decision made while executing gets a short ADR linking back to the RFC. The RFC records *why we are doing this*; the ADRs record *what we settled on*.
- **Durable guidance becomes a skill or rule.** Guidance engineers apply day to day graduates out of the RFC so it is enforced at the point of work rather than buried in prose.
- **A decision not to do it is still a decision, and it is also an ADR.** This is the record Declined proposals in `path-docs.md` requires before a declined RFC, or a section cut from one, is deleted. The RFC's exploration does not move into the ADR with it: keep what was decided, why, and the constraints, and let the PR hold the design. A parked design's cost analysis and implementation detail rest on assumptions that will be false for whoever revisits it, so preserving it reads as a head start and is a trap.

Cutting scope mid-review is this process working, not a loss. An RFC is expected to shrink as review lands; the parts that lose are deleted, with an ADR behind them if the decision is worth recording at all.

## Amending a stable RFC

A `stable` RFC keeps being edited while its phases execute. Two rules keep that honest.

**Amend in place; do not spawn an ADR for every change.** Scope reductions, dropped support, and settled facts go into the RFC's own **Decisions & Follow-ups**. Reserve ADRs for decisions a later phase has to *build against*. The heuristic: if it changes what gets built, it is an RFC amendment; if it changes how something must be built, it is an ADR.

**When reversing a decision the RFC already records, strike it through and annotate it** rather than deleting it. The reasoning for the reversal is the valuable part, and a silently rewritten RFC cannot be audited.

```markdown
- ~~PRs open ready for review, not as drafts.~~ **Revised during Phase 1** ([ADR 002](...)):
  PRs open as drafts. Opening ready left no checkpoint between approving a plan and N pull
  requests existing.
```

Update the body text at the same time, so the prose and the decisions list do not disagree, and keep `related_adrs` / `related_milestones` frontmatter current as artifacts are spawned.

## PR checklist

- **New multi-decision initiative needing buy-in?** Author the RFC before the rearchitecture starts.
- **Summary states a problem, not a gap?** Apply the litmus test in Problem statements above.
- **RFC accepted?** Set `status: stable`, group the execution issues under milestone(s) linked in `related_milestones`, and spawn ADRs as decisions land, linking them in `related_adrs`.
- **Superseding an RFC?** Set the old one's `status: deprecated` and link the replacement from its body; don't delete it.
- **RFC declined, or a chunk of one cut in review?** Record the outcome in an ADR and delete the RFC, or the cut section, in the same PR. See Composition with ADRs and rules above.
