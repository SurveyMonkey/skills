# SurveyMonkey Skills

[![gates](https://github.com/SurveyMonkey/skills/actions/workflows/gates.yml/badge.svg?branch=main)](https://github.com/SurveyMonkey/skills/actions/workflows/gates.yml)

> A Claude Code plugin marketplace containing job-scoped plugins for SurveyMonkey engineering workflows. Each plugin groups related skills under a single namespace so they can be installed and invoked together.

## Installation

Add the marketplace to your Claude Code settings:

```bash
claude plugin install gh-security@SurveyMonkey/skills
```

## Available Plugins

| Plugin | Namespace | Description |
|---|---|---|
| `gh-security` | `/gh-security:*` | Resolve Dependabot alerts in parallel across a repo, org, or your own repos: one subagent per package major line per repo in an isolated worktree, ranked by severity and EPSS, with lockfile validation, major-bounded scoped overrides, draft PRs carrying a computed merge-risk rating, a check-aware mark-ready flow, and a report-only pin audit that finds overrides no longer needed |

Two entry points: ask Claude to fix the repo's security alerts (the `resolve-alerts` skill
triggers from natural language) or run `/gh-security:resolve-alerts` explicitly.
`/gh-security:fix-alert` remains as a deprecated shim that fixes only the top-ranked group.

**Pin audit.** Overrides and resolutions added to hold a transitive dependency at a safe version
outlive their reason, and then quietly hold packages back. `/gh-security:audit-pins` reports which
of a repo's pins are no longer needed, testing each removal in an isolated worktree against every
published advisory for the package rather than against the repo's own alert history — which the
pin itself blinds. It also runs automatically in a spare slot when a fix batch is smaller than the
concurrency cap, and is offered after a batch that filled it. Report-only: it opens no PR.

A PostToolUse hook on `Bash` (and `BashOutput`, for backgrounded commands) also watches for a
GitHub push-time vulnerability notice, a Dependabot alert URL, or non-zero `npm`/`pnpm`/`yarn
audit` output, and nudges Claude to offer the `resolve-alerts` skill when one appears. It is a
local grep with no network calls and never runs `gh` itself: a package-manager-only match nudges
toward checking GitHub security alerts rather than assuming a fix is needed, since GitHub stays
the sole data source the fix pipeline acts on.

Supports pnpm, npm, and Yarn Berry. Other ecosystems and package managers are reported rather
than attempted; see [CONTRIBUTING.md](.github/CONTRIBUTING.md) to request one.

**First-run permissions:** on its first run in a repo, the skill offers a one-decision preflight
— it shows the exact allow rules for the plugin's own scripts and prescribed git/PR commands and,
on consent, writes them to that repo's `.claude/settings.local.json` (gitignored, revocable line
by line). Decline and everything still works; each command just prompts individually as it comes
up. Fix worktrees live at a stable `.claude/worktrees/` path inside the repo (kept out of
`git status` via `.git/info/exclude`), so worktree-related approvals persist across runs too. The skill declares `allowed-tools` pre-approval, but
Claude Code does not currently apply it to plugin skills
([anthropics/claude-code#80696](https://github.com/anthropics/claude-code/issues/80696),
[#80802](https://github.com/anthropics/claude-code/issues/80802)); a hook-based fix is tracked in
[#16](https://github.com/SurveyMonkey/skills/issues/16).

## Plugin Architecture

Each plugin lives in its own directory under `plugins/` and owns a single namespace. Skills within a plugin are invoked as `/namespace:skill-name`.

```
plugins/
  gh-security/
    .claude-plugin/
      plugin.json
    skills/         # orchestrators that run in the main session
    agents/         # subagents dispatched in parallel, model pinned in frontmatter
    commands/       # explicit entry points and deprecation shims
    scripts/
      common/       # ecosystem-agnostic: scope, discovery, routing, risk scoring, PR state
      ecosystems/   # one adapter per advisory ecosystem
    hooks/
      hooks.json    # PostToolUse hook registration (Bash -> notice-scan.sh)
```

Deterministic work belongs in `scripts/` with a JSON contract; skills, agents, and commands carry
only the judgment.
Ecosystem-specific behavior stays behind the adapter contract in
[ADR 001](docs/adr/001-ecosystem-adapter-contract.md).

New plugins should follow this same structure. One namespace per plugin, one concern per namespace.

## For SurveyMonkey Engineers

This repository is public so that any SurveyMonkey engineer can install these plugins without needing to be added to the GitHub org. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for how to propose new plugins or skills.

## License

[MIT](LICENSE)
