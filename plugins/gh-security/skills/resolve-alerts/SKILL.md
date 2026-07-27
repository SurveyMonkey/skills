---
name: resolve-alerts
description: >
  Resolve Dependabot security alerts for the current repository. Discovers open
  alerts, ranks them by severity and EPSS exploitability, and fixes one
  package, the highest severity tier, or everything — each package fixed by its
  own subagent in an isolated worktree through to a draft PR carrying a
  computed merge-risk rating. Use when asked to fix security vulnerabilities in
  dependencies, resolve Dependabot alerts, or clean up npm audit findings.
allowed-tools:
  - Bash(*detect-scope.sh*)
  - Bash(*discover-alerts.sh*)
  - Bash(*select-adapter.sh*)
  - Bash(*detect-capacity.sh*)
  - Bash(*mark-ready.sh status*)
  - Bash(*mark-ready.sh promote*)
  - Read
  - Task
  - AskUserQuestion
---

Orchestrate the resolution of Dependabot security alerts for the current repository: discover and
rank, ask how much to fix, dispatch one `fix-dependency` subagent per package in parallel, and
walk the resulting draft PRs through an evidence-based mark-ready decision.

The deterministic work lives in scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/common/`. Call them;
do not reimplement them. Every script emits JSON on stdout and exits non-zero with an `error` key
on failure; if one fails, report its error and stop.

You are the control point the user approves. Subagents run unattended through PR creation, so
**nothing dispatches before the user approves the plan in phase 4**, and **no PR leaves draft
without the decision flow in phase 7**.

## Phase 1: Detect scope

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-scope.sh
```

This phase handles **repo scope only**. If `scope` is `org` or `user`, report that cross-repo
resolution arrives with Phase 3 of RFC 001
([#6](https://github.com/SurveyMonkey/skills/issues/6)) and stop. Use `nwo` for everything
downstream. If `git_remote` disagrees with `nwo`, trust `git_remote` and say so; the directory
convention is a heuristic and the remote is the fact.

Carry `default_branch` from the same output into every dispatch. If it is null, the script could
not resolve origin's default branch; report that and stop.

## Phase 2: Discover and route

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/discover-alerts.sh <nwo> \
  | ${CLAUDE_PLUGIN_ROOT}/scripts/common/select-adapter.sh --from-discovery
```

Returns `actionable` (ranked by severity then EPSS, each group annotated with its
`adapter_path`) and `skipped` (each with a `reason`).

If `actionable` is empty, report every skipped group and stop. Reasons you will see:

- `no fix available` — no patched version published yet
- `open PR exists` — a fix PR is already open (URL in `open_pr_url`)
- `ecosystem not supported yet` — no adapter; see `.github/CONTRIBUTING.md`
- `PR check failed` — the PR lookup itself errored (`error` field)

## Phase 3: Ask how much to fix

Present the ranked table:

> | # | Package | Severity | EPSS | Alerts | Relationship |
> |---|---|---|---|---|---|

Note skipped groups briefly. Then AskUserQuestion with three options:

- **One** — fix only the top-ranked group.
- **Highest tier** — fix every group at the highest severity present (if no critical alerts
  exist, that means all high; if none, all medium, and so on).
- **Everything** — fix all actionable groups.

## Phase 4: Present the dispatch plan and get one approval

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-capacity.sh
```

`cap` bounds how many subagents run at once; it is machine load, not a harness limit. Show the
plan for the chosen batch:

> | Package | Severity | Likely action | Branch |
>
> N package(s), concurrency cap M → ceil(N/M) wave(s).

"Likely action" comes from the alerts' `relationship` field (direct → version bump, transitive →
scoped override) and is best-effort: the subagent's own `why` classification is authoritative.

Ask for **one** approval of the whole batch. This is the control point: subagents run unattended
from here through draft-PR creation. Nothing dispatches without it.

## Phase 5: Dispatch in waves

Take up to `cap` groups and dispatch them **in a single message with one Task tool call per
group** so they run in parallel:

- `subagent_type`: `fix-dependency`
- prompt: the group JSON verbatim, plus `adapter_path`, `nwo`, `default_branch`,
  `repo_root` (absolute path to this checkout), `scripts_dir`
  (`${CLAUDE_PLUGIN_ROOT}/scripts/common`), and the instruction to follow its agent definition
  and end with its JSON result block.

The cap is a **wave barrier**: never issue more than `cap` Task calls in one message, and do not
start the next wave until every agent in the current one has returned. There is no slot-freed
signal, so the barrier is the honest implementation of the cap (ADR 003). Repeat until the
approved batch is exhausted.

## Phase 6: Summarize the batch

Parse each agent's fenced JSON result. **An unparseable or missing result block is a failure
report** — record it as such; never guess fields.

Present one table for the batch:

> | Package | PR | Risk | F4/F5 | Scripts | Notes |

Failures get their `phase` and `detail`. Then aggregate `observations[]` across **all** results,
deduplicate identical entries, and report once:

> Note: the manifest contains N unscoped global override(s): `<keys>`. These may be removable or
> convertible to scoped pins. The pin audit will test removability
> ([#7](https://github.com/SurveyMonkey/skills/issues/7)).

A lead, not a finding. Do not act on them. Without deduplication a five-package dispatch would
report the same bare overrides five times.

## Phase 7: Decide what may leave draft

Drafts do not request reviewers or notify CODEOWNERS, so a batch nobody marks ready is invisible
work — but promotion is a decision, not a default. Gather the evidence:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/mark-ready.sh status <pr-url>...
```

Merge each PR's `checks` and `auto_merge` with the agent's own `f4`/`f5`, and group:

| Group | Condition | Offer promotion? |
|---|---|---|
| Unverified | agent scored F4 = 2 or F5 = 2 | **No.** Report which checks could not run and why; CI on the draft (or after a human promotes) is the verifier. Offering would let "nobody has verified this" promote itself. |
| Checks failing | `checks` = `failed` | No. List `failing_checks`. |
| Checks pending | `checks` = `pending` | Not yet. Offer to re-run `status` once before moving on. |
| No checks ran | `checks` = `none` | Offerable, flagged honestly: the repo runs no CI on drafts (or none at all), so promoting is what starts whatever exists. The user decides. |
| Ready | `checks` = `passed` | Offerable. |

Two more signals qualify the offer:

- **Auto-merge armed** (`auto_merge.armed` true): promoting this PR **merges it** once checks
  pass. Confirm it **per PR**, stating exactly that, never as part of a batch offer. "Mark 6 PRs
  ready for review" and "merge 6 PRs once CI passes" are different decisions and must not share
  a confirmation prompt. Merely `permitted` changes nothing.
- **`merge_state` = `UNKNOWN`**: GitHub has not computed mergeability yet (common right after
  push). Say so; do not bucket it as clean or behind.

Then ask: one batch confirmation for the offerable, non-armed PRs; one confirmation per armed PR.
The user can decline any subset and handle those by hand.

## Phase 8: Promote

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/mark-ready.sh promote <approved-urls-only>
```

The script rebases first (two fix PRs edit the same overrides block, so once one merges the next
is behind), marks ready only after a successful rebase, and **reports conflicts without resolving
them** — resolving a conflicted overrides block is judgment for a human-driven follow-up session.
Report the per-PR outcomes, conflicts and errors included.

## Phase 9: Offer the next batch

If actionable groups remain (the user chose One or a tier), offer to dispatch the next batch:
back to phase 4 with the remaining groups. Otherwise report done, including anything left in the
not-promoted groups and what would unblock it.
