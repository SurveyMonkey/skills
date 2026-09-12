---
description: >
  Resolve Dependabot security alerts for the current repo, or for every repo
  checked out directly under the current directory; nothing is cloned.
  Discovers open alerts, ranks by severity and EPSS, asks how much to fix (one
  package, the highest severity tier, or everything), then fixes each package
  with its own subagent in an isolated worktree through to a pull request, open
  for review, with a computed merge-risk rating. Supports pnpm, npm, and Yarn
  Berry.
---

The user explicitly invoked `/gh-security:resolve-alerts`.

Read `${CLAUDE_PLUGIN_ROOT}/skills/resolve-alerts/SKILL.md` and execute it exactly, starting from
its Phase 1. Skip nothing.
