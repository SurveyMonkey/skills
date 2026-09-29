# Dependencies outside a plugin

A plugin can assume node on the 22.18 floor, git and the GitHub CLI. It assumes nothing else.
gh-security also needs `bash` and `jq` for its bash scripts. Two of them, `notice-scan.sh` and
`detect-capacity.sh`, stay bash after the port.
It still checks each tool that it uses, so that a user who is not set up gets an early alert.

- Declare each dependency (a tool, a `gh` extension, another plugin) in one table in the plugin.
  A dependency on another plugin is a row in that table, never a copy of its code.
- A `SessionStart` hook checks the table. Its matcher is `startup|resume|clear|compact`, so the
  result comes back after compaction. The check is fast and local, with a deadline well under the
  hook's `timeout`. A `SessionStart` hook finishes in less than 3 seconds, with `"timeout": 3`
  in `hooks.json`.
- When everything is present, the hook writes nothing. When something is missing, it writes JSON
  with both fields (`.claude/rules/path-hooks.md`):
  - `systemMessage`: one line for each missing item, with the plugin name first, for the user.
  - `additionalContext`: which items are missing and that the plugin cannot run, so the model
    does not start work that will fail.
- Never write plain text to stdout from a `SessionStart` hook. Claude Code adds it to the
  model's context.
- The check is one pure function in `lib/` over the plugin's table. Each hook is a thin adapter.
- A skill has no preflight step. A command that fails still reports its own failure, because a
  check at session start can go stale.
- A script cannot report that node is missing. The `hooks.json` command string checks
  `command -v node` and writes the `systemMessage` JSON itself. Shell in a `hooks.json` string is
  not a bash file.
- A `SessionStart` hook runs once, not on every tool call. Below the node floor, it may write one
  `systemMessage` line with the floor version. A hook on each tool call still checks
  the floor and stays silent (`meetsNodeFloor`, which lands in `lib/node-floor.ts` with #274).
- Do not check an optional plugin. A skill sees the available skills in its listing, and works
  around an absent one.
