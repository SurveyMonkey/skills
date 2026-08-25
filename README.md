# SurveyMonkey Skills

[![gates](https://github.com/SurveyMonkey/skills/actions/workflows/gates.yml/badge.svg?branch=main)](https://github.com/SurveyMonkey/skills/actions/workflows/gates.yml)

> A Claude Code plugin marketplace containing job-scoped plugins for SurveyMonkey engineering workflows. Each plugin groups related skills under a single namespace so they can be installed and invoked together.

## Installation

Add the marketplace to your Claude Code settings:

```bash
claude plugin install gh-security@SurveyMonkey/skills
```

## Available Plugins

| Plugin | Namespace | Summary |
|---|---|---|
| [gh-security](#gh-security) | `/gh-security:*` | Orchestrated, multi-subagent resolution of Dependabot security alerts, plus an audit of the dependency pins earlier fixes leave behind that opens its own draft removal PR |

### gh-security

Resolves Dependabot security alerts for one repository, an entire org, or all of your own repos.
Discovery ranks open alerts by severity and EPSS exploitability, you choose how much to fix (one
package, the highest severity tier, or everything), and the orchestrator dispatches one subagent
per package major line per repo, each working in an isolated git worktree through to a draft PR
that carries a computed merge-risk rating.

| Entry point | Kind | What it does |
|---|---|---|
| `resolve-alerts` | Skill | Triggers from natural language ("fix this repo's security alerts", "clean up npm audit findings"). Discovers, ranks, and batches alerts, then dispatches fix subagents in parallel waves and batch-promotes the resulting draft PRs. |
| `/gh-security:resolve-alerts` | Command | Explicit entry point for the same skill. |
| `/gh-security:audit-pins` | Command | Reports which of a repo's dependency pins (overrides and resolutions) are no longer needed, testing each removal in an isolated worktree against every published advisory for the package, then opens a draft PR removing the confirmed set. Report-only is offered as the alternative. |
| `/gh-security:fix-alert` | Command (deprecated) | Shim that fixes only the single top-ranked alert group, then offers the next batch. Use `resolve-alerts` instead. |

The parallel work is done by two subagents, dispatched by the orchestrator rather than invoked
directly:

| Agent | Role |
|---|---|
| `fix-dependency` | Fixes every alert for one package major line in one repo, in an isolated worktree, through to a draft PR with a computed merge-risk rating. |
| `audit-pins` | Audits one repository's pins and reports which are removable, including whether removing one shifts any other package's resolution, and in PR mode removes the confirmed set, tests it in one further install, and opens a draft PR. Also rides along automatically in a spare slot when a fix batch does not fill the concurrency cap. |

**Supported package managers, by advisory ecosystem:**

- `npm`: pnpm, npm, and Yarn Berry (v2+). bun and Yarn Classic (v1) are rejected with a clear
  message rather than guessed at.
- Every other ecosystem (`pip`, `rubygems`, `maven`, `nuget`, `composer`, `go`, `rust`, and the
  rest) is reported, not attempted. `pip` is planned as RFC 001 Phase 6
  ([#9](https://github.com/SurveyMonkey/skills/issues/9)). See
  [CONTRIBUTING.md](.github/CONTRIBUTING.md) to request one.

**What the plugin does, at headline level:**

- **Parallel fix waves.** One subagent per package major line per repo, each in its own git
  worktree under the target repo, dispatched in waves sized to the machine's capacity.
- **Repo, org, or user scope.** Point it at the current repo, a whole GitHub org, or everything
  you own; org runs filter to repos you can actually push to.
- **Risk-ranked discovery.** Alerts are grouped by package and major line, then ranked by
  severity and EPSS exploitability so the worst goes first.
- **A merge-risk rating on every PR.** Seven scored factors (version delta, runtime exposure,
  usage surface, test coverage of the affected surface, CI presence, override blast radius, and
  declared-range distance) band each fix Low, Medium, or High, and a major version delta or a
  newly added global pin never rates Low. The score is static analysis of the repository, so no
  agent runs your test suite; CI on the draft PR is the verifier.
- **Lockfile validation that refuses to bluff.** A fix claims completion only when the lockfile
  proves the vulnerable ranges are gone, and a parser finding nothing is an error, never a pass.
- **Draft PRs with check-aware promotion.** Fixes land as drafts; the orchestrator batch-promotes
  them with check state reported honestly (failing checks block; pending or absent checks are
  flagged, not waited on), with per-PR confirmation where auto-merge is armed.
- **Pin audit that opens its own removal PR.** Finds overrides and resolutions that no longer
  protect anything, judged against the full advisory database (which the pin itself blinds repo
  alert history to), including collateral effects of removing each pin. Each pin is tested on its
  own, the removable set is then tested once more together, and a draft PR removes it with that
  evidence in the body. Report-only stays available as the alternative.
- **Proactive nudge hook.** A PostToolUse hook watches Bash output for push-time vulnerability
  notices, Dependabot alert URLs, and non-zero `npm`/`pnpm`/`yarn audit` output. A GitHub-sourced
  match offers `resolve-alerts` directly; an audit-only match nudges toward checking GitHub
  alerts first, since GitHub stays the sole source the fix pipeline acts on. It stays silent when
  the push came from one of the plugin's own branches, so a dispatched fix or audit run is never
  nudged to offer the flow it is already part of. Local grep/jq only; it never makes network calls.

## Documentation

How the marketplace and its plugins are structured: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Decision records live in [docs/adr/](docs/adr/index.md) and RFCs in
[docs/rfc/](docs/rfc/index.md).

## For SurveyMonkey Engineers

This repository is public so that any SurveyMonkey engineer can install these plugins without needing to be added to the GitHub org. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for how to propose new plugins or skills.

## License

[MIT](LICENSE)
