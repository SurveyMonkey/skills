#!/usr/bin/env bash
# scripts/common/notice-scan.sh — PostToolUse hook: nudge toward gh-security
#
# Reads the PostToolUse hook payload for a completed Bash or BashOutput call
# on stdin (https://code.claude.com/docs/en/hooks) and scans the tool's
# output for three signal classes:
#   - GitHub's push-time vulnerability notice ("GitHub found N vulnerabilities
#     on <branch> ...")
#   - a Dependabot alert URL (".../security/dependabot" or ".../N")
#   - non-zero package manager audit output: npm/pnpm/yarn "N vulnerabilities"
#     in text form, `npm audit --json` / `pnpm audit --json`
#     (`.metadata.vulnerabilities.total`), or classic yarn's NDJSON
#     `"auditAdvisory"` records
#
# BashOutput is included because that is how a backgrounded Bash command's
# output surfaces to Claude; a text-only "Bash" matcher never sees it.
#
# A GitHub-sourced match (the first two) nudges Claude to offer the
# resolve-alerts skill directly. A package-manager-only match nudges toward
# checking GitHub security alerts instead, without asserting a fix is needed:
# GitHub stays the sole data source for the fix pipeline
# (docs/rfc/001-alert-orchestration.md, Phase 5), and a package manager's own
# audit findings may not correspond to any open GitHub alert. When both
# signal classes are present in the same output, the GitHub branch wins:
# a GitHub notice is grounds enough to offer the skill directly regardless
# of what else the output also contains.
#
# Local grep/jq only: no network calls, no gh invocations. Exits 0 with no
# stdout on malformed or non-object input, an unrecognized tool, or no
# match, so it stays silent on the overwhelming majority of calls and never
# breaks the session.

set -euo pipefail

# Command substitution truncates at the first NUL byte and strips trailing
# newlines. Accepted degrade-gracefully tradeoff: a payload containing NUL
# is not valid JSON text anyway, and trailing newlines carry no signal here.
input=$(cat)

# `jq -e .` alone accepts any valid JSON value, including a bare string,
# number, array, or boolean; indexing one of those with `.tool_name` below
# would exit non-zero under `set -e`, which the "never crashes" contract
# forbids for a hook that fires on every Bash call. Requiring a top-level
# object rules that out up front.
if ! printf '%s' "$input" | jq -e 'type == "object"' >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty')
case "$tool_name" in
  Bash | BashOutput) ;;
  *) exit 0 ;;
esac

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

# npm/pnpm `audit --json` reports its count under a fixed key instead of the
# prose form above; a plain text regex can never match it, the same class of
# bug that made the shipped v0.1.0 yarn lockfile validator report a false
# "clean" (see plugins/gh-security/scripts/CLAUDE.md, "The rule that matters
# most"). jq is asked to parse only the JSON case, guarded with `2>/dev/null`
# and an explicit type check so audit output that is not valid JSON (the
# common case, npm/pnpm's default human-readable form) never trips `set -e`.
if [ "$pm_match" = false ] && printf '%s' "$output" | jq -e '
    type == "object"
    and (.metadata.vulnerabilities.total? // 0) > 0
  ' >/dev/null 2>&1; then
  pm_match=true
fi

# Classic yarn's `audit --json` emits NDJSON (one JSON object per line, not
# one parseable document), so it is matched as a literal marker rather than
# parsed as a whole.
if [ "$pm_match" = false ] && printf '%s' "$output" | grep -q '"auditAdvisory"'; then
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
