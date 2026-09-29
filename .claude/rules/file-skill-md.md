---
paths:
  - "**/skills/**/SKILL.md"
  - "**/docs/flows/**"
---

# Skill Files

Every plugin skill MUST have a flow directory, `docs/flows/<plugin>/<skill>/`. The directory
holds:

- `_skill-flow.md`: the flow of the skill.
- `<agent>-agent-flow.md`: the flow of each subagent that the skill dispatches, such as
  `fix-dependency-agent-flow.md`.
- `<subcommand>-flow.md`: the flow of each CLI subcommand that `SKILL.md` runs, once it has
  branches of its own worth a diagram. The gh-security skills start to run subcommands with #237.

Each file holds one diagram, as a `mermaid` fenced block, with the OKF frontmatter of
`.claude/rules/path-docs.md`. Add a row for a new file to `docs/flows/index.md`.

The diagram does NOT belong in `SKILL.md`. The skill loads `SKILL.md` into context every time it
runs, so anything there costs context on every run. A person reads a diagram occasionally, to
reason about the skill. So the diagram goes in a separate file, outside the skill directory,
because that directory ships to each user.

Draw the decisions and outcomes, not the call stack. Show the branches a reader would otherwise
have to derive from prose:

- what determines which path is taken
- every terminal outcome, including the refusals, not just the happy path
- where the skill stops and does nothing, and why

A diagram that shows only the success path is worse than none. It implies the failure paths do
not exist. Prefer `flowchart TD`. Node text says what happens in the domain ("branch has merge
proof?"), not what the code does, so the diagram survives code changes.

## Commands in SKILL.md

Spell out every script a skill runs, at every call site:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" version
```

Do NOT hold the command in a variable and expand it (`S="node ...ts"` then `$S version`). zsh does
not word-split an unquoted expansion, so it looks up the whole string as one command name, and
the call exits 127. The Bash tool's shell is the user's login shell, and it discards shell state
between calls, so a variable defined in one block is not there for the next.
`tests/repo/skills.test.ts` enforces this.
