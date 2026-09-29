---
paths:
  - "**/spec/**"
  - "tests/**"
  - "harness/**"
---

# Specs

This repository's test strategy is the `testing` skill: invoke it with the Skill tool (`testing`, or `/testing`) before writing or reviewing an example here.

It owns the whole of that strategy, so there is no second copy to consult. The gate commands, the ShellCheck rules and the rules about what this public repository may name stay in the root `CLAUDE.md`.

Where a test lives, how it imports, and the coverage rule are the skill's Layout and Coverage sections.

This rule covers both suites: vitest under `tests/` (with `harness/`) and `spec/js/`, and shellspec everywhere else under `spec/`.
