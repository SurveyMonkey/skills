---
okf_version: "0.2"
---

# ADR index

| Doc | Description |
|-----|-------------|
| [001-ecosystem-adapter-contract.md](001-ecosystem-adapter-contract.md) | Invocation, exit-code, and JSON-output contract for the per-ecosystem adapter scripts, including the empty-result and range-semantics obligations. |
| [002-pr-draft-state-and-approval-flow.md](002-pr-draft-state-and-approval-flow.md) | Fix PRs open as drafts and the orchestrator batch-promotes them, with per-PR confirmation where auto-merge is armed. |
| [003-worktree-isolation-and-concurrency-cap.md](003-worktree-isolation-and-concurrency-cap.md) | Fix agents work in per-major-line worktrees under .claude/worktrees inside the target repo, with a per-machine concurrency cap enforced as a wave barrier. |
| [004-subagent-model-tiering.md](004-subagent-model-tiering.md) | The fix-dependency subagent is pinned to sonnet, the orchestrator inherits the session model, and criteria are set for a future Haiku trial. |
