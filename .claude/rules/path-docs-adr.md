---
paths:
  - "**/docs/adr/**"
---

# Architecture Decision Records (ADRs)

An ADR records **one decision, after it is made**. Work spanning multiple decisions that needs buy-in before building is an RFC; product ambiguity is a PRD.

Shared frontmatter requirements — `type`, `description`, the status model, trust, actors, shared keys — are in `path-docs.md`. This rule adds only what is specific to ADRs.

## Naming

`docs/adr/NNN-descriptive-slug.md` — zero-padded sequential number plus slug.

## Frontmatter

```yaml
---
type: ADR
description: <one line>
status: stable           # draft | stable | deprecated
created: YYYY-MM-DD
owner: <github-handle>
related_issues: []       # optional — issue numbers this ADR tracks
related_milestones: []   # optional — milestones grouping the work this ADR tracks
---
```

`type`, `description`, `status`, `created`, and `owner` are required; `related_issues` and `related_milestones` are optional. An ADR is `draft` while the decision is proposed, `stable` once accepted.

**Issues or milestones:** a couple of direct references is fine as `related_issues`. Once an ADR tracks more than a few issues, group them under a milestone and reference it in `related_milestones` instead, so the frontmatter stops churning as issues open and close (formats in `path-docs.md`).

**ADRs add no unique keys** — supersession is a body link per the status model, so there is no `superseded_by` key.

**Status is frontmatter, not a `## Status` body heading.** The old template's `Proposed` / `Accepted` / `Superseded by ADR-NNN` vocabulary collapses into the three-value model per `path-docs.md`.

## Sections

Context / Decision / Consequences. The old template's fourth section, Status, is frontmatter now.

**Context establishes the problem before Decision names a solution.** Write Context so it stands without the Decision: the symptom or forcing constraint, with evidence, in terms that admit more than one answer. A Context that only says the chosen option is missing ("we have no X") is the Decision restated as its own absence — if no solution other than the one in Decision could satisfy the Context, rewrite the Context in terms of the underlying symptom.

## PR checklist

- **New ADR?** A significant architectural decision (new dependency, data-flow pattern, tooling change, performance trade-off) requires one.
- **Existing ADRs followed?** Changes comply with in-force ADRs (`status: stable`) or explicitly note the deviation.
- **Decision came out of an RFC?** Link it back from that RFC's `related_adrs`.
- **Superseding an ADR?** Set the old one's `status: deprecated` and link the replacement from its body; don't delete it.
