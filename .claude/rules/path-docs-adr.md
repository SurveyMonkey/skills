---
paths:
  - "**/docs/adr/**"
---

# Architecture Decision Records (ADRs)

ADRs are stored in `docs/adr/` and follow the naming convention `NNN-descriptive-slug.md`.

Template: Status / Context / Decision / Consequences. Status values: `Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-NNN`.

## PR checklist

- **New ADR?** Significant architectural decisions (new dependency, data flow pattern, tooling change, performance trade-off) require an ADR.
- **Existing ADRs followed?** Changes must comply with accepted ADRs, or explicitly note the deviation.
- **Revise an ADR?** When constraints change, update the old ADR's status to `Superseded by ADR-NNN` and write the replacement.
