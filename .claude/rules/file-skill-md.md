---
paths:
  - "**/skills/**/SKILL.md"
  - "**/docs/flows/**"
---

# Skill Files

- Every plugin skill MUST have a flow directory, `docs/flows/<plugin>/<skill>/`, holding
  `_skill-flow.md`, one `<agent>-agent-flow.md` for each subagent the skill dispatches, and one
  `<subcommand>-flow.md` for each CLI subcommand the skill runs once it has branches worth a
  diagram.
- Each file holds one `mermaid` diagram, with the OKF frontmatter of `path-docs.md`, and a row in
  `docs/flows/index.md`.
- The diagram does not go in `SKILL.md`, and `SKILL.md` does not reference it.
- Keep `SKILL.md` under 500 lines, with reference material in supporting files. Put the key use
  case first in `description`: the listing truncates at 1,536 characters.
- Never set `disable-model-invocation: true` on a skill that another skill or an orchestrator
  invokes. Use `user-invocable: false` when only the model should start it.
- Spell out every script a skill runs, at every call site:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" version
  ```

  Never hold the command in a variable and expand it (`S="node ...ts"` then `$S version`). zsh
  does not word-split the expansion, so the call exits 127, and the Bash tool keeps no shell
  state between calls.

`tests/repo/skills.test.ts` enforces the `_skill-flow.md` file and the no-variable rule. How to
draw a diagram is in the `plugin-design` skill (`flows.md`).
