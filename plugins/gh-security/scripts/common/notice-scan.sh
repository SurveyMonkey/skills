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
# A match is suppressed entirely when the branch in hand is one the plugin
# itself creates (`fix/dependabot-*`, its flat fallback `fix-dependabot-*`
# used when a remote branch named `fix` blocks the slash namespace — issue
# #123 — and `chore/dependabot-remove-pins`): that
# output is the plugin's own dispatched work reporting back, not a repository
# whose alerts nobody has looked at. See the block guarding the emit below.
#
# Local grep/jq and one `git branch --show-current` after a match: no network
# calls, no gh invocations. Exits 0 with no
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

# grep is fed from a heredoc, never `printf ... | grep -q`. `grep -q` exits at
# its first match while printf is still writing, printf takes SIGPIPE, and
# `set -euo pipefail` above then makes the *matched* pipeline non-zero: the
# `if` takes the false branch and a real notice never fires, silently. It is a
# scheduling race on a short payload and deterministic once the payload
# exceeds the pipe buffer, which is why the suite was green over it for so
# long ([#157](https://github.com/SurveyMonkey/skills/issues/157)). A heredoc
# has no reader to exit early and no second process to kill.
github_match=false
pm_match=false

if grep -Eqi 'github found [1-9][0-9]* vulnerabilit' <<SCAN_INPUT
$output
SCAN_INPUT
then
  github_match=true
fi

if grep -Eq 'https://github\.com/[^/[:space:]]+/[^/[:space:]]+/security/dependabot(/[0-9]+)?' <<SCAN_INPUT
$output
SCAN_INPUT
then
  github_match=true
fi

if grep -Eqi '[1-9][0-9]* vulnerabilit(y|ies)' <<SCAN_INPUT
$output
SCAN_INPUT
then
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
if [ "$pm_match" = false ] && grep -q '"auditAdvisory"' <<SCAN_INPUT
$output
SCAN_INPUT
then
  pm_match=true
fi

# Yarn Berry's `audit --json` (really `yarn npm audit --json`) is a
# different NDJSON shape entirely: one record per line keyed
# `{"value": "<package>", "children": {"ID":..., "Severity":"...", ...}}`,
# carrying none of the v1 markers above — the v1 detection above is silent
# on real Berry output (issue #32).
#
# Matched by parsing each line as its own JSON document (`fromjson`) rather
# than pattern-matching the raw text: a text regex for `"children":{...` can
# never rule out a literal `{` occurring in an *earlier* field of the same
# record (`Issue`, `URL`) without also being able to match a `}` there, which
# is the same unmatchable-pattern bug class this file exists to avoid
# (issue #41; plugins/gh-security/scripts/CLAUDE.md, "The rule that matters
# most"). `-R` reads NDJSON one line at a time; the outer `try ... catch
# empty` absorbs a line that is not valid JSON (`fromjson` fails) or whose
# `children` is present but not an object (`.children.Severity` errors on a
# string/array/number), so either degrades to "no signal on this line"
# instead of aborting the scan. `// empty` treats a record with no `Severity`
# key (`children.Severity` is `null`) the same way, rather than emitting the
# literal string "null" as a match.
if [ "$pm_match" = false ] && printf '%s' "$output" | jq -R '
    try (fromjson | .children.Severity // empty) catch empty
  ' 2>/dev/null | grep -q .; then
  pm_match=true
fi

if [ "$github_match" = false ] && [ "$pm_match" = false ]; then
  exit 0
fi

# The plugin's own dispatched work is not a reason to offer the plugin.
#
# Every fix-dependency and audit-pins run pushes from inside its own worktree,
# and GitHub answers that push with the very notice this hook scans for. The
# nudge then landed in a subagent that resolve-alerts had *already* dispatched,
# telling it to offer resolve-alerts and ask whether to start
# ([#77](https://github.com/SurveyMonkey/skills/issues/77)).
#
# The notice itself cannot be the discriminator: GitHub's text names the
# repository and its *default* branch ("GitHub found 24 vulnerabilities on
# <owner>/<repo>'s default branch"), never the branch that was pushed. So the
# branch is read from the two places that do carry it, in the order they are
# trustworthy:
#
#   1. The pushed branch named in the command itself (`.tool_input.command`),
#      which is right even when the hook's own cwd is the orchestrator's
#      checkout rather than the subagent's worktree.
#   2. Failing that, the branch checked out in the payload's `cwd`, which is
#      the worktree the command ran in. This covers `git push -u origin HEAD`
#      and every non-push command (a follow-up `gh pr create` in the same
#      worktree) that trips the scan.
#
# Deliberately not a documented "ignore this nudge" line in the two agent
# definitions: that burns a turn on every push, depends on the agent following
# an instruction about something it was never told to expect, and would have to
# be copied into any future caller of these branches.
#
# Checked only after a match, so the `git` call costs nothing on the
# overwhelming majority of Bash calls, which match nothing at all.
# `fix[-/]dependabot-` covers both spellings of the fix branch: the slash
# scheme and the flat fallback dispatched when a remote branch named `fix`
# blocks the `fix/*` namespace (issue #123). Matching the flat spelling as a
# bare substring would also hit a user's own `my-fix-dependabot-*` or
# `hotfix/dependabot-*` branch — the slash-only pattern already had the
# latter over-match — so the command-text check below requires the match to
# start the string or follow a separator that cannot continue a branch name
# fragment (`/` for `refs/heads/...`, space, `:`, quotes all qualify;
# letters, digits, `_`, `.`, and `-` do not). The branch check stays
# anchored at `^`, which needs no boundary of its own.
PLUGIN_BRANCH_RE='(fix[-/]dependabot-|chore/dependabot-remove-pins)'

command_text=$(printf '%s' "$input" | jq -r '
  if (.tool_input | type) == "object" then (.tool_input.command // "") else "" end
')

if grep -Eq "(^|[^[:alnum:]_.-])$PLUGIN_BRANCH_RE" <<SCAN_INPUT
$command_text
SCAN_INPUT
then
  exit 0
fi

payload_cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
if [ -n "$payload_cwd" ] && [ -d "$payload_cwd" ] && command -v git >/dev/null 2>&1; then
  # `|| true` because every failure here is a normal situation, not an error:
  # a cwd outside any repository, a detached HEAD (empty output), or a git
  # that refuses the directory. None of them may break a hook that fires on
  # every Bash call.
  current_branch=$(git -C "$payload_cwd" branch --show-current 2>/dev/null || true)
  if [ -n "$current_branch" ] \
    && grep -Eq "^$PLUGIN_BRANCH_RE" <<SCAN_INPUT
$current_branch
SCAN_INPUT
then
    exit 0
  fi
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
