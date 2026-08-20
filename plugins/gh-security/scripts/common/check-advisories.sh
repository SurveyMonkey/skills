#!/usr/bin/env bash
# check-advisories.sh — every published advisory range for one package
#
# Usage:
#   check-advisories.sh [--ecosystem <eco>] [--adapter <path> --version <v>] <package>
#
# Output:
#   {package, ecosystem, advisory_count, withdrawn_excluded, vulnerable_ranges[],
#    advisories[], version, verdict, matched_ranges[], unevaluated_ranges[]}
#
# The pin audit's source of truth for whether a pinned package is still
# dangerous (RFC 001 Phase 4). It unions the vulnerable ranges of **every
# published advisory** for the package, not just the advisory that prompted the
# pin, and not the repository's own alert history.
#
# That distinction is the whole point of this script. A pin keeps vulnerable
# versions out of the lockfile, so advisories published *after* the pin never
# matched an installed version and never surfaced as a Dependabot alert on the
# repository. Judging removability from repo alert history therefore asks "was
# anything reported while we were protected?", whose answer is no by
# construction, and removing the pin on that answer reintroduces exactly what
# was published in the interim.
#
# With --adapter and --version, each range is evaluated against a candidate
# version through the adapter's `range_facts` verb, because what a range admits
# is an ecosystem question (semver here, PEP 440 in Phase 6) and range
# semantics stay behind the adapter contract (ADR 001).
#
# Verdicts, and why there are four:
#   vulnerable    — at least one advisory range admits the version
#   safe          — advisories exist, every range was evaluated, none matched
#   unknown       — no range matched, but at least one could not be evaluated;
#                   never reported as safe, since the unevaluated range is
#                   exactly where an unnoticed match would hide
#   no-advisories — the query succeeded and returned nothing for this package.
#                   NOT a synonym for safe: a pin may exist for a
#                   non-security reason, and a misspelled package name or the
#                   wrong ecosystem produces this same empty answer.
#
# Targets bash 3.2; depends only on bash, jq, gh.

set -euo pipefail

ECOSYSTEM="npm"
ADAPTER=""
VERSION=""

usage() {
  printf '{"error":"Usage: check-advisories.sh [--ecosystem <eco>] [--adapter <path> --version <v>] <package>"}\n' >&2
  exit 1
}

die() {
  printf '{"error":%s}\n' "$(printf '%s' "$1" | jq -Rs .)" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ecosystem) ECOSYSTEM="${2:-}"; [ -n "$ECOSYSTEM" ] || usage; shift 2 ;;
    --adapter)   ADAPTER="${2:-}";   [ -n "$ADAPTER" ]   || usage; shift 2 ;;
    --version)   VERSION="${2:-}";   [ -n "$VERSION" ]   || usage; shift 2 ;;
    --) shift; break ;;
    -*) usage ;;
    *)  break ;;
  esac
done

PACKAGE="${1:-}"
[ -n "$PACKAGE" ] || usage

# Half a pair is a usage error, not a silently degraded run: a caller that
# passed a version and expected a verdict must not receive a listing that looks
# like one.
if [ -n "$VERSION" ] && [ -z "$ADAPTER" ]; then
  die "check-advisories.sh: --version requires --adapter; range semantics are the adapter's (ADR 001)."
fi
if [ -n "$ADAPTER" ] && [ -z "$VERSION" ]; then
  die "check-advisories.sh: --adapter requires --version; there is nothing to evaluate the ranges against."
fi
if [ -n "$ADAPTER" ] && [ ! -x "$ADAPTER" ]; then
  die "check-advisories.sh: adapter is not executable: $ADAPTER"
fi

ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

# `affects` matches the package name; the ecosystem narrows it, since the same
# name exists in more than one registry. --slurp yields one array per page.
RAW=$(gh api \
  "advisories?affects=$PACKAGE&ecosystem=$ECOSYSTEM&per_page=100" \
  --paginate --slurp 2>"$ERR_FILE") || {
  die "Failed to fetch advisories for $PACKAGE ($ECOSYSTEM): $(cat "$ERR_FILE")"
}

if ! printf '%s' "$RAW" | jq -e 'type == "array"' >/dev/null 2>&1; then
  msg=$(printf '%s' "$RAW" | jq -r '.message // "response is not a JSON array"' 2>/dev/null \
    || printf 'response is not JSON')
  die "Unexpected advisories response for $PACKAGE: $msg"
fi

# `affects` is a filter on the advisory, so an advisory reached by this query
# still carries vulnerability entries for other packages. Match the name
# exactly, and drop withdrawn advisories: a withdrawn advisory is one GitHub
# has retracted, and holding a pin in place for it is holding it for nothing.
FILTERED=$(printf '%s' "$RAW" | jq \
  --arg pkg "$PACKAGE" --arg eco "$ECOSYSTEM" '
  flatten
  | map(select((.vulnerabilities // [])
               | map(.package.name == $pkg and .package.ecosystem == $eco)
               | any)) as $all
  | {
      withdrawn_excluded: ([$all[] | select(.withdrawn_at != null)] | length),
      advisories: [
        $all[]
        | select(.withdrawn_at == null)
        | . as $a
        | (.vulnerabilities // [])[]
        | select(.package.name == $pkg and .package.ecosystem == $eco)
        | {
            ghsa_id: $a.ghsa_id,
            cve_id: $a.cve_id,
            severity: $a.severity,
            type: $a.type,
            published_at: $a.published_at,
            summary: $a.summary,
            url: $a.html_url,
            vulnerable_version_range: .vulnerable_version_range,
            first_patched_version: (
              if (.first_patched_version | type) == "object"
              then .first_patched_version.identifier
              else .first_patched_version end
            )
          }
      ]
    }
  | . + {vulnerable_ranges: ([.advisories[].vulnerable_version_range
                              | select(. != null)] | unique)}
' 2>"$ERR_FILE") || die "Failed to parse advisories for $PACKAGE: $(cat "$ERR_FILE")"

MATCHED=""
UNEVALUATED=""
if [ -n "$VERSION" ]; then
  while IFS= read -r range; do
    [ -n "$range" ] || continue
    facts=$("$ADAPTER" range_facts "$range" "$VERSION" 2>/dev/null) || facts=""
    # An adapter that answers nothing has answered nothing. jq on empty input
    # emits nothing rather than failing, so an unchecked reply would skip both
    # branches below and leave the range silently uncounted (ADR 001).
    if [ -z "$facts" ] || ! printf '%s' "$facts" | jq -e 'type == "object"' >/dev/null 2>&1; then
      UNEVALUATED="$UNEVALUATED$range
"
      continue
    fi
    if ! printf '%s' "$facts" | jq -e 'has("parseable") and has("satisfied")' >/dev/null 2>&1; then
      die "check-advisories.sh: adapter's range_facts omitted parseable/satisfied for '$range'; the contract requires both (ADR 001)."
    fi
    if [ "$(printf '%s' "$facts" | jq -r '.parseable')" != "true" ]; then
      UNEVALUATED="$UNEVALUATED$range
"
    elif [ "$(printf '%s' "$facts" | jq -r '.satisfied')" = "true" ]; then
      MATCHED="$MATCHED$range
"
    fi
  done <<EOF
$(printf '%s' "$FILTERED" | jq -r '.vulnerable_ranges[]')
EOF
fi

printf '%s' "$FILTERED" | jq \
  --arg pkg "$PACKAGE" --arg eco "$ECOSYSTEM" --arg version "$VERSION" \
  --argjson matched "$(printf '%s' "$MATCHED" | jq -Rs 'split("\n") | map(select(length > 0)) | unique')" \
  --argjson unevaluated "$(printf '%s' "$UNEVALUATED" | jq -Rs 'split("\n") | map(select(length > 0)) | unique')" '
  {
    package: $pkg,
    ecosystem: $eco,
    advisory_count: (.advisories | length),
    withdrawn_excluded: .withdrawn_excluded,
    vulnerable_ranges: .vulnerable_ranges,
    advisories: .advisories,
    version: (if $version == "" then null else $version end),
    matched_ranges: $matched,
    unevaluated_ranges: $unevaluated,
    verdict: (
      if   (.advisories | length) == 0        then "no-advisories"
      elif $version == ""                     then null
      elif ($matched | length) > 0            then "vulnerable"
      elif ($unevaluated | length) > 0        then "unknown"
      else "safe" end
    )
  }'
