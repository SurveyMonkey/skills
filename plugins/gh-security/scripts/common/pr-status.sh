#!/usr/bin/env bash
# pr-status.sh — read the state of pull requests this flow opened
#
# Usage: pr-status.sh <pr-url>...
#
# Output: {"prs": [...]} — one entry per URL, in argument order.
#
# **Read-only, and the whole script.** It runs `gh pr view` and `gh api` and
# nothing that changes a pull request. There is deliberately no verb for
# marking one ready: PRs open ready for review (ADR 008), so nothing in this
# plugin acts on a PR after `gh pr create`. The mutating half this script
# used to carry — rebase, then `gh pr ready` — is gone with the promotion
# phases it served.
#
# Its callers are the orchestrator's closing report and the standalone
# /gh-security:audit-pins command, both of which print this as information.
# Interpreting it is the caller's job; this script does exactly what it is told
# on exactly the URLs it is given.
#
# Entry:
#   { url, number, repo, state, is_draft, head, base, merge_state, behind,
#     conflict, checks, check_counts: {total, passed, failed, pending},
#     failing_checks, auto_merge: {permitted, armed, enabled_by, method} }
#
#   A URL that could not be read is `{url, error}` instead, with none of the
#   fields above: either it is not a GitHub pull request URL, or `gh pr view`
#   failed on it.
#
#   - `checks` is passed | failed | pending | none, derived from
#     statusCheckRollup. The rollup mixes two node shapes — CheckRuns carry
#     status/conclusion, legacy StatusContexts carry only state — and both
#     must be read or a repo reporting only legacy contexts misclassifies. An
#     empty rollup is "none", never "passed": no CI at all, or a rollup that
#     has not populated yet, is a fact to surface, not a green light. This
#     flow observes checks and never prescribes them (ADR 008, carried
#     forward from ADR 002).
#   - `merge_state` passes the raw mergeStateStatus through because UNKNOWN
#     is a real transient right after a push; the caller must not read it as
#     clean or behind. Most PRs read UNKNOWN when the final report runs,
#     seconds after they were created.
#   - `auto_merge.armed` means auto-merge is enabled on this PR: it merges
#     itself once checks pass, and nothing here or in any agent arms it.
#     `permitted` is the repository setting; null when the token cannot see
#     it.
#
# Exit: 1 if any URL produced an error entry — a malformed URL, which is never
# viewed at all, a failed `gh pr view`, and a `gh pr view` whose output could
# not be parsed. The full report is emitted either way, like the adapter's
# validate: report and fail. **One bad URL never costs the others their
# entries**, which is why a parse failure becomes an entry rather than an
# abort: `gh` writes its release-upgrade notice to stderr while exiting 0, and
# capturing that into the payload used to kill the whole run mid-loop with a
# bare `jq: parse error` and no report at all (#87).

set -euo pipefail

usage() {
  printf '{"error":"Usage: pr-status.sh <pr-url>..."}\n' >&2
  exit 1
}

[ "$#" -ge 1 ] || usage

# https://github.com/OWNER/REPO/pull/123 -> OWNER/REPO; empty on anything else.
parse_repo() {
  printf '%s\n' "$1" \
    | sed -nE 's#^https://github\.com/([^/]+)/([^/]+)/pull/[0-9]+$#\1/\2#p'
}

# One repo-settings call per unique repository. bash 3.2 has no associative
# arrays, so the memo is newline-delimited "repo value" lines. The result
# lands in ALLOW_VALUE rather than on stdout: a $(...) caller would run this
# in a subshell and the memo write would be lost with it.
REPO_MEMO=""
ALLOW_VALUE=""

allow_auto_merge() {
  repo="$1"
  while IFS=' ' read -r r v; do
    if [ "$r" = "$repo" ]; then
      ALLOW_VALUE="$v"
      return 0
    fi
  done <<< "$REPO_MEMO"

  value=$(gh api "repos/$repo" --jq '.allow_auto_merge' 2>/dev/null || printf '')
  case "$value" in
    true|false) ;;
    *) value="null" ;;  # setting invisible to this token, or the call failed
  esac
  REPO_MEMO="$REPO_MEMO$repo $value
"
  ALLOW_VALUE="$value"
}

status_entry() {
  # stdin: the gh pr view JSON. Args: url, repo, permitted.
  jq -c --arg url "$1" --arg repo "$2" --argjson permitted "$3" '
  def entry_state:
    if (.state? // null) != null then
      # StatusContext: legacy commit status, only a state field
      if .state == "SUCCESS" then "passed"
      elif .state == "PENDING" or .state == "EXPECTED" then "pending"
      else "failed"
      end
    else
      # CheckRun: status says whether it finished, conclusion says how
      if (.status // "") != "COMPLETED" then "pending"
      elif (.conclusion // "") == "SUCCESS"
        or .conclusion == "NEUTRAL"
        or .conclusion == "SKIPPED" then "passed"
      else "failed"
      end
    end;

  (.statusCheckRollup // []) as $roll
  | ($roll | map(entry_state)) as $states
  | {
      url: $url,
      number: .number,
      repo: $repo,
      state: .state,
      is_draft: .isDraft,
      head: .headRefName,
      base: .baseRefName,
      merge_state: .mergeStateStatus,
      behind: (.mergeStateStatus == "BEHIND"),
      conflict: (.mergeStateStatus == "DIRTY"),
      checks: (
        if ($roll | length) == 0 then "none"
        elif ($states | any(. == "failed")) then "failed"
        elif ($states | any(. == "pending")) then "pending"
        else "passed"
        end
      ),
      check_counts: {
        total: ($roll | length),
        passed: ($states | map(select(. == "passed")) | length),
        failed: ($states | map(select(. == "failed")) | length),
        pending: ($states | map(select(. == "pending")) | length)
      },
      failing_checks: [
        $roll[] | select(entry_state == "failed") | (.name // .context // "unknown")
      ],
      auto_merge: {
        permitted: $permitted,
        armed: (.autoMergeRequest != null),
        enabled_by: (
          .autoMergeRequest.enabledBy
          | if type == "object" then (.login // null) else . end
        ),
        method: (.autoMergeRequest.mergeMethod // null)
      }
    }
  '
}

run_status() {
  entries=""
  failed=false

  # stderr goes to a file rather than into the payload. `2>&1` here captured
  # gh's own chatter — the release-upgrade notice is the common one, and it
  # arrives WITH a zero exit — into $view, so the jq below parsed a diagnostic
  # as JSON.
  ERR_FILE=$(mktemp)
  trap 'rm -f "$ERR_FILE"' EXIT INT TERM

  for url in "$@"; do
    repo=$(parse_repo "$url")
    if [ -z "$repo" ]; then
      entry=$(jq -nc --arg url "$url" \
        '{url: $url, error: "not a GitHub pull request URL"}')
      failed=true
    elif view=$(gh pr view "$url" \
        --json number,state,isDraft,headRefName,baseRefName,mergeStateStatus,statusCheckRollup,autoMergeRequest \
        2>"$ERR_FILE"); then
      allow_auto_merge "$repo"
      # Guarded, not bare: a parse failure is this PR's entry, never the end of
      # the report. `|| entry=""` keeps set -e out of it, and the empty test
      # also catches a jq that exits 0 on empty input.
      entry=$(printf '%s' "$view" | status_entry "$url" "$repo" "$ALLOW_VALUE" 2>/dev/null) \
        || entry=""
      if [ -z "$entry" ]; then
        entry=$(jq -nc --arg url "$url" \
          --arg err "gh pr view output could not be parsed: $(printf '%s' "$view" | head -c 200)" \
          '{url: $url, error: $err}')
        failed=true
      fi
    else
      entry=$(jq -nc --arg url "$url" --arg err "$(cat "$ERR_FILE")" \
        '{url: $url, error: $err}')
      failed=true
    fi
    entries="$entries$entry
"
  done

  printf '%s' "$entries" | jq -s '{prs: .}'
  [ "$failed" = false ]
}

run_status "$@"
