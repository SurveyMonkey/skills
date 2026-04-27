# Contributing

This repository is maintained by SurveyMonkey engineers. Contributions are currently limited to SurveyMonkey employees.

## Adding a New Skill to an Existing Plugin

1. Create a new skill file under the appropriate `plugins/<namespace>/skills/` directory.
2. Follow the patterns established by existing skills in that plugin.
3. Open a PR with a clear description of what the skill does and how to test it.

## Proposing a New Plugin

A plugin should represent a distinct job or tool scope. Before creating one, check whether an existing plugin namespace already covers your use case.

1. Open an issue describing the plugin's purpose, proposed namespace, and the initial set of skills.
2. Once approved, create the plugin directory under `plugins/` following the structure in the README.
3. Open a PR with the plugin scaffold and at least one working skill.

## Guidelines

- One namespace per plugin, one concern per namespace.
- Skill names should be verb-first and descriptive (e.g., `resolve-alerts`, `audit-deps`).
- Test skills against real repositories before submitting.
