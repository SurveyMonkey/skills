---
paths:
  - "**/hooks/**/*.ts"
  - "**/hooks/*.json"
---

# Hook Output: additionalContext vs systemMessage

- `systemMessage` (top level) is rendered in the terminal, whether or not the model takes a turn.
  Use it for anything that must reach the user.
- `additionalContext` (inside `hookSpecificOutput`) reaches the model only, which may paraphrase
  or drop it. Use it for anything meant only to help the model decide.
- A `SessionStart` response may carry both.
- A hook that shows status follows the status line pattern.

The detail, the status line pattern and the client scope are in the `plugin-design` skill
(`hooks.md`). Reference: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).
