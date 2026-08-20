---
name: resolve-alerts
description: >
  Resolve Dependabot security alerts for the current repository. Discovers open
  alerts, ranks them by severity and EPSS exploitability, and fixes one
  package, the highest severity tier, or everything — one subagent per group
  (one major line of one package) in an isolated worktree through to a draft PR
  carrying a computed merge-risk rating. Use when asked to fix security
  vulnerabilities in dependencies, resolve Dependabot alerts, or clean up npm
  audit findings.
allowed-tools: Bash(*detect-scope.sh*), Bash(*discover-alerts.sh*), Bash(*select-adapter.sh*), Bash(*detect-capacity.sh*), Bash(*mark-ready.sh status*), Bash(*mark-ready.sh promote*), Bash(*preflight-permissions.sh*), Read, Task, AskUserQuestion
---

Orchestrate the resolution of Dependabot security alerts for the current repository: discover and
rank, ask how much to fix, dispatch one `fix-dependency` subagent per group (one major line of one
package) in parallel, and
walk the resulting draft PRs through an evidence-based mark-ready decision.

The deterministic work lives in scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/common/`. Call them;
do not reimplement them. Every script emits JSON on stdout and exits non-zero with an `error` key
on failure; if one fails, report its error and stop.

You are the control point the user approves. Subagents run unattended through PR creation, so
**nothing dispatches before the user approves the plan in phase 5**, and **no PR leaves draft
without the decision flow in phase 8**.

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

## Phase 2: Permissions preflight

Claude Code does not currently honor this skill's `allowed-tools` grants for plugin skills, so
every prescribed command would otherwise prompt once per shape, per repo. With `nwo` and `repo_root` known from phase 1, run:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/preflight-permissions.sh check <repo_root> <nwo>
```

- If it errors (for example, an unparseable settings file), say so, **skip the preflight, and
  continue** — the run proceeds with ordinary prompts; never block alert resolution on
  permissions housekeeping. This is the one scripted step whose failure is not fatal.
- If `missing_count` is 0 and `additional_directories_missing` is empty, continue silently.
- Otherwise ask for consent with **every missing rule enumerated inside the AskUserQuestion's
  question text itself** — one rule per line, followed by the plugin directory to be granted
  read access and the destination path (`<repo_root>/.claude/settings.local.json`, gitignored,
  revocable line by line). The tool-output JSON is collapsed in the UI, so a list that appears
  only there is invisible; a bare count ("add these 9 rules?") is uninformed consent and is a
  failure of this step. Options: add them now, or continue without (every rule then prompts
  individually as it comes up). On consent:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/preflight-permissions.sh apply <repo_root> <nwo>
```

Report what was added. The catalog is the plugin's prescribed surface only — its own scripts,
the fix agent's mandated git shapes, and the push/PR tail that the phase 5 batch approval
authorizes. Commands agents improvise are deliberately not covered: the spec'd path runs
smooth, deviation still gets scrutiny.

## Phase 3: Discover and route

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/discover-alerts.sh <nwo> \
  | ${CLAUDE_PLUGIN_ROOT}/scripts/common/select-adapter.sh --from-discovery
```

Returns `actionable` (ranked by severity then EPSS, each group annotated with its
`adapter_path`) and `skipped` (each with a `reason`).

A group is **one major line of one package**, not one package: a package resolved at several
majors at once has a different patched version per line, and one group per line is what lets each
get its own branch, worktree and PR (issue #19). Two groups with the same `package` and different
`major_line` are independent work, not a duplicate.

If `actionable` is empty, report every skipped group and stop. Reasons you will see:

- `no fix available` — no patched version published yet
- `open PR exists` — a fix PR is already open (URL in `open_pr_url`)
- `ecosystem not supported yet` — no adapter; see `.github/CONTRIBUTING.md`
- `PR check failed` — the PR lookup itself errored (`error` field)

## Phase 4: Ask how much to fix

Present the ranked table:

> | # | Package | Line | Severity | EPSS | Alerts | Relationship |
> |---|---|---|---|---|---|---|

`Line` is the group's `major_line` (`6.x`, `7.x`). Show it always, not only when a package has
more than one: a row that says `undici 6.x` and another that says `undici 7.x` is the difference
between two fixes and one, and hiding it is how the collapsed-group bug read as normal.

Note skipped groups briefly. Then AskUserQuestion with three options:

- **One** — fix only the top-ranked group (one line of one package, not every line of it).
- **Highest tier** — fix every group at the highest severity present (if no critical alerts
  exist, that means all high; if none, all medium, and so on).
- **Everything** — fix all actionable groups.

## Phase 5: Present the dispatch plan and get one approval

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-capacity.sh
```

`cap` bounds how many subagents run at once; it is machine load, not a harness limit. Show the
plan for the chosen batch:

> | Package | Line | Severity | Likely action | Branch |
>
> N group(s), concurrency cap M → ceil(N/M) wave(s).

"Likely action" comes from the alerts' `relationship` field (direct → version bump, transitive →
scoped override) and is best-effort: the subagent's own `why` classification is authoritative.

Ask for **one** approval of the whole batch. This is the control point: subagents run unattended
from here through draft-PR creation. Nothing dispatches without it.

## Phase 6: Dispatch in waves

Take up to `cap` groups and dispatch them **in a single message with one Task tool call per
group** so they run in parallel:

- `subagent_type`: `fix-dependency`
- prompt: the group JSON verbatim, plus `adapter_path`, `nwo`, `default_branch`,
  `repo_root` (absolute path to this checkout), `scripts_dir`
  (`${CLAUDE_PLUGIN_ROOT}/scripts/common`), and the instruction to follow its agent definition
  and end with its JSON result block.

Two lines of the same package may run in the same wave: they carry different `branch_name`s and
different worktree paths, so they cannot collide.

The cap is a **wave barrier**: never issue more than `cap` Task calls in one message, and do not
start the next wave until every agent in the current one has returned. There is no slot-freed
signal, so the barrier is the honest implementation of the cap (ADR 003). Repeat until the
approved batch is exhausted.

## Phase 7: Summarize the batch

Parse each agent's fenced JSON result. **An unparseable or missing result block is a failure
report** — record it as such; never guess fields.

Present one table for the batch:

> | Package | Line | PR | Risk | F4/F5 | Scripts | Notes |

Failures get their `phase` and `detail`. A result whose `action` is `bare-override` says so in
Notes (`bare override added` or `bare override tightened`, from `bare_override`): it is the one
action whose blast radius reaches past the alerts being fixed, and the table is where a user
comparing PRs will see it.

Then report every non-empty `requires_major_bump[]`, per package line, before anything else in the
summary:

> Still vulnerable after this batch: `undici` 5.29.0 (alerts patched only in the 6.x line). No
> override bounded to 5.x can fix this; it needs a major bump of the parent that pins it, or
> dropping that parent.

These are alerts that stay open after the PRs merge. Reporting a batch as done without them is the
failure mode issue #19 is about, and it is worse coming from the summary than from an agent.

Then aggregate `observations[]` across **all** results, deduplicate identical entries, and split
them by `type`, because the two are not the same news.

`unscoped_override_added` entries are global pins **this batch just created** (the agent's
`bare_override` is `added` and its `action` is `bare-override`). Report them individually, with
the reason the agent gave and the PR that introduced them:

> This batch added 1 unscoped global override: `sharp` `>=0.35.0 <1` in <PR>, because <reason>.
> It pins `sharp` for every consumer in that repository, including copies that were never
> vulnerable.

`unscoped_override` entries are pre-existing, and stay one aggregate line:

> Note: the manifest contains N unscoped global override(s): `<keys>`. These may be removable or
> convertible to scoped pins. The pin audit will test removability
> ([#7](https://github.com/SurveyMonkey/skills/issues/7)).

Leads, not findings. Do not act on either. Without deduplication a five-package dispatch would
report the same pre-existing bare overrides five times. Never fold a newly added pin into that
count and call it pre-existing debt: this batch is the record of where it came from.

## Phase 8: Decide what may leave draft

Drafts do not request reviewers or notify CODEOWNERS, so a batch nobody marks ready is invisible
work — but promotion is a decision, not a default. Gather the evidence:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/mark-ready.sh status <pr-url>...
```

Merge each PR's `checks` and `auto_merge` with the agent's own `f4`/`f5`, and group:

| Group | Condition | Offer promotion? |
|---|---|---|
| Unverified | agent scored F4 = 2 or F5 = 2, and the checks the agent skipped did **not** run in CI | **No.** Report which checks could not run and why; CI on the draft (or after a human promotes) is the verifier. Offering would let "nobody has verified this" promote itself. |
| Verified by CI | agent scored F4 = 2 or F5 = 2, but the rollup shows the **specific skipped checks** ran and passed | Offerable — the deferral resolved to the right actor. The offer must name what was skipped locally and which CI check covered it. |
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
- **Rollups populate as workflows spawn**, and jobs that have not been reported yet are
  invisible — absent is not pending. On a PR created minutes ago, or one reporting materially
  fewer checks than its batch siblings, treat `checks: passed` as provisional: hold the offer
  and re-run `status` before treating the set as complete.

Then ask: one batch confirmation for the offerable, non-armed PRs; one confirmation per armed PR.
The user can decline any subset and handle those by hand.

## Phase 9: Promote

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/mark-ready.sh promote <approved-urls-only>
```

The script rebases first (two fix PRs edit the same overrides block, so once one merges the next
is behind — and Dependabot's own merges race long batches the same way), marks ready only after a
successful rebase, and **reports conflicts without resolving them**. For a conflicted PR,
recommend regeneration over hand-resolution: these PRs are machine-generated, so closing the PR,
deleting its branch, and re-running this skill for that package rebuilds the fix cleanly on the
new default branch — hand-merging a conflicted lockfile is strictly worse. Manual resolution
remains the user's fallback. Report the per-PR outcomes, conflicts and errors included.

## Phase 10: Offer the next batch

If actionable groups remain (the user chose One or a tier), offer to dispatch the next batch:
back to phase 4 with the remaining groups. Otherwise report done, including anything left in the
not-promoted groups and what would unblock it.
