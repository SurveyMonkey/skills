#!/usr/bin/env bash
# run-check.sh — run one verification command and report the outcome as JSON
#
# Usage: run-check.sh <command> [args...]
# Output: {command, exit, log, lines, tail}
#
# Agents kept instrumenting check runs with `; echo "EXIT:$?"` markers —
# across every live test run — because a check's exit code and the tail of
# its output are exactly what their judgment needs, and they do not trust
# either to survive the tool result. This script makes the outcome explicit
# instead: the check's full output goes to a log file in the current
# directory (the worktree, so it dies with the agent's cleanup), and the
# JSON carries the exit code, the line count, and the last 60 lines.
#
# The check failing is data, not an error: this script exits 0 whenever it
# ran the command at all, and callers read `.exit`. Only a usage error is
# this script's own failure.

set -uo pipefail

if [ "$#" -lt 1 ]; then
  printf '{"error":"Usage: run-check.sh <command> [args...]"}\n' >&2
  exit 1
fi

LOG="$PWD/.gh-security-check.log"

"$@" > "$LOG" 2>&1
check_exit=$?

lines=$(wc -l < "$LOG" | tr -d '[:space:]')

tail -60 "$LOG" | jq -R . | jq -s \
  --arg command "$*" \
  --argjson exit "$check_exit" \
  --arg log "$LOG" \
  --argjson lines "$lines" \
  '{command: $command, exit: $exit, log: $log, lines: $lines, tail: .}'
