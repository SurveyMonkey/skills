---
description: >
  Audit this repo's dependency pins — the overrides and resolutions added to
  hold transitive dependencies at safe versions — and report which are no
  longer needed. Preflights for the repo's own open security-labeled PRs and
  stops if any exist. Each removal is tested in an isolated worktree against
  every published advisory for the package, and the removable set is tested
  once more together before a removal PR is opened for review. Report-only is
  offered as the alternative.
---

The user explicitly invoked `/gh-security:audit-pins`. Run the pin audit on the current
repository, directly: this entry point does not discover or fix alerts.

## 1. Detect scope

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-scope.sh
```

The audit is **repo-scoped**, and stays so even though alert resolution now reaches org and user
scope: one `audit-pins` agent tests one repository's pins. `scope` is `repo` when the working
directory is inside a git repository and `null` when it is not; nothing is inferred from what the
directories are named (issue #134). If `scope` is null, say that this command audits a single
repository and ask which one, or ask the user to run it from that repo's checkout; then continue
from that checkout. **Re-run `detect-scope.sh <that checkout>` and read `nwo`, `default_branch`
and `repo_root` from the second output**, never from the first: the first ran outside every
repository, so every one of its fields is null, and the two paragraphs below would stop the audit
on a null that describes the old path rather than the checkout the user named. Never fan out
across every repo in an org by hand — each pin tested costs an install, and a silent org-wide
sweep is not what the user asked for.

`nwo` is parsed from `origin`'s remote URL and has no other source, so there is nothing to
cross-check it against: if it is null, this checkout has no usable `origin`; report that and stop,
since the audit's own PR is opened against that repository. If `default_branch` is null, report
that and stop — the audit worktree is created from it.

`repo_root` is `git -C <path> rev-parse --show-toplevel`.

**Resolve `env_prefix` here too, before anything else talks to the repo.** In a workspace where
`gh`, `git`, and the package manager get their identity from `direnv` exporting per-directory
config (`GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`, a registry token) rather than a single ambient
login, a tool-shell invocation misses that: direnv loads via a shell hook, which non-interactive
shells do not run, so a bare `gh` or `git` silently resolves the wrong identity. Check whether a
`.envrc` is present at or above `repo_root`. If so, `env_prefix` is `direnv exec <repo_root>`,
and every `gh`, `git`, and plugin-script invocation this command makes — step 3's `gh pr list`,
step 7's `pr-status.sh` — runs under it; `direnv exec` injects environment without changing
directory, so it composes with, never replaces, whatever `cd` or `-C` locator a command already
carries. If not, there is no `env_prefix` and those commands run bare.

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

## 3. Check for open security fix PRs, and stop if any exist

```bash
<env_prefix> gh pr list --repo <nwo> --label security --state open --limit 100 \
  --json number,title,url,headRefName
```

`<env_prefix>` is what step 1 resolved; when the repo resolved none, run the call bare.

**A non-zero exit here is a failure result quoting stderr, never an answer.** An empty list and a
call that could not run look identical once you stop reading the exit status, and reading a failed
lookup as "no open PRs" is what opens the audit against a moving target. Report the failure and
stop; do not dispatch the agent and do not proceed as if the list came back empty.

The audit's verdicts are computed against the default branch. An open PR carrying the `security`
label may be an unmerged fix from `resolve-alerts` or `fix-dependency` still adding or tightening
an override the audit is about to judge removable; removing a pin one of these PRs still needs
produces exactly the inversion the field test's audit PR demonstrated, where an audit PR
removed 8 keys that four of the batch's own unmerged fix PRs tightened or widened.

**Exclude the audit's own removal PR from this match.** `chore/dependabot-remove-pins` carries the
`security` label too, so filter out any entry whose `headRefName` is `chore/dependabot-remove-pins`
before evaluating the list — that PR is this plugin's own prior output, not a fix in flight, and
the agent's own phase 1 open-PR guard already handles it on its own terms. A removal-PR hit surfacing here
through some other label or head is still worth reporting; it just is not assumed by name.

If the (filtered) list is non-empty, report each PR by number and title, say that these open
security fixes should be merged or closed before the audit runs, and **stop**. Do not dispatch the
agent. There is no proceed-anyway option here: a user who wants to run the audit regardless says so
in conversation, and no skill machinery is needed for that.

If the list is empty, continue.

## 4. Keep the audit worktree out of `git status`

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/ensure-worktree-exclude.sh <repo_root>
```

Local-only, never committed, idempotent. The agent does not do this for itself: `.git/info/exclude`
is repo-global state, and an agent may share a `repo_root` with a concurrent sibling
([#35](https://github.com/SurveyMonkey/skills/issues/35)). A failure here is not fatal — report it
and dispatch anyway.

## 5. Ask which mode, then dispatch

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
(`${CLAUDE_PLUGIN_ROOT}/scripts/common`), `mode`, and an OPTIONAL `env_prefix`, plus the
instruction to follow its agent definition and end with its JSON result block.

**Pass the `env_prefix` step 1 resolved, when it resolved one; omit the field otherwise.** The
agent prepends it verbatim to every `gh`, `git`, package-manager, and adapter-script call,
composed after each command's own `cd` locator, and runs those commands bare when the field is
absent.

This command runs no registry preflight, deliberately: it dispatches one agent, so a dead
registry token costs one failed install and one clear failure report — there is no fan-out to
protect, which is what the `resolve-alerts` probe exists for.

**Never omit `mode` and never guess it.** The agent treats a missing or unrecognized value as an
`input` failure rather than defaulting, because the two modes differ by whether a pull request is
opened against a real repository.

The audit runs an install per pin it tests. PR mode adds up to two more for the combined test. It
is not instant; say so before dispatching.

## 6. Report

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

## 7. Report the PR

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
<env_prefix> ${CLAUDE_PLUGIN_ROOT}/scripts/common/pr-status.sh <pr.url>
```

Under the `env_prefix` step 1 resolved (the script's own `gh` call needs the same identity);
bare when the repo resolved none.

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

**That is the end of the command.** There is no further step and nothing to offer.

A conflicted removal PR is better regenerated than hand-resolved: close it and re-run this
command. There is no branch to clean up by hand. The audit owns `chore/dependabot-remove-pins`,
creates it only at commit time, deletes any local remnant and force-pushes over a remote one that
carries no open PR, so the next run rebuilds it from the current default branch on its own.
