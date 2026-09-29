---
paths:
  - "**/spec/**"
  - "tests/**"
  - "harness/**"
---

# Specs

Before you write or review an example here, invoke the `testing` skill (Skill tool `testing`, or
`/testing`). It holds the whole test strategy, with no second copy. Where a test lives, how it
imports, and the coverage rule are its Layout and Coverage sections. The gate commands, the
ShellCheck rules and what this public repository may name are in the root `CLAUDE.md`.

Two suites: vitest in `tests/` (with `harness/`) and `spec/js/`, and shellspec in the rest of
`spec/`.
