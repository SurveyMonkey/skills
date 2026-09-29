---
name: docs-authoring
description: How to write or change a doc under docs/ in this repository. Covers OKF frontmatter and the status model, the shared keys and reference formats, trust and staleness metadata, the ADR and RFC shapes and section guidance, amending a stable RFC, recording a declined proposal, and index rows. Use when you create, amend, supersede or decline an ADR or RFC, or add trust or staleness metadata to any doc.
---

# Docs authoring

The rules that always apply are in `.claude/rules/path-docs.md`, `path-docs-adr.md` and
`path-docs-rfc.md`. This skill holds the detail and the reasoning behind them. Read only the file
the task needs.

- [okf.md](okf.md): how richer status vocabularies map onto the three values, how a declined
  proposal is recorded, the shared keys and their reference formats, trust (`generated`,
  `verified`, `sources`), staleness, and bundle navigation.
- [rfc.md](rfc.md): a single file or a directory, problem statements, how an RFC relates to ADRs
  and rules, how to amend a stable RFC, and the RFC pull request checklist.
- [adr.md](adr.md): how to write Context so it stands before the Decision, and the ADR pull
  request checklist.
