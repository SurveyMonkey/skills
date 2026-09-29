# Hook output patterns

## additionalContext and systemMessage

A hook's JSON response can carry two different fields, to get a message to a person. They reach
the user in genuinely different ways:

- `additionalContext` (inside `hookSpecificOutput`) is inserted into the model's context only.
  It is never rendered directly. The model sees it on its next turn, and it may voice,
  paraphrase, or ignore it. The user's first input can pre-empt that turn, when they already run
  the very command the hook would have suggested. If so, the message can go completely
  unmentioned.
- `systemMessage` (top-level in the response) is rendered directly by the Claude Code CLI, as
  visible terminal output. This happens independent of whether the model ever takes a turn.

A `SessionStart` response may return both in the same payload. They are not exclusive.

Reach for `systemMessage` for anything that must reach the user, no matter what they type next.
Reach for `additionalContext` for anything meant only to help the model decide. There, the model
may paraphrase it, or silently drop it, and that is acceptable.

Reference: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

## Status line hooks

A plugin hook that shows status writes this pattern in `systemMessage`, one line after the other:

```
<prefix>: [<item>] [<item> N]
<prefix>: ⚠️ <problem>[ in N repos][: <cause>]
```

- One status line at most: the plugin prefix, then bracketed items. Leave out an item that is zero.
- Then one `<prefix>: ⚠️ <problem>` line for each kind of problem. Each kind has fixed words.
- One line per kind, not per repository. In a folder of repositories, write the count: `in N
  repos`, or `in 1 repo`. Add a short cause after `: `, from the first failure of that kind.
- Write the full detail of each failure to stderr, one line each. Claude Code keeps stderr in its
  debug log.
- A missing required tool is a problem line of its own. It stops all other checks.
- When there is nothing to show, write nothing.

## Scope: terminal CLI only

This guidance targets the Claude Code terminal/CLI, which is what every plugin here targets.
VS Code's integration currently discards `systemMessage` for `SessionStart`
([anthropics/claude-code#15344](https://github.com/anthropics/claude-code/issues/15344)). That is
a gap in a different client, not a reason to avoid `systemMessage` here.
