---
description: >
  Audit this repo's dependency pins — the overrides and resolutions added to
  hold transitive dependencies at safe versions — and report which are no
  longer needed. Each removal is tested in an isolated worktree against every
  published advisory for the package, and the removable set is tested once more
  together before a removal PR is opened for review. Report-only is offered as
  the alternative.
---

The user explicitly invoked `/gh-security:audit-pins`. Run the pin audit on the current
repository, directly: this entry point does not discover or fix alerts.

## 1. Detect scope

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-scope.sh
```

The audit is **repo-scoped**, and stays so even though alert resolution now reaches org and user
scope: one `audit-pins` agent tests one repository's pins. If `scope` is `org` or `user`, say that
this command audits a single repository and ask which one, or ask the user to run it from that
repo's checkout; then continue from that repo. Never fan out across every repo in the org by hand
— each pin tested costs an install, and a silent org-wide sweep is not what the user asked for.

If `git_remote` disagrees with `nwo`, trust `git_remote` and say so. If `default_branch` is null,
report that and stop — the audit worktree is created from it.

`repo_root` is `git -C <path> rev-parse --show-toplevel`.

## 2. Check there is something to audit, then resolve the adapter

Two separate questions, in this order.

**Is there a manifest?** Use Glob or `test -f <repo_root>/package.json`. `npm` is the only
ecosystem with an adapter today, so a repository with no node manifest has nothing this command
can audit: report exactly that and stop, without dispatching an agent that would only fail on its
first adapter call.

**Which adapter?**

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/select-adapter.sh --ecosystem npm
```

This resolves `adapter_path` and nothing else. It is a pure routing table — ecosystem in, adapter
path out — and never looks at the filesystem, so it answers `supported: true` for `npm` in an
empty directory. It cannot stand in for the check above. Python arrives with its adapter
([#9](https://github.com/SurveyMonkey/skills/issues/9)), and this call is where the choice will be
made once more than one exists.

## 3. Keep the audit worktree out of `git status`

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/ensure-worktree-exclude.sh <repo_root>
```

Local-only, never committed, idempotent. The agent does not do this for itself: `.git/info/exclude`
is repo-global state, and an agent may share a `repo_root` with a concurrent sibling
([#35](https://github.com/SurveyMonkey/skills/issues/35)). A failure here is not fatal — report it
and dispatch anyway.

## 4. Ask which mode, then dispatch

The agent cannot ask anything, so the mode is decided here and passed in. AskUserQuestion, once,
with two options. **PR mode is the first option and the recommended one**, because the audit
already does every bit of the work a removal PR needs and stopping at a report makes a human
re-derive the diff by hand:

- **Open a PR** (`mode: pr`, recommended): audit as usual, then remove the pins the audit
  confirms, install once with all of them gone, re-check every version that newly resolves against
  every published advisory, and open a PR with that evidence. It opens **ready for review**, which
  is not merging it: you review the diff and merge it on GitHub, or close it (ADR 008).
- **Report only** (`mode: report`): the findings and nothing else; the repository is left exactly
  as it is.

Then one Task call, `subagent_type` `audit-pins`, whose prompt carries `repo_root`, `nwo`,
`default_branch`, `adapter_path` (from step 2), `scripts_dir`
(`${CLAUDE_PLUGIN_ROOT}/scripts/common`), and `mode`, plus the instruction to follow its agent
definition and end with its JSON result block.

**Never omit `mode` and never guess it.** The agent treats a missing or unrecognized value as an
`input` failure rather than defaulting, because the two modes differ by whether a pull request is
opened against a real repository.

The audit runs an install per pin it tests. PR mode adds up to two more for the combined test. It
is not instant; say so before dispatching.

## 5. Report

Parse the agent's fenced JSON result. **An unparseable or missing result block is a failure
report** — say so; never guess fields. Present its findings **grouped by package, one table per
package**, as the agent reported them — never a flat list of pin keys:

> | Pin | Scope | Value | Attributable to removal | Elsewhere in the tree | Advisories | Finding |

"Elsewhere in the tree" is not optional and never blank. It reads `nothing else moved`, or names
each other package whose resolution changed with its verdict, or reads `not checked` when the map
was unavailable or only partly read. A verdict with an empty column and one with an unchecked
column are different claims, and a reader who cannot tell them apart is being told the stronger
one.

Then, in order:

- **Removable** pins: what to delete, and the version that resolves instead.
- **Removable individually** pins (`removable-individually`): the package carries more than one,
  and each was tested with the others still in place. Say that, and say that removing more than
  one requires a fresh audit of what remains. Never collapse this status into `removable`; the
  word would then read as a property of the set, which is exactly what was not tested.
- **Still required** pins: the advisory range that still admits the version that would resolve.
- **Inconclusive** and **not tested** pins: why, so the user knows what was not established. A pin
  reported as `no-advisories` is not a pin proven safe.
- **Not a version pin**: aliases, patches, workspace and git targets, npm `"$pkg"` references.
  These are not stale pins; they are how the repository gets a different package or a patched one.

In `report` mode that is the whole result: nothing was changed, and the user acts on the findings.

## 6. Report the PR

In `pr` mode only, and only when the result's `pr` is non-null. Report the URL, the attempt that
passed (`pr.attempt`), `pr.removed_keys`, and `pr.left_behind` with each reason, then the
`pr.risk` band beside the findings above, or "not scored" when `pr.risk.band` is `null` because no
removed package had a version move to rate.

When `pr` is `null`, say which of the five reasons in `pr_skipped_reason` it was and stop here:

| `pr_skipped_reason` | What to say |
|---|---|
| `open PR already exists` | a removal PR is already open on `chore/dependabot-remove-pins`; link `existing_pr_url` and say these findings are what tells them whether it is still the right one |
| `no pins` | the repository declares no overrides or resolutions at all |
| `no removable pins found` | it has pins, and every one of them is still doing something |
| `partial resolution map` | the lockfile could not be read whole, so no removal could be judged against the whole tree; report the count of unreadable entries |
| `combined test failed` | the confirmed pins are not removable as a set; name the package and version that failed it, and which attempt ran |

None of those is a failure; the audit answered the question it was asked. `pr_skipped_detail`
carries the evidence beside the reason: the attempt number (there is no `pr.attempt` to read, since
`pr` is `null` here), the package and version that failed the test or the count of unreadable
entries, and any second reason that also applied.

**A `"status": "failure"` result is none of the five.** Report it as its `failure.phase` and
`failure.detail`, in the failure's own terms. The run stopped part-way, which is not one of the
ways a completed audit declines to open a PR, and presenting it as one hides a broken run among
ordinary outcomes.

**A `pr`-mode success with a `null` `pr` and a `pr_skipped_reason` that is missing or outside those
five values is a contract violation.** Report it as a failure of the agent, quoting what came back,
exactly as an unparseable result block is reported. Never guess which reason was meant.

Otherwise read the PR's current state once and report it as information:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/pr-status.sh <pr.url>
```

Nothing here acts on a pull request after `gh pr create` (ADR 008): do not offer to merge it, do
not enable auto-merge, and do not ask whether it may be marked ready for review, because it already
is. Report what follows, then stop.

- **`pr.risk` rates the change for the reviewer**, and nothing gates on it (ADR 006). A `null`
  band, where no removed package had a version move to rate, is not a gap.
- **The check state is minutes old.** `none` usually means the workflows have not started rather
  than that there are none; `pending` cites `check_counts`; `passed` on a PR this fresh is
  provisional, since rollups populate as workflows spawn and an unreported job is invisible;
  `failed` names `failing_checks`, which is the one worth saying loudly. `merge_state: UNKNOWN` is
  ordinary right after a push and is neither clean nor behind.
- **`auto_merge.armed`** means somebody enabled auto-merge and the PR will merge itself once
  checks pass. Nothing here arms it, so say that it is armed and by whom (`enabled_by`). Merely
  `permitted` is a repository setting and says nothing about this PR.

**That is the end of the command.** There is no further step and nothing to offer.

A conflicted removal PR is better regenerated than hand-resolved: close it and re-run this
command. There is no branch to clean up by hand. The audit owns `chore/dependabot-remove-pins`,
creates it only at commit time, deletes any local remnant and force-pushes over a remote one that
carries no open PR, so the next run rebuilds it from the current default branch on its own.
