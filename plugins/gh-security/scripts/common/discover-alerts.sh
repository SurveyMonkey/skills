#!/usr/bin/env bash
# discover-alerts.sh: fetch and rank open Dependabot alerts by package major line
#
# Usage:
#   discover-alerts.sh [--branch-style slash|flat] <owner/repo>
#
# One repository per invocation. The repositories in scope are the checkouts
# already on disk, and `discover-repos.sh` is what names them; this script is
# run once per checkout, against the `owner/repo` that checkout's remote
# resolves to.
#
# --branch-style selects the branch naming scheme every emitted `branch_name`
# uses: `slash` (the default, `fix/dependabot-<pkg>-<line>x`) or `flat`
# (`fix-dependabot-<pkg>-<line>x`). Git refs are a filesystem namespace, so a
# remote with a pre-existing branch literally named `fix` (`refs/heads/fix`)
# rejects every `fix/*` push with `(directory file conflict)` — discovered on
# a field run only after each fix agent had finished all of its work (issue
# #123). The caller probes the remote (`git ls-remote --heads origin
# refs/heads/fix`, resolve-alerts SKILL.md) and passes `flat` when the slash
# namespace is blocked; this script applies the scheme, it never probes. The
# namespace is a per-repo fact, and the caller runs discovery once per
# checkout and passes that checkout's own style.
#
# Alerts come from GET /repos/{owner}/{repo}/dependabot/alerts (paginated).
#
# Output: JSON with two top-level keys:
#   actionable:   groups with a fix available and no open PR (sorted by
#                 severity then EPSS; package and then major line break
#                 remaining ties — `repo` is constant, one repository per
#                 invocation)
#   skipped:      groups excluded (no fix, PR already open, or unsupported
#                 ecosystem), with reason
#
# Each group:
#   { repo, package, ecosystem, major_line, max_severity, max_epss_percentile,
#     alert_count, highest_fixed_version, branch_name, alerts: [{ number, cve,
#     ghsa, severity, summary, vulnerable_range, fixed_in, epss_percentile,
#     relationship, manifest }],
#     sibling_alerts: [{ major, vulnerable_ranges[] }] }
# Skipped groups also include: { reason, open_pr_url?, error? }
#
# `sibling_alerts` describes every OTHER group of the same package in the same
# repo, skipped groups included (a no-fix-available line still carries open
# alerts): its major as a number, or null for a "none" line, and the unique
# vulnerable ranges of its alerts. It is what the fix agent hands the
# adapter's `validate --sibling-alerts`, which classifies a within-major dedup
# move as benign only when the moved line provably carries no open alerts
# (issue #105). `[]` is a positive claim: no other line of this package has
# open alerts.
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

BRANCH_STYLE="slash"
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --branch-style)
      BRANCH_STYLE="${2:?--branch-style requires a value}"
      shift 2
      ;;
    --branch-style=*)
      BRANCH_STYLE="${1#--branch-style=}"
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

case "$BRANCH_STYLE" in
  slash|flat) ;;
  *)
    printf '{"error":"Unknown branch style: %s (expected slash or flat)"}\n' "$BRANCH_STYLE" >&2
    exit 1
    ;;
esac

if [ -z "$TARGET" ]; then
  printf '{"error":"Usage: discover-alerts.sh [--branch-style slash|flat] <owner/repo>"}\n' >&2
  exit 1
fi

ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

# Single source of truth for branch naming. The line suffix is what keeps two
# groups for the same package from colliding on one branch; it is applied to
# every group, including single-line packages, so a package that grows a second
# line later does not rename the branch it already had.
#
# Two spellings of the same name, selected by --branch-style (header comment).
# The orchestrator passes the style to this script directly, so the names come
# out in the right scheme to begin with. classify-lines.sh keeps a
# --branch-style of its own for a caller that learns the namespace verdict
# only after discovery has run, and that conversion needs no re-derivation
# because the two spellings differ only in the first separator.
slash_branch_name() {
  case "$2" in
    none) printf 'fix/dependabot-%s-unfixed' "$1" ;;
    *)    printf 'fix/dependabot-%s-%sx' "$1" "$2" ;;
  esac
}

flat_branch_name() {
  case "$2" in
    none) printf 'fix-dependabot-%s-unfixed' "$1" ;;
    *)    printf 'fix-dependabot-%s-%sx' "$1" "$2" ;;
  esac
}

branch_name() {
  if [ "$BRANCH_STYLE" = "flat" ]; then
    flat_branch_name "$@"
  else
    slash_branch_name "$@"
  fi
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

# Fail loudly on anything that is not the array `gh api --paginate --slurp`
# produces: one entry per response page, each of them an array of alerts. An
# empty array is a legitimate "no alerts" answer, but a JSON error object or
# non-JSON body must never be silently treated as zero alerts. The API's own
# `.message` is quoted when the body is JSON at all; a non-JSON body has none
# to read, so the two cases report differently.
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

# Group one repo's alerts into the actionable/skipped contract, tagging every
# group with `repo`. `alerts_json` arrives as `gh api --paginate --slurp` left
# it — an array of response pages, not a flat array of alerts — and the
# `flatten` opening the jq program below is what collapses that page nesting.
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
      # Every OTHER group of the same package in this repo, alerts and all,
      # built before any routing so lines later skipped still count: a
      # no-fix-available line still carries open alerts. A "none" line
      # contributes major: null; its ranges stay checkable. This is the whole
      # sibling knowledge validate --sibling-alerts needs, and [] genuinely
      # means "no other line of this package has open alerts" (issue #105).
      . as $all |
      map(. as $g
          | . + {sibling_alerts:
              [ $all[]
                | select(.package == $g.package
                         and .major_line != $g.major_line)
                | {major: (if .major_line == "none" then null
                           else (.major_line | tonumber) end),
                   vulnerable_ranges:
                     ([.alerts[].vulnerable_range] | unique)} ]}) |
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
      # function runs inside `RESULT=$(group_repo_alerts "$TARGET" "$ALERTS")
      # || exit 1` at its call site, and bash suppresses errexit throughout
      # the left side of `||`, so a compare_versions failure inside
      # highest_version was swallowed and discovery reported success under the
      # bash the shebang actually invokes. The suite only saw the correct
      # refusal because /bin/sh (POSIX mode) propagates the failure where bash
      # does not (issue #58); CI's bash leg is what caught it.
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
    # Under the slash style, also check the group's flat-scheme name: a repo
    # that once carried a branch named `fix` had its PRs opened flat (issue
    # #123), and deleting that branch later flips discovery back to slash while
    # such a PR can still be open. The reverse check is never made — while
    # `refs/heads/fix` exists (the flat style's precondition), the remote
    # cannot also hold any `fix/*` ref, so no slash-named PR can be open.
    # This candidate costs one extra `gh pr list --search` call (the Search
    # API, rate-limited to 30 req/min) per group on the default slash path.
    # That is accepted for correctness across a style flip: without it, a
    # group whose PR predates a since-deleted `fix` branch would be
    # rediscovered as unfixed and dispatched again. One edge stays
    # unreachable regardless: an open PR headed from a fork could coexist
    # under either style and go unseen by this check, since `head:` search
    # does not qualify the fork owner here — but this plugin never opens a
    # PR from a fork, so that PR, if it exists, was not opened by this tool.
    flat_twin=""
    if [ "$BRANCH_STYLE" = "slash" ]; then
      flat_twin=$(flat_branch_name "$pkg" "$line")
      pr_candidates+=("$flat_twin")
    fi
    # The legacy name predates per-line grouping and needs no flat twin: the
    # flat scheme shipped after the per-line split, so no flat branch without a
    # line suffix has ever been created by this plugin. It is itself a slash
    # name, so under the flat style it is skipped for the same reason the
    # slash candidate is — the remote cannot hold it.
    if [ "$newest_line" = "true" ] && [ "$BRANCH_STYLE" = "slash" ]; then
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
          # Name the other branch in the reason: the report should not imply
          # a PR exists on this line`s own branch when it does not.
          if [ "$candidate" != "$branch" ]; then
            if [ -n "$flat_twin" ] && [ "$candidate" = "$flat_twin" ]; then
              pr_reason="open PR exists (flat-scheme branch $candidate)"
            else
              pr_reason="open PR exists (legacy branch $candidate)"
            fi
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

ALERTS=$(gh api "repos/$TARGET/dependabot/alerts?state=open&per_page=100" \
  --paginate --slurp 2>"$ERR_FILE") || {
  printf '{"error":"Failed to fetch alerts for %s: %s"}\n' "$TARGET" "$(cat "$ERR_FILE")" >&2
  exit 1
}
validate_alerts_json "$TARGET" "$ALERTS"
RESULT=$(group_repo_alerts "$TARGET" "$ALERTS") || exit 1
# Both arms of group_repo_alerts arrive here: the early "no groups" literal
# and the jq-assembled report. Both leave through the same jq, so an empty
# answer and a populated one are formatted identically.
printf '%s\n' "$RESULT" | jq . || {
  printf '{"error":"Internal error: failed to format output JSON for %s"}\n' "$TARGET" >&2
  exit 1
}
