# OKF profile: the detail

## Description and vocabulary

`description` is what `index.md` surfaces so an agent can decide whether to open the file. Write
it as a statement of the doc's subject, not a restatement of its title.

The type vocabulary (`.claude/rules/path-docs.md`) is deliberately small. A doc that fits none of
these is usually a `Reference`. This includes diagram-directory READMEs, which do not get a type of their own. If you extend the vocabulary,
that is a profile revision, not a local decision.

## Status model

ADRs, RFCs, and PRDs carry `status`. They use OKF's three values and nothing else:

| Value | Meaning |
|-------|---------|
| `draft` | In progress or under review. |
| `stable` | Agreed and in force. |
| `deprecated` | Superseded, withdrawn, or no longer in force. |

Richer vocabularies collapse into these three values. ADR `Proposed` and RFC `in-review` become
`draft`. ADR `Accepted`, RFC `accepted`/`implemented`, and PRD `approved` become `stable`. ADR
`Superseded by ADR-NNN`/`Deprecated`, RFC `superseded`/`withdrawn`, and PRD `superseded` become
`deprecated`.

Three things the three values deliberately do not carry:

- **Supersession** is a link from the deprecated doc to its replacement, in the body. Never
  delete a doc that was in force and got superseded. Old links still resolve to it.
- **Finer lifecycle** ("in review", "implemented") goes in the body when it matters.
- **Decline.** There is no `declined` value, because a proposal that is turned down does not stay
  a doc. See below.

`Reference` and `Runbook` docs do not carry `status`. They are current or stale, and
`stale_after` tracks that.

## Declined proposals

A proposal that is considered and not adopted is deleted, not parked. `deprecated` does not
describe it. That value means a doc was once in force and no longer is. If you apply it to
something never adopted, the label misreads as "we used this once."

Record the outcome first, then delete the proposal in the same PR. The record must carry the
constraints in force at the time. These are team size, product stage, and what the project does
and does not commit to. A future reader needs this, to tell whether their own situation differs
enough to decide otherwise.

Where that record goes depends on the doc type. The per-type rule states the location. The pull
request is the archive for the proposal itself, so link it from the record.

## Shared keys

Defined once here; each per-type rule states which of them it requires.

| Key | Value |
|-----|-------|
| `owner` | GitHub handle accountable for the doc. |
| `created` | `YYYY-MM-DD`. |
| `related_issues` | Issue numbers this doc tracks. |
| `related_milestones` | Milestones that group the work this doc tracks. |

Keys unique to one type live in that type's rule.

**Issues or milestones?** A milestone is one stable reference. An issue list churns, because
execution issues open and close. Each change then means another edit to the doc. Prefer
`related_milestones` whenever a doc tracks more than a few issues. The issue list then lives on
the milestone instead, where it maintains itself. Each per-type rule states which key(s) its type
uses.

**Reference formats.** Same-repo references are bare numbers: `related_issues: [1040]`,
`related_milestones: [3]`. Cross-repo issues use GitHub's shorthand (`owner/repo#24`). Milestones
have no shorthand. A cross-repo milestone reference mirrors the URL path instead
(`owner/repo/milestone/3`). Add `https://github.com/` in front to resolve it.

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

- **Never write a `verified` entry at authoring time.** It asserts that a person confirmed the
  *current* content, which cannot be true before review. The team appends entries once reviewers
  approve the landing PR, with `at:` set to the approval date. Until the OKF tooling lands, you
  can derive these from GitHub PR approvals. Add one by hand only when someone explicitly asks.
- **Comments alone are provenance, never verification.** This covers feedback the team
  incorporates without the commenter's final approval. It may go in `sources` instead
  (`sources: [{ resource: <review thread URL>, author: human:<handle> }]`). This is optional,
  because PR history already records it. Never promote it to `verified`, because the commenter
  critiqued only a prior version.
- **Revisions expire trust.** A content change advances `generated.at`, and `verified` entries
  older than it are stale. A prior verifier does not keep unearned trust through a rewrite.
- **Metadata-only changes do not.** A change that does not alter the doc body is metadata-only
  and must not advance `generated.at`. That covers `status` transitions, `stale_after` bumps,
  `description`/`owner` edits, and entries added to `verified` or `sources`. A record of trust
  must never expire that trust.

The team applies trust metadata from now on, and opportunistically on revision. Do not backfill
it across existing docs.

## Staleness

`stale_after: YYYY-MM-DD` belongs on docs that describe how things currently are. These docs rot
silently: `Reference` docs (architecture overviews, schema docs) and `Runbook`s. Set it about six
months out.

It does **not** belong on point-in-time records. ADRs, RFCs, and PRDs are accounts of a decision
at a moment. They do not go stale in this sense.

When the date passes, re-verify the content against reality, then advance the date. Never bump it
without the re-check.

## Navigation

A bundle root is a directory whose docs form one set to navigate. This is `docs/` in a repo that
keeps its knowledge flat. Or it is each typed subdirectory (`docs/adr/`, `docs/rfc/`) where those
exist. Its `index.md` declares `okf_version: "0.2"` and lists the bundle's docs by `description`.
A reader or agent can then decide what to read, before it opens any file. As a reserved file it
carries no `type`/`description` of its own.

When you land a new doc, add its row to the index in the same PR. Create the `index.md` file if
it is missing.
