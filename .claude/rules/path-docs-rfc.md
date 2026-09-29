---
paths:
  - "**/docs/rfc/**"
---

# Requests for Comments (RFCs)

An RFC is a reviewed proposal for work broader than one ADR that needs alignment before the team
builds. The shared frontmatter rules are in `path-docs.md`.

- Name: `docs/rfc/NNN-kebab-slug.md`, or a directory `docs/rfc/NNN-kebab-slug/` with the RFC at
  `README.md`. The number and slug never change.
- Frontmatter:

  ```yaml
  ---
  type: RFC
  description: <one line>
  status: draft            # draft | stable | deprecated
  created: YYYY-MM-DD
  owner: <github-handle>
  related_milestones: []   # execution is tracked by milestone, never by issue list
  related_adrs: []         # the ADRs this RFC produced; keep it current
  ---
  ```

  `type`, `description`, `status`, `created` and `owner` are required.
- Sections, in order: Summary, Motivation, Goals / Non-Goals, Proposed Approach, Alternatives
  Considered, Trade-offs & Risks, Rollout / Migration Plan, Open Questions, Decisions &
  Follow-ups, Related. Omit one only when it genuinely does not apply.
- The Summary states a problem with evidence, not a gap. If no solution other than the proposed
  one could satisfy it, rewrite it in terms of the underlying symptom.
- Amend a `stable` RFC in place. Strike through a reversed decision and annotate it; never
  delete it.
- A declined RFC, or a section cut in review, is recorded in an ADR and deleted in the same PR.

Shape, problem statements, composition with ADRs, amendments and the pull request checklist are in
the `docs-authoring` skill (`rfc.md`).
