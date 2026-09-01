---
okf_version: "0.2"
---

# ADR index

| Doc | Description |
|-----|-------------|
| [001-ecosystem-adapter-contract.md](001-ecosystem-adapter-contract.md) | Invocation, exit-code, and JSON-output contract for the per-ecosystem adapter scripts: the empty-result and range-semantics obligations, pin listing, the whole-tree resolution map with self-reported parse coverage, and alias identity across verbs. |
| [002-pr-draft-state-and-approval-flow.md](002-pr-draft-state-and-approval-flow.md) | **Superseded by 008.** Fix PRs opened as drafts and the orchestrator batch-promoted them, with per-PR confirmation where auto-merge is armed. |
| [003-worktree-isolation-and-concurrency-cap.md](003-worktree-isolation-and-concurrency-cap.md) | Fix agents work in per-major-line worktrees under .claude/worktrees inside the target repo, with a per-machine concurrency cap enforced as a rolling agent pool. |
| [004-subagent-model-tiering.md](004-subagent-model-tiering.md) | The fix-dependency subagent is pinned to sonnet, the orchestrator inherits the session model, and criteria are set for a future Haiku trial. |
| [005-quality-gate-venues.md](005-quality-gate-venues.md) | The quality gates run from one entry point, split across git hooks by cost (fast gates pre-commit, the suite pre-push) and all enforced in CI on ubuntu plus macOS with pinned tool versions, with the plugin version gate running in CI alone because only there is its comparison base unambiguous. |
| [006-merge-risk-is-static-analysis.md](006-merge-risk-is-static-analysis.md) | Merge risk is computed from the repository's files rather than from checks an agent runs, and CI on the pull request is the verifier. |
| [007-pin-removal-prs.md](007-pin-removal-prs.md) | The pin audit opens one removal PR per repository, ready for review, defaulting to PR mode, gated on a combined test of the whole removed set that fails closed on a partial view of the tree. |
| [008-prs-open-ready-for-review.md](008-prs-open-ready-for-review.md) | Fix and pin-removal PRs open ready for review, the phase 5 dispatch approval is the only checkpoint, and no phase acts on a pull request after it is created. |
| [009-decouple-pin-audit.md](009-decouple-pin-audit.md) | The pin audit no longer rides along in a resolve-alerts run; it is reached only through /gh-security:audit-pins, which preflights for the repo's own open security-labeled PRs and stops if any exist. |
| [010-workflow-scripts-are-files-with-a-js-toolchain.md](010-workflow-scripts-are-files-with-a-js-toolchain.md) | Workflow scripts ship as files under plugins/*/workflows/ rather than markdown fences, and the repo gains a dev-and-CI JavaScript toolchain (vitest, ajv) with coverage thresholds at 100 to test them, while shipped plugin scripts stay bash + jq + gh. |
