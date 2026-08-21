#!/usr/bin/env bash
# pr-state.sh — inspect fix PRs, probe a repo's auto-merge setting, and
# rebase PRs that have fallen behind
#
# Usage:
#   pr-state.sh status    <pr-url>...   # read-only: checks, auto-merge, behind
#   pr-state.sh automerge <nwo>...      # read-only: repo auto-merge setting
#   pr-state.sh rebase    <pr-url>...   # rebase behind PRs; never merges
#
# Output: {"prs": [...]} for status and rebase, {"repos": [...]} for
# automerge — one entry per argument, in argument order.
#
# The verbs deliberately split the read-only surface from the mutating one:
# `status` and `automerge` only run `gh pr view` / `gh api`, `rebase` changes
# PRs. Policy — which PRs to rebase, what to tell the user about an armed
# auto-merge, the F4/F5 verification reporting — belongs to the caller. This
# script does exactly what it is told on exactly the arguments it is given.
#
# There is no promote verb: fix PRs open ready for review (ADR 006), so
# draft promotion is not a step in this system's flow. What survived the
# reversal is the rebase, because two fix PRs in one repository edit the same
# overrides block and the second falls behind the moment the first merges.
#
# status entry:
#   { url, number, repo, state, is_draft, head, base, merge_state, behind,
#     conflict, checks, check_counts: {total, passed, failed, pending},
#     failing_checks, auto_merge: {permitted, armed, enabled_by, method} }
#
#   - `checks` is passed | failed | pending | none, derived from
#     statusCheckRollup. The rollup mixes two node shapes — CheckRuns carry
#     status/conclusion, legacy StatusContexts carry only state — and both
#     must be read or a repo whose CI is gated misclassifies. An empty rollup
#     is "none", never "passed": no CI, or CI that has not spawned yet, is a
#     fact to surface, not a green light (ADR 006 keeps ADR 002's rule of
#     observing rather than assuming).
#   - `merge_state` passes the raw mergeStateStatus through because UNKNOWN
#     is a real transient right after a push; the caller must not read it as
#     clean or behind.
#   - `auto_merge.armed` means auto-merge is enabled on this PR: it merges
#     itself once checks pass, with or without anyone reading the diff.
#     `permitted` is the repository setting; null when the token cannot see
#     it.
#
# automerge entry:
#   { repo, permitted }
#
#   The repository setting alone, answerable before any PR exists. It is the
#   pre-dispatch half of the auto-merge disclosure ADR 006 requires: a PR
#   cannot be armed before it is created, so the only auto-merge fact
#   available at the checkpoint is whether the repository permits it at all.
#   `permitted` is null when the token cannot see the setting.
#
# rebase entry:
#   { url, status: rebased | already-current | conflict | error, stage,
#     detail }
#
#   Rebase only. This verb never marks a PR ready and never merges one.
#   "Already up to date" (any phrasing) is success. Conflicts are reported,
#   never resolved: a conflicted overrides block is judgment, which a script
#   refuses to guess at.
#
# Exit: status and automerge exit 1 if any argument could not be read; rebase
# exits 1 if any PR ended in conflict or error. The full report is emitted
# either way, like the adapter's validate: report and fail.

set -euo pipefail

usage() {
  printf '{"error":"Usage: pr-state.sh status|rebase <pr-url>... | automerge <nwo>..."}\n' >&2
  exit 1
}

VERB="${1:-}"
case "$VERB" in
  status|automerge|rebase) shift ;;
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
# automerge
# ---------------------------------------------------------------------------

run_automerge() {
  entries=""
  failed=false

  for repo in "$@"; do
    # OWNER/REPO and nothing else: one slash, non-empty on both sides. A URL
    # passed here would otherwise reach `gh api repos/<url>` and read as a
    # repository whose setting is invisible, which is the wrong answer.
    case "$repo" in
      */*/* | /* | */)
        valid=false ;;
      */*)
        valid=true ;;
      *)
        valid=false ;;
    esac

    if [ "$valid" = true ]; then
      allow_auto_merge "$repo"
      entry=$(jq -nc --arg repo "$repo" --argjson permitted "$ALLOW_VALUE" \
        '{repo: $repo, permitted: $permitted}')
    else
      entry=$(jq -nc --arg repo "$repo" \
        '{repo: $repo, error: "not an OWNER/REPO name"}')
      failed=true
    fi
    entries="$entries$entry
"
  done

  printf '%s' "$entries" | jq -s '{repos: .}'
  [ "$failed" = false ]
}

# ---------------------------------------------------------------------------
# rebase
# ---------------------------------------------------------------------------

run_rebase() {
  entries=""
  all_current=true

  for url in "$@"; do
    status=""
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

    case "$status" in
      rebased | already-current) ;;
      *) all_current=false ;;
    esac

    entry=$(jq -nc \
      --arg url "$url" --arg status "$status" \
      --arg stage "$stage" --arg detail "$detail" \
      '{url: $url, status: $status,
        stage: (if $stage == "" then null else $stage end),
        detail: (if $detail == "" then null else $detail end)}')
    entries="$entries$entry
"
  done

  printf '%s' "$entries" | jq -s '{prs: .}'
  [ "$all_current" = true ]
}

case "$VERB" in
  status)    run_status "$@" ;;
  automerge) run_automerge "$@" ;;
  rebase)    run_rebase "$@" ;;
esac
