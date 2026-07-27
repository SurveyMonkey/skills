#!/usr/bin/env bash
# preflight-permissions.sh — one-time permission rules for the plugin's
# prescribed command surface
#
# Usage:
#   preflight-permissions.sh check <repo_root> [nwo]   # read-only report
#   preflight-permissions.sh apply <repo_root> [nwo]   # write missing rules
#
# Claude Code does not currently apply skill `allowed-tools` grants to plugin
# skills (anthropics/claude-code#80696, #80802), so every prescribed command
# prompts per shape, per repo. Until that is fixed upstream or the PreToolUse
# hook ships (issue #16), this script lets the orchestrator offer the grants
# as ONE reviewed decision: the catalog below lands in the target repo's
# .claude/settings.local.json (gitignored, per-repo, revocable line by line).
#
# The catalog is the plugin's PRESCRIBED surface only: the bundled scripts,
# the exact git shapes the fix agent's definition mandates, and the PR tail
# that batch approval already authorizes (ADR 002: the dispatch approval is
# the control point; the draft PR is the checkpoint). Deliberately absent:
# repo script execution (running a repo's test suite is repo-specific trust)
# and anything global. Commands agents improvise still prompt — that
# asymmetry is a feature: the spec'd path runs smooth, deviation gets
# scrutiny.
#
# check output:
#   {settings_path, exists, missing, present, missing_count,
#    additional_directories_missing}
# apply output:
#   {settings_path, added, already_present, additional_directories_added}
#
# apply preserves everything else in the settings file (deny rules, other
# keys, ordering) and only appends what is missing. A settings file that is
# not valid JSON is an error: this script never overwrites content it cannot
# parse.

set -euo pipefail

usage() {
  printf '{"error":"Usage: preflight-permissions.sh check|apply <repo_root> [nwo]"}\n' >&2
  exit 1
}

VERB="${1:-}"
REPO_ROOT="${2:-}"
NWO="${3:-}"
case "$VERB" in
  check|apply) ;;
  *) usage ;;
esac
[ -n "$REPO_ROOT" ] || usage
[ -d "$REPO_ROOT" ] || {
  printf '{"error":"repo_root does not exist: %s"}\n' "$REPO_ROOT" >&2
  exit 1
}

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
SETTINGS_DIR="$REPO_ROOT/.claude"
SETTINGS="$SETTINGS_DIR/settings.local.json"

# The catalog. Literal paths, so the rules a user reviews are exactly the
# rules that match. One rule covers every bundled script: all of scripts/ is
# the plugin's own deterministic tooling, a 9-line list is one a user
# actually reads before consenting, and scripts added by future plugin
# versions are covered without re-prompting after an upgrade.
RULES="Bash($PLUGIN_ROOT/scripts/*)
Bash(git -C $REPO_ROOT rev-parse *)
Bash(git -C $REPO_ROOT fetch origin *)
Bash(git -C $REPO_ROOT worktree *)
Bash(mkdir -p $REPO_ROOT/.claude/worktrees)
Bash(git -C $REPO_ROOT/.claude/worktrees/*)
Bash(git push -u origin fix/dependabot-*)"

if [ -n "$NWO" ]; then
  RULES="$RULES
Bash(gh label * --repo $NWO *)
Bash(gh pr create --repo $NWO *)"
fi

rules_json=$(printf '%s\n' "$RULES" | jq -R . | jq -s .)

if [ -f "$SETTINGS" ]; then
  exists=true
  current=$(cat "$SETTINGS")
  if ! printf '%s' "$current" | jq empty 2>/dev/null; then
    printf '{"error":"%s is not valid JSON; refusing to touch it"}\n' "$SETTINGS" >&2
    exit 1
  fi
else
  exists=false
  current='{}'
fi

report=$(printf '%s' "$current" | jq \
  --argjson rules "$rules_json" \
  --arg plugin_root "$PLUGIN_ROOT" \
  --arg settings "$SETTINGS" \
  --argjson exists "$exists" '
  (.permissions.allow // []) as $have
  | (.permissions.additionalDirectories // []) as $dirs
  | ($rules | map(select(. as $r | $have | index($r) | not))) as $missing
  | {
      settings_path: $settings,
      exists: $exists,
      missing: $missing,
      present: ($rules - $missing),
      missing_count: ($missing | length),
      additional_directories_missing: (
        if ($dirs | index($plugin_root)) then [] else [$plugin_root] end
      )
    }
')

if [ "$VERB" = "check" ]; then
  printf '%s\n' "$report"
  exit 0
fi

updated=$(printf '%s' "$current" | jq \
  --argjson report "$report" '
  .permissions = (
    (.permissions // {})
    | .allow = ((.allow // []) + $report.missing)
    | .additionalDirectories =
        ((.additionalDirectories // []) + $report.additional_directories_missing)
  )
')

mkdir -p "$SETTINGS_DIR"
tmp=$(mktemp "$SETTINGS_DIR/.settings.XXXXXX")
printf '%s\n' "$updated" > "$tmp"
mv "$tmp" "$SETTINGS"

printf '%s' "$report" | jq '{
  settings_path,
  added: .missing,
  already_present: .present,
  additional_directories_added: .additional_directories_missing
}'
