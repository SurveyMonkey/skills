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
- A `SessionStart` hook uses the matcher `startup|resume|clear|compact` and `"timeout": 3`,
  writes nothing when everything is present, and never writes plain text to stdout.
- A hook that shows status writes, in `systemMessage`, at most one status line and then one line
  for each kind of problem, and nothing when there is nothing to show:

  ```
  <prefix>: [<item>] [<item> N]
  <prefix>: ⚠️ <problem>[ in N repos][: <cause>]
  ```

The detail, the status line pattern and the client scope are in the `plugin-design` skill
(`hooks.md`). Reference: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).
