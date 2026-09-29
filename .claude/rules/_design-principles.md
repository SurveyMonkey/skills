# Design Principles

Every skill, agent, hook, script and command function here is small, does one job, and composes
with the others. Each one costs tokens and time on every use, so keep both low.

- Anything deterministic runs in a script, not an agent. The script emits structured output, and
  the agent decides from it.
- A hook does what must always happen the same way. A skill holds judgment or knowledge. A
  subagent is only for context isolation or parallel work.
- An orchestrator holds the order of steps and the decisions between them, and no other logic.
- Derive what a plugin needs on each run. State on disk is a last resort, and lives under
  `${CLAUDE_PLUGIN_DATA}`. A literal path in a plugin is a defect.

## Challenge a divergence

When a proposal, plan or change goes against a rule here, or in the `plugin-design` skill, say so
before work starts:

1. Name the rule, and cite the official source that supports it
   ([Sources](../skills/plugin-design/composition.md#sources)).
2. Propose the smaller alternative. Look for one or two parts that you can remove, or move into
   a script or a shared function, to make the design much simpler.
3. Let the user decide. When the user keeps the divergence, record the ruling on the issue.

Make the challenge also when the user asks for the divergent design. Do not silently build a
simpler design than the one approved.

Plugins that differ from these rules today are tracked in issues: gh-security has no
`SessionStart` check yet (#275), and its `resolve-alerts` `SKILL.md` is over 500 lines (#237). Do
not migrate one as a side effect of other work.

Before you design or change a skill, agent, hook, script, command or plugin, invoke the
`plugin-design` skill.
