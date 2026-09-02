---
type: ADR
description: Fix agents work in per-major-line worktrees under .claude/worktrees inside the target repo, with a per-machine concurrency cap enforced as a rolling agent pool.
status: stable
created: 2026-08-20
owner: brianespinosa
related_issues: [5, 35, 84, 94, 161]
---

# ADR 003: Worktree isolation and the concurrency cap

Drives [RFC 001](../rfc/001-alert-orchestration.md). Landed in Phase 2
([#5](https://github.com/SurveyMonkey/skills/issues/5)).

## Context

Phase 2 runs one `fix-dependency` subagent per vulnerable package, in parallel, frequently in the
same repository. Two agents editing one `package.json` and one lockfile on one branch cannot
work; each needs its own checkout. The RFC settles *that* worktrees isolate them, but not where
worktrees live, how the pre-existing-failure comparison works without `git switch`, what cleanup
is required, or how the concurrency cap is enforced by an orchestrator whose Task tool offers no
completion signal short of the agent returning.

The location question was decided twice. The first decision was temp directories outside the
repository: `.claude/worktrees/` inside the repo appears as `?? .claude/worktrees/` in
`git status` for any repository not ignoring the path (verified against a clean checkout), and a
crashed agent would strand a full checkout inside someone's project. The first live parallel
dispatch reversed it ([#5](https://github.com/SurveyMonkey/skills/issues/5), run report and
worktree-placement comments): commands touching a temp-path worktree prompt as out-of-workspace
access, the suggested permission rules are keyed to that run's `mktemp` path and so can never
persist across runs, and the accumulated friction is what made the user abort the run. The
`git status` objection has a mitigation the first decision missed — one line in
`.git/info/exclude`, local-only and never committed.

## Decision

**Worktrees live at `.claude/worktrees/fix-dependabot-<package>` inside the target repository,
kept out of `git status` via `.git/info/exclude`.** The stable in-workspace path means the
permission rules a user accepts persist across runs, and matches the directory Claude Code's own
worktree tooling uses. Before creating it, the agent ensures the exclude line exists; these are
the only two writes into the user's repository the agent may make outside its own worktree. The
fix branch is cut from a freshly fetched `origin/<default>`. The user's working tree is never
touched: no switch, no stash, no edits. A pre-existing `$WORK` directory (a crashed prior run)
stops the agent with a report naming the path, never a silent delete.

**A pre-existing local fix branch stops the agent.** Discovery checks for open PRs, not local
branches, so an existing `fix/dependabot-<pkg>` branch may hold unpushed work. The agent reports
the collision as a failure rather than deleting or reusing the branch.

**The default-branch comparison uses a second, lazy, detached worktree.** The rule that a failure
is never attributed to pre-existing breakage without running the same check on the default branch
survives from the single-session flow, but `git stash`/`git switch` cannot work in a worktree
whose default branch is checked out elsewhere. The agent creates
`worktree add --detach $WORK/base origin/<default>` and installs there — but only when a failure
actually needs attribution, because the cost is a second full install.

**Cleanup runs on every exit path.** `git worktree remove --force` (installs make trees dirty to
a plain remove) for both worktrees, then `worktree prune`, then `rm -rf` of the `$WORK`
directory — on success and on failure alike. A cleanup failure is reported, never silent; an
orphan under `.claude/worktrees/` sits at a stable, discoverable path, which is the acceptable
face of the in-repo trade-off (the crashed-agent stranding that argued for temp directories is
now at least visible and named in the failure report).

**The concurrency cap is computed per machine and ~~enforced as a wave barrier~~ enforced as a
rolling pool ([#94](https://github.com/SurveyMonkey/skills/issues/94), v0.8.4).**
`detect-capacity.sh` derives `clamp(min(floor(cores / 3), floor(total_ram_gb / 8)), 3, 6)` from
unprivileged reads (`sysctl` on macOS, `nproc` and `/proc/meminfo` on Linux), falling back to 3
on any detection failure. Total rather than available RAM keeps the cap deterministic per
machine. ~~The orchestrator dispatches at most `cap` Task calls per message and waits for the
whole wave before starting the next. A rolling pool would utilize slots better, but the Task tool
has no slot-freed signal, so a barrier is the honest implementation; the slowest agent gating its
wave is accepted.~~ **Superseded in v0.8.4**
([#94](https://github.com/SurveyMonkey/skills/issues/94)): see
[the rolling-pool amendment](#amendment-rolling-pool-replaces-the-wave-barrier). The cap itself
and its computation are unchanged; only how it is enforced changed.

## Consequences

Same-repo parallelism is safe by construction rather than by coordination: agents share nothing
but the object store and the remote.

Every agent pays for a full install (worktrees share no `node_modules`), and an agent that needs
the base-branch comparison pays twice. That is the price of the attribution rule, and the rule
has already earned it: the Phase 1 field case where a vitest bump turned a green suite red looked
exactly like pre-existing breakage until both trees ran.

~~Wave-barrier dispatch under-utilizes relative to a rolling pool. Accepted; revisit only if the
harness grows a completion signal worth reacting to.~~ **Superseded in v0.8.4**
([#94](https://github.com/SurveyMonkey/skills/issues/94)): the harness grew that signal, which is
the revisit condition this named. See
[the rolling-pool amendment](#amendment-rolling-pool-replaces-the-wave-barrier).

Stale local fix branches surface as agent failures instead of silent reuse. The orchestrator's
summary tells the user which branch to inspect or delete; that judgment stays human.

## Amendment: one worktree per package major line

[Issue #19](https://github.com/SurveyMonkey/skills/issues/19) split discovery's groups by package
*major line*, so the unit of isolation is a line, not a package: worktrees are
`.claude/worktrees/fix-dependabot-<package>-<major_line>x` and branches
`fix/dependabot-<package>-<major_line>x`. Everything above holds unchanged; the suffix is what
keeps two agents fixing different lines of one package from colliding, and it is applied to every
group so a package that grows a second line later does not rename the branch of the line it
already had.

[Issue #161](https://github.com/SurveyMonkey/skills/issues/161) amended the *path* half of that
template: the worktree is `.claude/worktrees/fix-dependabot-<package_path>-<major_line>x`, where
**`<package_path>` is `<package>` with every `/` replaced by `-`**. A scoped package interpolated
verbatim turns its `/` into a directory separator, so the workspace lands a level deeper and the
orchestrator's reap, handed the leaf, removes the leaf and reports `left_behind: []` while the
interposed `fix-dependabot-@scope/` directory survives every clean run, in every repository,
forever. The branch templates are untouched and keep the raw `<package>` verbatim, in both
spellings: the ordinary `fix/dependabot-<package>-<major_line>x` and the issue #123 flat fallback
`fix-dependabot-<package>-<major_line>x`. The flat fallback is the one string byte-identical to
the path template, so it is the one place the replacement could plausibly be carried where it
must not go: refs are a namespace git handles, and the field run that surfaced this pushed and
deleted scoped branches cleanly.

## Amendment: repo-global git state is the orchestrator's, not the agent's

[Issue #35](https://github.com/SurveyMonkey/skills/issues/35) found the Consequences claim above —
"agents share nothing but the object store and the remote" — to be false in two places, once the
spare-slot pin audit made an agent share a `repo_root` with a concurrent sibling **by design**.
Worktree *paths* are isolated; repository state is not.

- **The `.git/info/exclude` line moves out of the agents.** `common/ensure-worktree-exclude.sh`
  writes it, called once per repo by the orchestrator (or by `/gh-security:audit-pins`) before any
  agent is dispatched. Two agents working the same repo start milliseconds apart, because the
  orchestrator fills and refills its pool by dispatching a message of Task calls, and a
  read-then-append from each can duplicate the line or tear the file. Writing it before any agent
  for that repo is dispatched removes the race by construction rather than narrowing it. The
  Decision's "only two writes into the user's repository" is now **one**: the worktree directory.
- **Cleanup drops `git worktree prune`.** It walks every worktree entry in the repository, so a
  call timed against a sibling's `worktree add` or `remove` can delete a live registration — and
  the breakage surfaces in the victim, not the caller. `git worktree remove <own-path>` already
  removes the caller's own entry, and it is the whole cleanup an agent is entitled to. A remove
  that fails is reported and left alone; an orphan is recoverable by hand once no agent is in
  flight.

Everything else above holds. The general rule the two share: an agent may name its own paths, and
nothing repository-wide.

## Amendment: the fix branch is cleaned up, and the guard on it is verified

[Issue #84](https://github.com/SurveyMonkey/skills/issues/84) found the Decision's "**A
pre-existing local fix branch stops the agent**" and the Cleanup rule that leaves the branch behind
to be a deadlock when read together: cleanup left a branch on every exit path, so the next run of
the same group always found one and always stopped. The guard's stated subject — someone's unpushed
work — was in practice never what it caught. The branch-leftover field-test repository carried
`fix/dependabot-react-router-6x` at this plugin's own pushed commit and `fix/dependabot-vite-6x` at
what was then `origin/main`, and both blocked a rerun until a human deleted them.

- **Cleanup deletes the branch when the delete is provably safe**, after the worktree comes off (git
  refuses to delete a branch checked out in a worktree): the push succeeded with that tip, so the
  remote carries the same commits, or the tip still equals `origin/<default_branch>`, so nothing was
  committed. Anything else is left in place and named in the report.
- **The guard compares tips instead of stopping on existence.** A local tip equal to
  `origin/<default_branch>` or to `origin/<branch_name>` is this plugin's leftover and is deleted
  and recreated; only a tip that is neither is unpushed work, and only that stops the run. This is
  the shape `agents/audit-pins.md` already uses for `chore/dependabot-remove-pins`, which proves a
  remnant against a closed PR's `headRefOid` rather than refusing on sight.

The Consequences claim that "stale local fix branches surface as agent failures" now holds only for
a branch whose tip nobody can account for; the orchestrator's summary still hands that judgment to
the human.

## Amendment: there is no `$WORK/base`

[ADR 006](006-merge-risk-is-static-analysis.md) retired the `fail-preexisting` / `fail-caused`
attribution discipline along with the F5 it fed, and with it the second worktree the Decision
describes. No agent runs the repository's checks, so nothing needs a default-branch comparison
tree: the fix flow installs one tree, `$WORK/fix`, and cleanup removes that one. Read the
Decision's "second, lazy, detached worktree" paragraph, its "for both worktrees", and the
Consequences' "pays twice" as history.

## Amendment: rolling pool replaces the wave barrier

[Issue #94](https://github.com/SurveyMonkey/skills/issues/94) retires the wave barrier. The
Decision deferred a rolling pool because "the Task tool has no slot-freed signal", and the
Consequences accepted the under-utilization "revisit only if the harness grows a completion signal
worth reacting to". **The harness grew it**: subagents run in the background and the orchestrator
is re-invoked with a task-completion notification when one finishes. That is the named revisit
condition, met.

- **The orchestrator holds the approved groups as a work queue and keeps `cap` agents in flight**,
  dispatching the next queued item into each slot a completion frees, until the queue drains.
  Slots no longer drain to zero `ceil(N/cap)` times waiting on the slowest agent of each wave.
- **The cap, its value, and `detect-capacity.sh` are unchanged**, as is its machine-wide scope
  across every repo in the batch. Only its enforcement changed, and the pool must never exceed it:
  refills are counted from the agents actually in flight, since dispatching against a stale count
  overshoots in a way a barrier could not.
- **Worktree isolation is untouched.** Per-major-line worktrees, per-group branches, and the
  repo-global git state rule from the issue #35 amendment all hold exactly as written, and the
  last of them binds harder: under a pool something is in flight from the first dispatch until the
  queue drains, rather than only between barriers.
- **A failed or unparseable agent result frees its slot like any other completion**, so a crash
  cannot stall the pool, and refilling a slot never prompts: the single dispatch approval covers
  the whole queue.

Everything else above holds.

## Amendment: the harness holds the pool, not the orchestrator

[Issue #175](https://github.com/SurveyMonkey/skills/issues/175) moves phase 6's dispatch into a
Workflow script embedded in `skills/resolve-alerts/SKILL.md`. The amendment above was right that
the harness had grown a completion signal; what it left in place was the orchestrator *reacting*
to that signal — filling, counting the agents actually in flight, refilling without overshooting.
That is bookkeeping a deterministic harness does exactly, and prose that re-derives it costs
tokens on every run to reach a worse answer.

- **The cap, its value, `detect-capacity.sh`, and its machine-wide scope are unchanged again.**
  Only enforcement moved: the script runs `min(cap, N)` workers over the dispatch list, so the
  worker count *is* the cap and the pool cannot exceed it. One workflow covers the whole batch,
  never one per repo, which is what keeps the scope machine-wide.
- **The stale-count hazard is gone rather than guarded**, because nothing counts.
- **Result shape is validated, not parsed.** Each agent call carries a `schema` for the Result
  block `agents/fix-dependency.md` promises, so the harness retries a mismatch and the
  "an unparseable block is a failure report" rule is replaced: an entry that comes back `null` is
  the failure report, and it is reaped and reported like any other.
- **Worktree isolation is untouched, and the repo-global git state rule binds exactly as the
  issue #35 amendment wrote it**: something is in flight from the workflow's first dispatch until
  it returns.
- **Approval is unchanged and still single.** Phase 4's approval now explicitly covers launching
  the workflow, and nothing inside it prompts.
- **The reap stays outside the script**, one `post-agent.sh` call per returned entry, so phase 7
  still reads per-group `left_behind` accounting rather than a summary the script invented.
- **ADR 004's `sonnet` pin is now passed explicitly** as `model: 'sonnet'` on the `agent()` call
  and mirrored on the `meta` phase entry. A workflow `agent()` without `model` inherits the
  session model, and whether `agentType` composes with the target definition's frontmatter is
  unspecified; leaving it implicit would void ADR 004 silently.

Two drifts this accepts, neither of them free:

- **The reap now runs after the whole batch, not per completion.** In practice almost nothing
  accumulates: `fix-group.sh cleanup` already removes the worktree before the agent returns on
  success, failure and partial progress, so only a crashed agent leaves one for the deferred reap,
  and the crashed-run guard cannot fire on a sibling's leftover under either design. Reaping after
  every agent has returned is a strict superset of the safety that justified reaping mid-flight.
- **Deferring the pull-request read to end of batch widens the window** in which a human merges or
  closes a PR between the agent opening it and `post-agent.sh` reading it. The read then returns
  something other than `OPEN`, the reap is correctly withheld, and that group's worktree and
  branch are reported as left behind. This inflates the `left_behind` report on long batches; it
  never deletes anything it should not, because the gate only ever withholds.

Everything else above holds.
