# Design Principles

Every skill, agent, hook, script and command is small, does one job, and composes with the
others. Each costs tokens and time on every use, so keep both low.

- Anything deterministic runs in a script, not an agent. The script emits structured output, and
  the agent decides from it.
- A hook does what must always happen the same way. A skill holds judgment or knowledge. A
  subagent is only for context isolation or parallel work.
- An orchestrator holds the order of steps and the decisions between them, and no other logic.
- Derive what a plugin needs on each run. State on disk is a last resort, and lives under
  `${CLAUDE_PLUGIN_DATA}`. A plugin that keeps state owns its whole lifecycle, through archive or
  removal. A literal path, or a tool the dependency check does not cover, is a defect.

## Challenge a divergence

When a proposal, plan or change goes against a rule here, or in the `plugin-design` skill, say so
before work starts:

1. Name the rule, and cite the official source that supports it
   ([Sources](../skills/plugin-design/composition.md#sources)).
2. Propose the smaller alternative: one or two parts to remove, or to move into a script or a
   shared function.
3. Let the user decide. When the user keeps the divergence, record the ruling on the issue.

Challenge also when the user asks for the divergent design. Do not silently build a
simpler design than the one approved.

A known divergence has an issue: the `resolve-alerts` `SKILL.md` of gh-security is over 500
lines (#237). Do not migrate it as a side effect of other work.

Before you design or change a skill, agent, hook, script, command or plugin, invoke the
`plugin-design` skill.
