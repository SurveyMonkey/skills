# SurveyMonkey Skills

> A Claude Code plugin marketplace containing job-scoped plugins for SurveyMonkey engineering workflows. Each plugin groups related skills under a single namespace so they can be installed and invoked together.

## Installation

Add the marketplace to your Claude Code settings:

```bash
claude plugin install gh-security@SurveyMonkey/skills
```

## Available Plugins

| Plugin | Namespace | Description |
|---|---|---|
| `gh-security` | `/gh-security:*` | Fix Dependabot alerts one package at a time: prioritized by severity and EPSS, with lockfile validation, major-bounded scoped overrides, and a computed merge-risk rating on every PR |

Supports pnpm, npm, and Yarn Berry. Other ecosystems and package managers are reported rather
than attempted; see [CONTRIBUTING.md](.github/CONTRIBUTING.md) to request one.

## Plugin Architecture

Each plugin lives in its own directory under `plugins/` and owns a single namespace. Skills within a plugin are invoked as `/namespace:skill-name`.

```
plugins/
  gh-security/
    .claude-plugin/
      plugin.json
    commands/
      ...
    scripts/
      common/       # ecosystem-agnostic: scope, discovery, routing, risk scoring
      ecosystems/   # one adapter per advisory ecosystem
```

Deterministic work belongs in `scripts/` with a JSON contract; commands carry only the judgment.
Ecosystem-specific behavior stays behind the adapter contract in
[ADR 001](docs/adr/001-ecosystem-adapter-contract.md).

New plugins should follow this same structure. One namespace per plugin, one concern per namespace.

## For SurveyMonkey Engineers

This repository is public so that any SurveyMonkey engineer can install these plugins without needing to be added to the GitHub org. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for how to propose new plugins or skills.

## License

[MIT](LICENSE)
