---
name: resolve-alerts
description: >
  Resolve Dependabot security alerts for the current repository, or across an
  entire org or the user's own repos. Discovers open alerts, ranks them by
  severity and EPSS exploitability, and fixes one package, the highest
  severity tier, or everything — one subagent per group (one major line of
  one package, in one repo) in an isolated worktree through to a draft PR
  carrying a computed merge-risk rating. Use when asked to fix security
  vulnerabilities in dependencies, resolve Dependabot alerts across a repo,
  org, or the user's own repos, or clean up npm audit findings.
allowed-tools: Bash(*detect-scope.sh*), Bash(*discover-alerts.sh*), Bash(*select-adapter.sh*), Bash(*detect-capacity.sh*), Bash(*mark-ready.sh status*), Bash(*mark-ready.sh promote*), Bash(*preflight-permissions.sh*), Bash(git clone*), Bash(gh repo clone*), Bash(git -C * fetch*), Read, Task, AskUserQuestion
---

Orchestrate the resolution of Dependabot security alerts, at repo, org, or user scope: discover
and rank, ask how much to fix, dispatch one `fix-dependency` subagent per group (one major line of
one package, in one repo) in parallel, and walk the resulting draft PRs through an evidence-based
mark-ready decision.

The deterministic work lives in scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/common/`. Call them;
do not reimplement them. Every script emits JSON on stdout and exits non-zero with an `error` key
on failure; if one fails, report its error and stop.

You are the control point the user approves. Subagents run unattended through PR creation, so
**nothing dispatches before the user approves the plan in phase 5**, and **no PR leaves draft
without the decision flow in phase 9**.

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
  resolved per repo in phase 6, once discovery says which repos are actually in play.
- **user scope**: use `owner` (the authenticated login) for display only; `discover-alerts.sh
  --scope user` always operates on the authenticated user's own repos regardless of what `owner`
  resolves to. `nwo` and `default_branch` are again resolved per repo in phase 6.

EMU orgs are out of scope (RFC 001 Non-Goals). This skill does not detect or special-case them; an
EMU org simply has no alerts visible to a personal-account session and discovery reports it as
such through the ordinary org-scope path.

## Phase 2: Permissions preflight (repo scope only)

Claude Code does not currently honor this skill's `allowed-tools` grants for plugin skills, so
every prescribed command would otherwise prompt once per shape, per repo. At **repo scope**, with
`nwo` and `repo_root` (the current checkout) known from phase 1, run:

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

**At org or user scope, skip this phase entirely.** No single `repo_root` exists yet — discovery
has not run, so which repos are even in play is unknown — and running a full consent flow per
candidate repo before the user has approved anything to fix would be premature housekeeping ahead
of the real decision point. The equivalent preflight runs per repo in phase 6, once the approved
batch names exactly the repos that will be touched.

## Phase 3: Discover and route

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

## Phase 4: Ask how much to fix

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

## Phase 5: Present the dispatch plan and get one approval

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-capacity.sh
```

`cap` bounds how many subagents run at once; it is machine load, not a harness limit, and it
applies **machine-wide across every repo in the batch**, not per repo — a wave that touches three
repos at once still saturates the same laptop. Show the plan for the chosen batch:

> | Repo | Package | Line | Severity | Likely action | Branch |
>
> N group(s) across M repo(s), concurrency cap C → ceil(N/C) wave(s).

Omit the `Repo` column at repo scope, as in phase 4. "Likely action" comes from the alerts'
`relationship` field (direct → version bump, transitive → scoped override) and is best-effort: the
subagent's own `why` classification is authoritative.

At org or user scope, name every distinct repo the plan touches and say plainly that a repo not
yet checked out locally will be cloned under the workspace's `@owner` convention before dispatch
(phase 6) — this is part of what the approval covers, not a separate consent step.

**Spare slot → the pin audit rides along.** If the approved batch has **fewer groups than `cap`**,
one `audit-pins` agent joins the first wave and the plan says so, in the same approval:

> 2 group(s), concurrency cap 4 → 1 wave, with 2 slot(s) spare. The pin audit will run in one of
> them against `octo/app`: it reports which of that repo's existing overrides/resolutions are no
> longer needed. Report-only, no PR.

Fix agents always get the slots first, and the audit takes at most **one** spare slot however many
are free — its own removability tests run installs, and a second copy of it would audit the same
repository twice. When the batch fills every slot, the audit is not dispatched here; phase 11
offers it instead, because spending a slot on housekeeping in a full dispatch trades away a fix.

**The audit is repo-scoped, at every scope of this skill.** At org or user scope the batch may span
repos while the audit covers exactly one, so the plan **names the repo it will audit**: the repo of
the top-ranked group, which is the one the user is most likely to be thinking about. It is not a
cross-repo audit, and the remaining repos are offered in phase 11 like any other.

Ask for **one** approval of the whole batch. This is the control point: subagents run unattended
from here through draft-PR creation. Nothing dispatches without it.

## Phase 6: Resolve local checkouts and preflight (org and user scope only)

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
3. **Run the same preflight as phase 2**, scoped to this repo:
   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/common/preflight-permissions.sh check <repo_root> <repo>
   ```
   Ask for consent the same way phase 2 does (every missing rule enumerated in the question text,
   not just the count) if anything is missing, then `apply` on consent. A failure here is not
   fatal, exactly as in phase 2: report it, skip the preflight for that repo, and continue — the
   run proceeds with ordinary prompts for that repo's commands.

Carry the resolved `{repo, repo_root, default_branch}` triples into phase 7; every group dispatched
for a given repo shares its triple.

## Phase 7: Dispatch in waves

Take up to `cap` groups **across every repo in the current wave** and dispatch them **in a single
message with one Task tool call per group** so they run in parallel:

- `subagent_type`: `fix-dependency`
- prompt: the group JSON verbatim, plus `adapter_path`, the group's own `nwo` (its `repo` field),
  `default_branch` and `repo_root` for that group's repo (from phase 1 at repo scope, or phase 6's
  resolved triples at org/user scope), and `scripts_dir`
  (`${CLAUDE_PLUGIN_ROOT}/scripts/common`), and the instruction to follow its agent definition
  and end with its JSON result block.

Two lines of the same package may run in the same wave, whether in the same repo or different
ones: they carry different `branch_name`s and different worktree paths (worktree paths are always
under that group's own `repo_root`), so they cannot collide.

When phase 5's approved plan included the pin audit, its Task call goes in that **same first
message**, counting against `cap` like any other agent:

- `subagent_type`: `audit-pins`
- prompt: the `{repo, repo_root, default_branch}` triple of the repo named in the plan (phase 1 at
  repo scope, that repo's phase 6 triple at org or user scope), its `adapter_path` (any of that
  repo's actionable groups — one repository, one toolchain), and `scripts_dir`, plus the
  instruction to follow its agent definition and end with its JSON result block.

It works in `.claude/worktrees/audit-pins` under that repo's own `repo_root`, which no fix agent
uses, so it cannot collide with the wave it rides in. Dispatch it once per run, in the first wave
only; later waves are fixes alone.

The cap is a **wave barrier**, machine-wide across every repo in the batch: never issue more than
`cap` Task calls in one message, and do not start the next wave until every agent in the current
one has returned. There is no slot-freed signal, so the barrier is the honest implementation of the
cap (ADR 003). Repeat until the approved batch is exhausted.

## Phase 8: Summarize the batch

Parse each agent's fenced JSON result. **An unparseable or missing result block is a failure
report** — record it as such; never guess fields.

Present one table for the batch:

> | Repo | Package | Line | PR | Risk | F4/F5 | Scripts | Notes |

Omit the `Repo` column at repo scope, as in phases 4 and 5.

Failures get their `phase` and `detail`. A result whose `action` is `bare-override` says so in
Notes (`bare override added` or `bare override tightened`, from `bare_override`): it is the one
action whose blast radius reaches past the alerts being fixed, and the table is where a user
comparing PRs will see it.

Then report every non-empty `requires_major_bump[]`, per package line (and per repo at org/user
scope), before anything else in the summary:

> Still vulnerable after this batch: `undici` 5.29.0 in `octo/app` (alerts patched only in the 6.x
> line). No override bounded to 5.x can fix this; it needs a major bump of the parent that pins it,
> or dropping that parent.

These are alerts that stay open after the PRs merge. Reporting a batch as done without them is the
failure mode issue #19 is about, and it is worse coming from the summary than from an agent.

**Then re-report every skipped repo from phase 3's `skipped_repos`, by name, if any remain
unaddressed.** These are repos with alerts the batch never touched at all, and belong in the same
summary as the batches that did run — never a detail left only in the earlier discovery report.

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

If an `audit-pins` agent ran in phase 7, report its result **after** the fix table and separately
from it: it fixed nothing and opened nothing, and mixing its rows into the PR table invites
reading a finding as a change. Name the repo it audited, which at org or user scope is one repo in
the batch rather than all of them. One table:

> | Pin | Scope | Value | Without the pin | Finding |

Then say plainly which pins are `removable` (and that removing them is the user's call, since this
phase opens no PR), which are `still-required` and against which advisory range, and which came
back `inconclusive`, `not-tested`, or `not-a-version-pin` — an audit that could not establish
something must not read as an all-clear. A bare override this batch just added will appear in the
audit as `still-required`; that is expected, not a contradiction.

An audit failure is reported as a failure and never suppresses the fix summary: the fixes and the
audit are independent work that happened to share a wave.

## Phase 9: Decide what may leave draft

Drafts do not request reviewers or notify CODEOWNERS, so a batch nobody marks ready is invisible
work — but promotion is a decision, not a default. Gather the evidence:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/mark-ready.sh status <pr-url>...
```

`mark-ready.sh` operates on PR URLs directly and needs no `repo_root`, so this step is unchanged at
every scope — a batch's PR URLs can span repos and are handled identically either way.

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

## Phase 10: Promote

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

## Phase 11: Offer the next batch, then the pin audit

If actionable groups remain (the user chose One or a tier), offer to dispatch the next batch:
back to phase 4 with the remaining groups.

Then, **unless an `audit-pins` agent already ran in phase 7**, recommend the pin audit once:

> Every fix in this run added or tightened a pin. The pin audit is the other direction: it finds
> overrides and resolutions a repository no longer needs, testing each removal in an isolated
> worktree against every published advisory for the package. Report-only — it opens no PR. It runs
> one install per pin it tests, so it takes a few minutes. Run it now?

On acceptance, dispatch `audit-pins` with the phase 7 payload and report its findings as phase 8
describes. The audit is **per repo**: at repo scope that is one agent; at org or user scope, name
the repos the batch touched and dispatch one agent per repo the user accepts, in waves under the
same `cap` — their removability tests run installs like any fix agent. Recommend it once and take
the answer; declining is a complete answer, and `/gh-security:audit-pins` runs it later, per repo,
without going through alert resolution at all.

Recommend it even when this run fixed nothing that touched an override: a repository accumulates
pins from every past run and from hand edits, and the audit is about all of them.

Otherwise report done, including anything left in the not-promoted groups, any repos still in
`skipped_repos`, and what would unblock each.
