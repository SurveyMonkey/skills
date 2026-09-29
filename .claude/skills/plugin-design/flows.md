# Flow diagrams: how to draw one

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

