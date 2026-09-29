---
paths:
  - "**/hooks/**/*.ts"
  - "**/hooks/*.json"
---

# Hook Output

- `systemMessage` (top level) shows in the terminal, whether or not the model takes a turn.
  Use it for anything that must reach the user.
- `additionalContext` (inside `hookSpecificOutput`) reaches only the model, which may paraphrase
  or drop it. Use it only to help the model decide.
- A `SessionStart` response may carry both.
- A `SessionStart` hook uses the matcher `startup|resume|clear|compact` and `"timeout": 3`,
  writes nothing when everything is present, and never writes plain text to stdout. When
  something is missing, it writes both fields: `systemMessage`, one line per missing item with the
  plugin name first, and `additionalContext`, what is missing and that the plugin cannot run.
- A status hook writes to `systemMessage` at most one status line, then one line for each kind
  of problem, and nothing when there is nothing to show:

  ```
  <prefix>: [<item>] [<item> N]
  <prefix>: ⚠️ <problem>[ in N repos][: <cause>]
  ```

Detail and client scope are in the `plugin-design` skill (`hooks.md`) and the
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks).
