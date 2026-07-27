# ADR 003: Worktree isolation and the concurrency cap

## Status

Accepted

Drives [RFC 001](../rfc/001-alert-orchestration.md). Landed in Phase 2
([#5](https://github.com/SurveyMonkey/skills/issues/5)).

## Context

Phase 2 runs one `fix-dependency` subagent per vulnerable package, in parallel, frequently in the
same repository. Two agents editing one `package.json` and one lockfile on one branch cannot
work; each needs its own checkout. The RFC settles *that* worktrees isolate them, but not where
worktrees live, how the pre-existing-failure comparison works without `git switch`, what cleanup
is required, or how the concurrency cap is enforced by an orchestrator whose Task tool offers no
completion signal short of the agent returning.

A location question with a wrong-looking obvious answer: Claude Code's own worktree convention is
`.claude/worktrees/` inside the repository. Verified against a clean checkout: a worktree created
there appears as `?? .claude/worktrees/` in `git status` for any repository that does not ignore
the path, and end users' repositories do not. A crashed agent would also strand a full checkout
(plus `node_modules`) inside someone's project.

## Decision

**Worktrees live in a temp directory outside the repository.** Each agent creates
`$(mktemp -d)/fix` via `git -C <repo_root> worktree add`, with the fix branch cut from a freshly
fetched `origin/<default>`. The user's checkout is never touched: no switch, no stash, no edits.

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
a plain remove) for both worktrees, then `worktree prune`, then `rm -rf` of the temp directory —
on success and on failure alike. A cleanup failure is reported, never silent: an orphaned
worktree in a temp directory is recoverable with `git worktree prune`, but only if someone knows
it happened.

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
