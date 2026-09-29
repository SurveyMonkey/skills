---
paths:
  - "**/docs/**"
---

# Documentation Frontmatter (OKF profile)

Every non-reserved `.md` file under `docs/` carries YAML frontmatter conforming to this profile of
the [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).
`index.md` and `log.md` are reserved and exempt. Agent-context files such as `CLAUDE.md` carry no
OKF frontmatter, wherever they sit.

```yaml
---
type: <ADR | RFC | PRD | Onboarding | Reference | Runbook>   # required
description: <one line>  # required: the doc's subject, readable standalone
---
```

- The type vocabulary is closed. A doc that fits none is usually a `Reference`.
- ADRs, RFCs and PRDs carry `status`: `draft`, `stable` or `deprecated`, and nothing else.
  `Reference` and `Runbook` docs carry no `status`; they carry `stale_after: YYYY-MM-DD`, about six
  months out.
- Never delete a doc that was in force: set `deprecated` and link its replacement from the body. A
  proposal that is declined is deleted, after its outcome is recorded.
- Never write a `verified` entry at authoring time.
- A new doc adds its row to its bundle's `index.md` in the same PR.

Per-type rules (`path-docs-adr.md`, `path-docs-rfc.md`) add only their own deltas. The status
mapping, shared keys, reference formats, trust, staleness and navigation detail are in the
`docs-authoring` skill (`okf.md`).
