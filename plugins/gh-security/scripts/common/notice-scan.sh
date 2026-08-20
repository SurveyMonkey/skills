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
#     in text form; `npm audit --json` / `pnpm audit --json` via a positive
#     severity count under `.metadata.vulnerabilities`; classic yarn (v1)
#     NDJSON `"auditAdvisory"` records; or Yarn Berry's NDJSON
#     `{"value":..., "children":{"Severity":...}}` records
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
#
# pnpm emits the npm v6 audit shape: `.metadata.vulnerabilities` carries only
# the severity-keyed counts (info/low/moderate/high/critical), with no
# `.total` key at all — reading `.total` there is always null (issue #32).
# Summing the five known severity keys instead reads correctly for both: npm
# v7+ carries the same five keys alongside `.total`, so the sum is still
# positive exactly when `.total` would have been. `try ... catch false` keeps
# a value of the wrong type (a string, an array) from raising a jq runtime
# error that would otherwise only surface as an unnoticed non-zero exit
# hidden inside this `if` condition.
if [ "$pm_match" = false ] && printf '%s' "$output" | jq -e '
    try (
      type == "object"
      and ((.metadata.vulnerabilities // {}) as $v
        | (($v.info // 0) + ($v.low // 0) + ($v.moderate // 0)
           + ($v.high // 0) + ($v.critical // 0)) > 0)
    ) catch false
  ' >/dev/null 2>&1; then
  pm_match=true
fi

# Classic yarn (v1) `audit --json` emits NDJSON (one JSON object per line,
# not one parseable document) shaped `{"type":"auditAdvisory", ...}`, so it
# is matched as a literal marker rather than parsed as a whole.
if [ "$pm_match" = false ] && printf '%s' "$output" | grep -q '"auditAdvisory"'; then
  pm_match=true
fi

# Yarn Berry's `audit --json` (really `yarn npm audit --json`) is a
# different NDJSON shape entirely: one record per line keyed
# `{"value": "<package>", "children": {"ID":..., "Severity":"...", ...}}`,
# carrying none of the v1 markers above — the v1 detection above is silent
# on real Berry output (issue #32). Matched the same way, as a same-line
# literal marker rather than a parsed document, keyed on `children.Severity`
# since that field is stable across the advisories seen in real captures
# while the rest of the record varies in which keys are present.
if [ "$pm_match" = false ] && printf '%s' "$output" | grep -Eq '"children":\{[^}]*"Severity":"'; then
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
