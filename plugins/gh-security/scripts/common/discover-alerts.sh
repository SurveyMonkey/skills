#!/usr/bin/env bash
# discover-alerts.sh: fetch and rank open Dependabot alerts by package major line
#
# Usage:
#   discover-alerts.sh [--scope repo] <owner/repo>
#   discover-alerts.sh --scope org <org>
#   discover-alerts.sh --scope user [login]
#
# Scope strategy (RFC 001 Phase 3, issue #6):
#   repo  GET /repos/{owner}/{repo}/dependabot/alerts (unchanged, single call)
#   org   GET /orgs/{org}/dependabot/alerts (aggregate, paginated). On a 403
#         (no org-level security visibility), falls back to enumerating
#         GET /orgs/{org}/repos and fanning out per repo inside this script.
#   user  No aggregate endpoint exists. Enumerates GET /user/repos?type=owner
#         (the authenticated user's own repos, forks and archived excluded)
#         and fans out per repo inside this script.
#
# At org (fallback) and user scope, each candidate repo's push permission is
# checked. A repo the authenticated user cannot push to is never dispatched;
# it is recorded in the top-level `skipped_repos` array by name so the caller
# can report it, never silently drop it. `skipped_repos` is always present,
# empty at repo scope and on a clean org aggregate call.
#
# EMU orgs are out of scope (RFC 001 Non-Goals): this script does not detect
# or special-case them.
#
# Output: JSON with three top-level keys:
#   actionable:   groups with a fix available and no open PR (sorted by
#                 severity then EPSS; repo and package break remaining ties)
#   skipped:      groups excluded (no fix, PR already open, or unsupported
#                 ecosystem), with reason
#   skipped_repos: repos excluded from a cross-repo scope for lack of push
#                 access, or because their alerts could not be fetched
#
# Each group:
#   { repo, package, ecosystem, major_line, max_severity, max_epss_percentile,
#     alert_count, highest_fixed_version, branch_name, alerts: [{ number, cve,
#     ghsa, severity, summary, vulnerable_range, fixed_in, epss_percentile,
#     relationship, manifest }] }
# Skipped groups also include: { reason, open_pr_url?, error? }
#
# One group per package *major line*, not per package. A package resolved at
# several majors at once (undici at 5.x, 6.x and 7.x is the case that exposed
# this) has a different patched version per line, and the fix agent's overrides
# are major-bounded, so a single highest_fixed_version describes only the newest
# line and leaves the others silently vulnerable (issue #19). Each group maps to
# one worktree, one branch, one PR.
#
# The line key is the leading component of `first_patched_version`, which is the
# only line signal an alert carries: the API never says which resolved copy an
# alert matched. Deciding whether a resolved copy is actually covered needs the
# lockfile, and that is the adapter's `validate` verb, not this script.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

SCOPE="repo"
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --scope)
      SCOPE="${2:?--scope requires a value}"
      shift 2
      ;;
    --scope=*)
      SCOPE="${1#--scope=}"
      shift
      ;;
    -*)
      printf '{"error":"Unknown argument: %s"}\n' "$1" >&2
      exit 1
      ;;
    *)
      TARGET="$1"
      shift
      ;;
  esac
done

case "$SCOPE" in
  repo|org|user) ;;
  *)
    printf '{"error":"Unknown scope: %s (expected repo, org, or user)"}\n' "$SCOPE" >&2
    exit 1
    ;;
esac

if [ "$SCOPE" = "repo" ] && [ -z "$TARGET" ]; then
  printf '{"error":"Usage: discover-alerts.sh [--scope repo] <owner/repo>"}\n' >&2
  exit 1
fi
if [ "$SCOPE" = "org" ] && [ -z "$TARGET" ]; then
  printf '{"error":"Usage: discover-alerts.sh --scope org <org>"}\n' >&2
  exit 1
fi

ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

# Single source of truth for branch naming. The line suffix is what keeps two
# groups for the same package from colliding on one branch; it is applied to
# every group, including single-line packages, so a package that grows a second
# line later does not rename the branch it already had.
branch_name() {
  case "$2" in
    none) printf 'fix/dependabot-%s-unfixed' "$1" ;;
    *)    printf 'fix/dependabot-%s-%sx' "$1" "$2" ;;
  esac
}

# Branch name used before per-line grouping shipped. Checked alongside the
# current name when looking for an open PR, so an upgrade does not open a
# duplicate PR against a repo that already has one from the old naming.
#
# Only the package's *newest* line consults it. A legacy PR was produced by the
# grouping that described a package by one highest_fixed_version, so it fixed
# the newest line and nothing else; letting every line match it would re-suppress
# the older still-vulnerable lines, which is precisely the bug issue #19 fixed.
legacy_branch_name() {
  printf 'fix/dependabot-%s' "$1"
}

# Pick the highest fixed version across a group's advisories.
#
# Version comparison belongs to the ecosystem adapter, not here: semver and
# PEP 440 disagree about prereleases, and a shared implementation would have to
# be wrong for one of them. Reads candidate versions on stdin.
highest_version() {
  eco="$1"
  adapter=$("$SCRIPT_DIR/select-adapter.sh" --ecosystem "$eco" 2>/dev/null \
    | jq -r '.adapter_path // empty' 2>/dev/null || printf '')
  best=""
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ -z "$best" ]; then
      best="$candidate"
      continue
    fi
    if [ -n "$adapter" ]; then
      if [ "$("$adapter" compare_versions "$candidate" "$best" | jq -r '.result')" = "1" ]; then
        best="$candidate"
      fi
    else
      # No adapter for this ecosystem. The group is going to be skipped anyway;
      # this only decides whether *some* fix exists to report.
      if [ "$(printf '%s\n%s\n' "$best" "$candidate" | sort -V | tail -1)" = "$candidate" ]; then
        best="$candidate"
      fi
    fi
  done
  printf '%s\n' "$best"
}

# Fail loudly on anything that is not a JSON array of alerts: an empty array is
# a legitimate "no alerts" answer, but a JSON error object or non-JSON body
# must never be silently treated as zero alerts.
validate_alerts_json() {
  label="$1"
  json="$2"

  if ! printf '%s' "$json" | jq empty 2>/dev/null; then
    printf '{"error":"Invalid JSON response for %s"}\n' "$label" >&2
    exit 1
  fi
  if ! printf '%s' "$json" | jq -e 'type == "array"' >/dev/null 2>&1; then
    msg=$(printf '%s' "$json" | jq -r '.message // "Response is not a JSON array"' 2>/dev/null)
    printf '{"error":"Unexpected API response for %s: %s"}\n' "$label" "$msg" >&2
    exit 1
  fi
}

# Group one repo's flat alert array into the actionable/skipped contract,
# tagging every group with `repo`. `alerts_json` is a flat JSON array of alert
# objects (already flattened out of any paginated page nesting).
group_repo_alerts() {
  repo="$1"
  alerts_json="$2"

  GROUPED=$(printf '%s' "$alerts_json" | jq '
    flatten |
    if length == 0 then []
    else
      [.[] | select(.dependency.package.name != null)] |
      def sev_rank:
        if . == "critical" then 0
        elif . == "high" then 1
        elif . == "medium" then 2
        elif . == "low" then 3
        else 4 end;

      # Leading component of the patched version, or "none" when no patched
      # version is published. Extraction, not comparison: ordering versions
      # stays behind the adapter (see scripts/CLAUDE.md).
      #
      # The identifier is advisory-supplied text, not a validated version.
      # Prose ("See vendor advisory") and stray whitespace do occur, and
      # anything that is not a plain nonnegative integer once trimmed would
      # otherwise end up in a group key and a branch name, where an embedded
      # space makes the `gh pr list --search` lookup succeed with no results
      # and the malformed group look actionable. Such an alert has no usable
      # line, so it takes the same route as one with no patched version at
      # all: line "none", skipped.
      def line_of:
        ((.security_vulnerability.first_patched_version.identifier // "")
         | tostring
         | sub("^[[:space:]]+"; "") | sub("[[:space:]]+$"; "")
         | sub("^[v=]+"; "")
         | split(".")[0] // "")
        | if test("^[0-9]+$") then . else "none" end;

      group_by([.dependency.package.name, line_of]) |
      map({
        package: .[0].dependency.package.name,
        ecosystem: .[0].dependency.package.ecosystem,
        major_line: (.[0] | line_of),
        max_severity: (
          [.[].security_advisory.severity] |
          map({val: ., rank: (. | sev_rank)}) |
          sort_by(.rank) |
          first.val
        ),
        max_epss_percentile: (
          [.[].security_advisory.epss.percentile // 0] | max
        ),
        alert_count: length,
        # Only versions from an alert with a usable line. An identifier the
        # line extraction rejected is not a version this pipeline can order or
        # bound a range with, so it must not become a highest_fixed_version
        # either.
        fixed_versions: [
          .[]
          | select(line_of != "none")
          | .security_vulnerability.first_patched_version.identifier // empty
        ],
        alerts: [.[] | {
          number: .number,
          cve: .security_advisory.cve_id,
          ghsa: .security_advisory.ghsa_id,
          severity: .security_advisory.severity,
          summary: .security_advisory.summary,
          vulnerable_range: .security_vulnerability.vulnerable_version_range,
          fixed_in: (
            .security_vulnerability.first_patched_version.identifier // "none"
          ),
          epss_percentile: (.security_advisory.epss.percentile // 0),
          relationship: (.dependency.relationship // "unknown"),
          manifest: (.dependency.manifest_path // "unknown")
        }]
      }) |
      # Which group is the package`s newest line, for the legacy-branch lookup
      # below. Internal to discovery: the loop reads it and drops it before
      # the group is emitted.
      (map(select(.major_line != "none"))
       | group_by(.package)
       | map({key: .[0].package,
              value: ([.[].major_line | tonumber] | max)})
       | from_entries) as $newest |
      map(. + {is_newest_line: (.major_line != "none"
                                and $newest[.package] == (.major_line | tonumber))}) |
      # Package and line break ties so two lines of the same package always
      # come out in a stable order.
      sort_by([(.max_severity | sev_rank), -(.max_epss_percentile),
               .package, .major_line])
    end
  ' 2>"$ERR_FILE") || {
    printf '{"error":"Failed to group alerts for %s: %s"}\n' "$repo" "$(cat "$ERR_FILE")" >&2
    return 1
  }

  if [ "$(printf '%s' "$GROUPED" | jq 'length')" -eq 0 ]; then
    printf '{"actionable":[],"skipped":[]}\n'
    return 0
  fi

  ACTIONABLE=()
  SKIPPED=()

  ITEMS=$(printf '%s' "$GROUPED" | jq -c '.[]' 2>"$ERR_FILE") || {
    printf '{"error":"Failed to iterate alert groups for %s: %s"}\n' "$repo" "$(cat "$ERR_FILE")" >&2
    return 1
  }

  while IFS= read -r group; do
    pkg=$(printf '%s' "$group" | jq -r '.package')

    versions=$(printf '%s' "$group" | jq -r '.fixed_versions[]')
    ecosystem=$(printf '%s' "$group" | jq -r '.ecosystem // "unknown"')
    if [ -n "$versions" ]; then
      highest=$(printf '%s\n' "$versions" | highest_version "$ecosystem")
      [ -n "$highest" ] || highest="none"
    else
      highest="none"
    fi
    line=$(printf '%s' "$group" | jq -r '.major_line')
    newest_line=$(printf '%s' "$group" | jq -r '.is_newest_line')
    branch=$(branch_name "$pkg" "$line")
    enriched=$(printf '%s' "$group" | jq -c \
      --arg hv "$highest" --arg br "$branch" --arg repo "$repo" \
      '. + {highest_fixed_version: $hv, branch_name: $br, repo: $repo}
       | del(.fixed_versions, .is_newest_line)')

    # Skip if no fix available
    if [ "$highest" = "none" ]; then
      SKIPPED+=("$(printf '%s' "$enriched" | jq -c '. + {reason: "no fix available"}')")
      continue
    fi

    # Skip if an open PR already exists for this line: its own branch always,
    # and the pre-#19 branch name only for the package's newest line, which is
    # the only line such a PR ever fixed.
    pr_url=""
    pr_failed=false
    pr_err=""
    pr_reason="open PR exists"
    pr_candidates=("$branch")
    if [ "$newest_line" = "true" ]; then
      pr_candidates+=("$(legacy_branch_name "$pkg")")
    fi
    for candidate in "${pr_candidates[@]}"; do
      pr_check_err=$(mktemp)
      if found=$(gh pr list --repo "$repo" \
        --search "head:${candidate}" \
        --state open --json url --jq '.[0].url // empty' 2>"$pr_check_err"); then
        rm -f "$pr_check_err"
        if [ -n "$found" ]; then
          pr_url="$found"
          # Name the legacy branch in the reason: the report should not imply
          # a PR exists on this line`s own branch when it does not.
          if [ "$candidate" != "$branch" ]; then
            pr_reason="open PR exists (legacy branch $candidate)"
          fi
          break
        fi
      else
        pr_err=$(cat "$pr_check_err")
        rm -f "$pr_check_err"
        pr_failed=true
        break
      fi
    done

    if [ "$pr_failed" = true ]; then
      SKIPPED+=("$(printf '%s' "$enriched" | jq -c --arg err "$pr_err" \
        '. + {reason: "PR check failed", error: $err}')")
      continue
    fi
    if [ -n "$pr_url" ]; then
      SKIPPED+=("$(printf '%s' "$enriched" | jq -c \
        --arg url "$pr_url" --arg reason "$pr_reason" \
        '. + {reason: $reason, open_pr_url: $url}')")
      continue
    fi

    ACTIONABLE+=("$enriched")
  done <<< "$ITEMS"

  actionable_json=$(if [ ${#ACTIONABLE[@]} -eq 0 ]; then printf '[]\n'; else printf '%s\n' "${ACTIONABLE[@]}" | jq -s '.'; fi)
  skipped_json=$(if [ ${#SKIPPED[@]} -eq 0 ]; then printf '[]\n'; else printf '%s\n' "${SKIPPED[@]}" | jq -s '.'; fi)
  printf '%s\n%s\n' "$actionable_json" "$skipped_json" | jq -s '{actionable: .[0], skipped: .[1]}' || {
    printf '{"error":"Internal error: failed to assemble output JSON for %s"}\n' "$repo" >&2
    return 1
  }
}

# Combine per-repo {actionable, skipped} blobs (one per line on stdin) into a
# single result, globally re-ranked. Severity and EPSS still lead the sort;
# repo and package break remaining ties so a multi-repo scope comes out in a
# stable order.
combine_results() {
  jq -s '
    def sev_rank:
      if . == "critical" then 0
      elif . == "high" then 1
      elif . == "medium" then 2
      elif . == "low" then 3
      else 4 end;
    {
      actionable: ([.[].actionable[]] | sort_by(
        [(.max_severity | sev_rank), -(.max_epss_percentile), .repo, .package, .major_line]
      )),
      skipped: [.[].skipped[]]
    }
  '
}

# Fetch, validate, group, and combine alerts across every repo listed by a
# `gh api` listing endpoint (org repos or the authenticated user's repos).
# Forks and archived repos are dropped silently (never dispatch targets);
# repos without push access are recorded in `skipped_repos`, never dropped
# silently, per the RFC's push-access filtering requirement.
fan_out() {
  api_path="$1"

  LIST=$(gh api "$api_path" --paginate --slurp 2>"$ERR_FILE") || {
    printf '{"error":"Failed to list repos via %s: %s"}\n' "$api_path" "$(cat "$ERR_FILE")" >&2
    exit 1
  }
  printf '%s' "$LIST" | jq empty 2>/dev/null || {
    printf '{"error":"Invalid JSON response listing repos via %s"}\n' "$api_path" >&2
    exit 1
  }

  CANDIDATES=$(printf '%s' "$LIST" | jq -c '
    flatten
    | map(select((.fork // false) == false and (.archived // false) == false))
    | map({full_name, push: ((.permissions.push) // false)})
  ')

  results=()
  skipped_repos=()

  rows=$(printf '%s' "$CANDIDATES" | jq -c '.[]')
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    full_name=$(printf '%s' "$row" | jq -r '.full_name')
    push=$(printf '%s' "$row" | jq -r '.push')

    if [ "$push" != "true" ]; then
      skipped_repos+=("$(jq -n --arg repo "$full_name" --arg reason "no push access" \
        '{repo: $repo, reason: $reason}')")
      continue
    fi

    repo_alerts_err=$(mktemp)
    if ! repo_alerts=$(gh api "repos/$full_name/dependabot/alerts?state=open&per_page=100" \
      --paginate --slurp 2>"$repo_alerts_err"); then
      skipped_repos+=("$(jq -n --arg repo "$full_name" --arg reason "alert fetch failed" \
        --arg err "$(cat "$repo_alerts_err")" '{repo: $repo, reason: $reason, error: $err}')")
      rm -f "$repo_alerts_err"
      continue
    fi
    rm -f "$repo_alerts_err"

    if ! printf '%s' "$repo_alerts" | jq empty 2>/dev/null || \
       ! printf '%s' "$repo_alerts" | jq -e 'type == "array"' >/dev/null 2>&1; then
      skipped_repos+=("$(jq -n --arg repo "$full_name" --arg reason "invalid alert response" \
        '{repo: $repo, reason: $reason}')")
      continue
    fi

    res=$(group_repo_alerts "$full_name" "$repo_alerts") || exit 1
    results+=("$res")
  done <<< "$rows"

  combined='{"actionable":[],"skipped":[]}'
  if [ ${#results[@]} -gt 0 ]; then
    combined=$(printf '%s\n' "${results[@]}" | combine_results)
  fi

  skipped_repos_json="[]"
  if [ ${#skipped_repos[@]} -gt 0 ]; then
    skipped_repos_json=$(printf '%s\n' "${skipped_repos[@]}" | jq -s '.')
  fi

  printf '%s' "$combined" | jq --argjson sr "$skipped_repos_json" '. + {skipped_repos: $sr}'
}

case "$SCOPE" in
  repo)
    ALERTS=$(gh api "repos/$TARGET/dependabot/alerts?state=open&per_page=100" \
      --paginate --slurp 2>"$ERR_FILE") || {
      printf '{"error":"Failed to fetch alerts for %s: %s"}\n' "$TARGET" "$(cat "$ERR_FILE")" >&2
      exit 1
    }
    validate_alerts_json "$TARGET" "$ALERTS"
    RESULT=$(group_repo_alerts "$TARGET" "$ALERTS") || exit 1
    printf '%s' "$RESULT" | jq '. + {skipped_repos: []}'
    ;;

  org)
    if AGG=$(gh api "orgs/$TARGET/dependabot/alerts?state=open&per_page=100" \
      --paginate --slurp 2>"$ERR_FILE"); then
      validate_alerts_json "$TARGET" "$AGG"
      FLAT=$(printf '%s' "$AGG" | jq -c 'flatten')

      repos=$(printf '%s' "$FLAT" | jq -r '[.[].repository.full_name] | unique | .[]')
      results=()
      while IFS= read -r r; do
        [ -n "$r" ] || continue
        repo_alerts=$(printf '%s' "$FLAT" | jq -c --arg r "$r" \
          '[.[] | select(.repository.full_name == $r)]')
        res=$(group_repo_alerts "$r" "$repo_alerts") || exit 1
        results+=("$res")
      done <<< "$repos"

      if [ ${#results[@]} -eq 0 ]; then
        printf '{"actionable":[],"skipped":[],"skipped_repos":[]}\n'
      else
        printf '%s\n' "${results[@]}" | combine_results | jq '. + {skipped_repos: []}'
      fi
    else
      agg_err=$(cat "$ERR_FILE")
      case "$agg_err" in
        *"403"*)
          # No org-level security visibility (security manager or admin
          # required). Fall back to per-repo enumeration of repos the
          # authenticated user can access, applying push-access filtering.
          fan_out "orgs/$TARGET/repos?per_page=100"
          ;;
        *)
          printf '{"error":"Failed to fetch org alerts for %s: %s"}\n' "$TARGET" "$agg_err" >&2
          exit 1
          ;;
      esac
    fi
    ;;

  user)
    # No aggregate endpoint exists for user scope. /user/repos only ever lists
    # the authenticated user's own repos, so an explicit login must match the
    # active gh session; scanning another user's repos needs org scope or a
    # session for that user.
    if [ -n "$TARGET" ]; then
      login=$(gh api user --jq '.login' 2>"$ERR_FILE") || {
        printf '{"error":"Failed to resolve the authenticated user: %s"}\n' "$(cat "$ERR_FILE")" >&2
        exit 1
      }
      if [ "$TARGET" != "$login" ]; then
        printf '{"error":"User scope only supports the authenticated user (%s); requested %s"}\n' \
          "$login" "$TARGET" >&2
        exit 1
      fi
    fi
    fan_out "user/repos?type=owner&per_page=100"
    ;;
esac
