---
paths:
  - "**/docs/rfc/**"
---

# Requests for Comments (RFCs)

An RFC is the engineering-side counterpart to a PRD: a reviewed proposal that drives a
longer-running technical initiative. Reach for an RFC when the work is **broader than a
single ADR** (it spans multiple decisions, files, or phases) and needs **alignment before
building** (alternatives and trade-offs matter). An ADR records one decision after it's made;
an RFC proposes an initiative and gathers feedback before committing.

**Not sure which?** One decision → ADR. Product ambiguity / stakeholder-facing → PRD. A
multi-decision technical change that needs buy-in → RFC.

An RFC is **either a single file or a directory**, using the same `NNN-kebab-slug` naming
either way (zero-padded sequential number + slug):

- **Single file** — `docs/rfc/NNN-kebab-slug.md`. The default; most RFCs need nothing more.
- **Directory** — `docs/rfc/NNN-kebab-slug/` with the RFC itself at `README.md` and
  supporting assets (diagrams, exports, extra `.md` files) colocated.

Start as a file. **Promote to a directory** once the RFC needs supporting artifacts: the
folder takes the file's name minus the `.md` extension, the file's content moves to
`README.md` inside it, and assets are added alongside. The number and slug never change
across the promotion.

## Frontmatter

The RFC (the single file, or the directory's `README.md`) starts with YAML frontmatter for state:

```yaml
---
status: draft            # draft | in-review | accepted | implemented | superseded | withdrawn
created: YYYY-MM-DD
owner: <github-handle>
related_issues: []       # GitHub issue numbers this RFC tracks
related_adrs: []         # ADR numbers spawned by this RFC's decisions
---
```

`status`, `created`, and `owner` are required. Lifecycle: `draft` → `in-review` → `accepted`
→ `implemented`; `superseded` (link the replacement) or `withdrawn` are terminal.

## Sections

The RFC covers these, in order (omit one only when it genuinely doesn't apply):

- **Summary** — the proposal in one paragraph; readable standalone.
- **Motivation** — the problem, what's insufficient today, why now.
- **Goals / Non-Goals** — what success is, and what this explicitly does not attempt.
- **Proposed Approach** — the design, with diagrams where they help.
- **Alternatives Considered** — the options weighed and why they lost. An RFC without this
  is an ADR wearing a costume.
- **Trade-offs & Risks** — what this costs and how it can fail.
- **Rollout / Migration Plan** — phased steps for the initiative; how existing state moves.
- **Open Questions** — unresolved points blocking or deferred.
- **Decisions & Follow-ups** — point decisions that graduate into ADRs (`docs/adr/`), work
  that becomes GitHub issues, and settled guidance that becomes a skill (`.claude/skills/`).
- **Related** — issues, PRs, ADRs, PRDs.

## Composition with ADRs and skills

An RFC drives an initiative; it does not replace the artifacts the initiative produces.

- **Point decisions → ADRs.** Each hard decision made while executing the RFC gets a short
  ADR that links back to the RFC. The RFC records *why we're doing this*; the ADRs record
  *what we settled on*.
- **Durable guidance → skill or rule.** Guidance engineers apply day to day graduates out of
  the RFC into a skill or a path-scoped rule, so it's enforced at the point of work rather
  than buried in prose.

## PR checklist

- **New multi-decision initiative needing buy-in?** Author an RFC (`docs/rfc/NNN-<slug>.md`,
  or a `docs/rfc/NNN-<slug>/` directory if it needs assets) before the rearchitecture starts.
- **RFC accepted?** Set `status: accepted`, then track execution via GitHub issues; spawn
  ADRs as decisions land and link them in `related_adrs`.
- **Superseding an RFC?** Set the old RFC's `status: superseded` and link the replacement;
  don't delete it.
