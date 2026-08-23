---
type: ADR
description: Fix agents work in per-major-line worktrees under .claude/worktrees inside the target repo, with a per-machine concurrency cap enforced as a wave barrier.
status: stable
created: 2026-08-20
owner: brianespinosa
related_issues: [5, 35, 84]
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

**The concurrency cap is computed per machine and enforced as a wave barrier.**
`detect-capacity.sh` derives `clamp(min(floor(cores / 3), floor(total_ram_gb / 8)), 3, 6)` from
unprivileged reads (`sysctl` on macOS, `nproc` and `/proc/meminfo` on Linux), falling back to 3
on any detection failure. Total rather than available RAM keeps the cap deterministic per
machine. The orchestrator dispatches at most `cap` Task calls per message and waits for the whole
wave before starting the next. A rolling pool would utilize slots better, but the Task tool has
no slot-freed signal, so a barrier is the honest implementation; the slowest agent gating its
wave is accepted.

## Consequences

Same-repo parallelism is safe by construction rather than by coordination: agents share nothing
but the object store and the remote.

Every agent pays for a full install (worktrees share no `node_modules`), and an agent that needs
the base-branch comparison pays twice. That is the price of the attribution rule, and the rule
has already earned it: the Phase 1 field case where a vitest bump turned a green suite red looked
exactly like pre-existing breakage until both trees ran.

Wave-barrier dispatch under-utilizes relative to a rolling pool. Accepted; revisit only if the
harness grows a completion signal worth reacting to.

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

## Amendment: repo-global git state is the orchestrator's, not the agent's

[Issue #35](https://github.com/SurveyMonkey/skills/issues/35) found the Consequences claim above —
"agents share nothing but the object store and the remote" — to be false in two places, once the
spare-slot pin audit made an agent share a `repo_root` with a concurrent sibling **by design**.
Worktree *paths* are isolated; repository state is not.

- **The `.git/info/exclude` line moves out of the agents.** `common/ensure-worktree-exclude.sh`
  writes it, called once per repo by the orchestrator (or by `/gh-security:audit-pins`) before any
  agent is dispatched. Two agents dispatched in one message — the required pattern — start
  milliseconds apart, and a read-then-append from each can duplicate the line or tear the file.
  Writing it before the wave removes the race by construction rather than narrowing it. The
  Decision's "only two writes into the user's repository" is now **one**: the worktree directory.
- **Cleanup drops `git worktree prune`.** It walks every worktree entry in the repository, so a
  call timed against a sibling's `worktree add` or `remove` can delete a live registration — and
  the breakage surfaces in the victim, not the caller. `git worktree remove <own-path>` already
  removes the caller's own entry, and it is the whole cleanup an agent is entitled to. A remove
  that fails is reported and left alone; an orphan is recoverable by hand once no wave is in
  flight.

Everything else above holds. The general rule the two share: an agent may name its own paths, and
nothing repository-wide.

## Amendment: the fix branch is cleaned up, and the guard on it is verified

[Issue #84](https://github.com/SurveyMonkey/skills/issues/84) found the Decision's "**A
pre-existing local fix branch stops the agent**" and the Cleanup rule that leaves the branch behind
to be a deadlock when read together: cleanup left a branch on every exit path, so the next run of
the same group always found one and always stopped. The guard's stated subject — someone's unpushed
work — was in practice never what it caught. `brianespinosa/bork` carried
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
