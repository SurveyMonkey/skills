---
paths:
  - "**/docs/**"
---

# Documentation Frontmatter (OKF profile)

Every non-reserved `.md` file under `docs/` carries YAML frontmatter conforming to this profile of the [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md). `index.md` and `log.md` are reserved by OKF and exempt. Agent-context files such as `CLAUDE.md` are not knowledge docs and carry no OKF frontmatter, wherever they sit. This rule holds everything common to all doc types. Per-type rules (`path-docs-adr.md`, `path-docs-rfc.md`) add only their own deltas and never restate what is here.

## Required on every doc

```yaml
---
type: <one of the vocabulary below>   # required
description: <one line>  # required — what this doc is, readable standalone
---
```

`description` is what `index.md` surfaces so an agent can decide whether to open the file. Write it as a statement of the doc's subject, not a restatement of its title.

## Type vocabulary

`ADR`, `RFC`, `PRD`, `Onboarding`, `Reference`, `Runbook`.

Deliberately small. A doc that fits none of these is usually a `Reference` — including diagram-directory READMEs, which do not get a type of their own. Extending the vocabulary is a profile revision, not a local decision.

## Status model

ADRs, RFCs, and PRDs carry `status`, using OKF's three values and nothing else:

| Value | Meaning |
|-------|---------|
| `draft` | Being written or under review. |
| `stable` | Agreed and in force. |
| `deprecated` | Superseded, withdrawn, or no longer in force. |

Richer vocabularies collapse into these: ADR `Proposed` and RFC `in-review` become `draft`; ADR `Accepted`, RFC `accepted`/`implemented`, and PRD `approved` become `stable`; ADR `Superseded by ADR-NNN`/`Deprecated`, RFC `superseded`/`withdrawn`, and PRD `superseded` become `deprecated`.

Three things the three values deliberately do not carry:

- **Supersession** is a link from the deprecated doc to its replacement, in the body. Never delete a doc that was in force and got superseded; it is what old links resolve to.
- **Finer lifecycle** ("in review", "implemented") goes in the body when it matters.
- **Decline.** There is no `declined` value, because a proposal that is turned down does not stay a doc. See below.

`Reference` and `Runbook` docs do not carry `status`; they are current or they are stale, which is what `stale_after` is for.

## Declined proposals

A proposal that is considered and not adopted is deleted, not parked. `deprecated` does not describe it: that value means a doc was in force and no longer is, so applying it to something never adopted misreads as "we used this once."

Record the outcome first, then delete the proposal in the same PR. The record must carry **the constraints in force at the time** (team size, product stage, what the project does and does not commit to), because that is what lets a future reader tell whether their own situation differs enough to decide otherwise. Where that record goes depends on the doc type; the per-type rule says. The pull request is the archive for the proposal itself, so link it from the record.

## Shared keys

Defined once here; each per-type rule states which of them it requires.

| Key | Value |
|-----|-------|
| `owner` | GitHub handle accountable for the doc. |
| `created` | `YYYY-MM-DD`. |
| `related_issues` | Issue numbers this doc tracks. |
| `related_milestones` | Milestones grouping the work this doc tracks. |

Keys unique to one type live in that type's rule.

**Issues or milestones?** A milestone is one stable reference; an issue list churns as execution issues open and close, and every change means another edit to the doc. Prefer `related_milestones` whenever a doc tracks more than a few issues: the issue list then lives on the milestone, where it maintains itself. Each per-type rule states which key(s) its type uses.

**Reference formats.** Same-repo references are bare numbers: `related_issues: [1040]`, `related_milestones: [3]`. Cross-repo issues use GitHub's shorthand (`owner/repo#24`). Milestones have no shorthand, so cross-repo milestone references mirror the URL path (`owner/repo/milestone/3`), which resolves by appending it to `https://github.com/`.

## Trust

```yaml
generated:
  by: <agent-id>
  at: <timestamp>
verified:
  - by: human:<github-handle>
    at: <timestamp>
```

Actors are namespaced: humans are `human:<github-handle>`, agents use their agent id.

- **Never write a `verified` entry at authoring time.** It asserts that a person confirmed the *current* content, which cannot be true before review. Entries are appended after the landing PR is approved, with `at:` set to the approval date. Until the OKF tooling lands these are derivable from GitHub PR approvals — add one by hand only when explicitly asked.
- **Comments alone are provenance, never verification.** Feedback incorporated without the commenter approving the final version may go in `sources` (`sources: [{ resource: <review thread URL>, author: human:<handle> }]`). Optional — PR history already records it. Never promote it to `verified` — the commenter critiqued a prior version.
- **Revisions expire trust.** A content change advances `generated.at`, and `verified` entries older than it are stale. A prior verifier does not keep unearned trust through a rewrite.
- **Metadata-only changes do not.** A change that does not alter the doc body is metadata-only and must not advance `generated.at`. That covers `status` transitions, `stale_after` bumps, `description`/`owner` edits, and appending `verified` or `sources` entries. Recording trust must never expire trust.

Trust metadata is applied going forward and opportunistically on revision. Do not backfill it across existing docs.

## Staleness

`stale_after: YYYY-MM-DD` belongs on docs that describe how things currently are and rot silently: `Reference` docs (architecture overviews, schema docs) and `Runbook`s. Set it about six months out.

It does **not** belong on point-in-time records — ADRs, RFCs, and PRDs are accounts of a decision at a moment, and do not go stale in this sense.

When the date passes, re-verify the content against reality, then advance the date. Never bump it without the re-check.

## Navigation

A bundle root is a directory whose docs are meant to be navigated as a set: `docs/` in a repo that keeps its knowledge flat, or each typed subdirectory (`docs/adr/`, `docs/rfc/`) where those exist. Its `index.md` declares `okf_version: "0.2"` and lists the bundle's docs by `description`, so a reader or agent can navigate without opening files. As a reserved file it carries no `type`/`description` of its own.

Landing a new doc adds its row to the index in the same PR; create the `index.md` if it is missing.
