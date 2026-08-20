#!/usr/bin/env bash
# scripts/common/notice-scan.sh — PostToolUse hook: nudge toward gh-security
#
# Reads the PostToolUse hook payload for a completed Bash call on stdin
# (https://code.claude.com/docs/en/hooks) and greps the tool's output for
# three signal classes:
#   - GitHub's push-time vulnerability notice ("GitHub found N vulnerabilities
#     on <branch> ...")
#   - a Dependabot alert URL (".../security/dependabot" or ".../N")
#   - non-zero package manager audit output (npm/pnpm/yarn "N vulnerabilities")
#
# A GitHub-sourced match (the first two) nudges Claude to offer the
# resolve-alerts skill directly. A package-manager-only match nudges toward
# checking GitHub security alerts instead, without asserting a fix is needed:
# GitHub stays the sole data source for the fix pipeline
# (docs/rfc/001-alert-orchestration.md, Phase 5), and a package manager's own
# audit findings may not correspond to any open GitHub alert.
#
# Local grep only: no network calls, no gh invocations. Exits 0 with no
# stdout on malformed input, a non-Bash tool, or no match, so it stays silent
# on the overwhelming majority of Bash calls and never breaks the session.

set -euo pipefail

input=$(cat)

if ! printf '%s' "$input" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty')
if [ "$tool_name" != "Bash" ]; then
  exit 0
fi

# tool_response is a string for a normal Bash result. Defend against an
# {stdout, stderr} object shape too, so a harness change degrades to
# scanning less text rather than erroring the hook.
output=$(printf '%s' "$input" | jq -r '
  if (.tool_response | type) == "object" then
    [(.tool_response.stdout // ""), (.tool_response.stderr // "")] | join("\n")
  else
    (.tool_response // "")
  end
')

github_match=false
pm_match=false

if printf '%s' "$output" | grep -Eqi 'github found [1-9][0-9]* vulnerabilit'; then
  github_match=true
fi

if printf '%s' "$output" | grep -Eq 'https://github\.com/[^/[:space:]]+/[^/[:space:]]+/security/dependabot(/[0-9]+)?'; then
  github_match=true
fi

if printf '%s' "$output" | grep -Eqi '[1-9][0-9]* vulnerabilit(y|ies)'; then
  pm_match=true
fi

if [ "$github_match" = false ] && [ "$pm_match" = false ]; then
  exit 0
fi

if [ "$github_match" = true ]; then
  context="This command's output contains a GitHub vulnerability notice (a push-time alert count or a Dependabot alert URL). Offer to run the gh-security resolve-alerts skill to review and fix the open Dependabot alerts, and ask whether to start."
else
  context="This command's output shows non-zero package manager audit findings (npm/pnpm/yarn audit). These may not correspond to any open GitHub Dependabot alert, since GitHub is the source of truth the gh-security plugin acts on. Suggest checking GitHub security alerts via the gh-security resolve-alerts skill; if GitHub reports no open alerts, say so and stop rather than trying to reconcile the audit output."
fi

jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
