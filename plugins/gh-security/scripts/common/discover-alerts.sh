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
#         (the authenticated user's own repos) and fans out per repo inside
#         this script.
#
# At org and user scope — including the org aggregate path, not only the
# fallback — each candidate repo's push permission is checked, and forks are
# excluded (archived repos too, on the fallback path; the aggregate response
# cannot name one, see the org-scope 403 handling below). None of these are
# ever dispatched; each is recorded in the top-level `skipped_repos` array by
# name and reason so the caller can report it, never silently dropped (RFC
# 001, "it must never be silent"; issue #43 for fork/archived). Org alert
# visibility (security manager) and per-repo push access are separate grants,
# so a repo the aggregate endpoint reports on is not necessarily one this user
# can push to. `skipped_repos` is always present, and empty only at repo
# scope.
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
#                 access, for being a fork or archived, or because their
#                 alerts could not be fetched
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
      # The comparison is checked rather than tested inline. Inside
      # `if [ "$(...)" = "1" ]` a non-zero adapter exit is invisible to
      # `set -e`, and an `{"error":...}` reply reduces through `.result` to the
      # string `null`, which reads as "not higher": a failed comparison would
      # silently pick the wrong highest_fixed_version (issue #39). Absent and
      # untyped are both errors here, per the adapter contract in
      # scripts/CLAUDE.md.
      cmp_json=$("$adapter" compare_versions "$candidate" "$best" 2>"$ERR_FILE") || {
        printf '{"error":"compare_versions failed for %s (%s vs %s): %s"}\n' \
          "$eco" "$candidate" "$best" "$(cat "$ERR_FILE")" >&2
        exit 1
      }
      cmp=$(printf '%s' "$cmp_json" | jq -r '
        if type == "object" and has("result") and (.result | type) == "number"
        then (.result | tostring) else "invalid" end' 2>/dev/null || printf 'invalid')
      case "$cmp" in
        1)     best="$candidate" ;;
        0|-1)  ;;
        *)
          printf '{"error":"compare_versions returned no usable result for %s (%s vs %s): %s"}\n' \
            "$eco" "$candidate" "$best" "$cmp_json" >&2
          exit 1
          ;;
      esac
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

# The API's own message out of a failed `gh api` invocation. gh formats an
# error as `gh: <message> (HTTP <code>)`, where `<message>` is the response
# body's `.message` when the body is JSON; anything it cannot parse is relayed
# unchanged, so the fallback is the text itself. Classification reads this
# rather than gh's whole formatted line, so neither the `gh:` prefix nor the
# status code can match a content pattern.
api_error_message() {
  printf '%s\n' "$1" | sed -e 's/^gh: //' -e 's/ (HTTP [0-9][0-9]*)[[:space:]]*$//'
}

# The HTTP status gh reported, or empty when it reported none.
http_status_of() {
  printf '%s\n' "$1" | sed -n 's/.*(HTTP \([0-9][0-9]*\)).*/\1/p' | tail -1
}

# Word-boundary match of an ERE alternation (lowercase) against a message.
#
# Free substring matching misfires in both directions: an ordinary
# permission-shaped 403 naming an org like `tessso-corp` contains `sso` and was
# hard-failing as an SSO block instead of falling back (issue #39). The
# boundaries are spelled with POSIX classes rather than `\b`, which BSD ERE
# does not support.
err_mentions() {
  printf '%s\n' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | grep -Eq "(^|[^a-z0-9])($2)([^a-z0-9]|\$)"
}

# Classify a JSON payload against the "array of alerts" contract without
# exiting, so a caller that must hard-stop (a top-level scope) and a caller
# that must record a per-repo skip and continue (the fan-out) can share one
# classification instead of the fan-out re-deriving a weaker check that
# discards the API's own `.message`.
#
# Exit status: 0 clean array (nothing printed), 2 not valid JSON at all
# (nothing printed; there is no `.message` to read from non-JSON), 3 valid
# JSON but not an array (the API's own `.message`, when present, printed on
# stdout).
classify_alerts_json() {
  json="$1"
  if ! printf '%s' "$json" | jq empty 2>/dev/null; then
    return 2
  fi
  if ! printf '%s' "$json" | jq -e 'type == "array"' >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r '.message // "Response is not a JSON array"' 2>/dev/null
    return 3
  fi
  return 0
}

# Fail loudly on anything that is not a JSON array of alerts: an empty array is
# a legitimate "no alerts" answer, but a JSON error object or non-JSON body
# must never be silently treated as zero alerts.
validate_alerts_json() {
  label="$1"
  json="$2"

  msg=$(classify_alerts_json "$json") && return 0
  status=$?
  if [ "$status" -eq 2 ]; then
    printf '{"error":"Invalid JSON response for %s"}\n' "$label" >&2
  else
    printf '{"error":"Unexpected API response for %s: %s"}\n' "$label" "$msg" >&2
  fi
  exit 1
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
      # The failure check is explicit, never left to `set -e`: this whole
      # function runs inside `res=$(group_repo_alerts ...) || exit 1` at its
      # call sites, and bash suppresses errexit throughout the left side of
      # `||`, so a compare_versions failure inside highest_version was
      # swallowed and discovery reported success under the bash the shebang
      # actually invokes. The suite only saw the correct refusal because
      # /bin/sh (POSIX mode) propagates the failure where bash does not
      # (issue #58); CI's bash leg is what caught it.
      highest=$(printf '%s\n' "$versions" | highest_version "$ecosystem") || exit 1
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

# Fetch and validate a `gh api` repo listing (org repos or the authenticated
# user's repos), reducing every row to the three fields the callers need.
#
# `push_status` distinguishes a genuine denial ("false") from a row that
# carries no usable `push` boolean ("unknown"): `// false` alone collapses both
# to the same reason, misattributing an absent-data case as a denial (the same
# absent-vs-false trap documented in scripts/CLAUDE.md for
# score-merge-risk.sh). An explicit `"push": null` is absent data too, so the
# test is on the value's *type*, not on the key being present (issue #40).
repo_listing_rows() {
  api_path="$1"

  list=$(gh api "$api_path" --paginate --slurp 2>"$ERR_FILE") || {
    printf '{"error":"Failed to list repos via %s: %s"}\n' "$api_path" "$(cat "$ERR_FILE")" >&2
    exit 1
  }
  printf '%s' "$list" | jq empty 2>/dev/null || {
    printf '{"error":"Invalid JSON response listing repos via %s"}\n' "$api_path" >&2
    exit 1
  }
  printf '%s' "$list" | jq -e 'type == "array"' >/dev/null 2>&1 || {
    msg=$(printf '%s' "$list" | jq -r '.message // "Response is not a JSON array"' 2>/dev/null)
    printf '{"error":"Unexpected repo listing response via %s: %s"}\n' "$api_path" "$msg" >&2
    exit 1
  }

  printf '%s' "$list" | jq -c '
    flatten
    | map({
        full_name,
        fork: (.fork // false),
        archived: (.archived // false),
        push_status: (
          if ((.permissions | type) == "object")
             and ((.permissions.push | type) == "boolean")
          then (if .permissions.push then "true" else "false" end)
          else "unknown"
          end
        )
      })
  ' 2>"$ERR_FILE" || {
    printf '{"error":"Failed to process repo listing via %s: %s"}\n' "$api_path" "$(cat "$ERR_FILE")" >&2
    exit 1
  }
}

# One `skipped_repos` entry for a repo excluded on push grounds. Shared so the
# aggregate path and the fan-out cannot drift on the reason strings a caller
# reports.
push_skip_entry() {
  case "$2" in
    false)
      jq -n --arg repo "$1" --arg reason "no push access" \
        '{repo: $repo, reason: $reason}'
      ;;
    *)
      jq -n --arg repo "$1" \
        --arg reason "permission data missing from API response" \
        '{repo: $repo, reason: $reason}'
      ;;
  esac
}

# One `skipped_repos` entry for a repo excluded on a repo-attribute ground
# (fork, archived). Same shape as `push_skip_entry`, shared so the aggregate
# path and the fan-out cannot drift on the reason strings either (issue #43).
attribute_skip_entry() {
  jq -n --arg repo "$1" --arg reason "$2" '{repo: $repo, reason: $reason}'
}

# Assemble a cross-repo result: per-repo {actionable, skipped} blobs on stdin,
# one per line, `skipped_repos` JSON as $1.
emit_combined() {
  blobs=$(cat)
  if [ -n "$blobs" ]; then
    combined=$(printf '%s\n' "$blobs" | combine_results)
  else
    combined='{"actionable":[],"skipped":[]}'
  fi
  printf '%s' "$combined" | jq --argjson sr "$1" '. + {skipped_repos: $sr}'
}

# Fetch, validate, group, and combine alerts across every repo listed by a
# `gh api` listing endpoint (org repos or the authenticated user's repos).
# Forks and archived repos are never dispatch targets, and repos without push
# access are never dispatch targets either; all three are recorded in
# `skipped_repos` with an explicit reason, never dropped silently, per the
# RFC's "must never be silent" requirement (issue #43 for fork/archived,
# issue #38 for push access).
fan_out() {
  api_path="$1"

  CANDIDATES=$(repo_listing_rows "$api_path")

  results=()
  skipped_repos=()

  rows=$(printf '%s' "$CANDIDATES" | jq -c '.[]')
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    full_name=$(printf '%s' "$row" | jq -r '.full_name')
    is_fork=$(printf '%s' "$row" | jq -r '.fork')
    is_archived=$(printf '%s' "$row" | jq -r '.archived')
    push_status=$(printf '%s' "$row" | jq -r '.push_status')

    if [ "$is_fork" = "true" ]; then
      skipped_repos+=("$(attribute_skip_entry "$full_name" "fork repository")")
      continue
    fi
    if [ "$is_archived" = "true" ]; then
      skipped_repos+=("$(attribute_skip_entry "$full_name" "archived repository")")
      continue
    fi

    if [ "$push_status" != "true" ]; then
      skipped_repos+=("$(push_skip_entry "$full_name" "$push_status")")
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

    if problem_msg=$(classify_alerts_json "$repo_alerts"); then
      res=$(group_repo_alerts "$full_name" "$repo_alerts") || exit 1
      results+=("$res")
    else
      classify_status=$?
      if [ "$classify_status" -eq 2 ]; then
        detail="invalid JSON in alert response"
      else
        detail="$problem_msg"
      fi
      skipped_repos+=("$(jq -n --arg repo "$full_name" --arg reason "invalid alert response" \
        --arg err "$detail" '{repo: $repo, reason: $reason, error: $err}')")
    fi
  done <<< "$rows"

  skipped_repos_json="[]"
  if [ ${#skipped_repos[@]} -gt 0 ]; then
    skipped_repos_json=$(printf '%s\n' "${skipped_repos[@]}" | jq -s '.')
  fi

  if [ ${#results[@]} -eq 0 ]; then
    emit_combined "$skipped_repos_json" < /dev/null
  else
    printf '%s\n' "${results[@]}" | emit_combined "$skipped_repos_json"
  fi
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

      # Push filtering applies here too, not only on the fallback path. Org
      # alert visibility and per-repo push access are separate grants, so a
      # security manager sees alerts for repos they cannot push to, and
      # dispatching one of those fails only at the fix agent's `git push` —
      # after a clone, a worktree, an install and a verification run.
      #
      # The cost is one extra API call: the aggregate response carries no
      # permission data, so the org repo listing is fetched purely to compute
      # `push_status`. Correctness over call count; the listing is paginated
      # at 100/page and reused for every repo in the response.
      repos=$(printf '%s' "$FLAT" | jq -r '[.[].repository.full_name] | unique | .[]')

      PERMS='{}'
      FORKS='{}'
      if [ -n "$repos" ]; then
        LISTING=$(repo_listing_rows "orgs/$TARGET/repos?per_page=100")
        PERMS=$(printf '%s' "$LISTING" | jq -c 'map({key: .full_name, value: .push_status}) | from_entries')
        FORKS=$(printf '%s' "$LISTING" | jq -c 'map({key: .full_name, value: .fork}) | from_entries')
      fi

      results=()
      skipped_repos=()
      while IFS= read -r r; do
        [ -n "$r" ] || continue
        # A fork with its own open alerts still reaches this loop: the
        # aggregate's candidate set is "repos with alerts", not the org
        # listing, so the fan-out's enumeration-time fork exclusion does not
        # apply here on its own. Skip it the same way, visibly, so the same
        # repo gets the same treatment regardless of which path discovered it
        # (issue #43) rather than silently riding into `actionable`.
        is_fork=$(printf '%s' "$FORKS" | jq -r --arg r "$r" '.[$r] // false')
        if [ "$is_fork" = "true" ]; then
          skipped_repos+=("$(attribute_skip_entry "$r" "fork repository")")
          continue
        fi
        # No equivalent archived check belongs here: GitHub refuses Dependabot
        # alerts for archived repositories outright, verified live against
        # arsenalamerica/source (the org's only archived repo) —
        # `gh api repos/arsenalamerica/source/dependabot/alerts?state=open`
        # returns HTTP 403 "Dependabot alerts are not available for archived
        # repositories" — so the aggregate response can never name one
        # (issue #43).
        #
        # A repo the aggregate reports on but the listing does not name has no
        # permission data at all, which is the "unknown" case, not a denial.
        push_status=$(printf '%s' "$PERMS" | jq -r --arg r "$r" '.[$r] // "unknown"')
        if [ "$push_status" != "true" ]; then
          skipped_repos+=("$(push_skip_entry "$r" "$push_status")")
          continue
        fi
        repo_alerts=$(printf '%s' "$FLAT" | jq -c --arg r "$r" \
          '[.[] | select(.repository.full_name == $r)]')
        res=$(group_repo_alerts "$r" "$repo_alerts") || exit 1
        results+=("$res")
      done <<< "$repos"

      skipped_repos_json="[]"
      if [ ${#skipped_repos[@]} -gt 0 ]; then
        skipped_repos_json=$(printf '%s\n' "${skipped_repos[@]}" | jq -s '.')
      fi

      if [ ${#results[@]} -eq 0 ]; then
        emit_combined "$skipped_repos_json" < /dev/null
      else
        printf '%s\n' "${results[@]}" | emit_combined "$skipped_repos_json"
      fi
    else
      agg_err=$(cat "$ERR_FILE")
      # A bare `403` is not proof of "no org-level security visibility": a rate
      # limit, a SAML/SSO enforcement block and an IP allow list all surface as
      # 403s too, and silently reinterpreting any of them as the permission
      # case fans out to per-repo calls that mostly also fail, or succeed
      # against a partial repo set, and come back looking like a clean, wrong
      # answer. All three are checked, and hard-fail, before the
      # permission-shaped fallback.
      agg_msg=$(api_error_message "$agg_err")
      # Bare `sso`, `saml` and `abuse` all collide with a hyphen-delimited org
      # name segment (`sso-analytics`, `abuse-tools`), since a hyphen is a
      # non-alphanumeric word boundary just like the space `err_mentions`
      # anchors on (issue #43). The fix is to require a multi-word phrase that
      # GitHub's own message text actually uses, which cannot appear as a bare
      # org-name segment. Each phrase below is checked against GitHub's real
      # 403 wording, not guessed:
      #   - "rate limit" — "API rate limit exceeded ..." (primary) and "You
      #     have exceeded a secondary rate limit ..." (secondary) both use it;
      #     already multi-word, unchanged from before this fix.
      #   - "abuse detection" — "You have triggered an abuse detection
      #     mechanism ..." is GitHub's actual abuse-block wording; the
      #     previous bare "abuse" is the riskiest bare keyword the issue
      #     flagged, since "abuse" is a plausible org-name segment.
      #   - "saml enforcement" / "sso enforcement" — "Resource protected by
      #     organization SAML enforcement ..." / "... SSO enforcement ..." are
      #     GitHub's actual messages; the previous bare "saml"/"sso" are
      #     dropped. "single sign-on" / "single sign on" are kept as
      #     already-safe multi-word phrases for the same block.
      #   - "ip allow list" was already multi-word and unchanged: GitHub's
      #     message reads "... has an IP allow list enabled ...".
      if err_mentions "$agg_msg" 'rate limit|abuse detection'; then
        printf '{"error":"Org alert aggregate call for %s was rate-limited: %s"}\n' \
          "$TARGET" "$agg_err" >&2
        exit 1
      elif err_mentions "$agg_msg" 'saml enforcement|sso enforcement|single sign-on|single sign on'; then
        printf '{"error":"Org alert aggregate call for %s blocked by SAML/SSO enforcement: %s"}\n' \
          "$TARGET" "$agg_err" >&2
        exit 1
      elif err_mentions "$agg_msg" 'ip allow list|ip allowlist'; then
        # An IP allow list blocks the credential, not this endpoint: every
        # per-repo call in the fallback is refused for the same reason, so
        # falling back would bury one clear cause under a pile of generic
        # `alert fetch failed` entries. Hard-fail and name it, which is also
        # the only outcome the user can act on (allow the address, or run
        # from a permitted network).
        printf '{"error":"Org alert aggregate call for %s blocked by an IP allow list: %s"}\n' \
          "$TARGET" "$agg_err" >&2
        exit 1
      elif [ "$(http_status_of "$agg_err")" = "403" ]; then
        # No org-level security visibility (security manager or admin
        # required). Fall back to per-repo enumeration of repos the
        # authenticated user can access, applying push-access filtering.
        fan_out "orgs/$TARGET/repos?per_page=100"
      else
        printf '{"error":"Failed to fetch org alerts for %s: %s"}\n' "$TARGET" "$agg_err" >&2
        exit 1
      fi
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
