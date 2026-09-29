# Composition, mechanisms and state

## Composition

- Pick the mechanism by the decision rule in the
  [extension overview](https://code.claude.com/docs/en/features-overview#match-features-to-your-goal).
  If a plugin grows and needs a different mechanism, raise it before the work starts, or in
  review.
- Anything deterministic runs in a script, not an agent. Split work so the script emits
  structured output and the agent decides from it.
- A command function is one job: parsed arguments, the environment and an injected io in, an
  envelope out (`.claude/rules/type-ts.md`). Shared logic is a pure function in `lib/`.
- An orchestrator composes skills, agents and scripts. It holds the order of steps and the
  decisions between them, and no other logic. It uses the tools of its own plugin, or tools that
  its plugin declares as dependencies ([dependencies.md](dependencies.md)). It never
  copies the logic of a tool that it calls.

Signals of a god component. Each one is a reason to split it:

- A skill body holds a procedure that a script could run and report on.
- A command function or skill does two jobs that a caller could want apart.
- A `SKILL.md` that approaches 500 lines, or that holds reference material.
- An agent does deterministic work.
- A file on disk remembers what the plugin could derive on each run.

## Mechanisms

- Hook when the action must always happen the same way and the agent need not reason about it.
  Hooks cost zero context unless they return output. Guardrails belong in `PreToolUse` hooks. An
  instruction in CLAUDE.md or a skill is a request, not enforcement.
- Skill when Claude has to decide how to apply the steps, or the content is knowledge.
- Subagent only for context isolation or parallel work. A subagent that must wait on something
  external waits in the foreground with a bounded blocking call. It returns once, with structured
  output. It must not arm a Monitor or a scheduled wake, then end its turn. That idles the
  worker, and the orchestrator then sees only "waiting". Wakes belong to the session that
  dispatched it, if anywhere.
- When an agent is needed, set `model` and `effort` in its frontmatter to the smallest value that
  passes the specs. The caller can size it instead. A call can set `model`, but not `effort`. A
  caller-sized agent leaves both unset and inherits the session's effort.
- A skill that another skill or an orchestrator invokes never sets `disable-model-invocation:
  true`. That flag hides the skill from the `Skill` tool, so its callers cannot reach it at all.
  Use `user-invocable: false` instead, when only the model should start the skill. Reserve
  `disable-model-invocation: true` for a workflow only a person should trigger.
- Keep `SKILL.md` under 500 lines, and put reference material in supporting files. Put the key
  use case first in `description`, since the listing truncates at 1,536 characters.
- New plugins use `skills/`, not `commands/`. The docs treat `commands/` as the flat legacy form.

## State

- Plugin state lives under `${CLAUDE_PLUGIN_DATA}`. `${CLAUDE_PLUGIN_ROOT}` changes on update.
- Derive what a plugin needs each time it runs. Do not write a file to remember it. State on
  disk is a last resort: it is the copy that goes stale.
- A plugin that must keep state, or a plan, owns its whole lifecycle, not just the write. That
  lifecycle runs from creation through resume and reconciliation with the source of truth. It
  ends with archive or removal when the work finishes.
- A plugin works generally, on any machine and any repository layout. Paths come from
  `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and the target repository's own conventions.
  A literal path, or a tool that its dependency hook does not check, is a defect.

## Sources

Cite these, not an analogy:

- [Extension overview](https://code.claude.com/docs/en/features-overview): which mechanism, and
  context cost by feature.
- [Skills](https://code.claude.com/docs/en/skills): progressive disclosure, size, invocation.
- [Subagents](https://code.claude.com/docs/en/sub-agents): isolation, what loads at startup.
- [Hooks](https://code.claude.com/docs/en/hooks): events, matchers, output fields.
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference): components and paths.
