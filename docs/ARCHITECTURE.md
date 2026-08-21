---
type: Reference
description: How the marketplace and its plugins are structured, including the plugin directory layout, the scripts-do-agents-decide split, the adapter contract, worktree isolation, PR flow, and the quality gates, with pointers to the ADR recording each decision.
owner: brianespinosa
created: 2026-08-21
stale_after: 2027-02-21
---

# Architecture

This repository is a Claude Code plugin marketplace. The catalog lives in
`.claude-plugin/marketplace.json`; each plugin lives in its own directory under `plugins/`, owns a
single namespace, and is versioned solely by its own `plugin.json` (see the root `CLAUDE.md` for
the release rules). Plugins install from the default branch; there are no tags or GitHub
releases.

## Plugin layout

Skills within a plugin are invoked as `/namespace:skill-name`. One namespace per plugin, one
concern per namespace.

```
plugins/
  gh-security/
    .claude-plugin/
      plugin.json   # the plugin's identity and version; the whole release is bumping it
    skills/         # orchestrators that run in the main session
    agents/         # subagents dispatched in parallel; each declares its model in frontmatter
    commands/       # explicit entry points and deprecation shims
    scripts/
      common/       # ecosystem-agnostic: scope, discovery, adapter routing, risk scoring,
                    # capacity detection, PR state, advisory lookup, permissions preflight
      ecosystems/   # one adapter per GitHub advisory ecosystem (node.sh handles npm alerts)
    hooks/
      hooks.json    # PostToolUse hook registration (Bash/BashOutput -> notice-scan.sh)
```

## Scripts do, agents decide

Deterministic work belongs in `scripts/` with a JSON contract; skills, agents, and commands carry
only the judgment. Scripts depend on `bash`, `jq`, and `gh` alone, target bash 3.2 (the macOS
default), and treat a contract field that is missing, mistyped, or empty as a hard error rather
than a default. The rule that anchors the whole repo: **finding nothing is an error, never a
pass**. Conventions and their reasoning live in
[plugins/gh-security/scripts/CLAUDE.md](../plugins/gh-security/scripts/CLAUDE.md).

## The decisions, and where they are recorded

- **Adapter contract** ([ADR 001](adr/001-ecosystem-adapter-contract.md)). Everything
  ecosystem-specific, version comparison and range semantics included, stays behind
  `<adapter>.sh <verb>` calls that emit JSON on stdout and fail with `{"error": ...}`. Adding an
  ecosystem means adding an adapter, not touching `common/`.
- **PR flow** ([ADR 002](adr/002-pr-draft-state-and-approval-flow.md)). Fix PRs open as drafts;
  the orchestrator batch-promotes them once checks pass, confirming per PR where auto-merge is
  armed.
- **Worktree isolation and concurrency** ([ADR 003](adr/003-worktree-isolation-and-concurrency-cap.md)).
  Each fix subagent works in its own linked worktree under the target repo's
  `.claude/worktrees/`, and waves are sized by a per-machine concurrency cap enforced as a
  barrier. Repo-global git state (like `.git/info/exclude`) is written only by the orchestrator,
  never by agents.
- **Subagent model tiering** ([ADR 004](adr/004-subagent-model-tiering.md)). The fix subagent is
  pinned to sonnet in its frontmatter; the orchestrator inherits the session model.
- **Quality gates** ([ADR 005](adr/005-quality-gate-venues.md)). Three gates (shellspec suite,
  ShellCheck, `claude plugin validate --strict`) run through one entry point,
  `scripts/check.sh`, from committed git hooks locally and from
  `.github/workflows/gates.yml` in CI on ubuntu and macOS with pinned tool versions.

The multi-agent orchestration itself, phases and all, is specified in
[RFC 001](rfc/001-alert-orchestration.md).

## Testing

Shellspec suites live in `spec/` at the repo root, with hand-authored fixtures that use only
public package names, no network access, and `gh` mocked. Conventions, including the rule that
every regression lands its fixture in the same commit as the fix, are in the root
[CLAUDE.md](../CLAUDE.md) Testing section.
