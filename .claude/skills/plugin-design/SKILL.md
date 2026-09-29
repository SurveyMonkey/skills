---
name: plugin-design
description: How to design or change a skill, agent, hook, script, command or plugin in this marketplace. Covers which mechanism to pick, how to split work between a script and an agent, where state lives, how a plugin declares and checks its dependencies, hook output fields and the status line pattern, the TypeScript layout and its boundaries, and how to draw a skill's flow diagram. Use before you propose, build or review a new plugin component, a hook or `hooks.json` entry, a `SessionStart` check, an agent's `model` or `effort` frontmatter, `disable-model-invocation`, or a change to how any of these is built.
---

# Plugin design

This skill holds the detail and reasons behind `.claude/rules/_design-principles.md`,
`type-ts.md`, `path-plugins.md`, `path-hooks.md`, `file-skill-md.md` and
`file-agent-md.md`. Read only the file the task needs.

- [composition.md](composition.md): how to split a component, the signals of a god component,
  which mechanism to pick (hook, skill, subagent), subagent sizing and waits, where plugin state
  lives, and the official sources to cite. Read it before you choose a mechanism, split a
  component, or challenge a design.
- [dependencies.md](dependencies.md): what a plugin may assume, the dependency table, and the
  `SessionStart` check with its output contract. Read it before you add a tool a plugin calls, or
  a hook that checks one.
- [hooks.md](hooks.md): what `systemMessage` and `additionalContext` each reach, and the status
  line pattern. Read it before you write a hook's output.
- [typescript.md](typescript.md): why the command handler is the seam, why `scripts/` and never
  `bin/`, why the entry point has one static import, the install behavior of the `src/lib`
  symlink, and why only erasable syntax. Read it when a TypeScript rule seems to be in the way.
- [flows.md](flows.md): how to draw a skill's flow diagram, and why it stays out of `SKILL.md`.
  Read it before you draw or change one.
