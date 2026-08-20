#!/usr/bin/env bash
# mark-ready.sh — inspect and promote draft fix PRs
#
# Usage:
#   mark-ready.sh status  <pr-url>...   # read-only: checks, auto-merge, behind
#   mark-ready.sh promote <pr-url>...   # rebase, then mark ready
#
# Output: {"prs": [...]} — one entry per URL, in argument order.
#
# The two verbs deliberately split the read-only surface from the mutating
# one: `status` only runs `gh pr view` / `gh api`, `promote` changes PRs.
# Policy — which PRs to promote, per-PR versus batch confirmation, the
# F4/F5 verification gate — belongs to the caller. This script does exactly
# what it is told on exactly the URLs it is given.
#
# status entry:
#   { url, number, repo, state, is_draft, head, base, merge_state, behind,
#     conflict, checks, check_counts: {total, passed, failed, pending},
#     failing_checks, auto_merge: {permitted, armed, enabled_by, method} }
#
#   - `checks` is passed | failed | pending | none, derived from
#     statusCheckRollup. The rollup mixes two node shapes — CheckRuns carry
#     status/conclusion, legacy StatusContexts carry only state — and both
#     must be read or draft-gated repos misclassify. An empty rollup is
#     "none", never "passed": no CI, or CI gated off drafts, is a fact to
#     surface, not a green light (ADR 002 prescribes observing, not
#     assuming).
#   - `merge_state` passes the raw mergeStateStatus through because UNKNOWN
#     is a real transient right after a push; the caller must not read it as
#     clean or behind.
#   - `auto_merge.armed` means auto-merge is enabled on this PR: promoting
#     it merges it once checks pass. `permitted` is the repository setting;
#     null when the token cannot see it.
#
# promote entry:
#   { url, status: rebased | already-current | conflict | error, ready,
#     stage, detail }
#
#   Strictly ordered per PR: rebase first, `gh pr ready` only after a
#   successful rebase, so reviewers are notified once, on final content.
#   "Already up to date" (any phrasing) is success. Conflicts are reported,
#   never resolved: a conflicted overrides block is judgment, which a script
#   refuses to guess at.
#
# Exit: status exits 1 if any PR could not be viewed; promote exits 1 if any
# PR ended in conflict or error. The full report is emitted either way, like
# the adapter's validate: report and fail.

set -euo pipefail

usage() {
  printf '{"error":"Usage: mark-ready.sh status|promote <pr-url>..."}\n' >&2
  exit 1
}

VERB="${1:-}"
case "$VERB" in
  status|promote) shift ;;
  *) usage ;;
esac
[ "$#" -ge 1 ] || usage

# https://github.com/OWNER/REPO/pull/123 -> OWNER/REPO; empty on anything else.
parse_repo() {
  printf '%s\n' "$1" \
    | sed -nE 's#^https://github\.com/([^/]+)/([^/]+)/pull/[0-9]+$#\1/\2#p'
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

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

  for url in "$@"; do
    repo=$(parse_repo "$url")
    if [ -z "$repo" ]; then
      entry=$(jq -nc --arg url "$url" \
        '{url: $url, error: "not a GitHub pull request URL"}')
      failed=true
    elif view=$(gh pr view "$url" \
        --json number,state,isDraft,headRefName,baseRefName,mergeStateStatus,statusCheckRollup,autoMergeRequest \
        2>&1); then
      allow_auto_merge "$repo"
      entry=$(printf '%s' "$view" | status_entry "$url" "$repo" "$ALLOW_VALUE")
    else
      entry=$(jq -nc --arg url "$url" --arg err "$view" \
        '{url: $url, error: $err}')
      failed=true
    fi
    entries="$entries$entry
"
  done

  printf '%s' "$entries" | jq -s '{prs: .}'
  [ "$failed" = false ]
}

# ---------------------------------------------------------------------------
# promote
# ---------------------------------------------------------------------------

run_promote() {
  entries=""
  all_ready=true

  for url in "$@"; do
    status=""
    ready=false
    stage=""
    detail=""

    rc=0
    out=$(gh pr update-branch --rebase "$url" 2>&1) || rc=$?
    lower=$(printf '%s' "$out" | tr '[:upper:]' '[:lower:]')
    # Every phrasing gh has used for "nothing to do" counts as success; the
    # exact string varies by version, so match loose, lowercase substrings.
    case "$lower" in
      *"up to date"* | *"up-to-date"* | *"no new commits"*)
        status="already-current" ;;
      *)
        if [ "$rc" -eq 0 ]; then
          status="rebased"
        else
          case "$lower" in
            *conflict*) status="conflict" ;;
            *)          status="error" ;;
          esac
          stage="rebase"
          detail="$out"
        fi
        ;;
    esac

    if [ "$status" = "rebased" ] || [ "$status" = "already-current" ]; then
      if rout=$(gh pr ready "$url" 2>&1); then
        ready=true
      else
        rlower=$(printf '%s' "$rout" | tr '[:upper:]' '[:lower:]')
        case "$rlower" in
          *"not a draft"*)
            # Already ready; promoting is idempotent.
            ready=true ;;
          *)
            status="error"
            stage="ready"
            detail="$rout"
            ;;
        esac
      fi
    fi

    [ "$ready" = true ] || all_ready=false

    entry=$(jq -nc \
      --arg url "$url" --arg status "$status" --argjson ready "$ready" \
      --arg stage "$stage" --arg detail "$detail" \
      '{url: $url, status: $status, ready: $ready,
        stage: (if $stage == "" then null else $stage end),
        detail: (if $detail == "" then null else $detail end)}')
    entries="$entries$entry
"
  done

  printf '%s' "$entries" | jq -s '{prs: .}'
  [ "$all_ready" = true ]
}

case "$VERB" in
  status)  run_status "$@" ;;
  promote) run_promote "$@" ;;
esac
