---
paths:
  - "plugins/*/agents/*.md"
---

# Agent Files

- Set `model` and `effort` in the frontmatter to the smallest values that pass the specs, or
  leave both unset for an agent its caller sizes.
- An agent that must wait on something external waits in the foreground with a bounded blocking
  call, and returns once, with structured output. It never arms a Monitor or a scheduled wake and
  then ends its turn.

The reasoning is in the `plugin-design` skill (`composition.md`, "Mechanisms").
