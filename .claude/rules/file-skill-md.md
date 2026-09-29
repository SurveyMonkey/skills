---
paths:
  - "**/skills/**/SKILL.md"
  - "**/docs/flows/**"
---

# Skill Files

- Every plugin skill has a flow directory, `docs/flows/<plugin>/<skill>/`, holding
  `_skill-flow.md`, one `<agent>-agent-flow.md` for each subagent the skill dispatches, and one
  `<subcommand>-flow.md` for each CLI subcommand the skill runs that has branches of its own.
- Each file holds one `mermaid` diagram, with the OKF frontmatter of `path-docs.md`, and a row in
  `docs/flows/index.md`.
- The diagram does not go in `SKILL.md`, and `SKILL.md` does not reference it.
- Spell out every script a skill runs, at every call site:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" version
  ```

  Never hold the command in a variable and expand it (`S="node ...ts"` then `$S version`). zsh
  does not word-split the expansion, so the call exits 127, and the Bash tool keeps no shell
  state between calls.

`tests/repo/skills.test.ts` enforces this. How to draw a diagram, and why it stays out of the
skill, is in the `plugin-design` skill (`flows.md`).
