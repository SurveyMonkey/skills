#!/usr/bin/env bash
# discover-alerts.sh — Fetch and rank open Dependabot alerts by package
# Usage: discover-alerts.sh <owner/repo>
# Output: JSON with two arrays:
#   actionable: groups with a fix available and no open PR (sorted by severity then EPSS)
#   skipped:    groups excluded (no fix or PR already open), with reason
#
# Each group:
#   { package, ecosystem, max_severity, max_epss_percentile, alert_count,
#     highest_fixed_version, branch_name, alerts: [{ number, cve, ghsa,
#     severity, summary, vulnerable_range, fixed_in, epss_percentile,
#     relationship, manifest }] }
# Skipped groups also include: { reason, open_pr_url?, error? }

set -euo pipefail

REPO="${1:?Usage: discover-alerts.sh <owner/repo>}"

# Single source of truth for branch naming
branch_name() {
  printf 'fix/dependabot-%s' "$1"
}

ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

ALERTS=$(gh api "repos/$REPO/dependabot/alerts?state=open&per_page=100" \
  --paginate --slurp 2>"$ERR_FILE") || {
  printf '{"error":"Failed to fetch alerts for %s: %s"}\n' "$REPO" "$(cat "$ERR_FILE")" >&2
  exit 1
}

if ! printf '%s' "$ALERTS" | jq empty 2>/dev/null; then
  printf '{"error":"Invalid JSON response for %s"}\n' "$REPO" >&2
  exit 1
fi

if ! printf '%s' "$ALERTS" | jq -e 'type == "array"' >/dev/null 2>&1; then
  msg=$(printf '%s' "$ALERTS" | jq -r '.message // "Response is not a JSON array"' 2>/dev/null)
  printf '{"error":"Unexpected API response for %s: %s"}\n' "$REPO" "$msg" >&2
  exit 1
fi

GROUPED=$(printf '%s' "$ALERTS" | jq '
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

    group_by(.dependency.package.name) |
    map({
      package: .[0].dependency.package.name,
      ecosystem: .[0].dependency.package.ecosystem,
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
      fixed_versions: [
        .[].security_vulnerability.first_patched_version.identifier //
        empty
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
    sort_by([(.max_severity | sev_rank), -(.max_epss_percentile)])
  end
' 2>"$ERR_FILE") || {
  printf '{"error":"Failed to group alerts: %s"}\n' "$(cat "$ERR_FILE")" >&2
  exit 1
}

if [ "$(printf '%s' "$GROUPED" | jq 'length')" -eq 0 ]; then
  printf '{"actionable":[],"skipped":[]}\n'
  exit 0
fi

ACTIONABLE=()
SKIPPED=()

ITEMS=$(printf '%s' "$GROUPED" | jq -c '.[]' 2>"$ERR_FILE") || {
  printf '{"error":"Failed to iterate alert groups: %s"}\n' "$(cat "$ERR_FILE")" >&2
  exit 1
}

while IFS= read -r group; do
  pkg=$(printf '%s' "$group" | jq -r '.package')

  versions=$(printf '%s' "$group" | jq -r '.fixed_versions[]')
  if [ -n "$versions" ]; then
    highest=$(printf '%s\n' "$versions" | jq -Rn \
      '[inputs | split(".") | map(tonumber? // 0)] | sort | last | map(tostring) | join(".")')
  else
    highest="none"
  fi
  branch=$(branch_name "$pkg")
  enriched=$(printf '%s' "$group" | jq -c \
    --arg hv "$highest" --arg br "$branch" \
    '. + {highest_fixed_version: $hv, branch_name: $br} | del(.fixed_versions)')

  # Skip if no fix available
  if [ "$highest" = "none" ]; then
    SKIPPED+=("$(printf '%s' "$enriched" | jq -c '. + {reason: "no fix available"}')")
    continue
  fi

  # Skip if an open PR already exists for this package
  pr_check_err=$(mktemp)
  if pr_url=$(gh pr list --repo "$REPO" \
    --search "head:${branch}" \
    --state open --json url --jq '.[0].url // empty' 2>"$pr_check_err"); then
    rm -f "$pr_check_err"
    if [ -n "$pr_url" ]; then
      SKIPPED+=("$(printf '%s' "$enriched" | jq -c --arg url "$pr_url" \
        '. + {reason: "open PR exists", open_pr_url: $url}')")
      continue
    fi
  else
    pr_err=$(cat "$pr_check_err")
    rm -f "$pr_check_err"
    SKIPPED+=("$(printf '%s' "$enriched" | jq -c --arg err "$pr_err" \
      '. + {reason: "PR check failed", error: $err}')")
    continue
  fi

  ACTIONABLE+=("$enriched")
done <<< "$ITEMS"

# Combine into final output
actionable_json=$(if [ ${#ACTIONABLE[@]} -eq 0 ]; then printf '[]\n'; else printf '%s\n' "${ACTIONABLE[@]}" | jq -s '.'; fi)
skipped_json=$(if [ ${#SKIPPED[@]} -eq 0 ]; then printf '[]\n'; else printf '%s\n' "${SKIPPED[@]}" | jq -s '.'; fi)
printf '%s\n%s\n' "$actionable_json" "$skipped_json" | jq -s '{actionable: .[0], skipped: .[1]}' || {
  printf '{"error":"Internal error: failed to assemble output JSON"}\n' >&2
  exit 1
}
