---
name: resolve-alerts
description: >
  Resolve Dependabot security alerts for the current repository, or across an
  entire org or the user's own repos. Discovers open alerts, ranks them by
  severity and EPSS exploitability, and fixes one package, the highest
  severity tier, or everything — one subagent per group (one major line of
  one package, in one repo) in an isolated worktree through to a pull request,
  open for review, carrying a computed merge-risk rating. Use when asked to fix security
  vulnerabilities in dependencies, resolve Dependabot alerts across a repo,
  org, or the user's own repos, or clean up npm audit findings.
allowed-tools: Bash(*detect-scope.sh*), Bash(*discover-alerts.sh*), Bash(*select-adapter.sh*), Bash(*detect-capacity.sh*), Bash(*pr-status.sh*), Bash(*ensure-worktree-exclude.sh*), Bash(git clone*), Bash(gh repo clone*), Bash(git -C * fetch*), Read, Task, AskUserQuestion
---

Orchestrate the resolution of Dependabot security alerts, at repo, org, or user scope: discover
and rank, ask how much to fix, dispatch one `fix-dependency` subagent per group (one major line of
one package, in one repo) in parallel, and report the pull requests they open.

The deterministic work lives in scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/common/`. Call them;
do not reimplement them. Every script emits JSON on stdout and exits non-zero with an `error` key
on failure; if one fails, report its error and stop.

You are the control point the user approves. Subagents run unattended through PR creation, so
**nothing dispatches before the user approves the plan in phase 4**, and that approval is the
whole of it: PRs open **ready for review** and **nothing here acts on a pull request after it is
created** (ADR 008). The decision to merge one is the reviewer's, on GitHub, with the diff in
front of them.

## Phase 1: Detect scope

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-scope.sh
```

`scope` is `repo`, `org`, or `user`, derived from the working directory's `@`-segment convention
(see the script's own header comment). **The user can override this**: if the request names a
different scope than the directory implies ("fix alerts across the whole org" while sitting in one
repo's checkout, or "just this repo" while sitting in the org directory), use the scope the user
asked for instead of the detected one, and say so.

- **repo scope**: use `nwo` for everything downstream. If `git_remote` disagrees with `nwo`, trust
  `git_remote` and say so; the directory convention is a heuristic and the remote is the fact.
  Carry `default_branch` from the same output into dispatch. If it is null, the script could not
  resolve origin's default branch; report that and stop.
- **org scope**: use `owner` as the org. `nwo` and `default_branch` are null here; they are
  resolved per repo in phase 5, once discovery says which repos are actually in play.
- **user scope**: use `owner` (the authenticated login) for display only; `discover-alerts.sh
  --scope user` always operates on the authenticated user's own repos regardless of what `owner`
  resolves to. `nwo` and `default_branch` are again resolved per repo in phase 5.

EMU orgs are out of scope (RFC 001 Non-Goals). This skill does not detect or special-case them; an
EMU org simply has no alerts visible to a personal-account session and discovery reports it as
such through the ordinary org-scope path.

## Phase 2: Discover and route

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/discover-alerts.sh --scope <scope> <target> \
  | ${CLAUDE_PLUGIN_ROOT}/scripts/common/select-adapter.sh --from-discovery
```

`target` is `nwo` at repo scope, `owner` at org scope, and omitted (or the authenticated login) at
user scope. Returns `actionable` (ranked by severity then EPSS, each group annotated with its
`adapter_path` and, at every scope, its own `repo`) and `skipped` (each with a `reason`), plus
`skipped_repos` — repos excluded at org or user scope, because the user cannot push to them
(`no push access`), because the API did not say whether they can (`permission data missing from
API response`), because the repo is a fork (`fork repository`, on both the aggregate and fan-out
paths) or archived (`archived repository`, fan-out path only — the aggregate response can never
name an archived repo, since GitHub refuses Dependabot alerts for archived repositories outright),
or because their alerts could not be read (`alert fetch failed`, `invalid alert response`).
`skipped_repos` is always present and empty at repo scope.

A group is **one major line of one package in one repo**, not one package: a package resolved at
several majors at once has a different patched version per line, and one group per line is what
lets each get its own branch, worktree and PR (issue #19). Two groups with the same `package` and
different `major_line`, or the same `package`/`major_line` in different `repo`s, are independent
work, never a duplicate.

If `actionable` is empty, report every skipped group and every skipped repo, and stop. Reasons you
will see:

- `no fix available` — no patched version published yet
- `open PR exists` — a fix PR is already open (URL in `open_pr_url`)
- `ecosystem not supported yet` — no adapter; see `.github/CONTRIBUTING.md`
- `PR check failed` — the PR lookup itself errored (`error` field)

`skipped_repos` reasons:

- `no push access` — the authenticated user cannot push to the repo; never dispatched
- `permission data missing from API response` — the API did not say whether the user can push
- `fork repository` — never a dispatch target, on both the aggregate and fan-out paths
- `archived repository` — never a dispatch target; fan-out path only
- `alert fetch failed` / `invalid alert response` — the per-repo alert call itself failed
  (`error` field where present)

**Report every skipped repo by name, every time it is non-empty**, whether or not `actionable` is
empty. A repo silently left out of the batch is exactly the failure mode the RFC's push-access
filtering requirement exists to prevent.

## Phase 3: Ask how much to fix

Present the ranked table:

> | # | Repo | Package | Line | Severity | EPSS | Alerts | Relationship |
> |---|---|---|---|---|---|---|---|

Omit the `Repo` column at repo scope — every row shares the same repo, and a constant column is
noise. Include it always at org and user scope, for the same reason `Line` is always shown: hiding
a dimension that can differ between rows is how a collapsed report reads as normal.

`Line` is the group's `major_line` (`6.x`, `7.x`). Show it always, not only when a package has
more than one: a row that says `undici 6.x` and another that says `undici 7.x` is the difference
between two fixes and one, and hiding it is how the collapsed-group bug read as normal.

Note skipped groups and skipped repos briefly. Then AskUserQuestion with three options:

- **One** — fix only the top-ranked group (one line of one package in one repo, not every line or
  every repo).
- **Highest tier** — fix every group at the highest severity present (if no critical alerts
  exist, that means all high; if none, all medium, and so on), across every repo in scope.
- **Everything** — fix all actionable groups, across every repo in scope.

## Phase 4: Present the dispatch plan and get one approval

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-capacity.sh
```

`cap` bounds how many subagents run at once; it is machine load, not a harness limit, and it
applies **machine-wide across every repo in the batch**, not per repo — agents that touch three
repos at once still saturate the same laptop. Show the plan for the chosen batch:

> | Repo | Package | Line | Severity | Likely action | Branch |
>
> N group(s) across M repo(s), concurrency cap C.

Omit the `Repo` column at repo scope, as in phase 3. "Likely action" comes from the alerts'
`relationship` field (direct → version bump, transitive → scoped override) and is best-effort: the
subagent's own `why` classification is authoritative.

At org or user scope, name every distinct repo the plan touches and say plainly that a repo not
yet checked out locally will be cloned under the workspace's `@owner` convention before dispatch
(phase 5) — this is part of what the approval covers, not a separate consent step.

**The pin audit is the last item in the queue.** One `audit-pins` agent joins the run behind every
fix, dispatched as soon as a slot is available for it: immediately, in the first dispatch, when the
fixes do not reach `cap`, and otherwise into the first slot a completion frees. The plan says so, in
the same approval:

> 2 group(s) across 1 repo, concurrency cap 4. The pin audit is queued last, against `octo/app`: it
> reports which of that repo's existing overrides/resolutions are no longer needed and, in PR mode,
> opens a PR removing the ones it confirms.

**The audit's mode is part of this same approval, never a second prompt.** The agent cannot ask, so
`mode` is decided here and passed at dispatch. **PR mode is the first option and the recommended
one**: the audit already does every bit of the work a removal PR needs, so stopping at a report
makes a human re-derive the diff by hand. Carry it as an option on the batch approval itself:

- **Approve, and let the audit open a removal PR** (`mode: pr`, recommended)
- **Approve, audit report-only** (`mode: report`)
- Decline

One approval covers the batch and the audit's mode together. Splitting them into two prompts is
what the one-approval principle exists to prevent, and the audit's PR is reviewed on GitHub like
any other.

Fix agents always come first in the queue, and the audit is queued **once**: its own removability
tests run installs, and a second copy of it would audit the same repository twice. It is queued
whatever the size of the batch, because there is no slot to spare or not spare, only a queue
position, and housekeeping that sits behind every fix costs a fix nothing.

**The audit is repo-scoped, at every scope of this skill.** At org or user scope the batch may span
repos while the audit covers exactly one, so the plan **names the repo it will audit**: the repo of
the top-ranked group, which is the one the user is most likely to be thinking about. It is not a
cross-repo audit, and the remaining repos are offered in phase 8 like any other.

Ask for **one** approval of the whole batch. This is **the last checkpoint before pull requests
exist**: subagents run unattended from here through PR creation, and no phase after this one asks
the user to approve anything about a PR. Nothing dispatches without it.

## Phase 5: Resolve local checkouts (org and user scope only)

Skip this phase entirely at repo scope — `repo_root`, `nwo`, and `default_branch` are already
known from phase 1.

For each **distinct repo** named in the approved batch:

1. **Resolve or create a local checkout.** The workspace convention is one `@`-prefixed directory
   per GitHub owner (see `detect-scope.sh`'s header comment). Compute the expected path as
   `<owner-directory>/<repo-name>`, where `<owner-directory>` is `path` from phase 1 at org scope,
   or `path/@<repo-owner>` at user scope (the repo's own owner, read from its `repo` field, which
   at user scope is always the authenticated login).
   - If a git repository already exists at that path, use it as `repo_root` and refresh it:
     `git -C <repo_root> fetch origin`.
   - If nothing exists there, clone it there: `gh repo clone <repo> <repo_root>`. This keeps the
     new checkout discoverable under the same convention next time, rather than stashing it
     somewhere temporary.
   - If a directory exists at that path but is not the expected git repository (wrong remote, or
     not a repository at all), stop and report the conflict for that repo rather than guessing;
     do not dispatch groups for it.
2. **Resolve `default_branch`** for that `repo_root`:
   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-scope.sh <repo_root>
   ```
   Use its `default_branch`. If null, report that repo as blocked and exclude its groups from
   dispatch rather than guessing a branch name.

Carry the resolved `{repo, repo_root, default_branch}` triples into phase 6; every group dispatched
for a given repo shares its triple.

## Phase 6: Dispatch from a rolling pool

**Once per distinct repo in the approved batch, before the first agent for that repo is
dispatched:**

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/ensure-worktree-exclude.sh <repo_root>
```

This writes the `.claude/worktrees/` line into that repo's `.git/info/exclude`, keeping the agents'
worktrees out of `git status`. It is local-only and never committed, it is idempotent, and it is
**yours to do, not the agents'**: two agents working the same repo start milliseconds apart, and a
read-then-append from each can duplicate the line or tear the file (issue #35). You know the repo
set, so one call per repo removes the race by construction. A failure here is not fatal — report it
and dispatch anyway; the worst case is worktree directories showing up in `git status`.

Then hold the approved groups as a **work queue**: every group across every repo, in the ranked
order phases 3 and 4 settled, with the pin audit last when the plan included one. Drain that queue
as a **rolling pool**, in two motions:

- **Fill.** Dispatch queued items until `cap` agents are in flight, **in a single message with one
  Task tool call per item**, so they start in parallel.
- **Refill.** On each completion notification, dispatch queued items until `cap` are in flight
  again, in one message whenever more than one slot is free. Concurrent completions can free
  several at once, and dispatching a single item per notification would leave the rest idle.

Keep going until the queue is empty and the last agent has returned. Nothing waits for a sibling.

Each queued group is **one Task tool call**:

- `subagent_type`: `fix-dependency`
- prompt: the group JSON verbatim, plus `adapter_path`, the group's own `nwo` (its `repo` field),
  `default_branch` and `repo_root` for that group's repo (from phase 1 at repo scope, or phase 5's
  resolved triples at org/user scope), and `scripts_dir`
  (`${CLAUDE_PLUGIN_ROOT}/scripts/common`), and the instruction to follow its agent definition
  and end with its JSON result block.

Two lines of the same package may be in flight together, whether in the same repo or different
ones: they carry different `branch_name`s and different worktree paths (worktree paths are always
under that group's own `repo_root`), so they cannot collide.

When phase 4's approved plan included the pin audit, it is the **last item in the queue**,
dispatched as soon as a slot is available for it once every fix has one: in the first dispatch when
the fixes do not reach `cap`, and otherwise into the first slot a completion frees. It counts
against `cap` like any other agent:

- `subagent_type`: `audit-pins`
- prompt: the `{repo, repo_root, default_branch}` triple of the repo named in the plan (phase 1 at
  repo scope, that repo's phase 5 triple at org or user scope), its `adapter_path` (any of that
  repo's actionable groups — one repository, one toolchain), `scripts_dir`, and **`mode`, exactly
  as phase 4's approval settled it**, plus the instruction to follow its agent definition and end
  with its JSON result block.

**Never omit `mode` and never guess it.** The agent treats a missing or unrecognized value as an
`input` failure rather than defaulting, because the two modes differ by whether a pull request is
opened against a real repository.

It works in `.claude/worktrees/audit-pins` under that repo's own `repo_root`, which no fix agent
uses, so their worktree **paths** cannot collide. That is a statement about directories only. The
audit shares a repository with the fix agents it runs beside, and **repo-global git state is
shared**, so while any agent is in flight no agent may touch it: no `.git/info/exclude` write (done
once above, before dispatch), no `git worktree prune` — repository-wide, and a badly timed one
deletes a live sibling's registration — no `git gc`, no config writes, no branch or ref
manipulation outside its own branch. Each agent adds and removes its own worktree by path and
nothing else. Both agent definitions state this as a hard rule; the reason it is written here too
is that the earlier absolute phrasing ("cannot collide") is what invited the two calls issue #35
found. Under a rolling pool something is in flight from the first dispatch until the queue drains,
so this is a rule for the whole run rather than for a window between dispatches.

Dispatch the audit once per run.

**The cap is machine-wide across every repo in the batch, and the pool must never exceed it.**
Refill up to `cap` rather than by one, and count from the agents *actually* in flight when a
completion arrives; dispatching against a stale count overshoots the cap, which is the one way a
pool can go wrong that a barrier could not. **A failed, crashed, or unparseable result frees its
slot exactly like a successful one**: record the failure for phase 7 and refill, because a crash
must never stall the pool. And **refilling a slot is not a new dispatch decision, so it never
prompts**: phase 4's single approval
covers the whole queue and remains the last checkpoint before pull requests exist. The harness
re-invokes you with a task-completion notification when a subagent finishes, which is the
slot-freed signal ADR 003 lacked; its amendment retires the barrier for this pool.

## Phase 7: Summarize the run

Results arrive **one at a time**, as each agent completes and its slot is refilled. Parse each
agent's fenced JSON result as it lands, keep it with the others, and present the summary once the
queue has drained and the last agent has returned. The summary describes the whole approved batch,
not whichever results happened to arrive together. **An unparseable or missing result block is a
failure report** — record it as such; never guess fields, and refill its slot like any other
completion.

Present one table for the run:

> | Repo | Package | Line | PR | Risk | F4/F5 | Notes |

`F4/F5` is `risk.f4` and `risk.f5` from the agent's result, which is the whole of the coverage and
CI signal an agent reports; the scorer's fuller `coverage` and `ci` objects stay in the PR body.

Omit the `Repo` column at repo scope, as in phases 3 and 4.

**A `no-op` result is neither a success nor a failure, and gets its own line, never the failure
list.** The group's fix was already on the default branch when the agent got there: it made no
commit, opened no PR, and validate confirmed the alerts are cleared by what is installed. Report
those separately, with the agent's `no_op.reason` and the merged PR when it named one:

> Already fixed, nothing to do: `undici` 6.x in `octo/app` — the scoped overrides are already on
> `main` (<PR #597>, merged 2026-08-17), and validate confirms all 8 alerts are cleared by the
> resolved 6.28.0. Dependabot has not re-scanned yet, which is why they still show as open.

The condition is Dependabot re-scan lag, not a bug anywhere: GitHub reports alerts as open for a
window after the fix merges. Folding these into the failure list presents a clean outcome as
needing attention and buries the genuine failures beside it (issue #34).

Failures get their `phase` and `detail`. A result whose `action` is `bare-override` says so in
Notes (`bare override added` or `bare override tightened`, from `bare_override`): it is the one
action whose blast radius reaches past the alerts being fixed, and the table is where a user
comparing PRs will see it.

A `phase: "classify"` failure whose `detail` names `peer_only_dependency` gets its own Notes label
(`peer-only dependency`) rather than the generic `failure: classify`: the package resolves only
through pnpm's peer auto-install, no `pnpm.overrides` key can reach it, and the remedy is a major
bump of one of the peer parents `detail` quotes, or a real dependency declaration. Both are
lockfile regeneration, both human work ([#103](https://github.com/SurveyMonkey/skills/issues/103)).

Then report every non-empty `requires_major_bump[]`, per package line (and per repo at org/user
scope), before anything else in the summary:

> Still vulnerable after this batch: `undici` 5.29.0 in `octo/app` (alerts patched only in the 6.x
> line). No override bounded to 5.x can fix this; it needs a major bump of the parent that pins it,
> or dropping that parent.

These are alerts that stay open after the PRs merge. Reporting a batch as done without them is the
failure mode issue #19 is about, and it is worse coming from the summary than from an agent.

**Then re-report every skipped repo from phase 2's `skipped_repos`, by name, if any remain
unaddressed.** These are repos with alerts the batch never touched at all, and belong in the same
summary as the batch that did run — never a detail left only in the earlier discovery report.

Then aggregate `observations[]` across **all** results, deduplicate identical entries, and split
them by `type`, because the two are not the same news.

`unscoped_override_added` entries are global pins **this batch just created** (the agent's
`bare_override` is `added` and its `action` is `bare-override`). Report them individually, with
the reason the agent gave, the repo, and the PR that introduced them:

> This batch added 1 unscoped global override: `sharp` `>=0.35.0 <1` in `octo/app` <PR>, because
> <reason>. It pins `sharp` for every consumer in that repository, including copies that were
> never vulnerable.

`unscoped_override` entries are pre-existing, and stay one aggregate line per repo:

> Note: `octo/app` contains N unscoped global override(s): `<keys>`. These may be removable or
> convertible to scoped pins. The pin audit tests removability
> ([#7](https://github.com/SurveyMonkey/skills/issues/7)).

Leads, not findings. Do not act on either. Without deduplication a five-package dispatch would
report the same pre-existing bare overrides five times. Never fold a newly added pin into that
count and call it pre-existing debt: this batch is the record of where it came from.

### Audit findings, when the audit rode along

If an `audit-pins` agent ran in phase 6, report its result **after** the fix table and separately
from it: its findings are judgments about pins, not changes, and mixing them into the PR table
invites reading a finding as a change. That holds in `pr` mode too, where the audit does open a PR:
the findings stay findings, and the PR gets its own report below them. Name the repo it audited,
which at org or user scope is one repo in the batch rather than all of them.

**Group the findings by package, one table per package**, exactly as the agent reported them —
never a flat list of pin keys:

> | Pin | Scope | Value | Attributable to removal | Elsewhere in the tree | Advisories | Finding |

"Elsewhere in the tree" is not optional and never blank: `nothing else moved`, the other packages
whose resolution changed with their verdicts, or `not checked` when the map was unavailable or only
partly read. Dropping it turns an unchecked claim into an affirmatively clean one.

Then say plainly which pins are removable, which are `still-required` and against which advisory
range, and which came back `inconclusive`, `not-tested`, or `not-a-version-pin` — an audit that
could not establish something must not read as an all-clear. A bare override this batch just added
will appear in the audit as `still-required`; that is expected, not a contradiction.

**Then, beneath the findings and still separate from the fix table, report the audit's own PR.**
When `pr` is non-null: its URL, the attempt that passed (`pr.attempt`), `pr.removed_keys`,
`pr.left_behind` with each reason, and the `pr.risk` band. Keep it out of the fix table: the fixes
add and tighten pins and this one removes them, and one table implying they are the same kind of
change is what that separation exists to prevent.

When `mode` was `pr` and `pr` is `null`, say which of the five reasons `pr_skipped_reason` gave:
`open PR already exists` (link `existing_pr_url`), `no pins` (the repository declares none at all),
`no removable pins found` (it has pins and every one still does something), `partial resolution
map` (the lockfile could not be read whole, so nothing could be judged against the whole tree), or
`combined test failed` (name the package and version that failed it, and which attempt ran). None
of those is a failure. `pr_skipped_detail` carries the evidence beside the reason, including the
attempt number, since there is no `pr.attempt` to read when `pr` is `null`, plus any second reason
that also applied.

A `"status": "failure"` result is none of the five: report it as its `failure.phase` and
`failure.detail`, with the other agents' failures. And **a `pr`-mode success with a `null` `pr`
whose `pr_skipped_reason` is missing or outside those five values is a contract violation** to
report as a failure of the agent, quoting what came back, exactly as an unparseable result block
is. Never guess which reason was meant.

When `mode` was `report`, `pr` is `null` by definition and there is nothing to report about it.

**`removable-individually` must never be reported as `removable`.** That status means the package
carries more than one removable pin and each was tested with the others still in place. Say so, in
the package's own section, and say that removing more than one of them requires a fresh audit of
what remains — a real run produced four `minimatch` pins with identical results purely because the
siblings held those versions during each test. Naming them together without that sentence is how a
reader turns four tested operations into one untested one.

An audit failure is reported as a failure and never suppresses the fix summary: the fixes and the
audit are independent queue items, and nothing about the audit's outcome is coupled to a fix's.

## Phase 8: Offer the groups the user declined, then the pin audit

If actionable groups remain because the user chose One or a tier, those groups were never approved
and never queued: the approved batch drained completely. Offer them now as a **new scope
question**, not as a resumption of work already approved: back to phase 3 with the remaining
groups.

Then recommend the pin audit once, **for the repos this run did not audit**. Phase 6 queues an audit
on every run that dispatches at all, so at repo scope that repo has normally been audited already
and there is nothing left to offer: say so in a line and skip the question. At org or user scope the
audit covered exactly one repo, so what remains to offer is every other repo this run touched:

> Every fix in this run added or tightened a pin. The pin audit is the other direction: it finds
> overrides and resolutions a repository no longer needs, testing each removal in an isolated
> worktree against every published advisory for the package. It runs one install per pin it tests,
> so it takes a few minutes. Run it now?

Ask the mode with the same question, **PR mode first and recommended**, on the same terms phase 4
sets out: open a removal PR for the pins it confirms (`mode: pr`, recommended), or report only
(`mode: report`). One question, two options plus declining; never a second prompt after the answer.

On acceptance, dispatch `audit-pins` with the phase 6 payload including `mode`, and report its
findings and its PR as phase 7 describes.

The audit is **per repo**: at repo scope that is one agent, and at org or user scope, name the repos
the batch touched but did not audit and dispatch one agent per repo the user accepts, through a
queue drained by the same rolling pool under the same `cap`, since their removability tests run
installs like any fix agent. Recommend it once and take the answer; declining is a complete answer,
and `/gh-security:audit-pins` runs it later, per repo, without going through alert resolution at
all.

Recommend it even when this run fixed nothing that touched an override: a repository accumulates
pins from every past run and from hand edits, and the audit is about all of them.

Otherwise report done, including any repos still in `skipped_repos` and what would unblock each.

**The closing report lists every PR this run opened, once, as information.** Read the current
state of them together:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/pr-status.sh <pr-url>...
```

Pass every `success` PR URL plus the audit's `pr.url` when one exists; `no-op` and `failure`
results carry a null `pr_url` and there is nothing to read. The script operates on PR URLs
directly and needs no `repo_root`, so a batch's URLs can span repos and are handled identically at
every scope.

Report each PR with its URL, its merge-risk band, and its check state — and **state what that
check state is worth**, because most of these PRs are minutes old:

- `none` means no check has reported yet, which on a repository with CI usually means the
  workflows have not started, not that there are none.
- `pending` cites `check_counts` ("3 of 5 finished").
- `passed` on a very fresh PR, or on one reporting materially fewer checks than its siblings, is
  provisional: rollups populate as workflows spawn, and a job that has not been reported yet is
  invisible. Absent is not pending. Do not present the set as CI-complete.
- `failed` names `failing_checks`. This is the one worth saying loudly, since it tells the user
  which PR to open first.
- `merge_state: UNKNOWN` means GitHub has not computed mergeability yet, which is ordinary right
  after a push. Say so rather than reading it as clean or behind.
- `behind: true` or `conflict: true` means GitHub has computed mergeability and the PR needs a
  rebase or has a conflicting change. Report either when true. Both are derived from
  `merge_state`, so on a PR created moments ago they are `false` because nothing was computed
  yet — `false` here is "not established", not "clean", and must not be reported as clean.
- `is_draft: true` likewise means a human converted it, since these open ready.
- **Non-zero exit still carries a full report.** `pr-status.sh` reports and fails, like the
  adapter's `validate`: if one URL could not be read, the other entries are still present and
  correct. Read the report, name the entries carrying `error`, and do not discard the batch.

**When this batch opened more than one PR against the same repo, say so, unconditionally.** Name
them together and state plainly that they edit the same overrides block, so merging one leaves the
rest behind and the second to merge may conflict. You know this from the dispatch plan, not from
any check: `behind` and `conflict` are almost always unset this early (above), so waiting to
observe the collision means never reporting it. GitHub's "Update branch" resolves the ordinary
case; a conflicted machine-generated fix is better regenerated than hand-resolved — close it and
re-run this skill for that package.

**This is a report, not a prompt.** Do not ask whether to mark anything ready, merge anything, arm
auto-merge, or re-check later: there is nothing left for this skill to do to a PR that exists
(ADR 008). Point the user at the URLs and stop.
