---
paths:
  - "**/docs/adr/**"
---

# Architecture Decision Records (ADRs)

An ADR records one decision, after it is made. Several decisions that need buy-in first are an
RFC. The shared frontmatter rules are in `path-docs.md`.

- Name: `docs/adr/NNN-descriptive-slug.md`, a zero-padded sequential number plus a slug.
- Frontmatter:

  ```yaml
  ---
  type: ADR
  description: <one line>
  status: stable           # draft | stable | deprecated
  created: YYYY-MM-DD
  owner: <github-handle>
  related_issues: []       # optional
  related_milestones: []   # optional; prefer it once an ADR tracks more than a few issues
  ---
  ```

- Sections: Context, Decision, Consequences. Status is frontmatter, never a body heading.
- Context states the problem so that more than one answer could satisfy it, before the Decision
  names one.
- A superseded ADR is set `deprecated` and links its replacement. It is never deleted.

Section guidance and the pull request checklist are in the `docs-authoring` skill (`adr.md`).
