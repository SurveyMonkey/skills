# Contributing

This repository is maintained by SurveyMonkey engineers. Contributions are currently limited to SurveyMonkey employees.

## Adding a New Skill to an Existing Plugin

1. Create a new skill file under the appropriate `plugins/<namespace>/commands/` directory.
2. Follow the patterns established by existing skills in that plugin.
3. Open a PR with a clear description of what the skill does and how to test it.

## Proposing a New Plugin

A plugin should represent a distinct job or tool scope. Before creating one, check whether an existing plugin namespace already covers your use case.

1. Open an issue describing the plugin's purpose, proposed namespace, and the initial set of skills.
2. Once approved, create the plugin directory under `plugins/` following the structure in the README.
3. Open a PR with the plugin scaffold and at least one working skill.

## Requesting Ecosystem or Package Manager Support

The `gh-security` plugin routes each Dependabot alert to an adapter chosen by the alert's own
ecosystem. Support is deliberately narrow: an adapter gets built when someone asks for it, not by
default.

Supported today:

| Ecosystem | Toolchains |
|---|---|
| `npm` | pnpm, npm, Yarn Berry (v2+) |

Anything else is **reported, not attempted**. If you hit one of these, the tool tells you rather
than guessing:

- **bun** — dropped in v0.2.0; nobody internally uses it
- **Yarn Classic (v1)** — a different lockfile format from Berry, and no repo we support uses it
- **Other advisory ecosystems** — `pip`, `rubygems`, `maven`, `nuget`, `composer`, `go`, `rust`,
  `erlang`, `actions`, `pub`, `swift`

To request support, open an issue with:

1. The ecosystem or package manager, and the repositories that need it.
2. A link to a real repository using it, so the adapter can be verified against something other
   than a fixture.
3. Anything unusual about how that toolchain constrains transitive dependencies, which is the part
   that differs most between ecosystems.

`pip` is already planned as Phase 6 of
[RFC 001](../docs/rfc/001-alert-orchestration.md). The adapter contract is documented in
[ADR 001](../docs/adr/001-ecosystem-adapter-contract.md).

## Local Development

To test a plugin locally without installing it, use `--plugin-dir` pointing to the plugin root (the directory that contains the `.claude-plugin/` folder):

```bash
claude --plugin-dir /path/to/skills/plugins/gh-security/
```

This loads the plugin for that session only. Edit the skill or script files, then start a new session to pick up changes.

## Guidelines

- One namespace per plugin, one concern per namespace.
- Skill names should be verb-first and descriptive (e.g., `resolve-alerts`, `audit-deps`).
- Test skills against real repositories before submitting.
