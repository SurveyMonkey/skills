---
okf_version: "0.2"
---

# ADR index

| Doc | Description |
|-----|-------------|
| [001-ecosystem-adapter-contract.md](001-ecosystem-adapter-contract.md) | Invocation, exit-code, and JSON-output contract for the per-ecosystem adapter scripts: the empty-result and range-semantics obligations, pin listing, the whole-tree resolution map with self-reported parse coverage, and alias identity across verbs. |
| [002-pr-draft-state-and-approval-flow.md](002-pr-draft-state-and-approval-flow.md) | **Superseded by 008.** Fix PRs opened as drafts and the orchestrator batch-promoted them, with per-PR confirmation where auto-merge is armed. |
| [003-worktree-isolation-and-concurrency-cap.md](003-worktree-isolation-and-concurrency-cap.md) | Fix agents work in per-major-line worktrees under .claude/worktrees inside the target repo, with a per-machine concurrency cap enforced as a wave barrier. |
| [004-subagent-model-tiering.md](004-subagent-model-tiering.md) | The fix-dependency subagent is pinned to sonnet, the orchestrator inherits the session model, and criteria are set for a future Haiku trial. |
| [005-quality-gate-venues.md](005-quality-gate-venues.md) | The three quality gates run from one entry point, split across git hooks by cost (fast gates pre-commit, the suite pre-push) and all enforced in CI on ubuntu plus macOS with pinned tool versions. |
| [006-merge-risk-is-static-analysis.md](006-merge-risk-is-static-analysis.md) | Merge risk is computed from the repository's files rather than from checks an agent runs, and CI on the pull request is the verifier. |
| [007-pin-removal-prs.md](007-pin-removal-prs.md) | The pin audit opens one removal PR per repository, ready for review, defaulting to PR mode, gated on a combined test of the whole removed set that fails closed on a partial view of the tree. |
| [008-prs-open-ready-for-review.md](008-prs-open-ready-for-review.md) | Fix and pin-removal PRs open ready for review, the phase 5 dispatch approval is the only checkpoint, and no phase acts on a pull request after it is created. |
