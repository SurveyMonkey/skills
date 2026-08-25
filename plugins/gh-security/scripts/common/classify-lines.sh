#!/usr/bin/env bash
# classify-lines.sh — reconcile each actionable group's major line with what
# the repository's lockfile actually resolves
#
# Usage:
#   ... | select-adapter.sh --from-discovery | classify-lines.sh --repo-root <path>
#
# Input:  the routed discovery JSON select-adapter.sh emits on stdout
#         ({actionable, skipped, ...}); actionable groups carry `adapter_path`.
# Output: the same envelope with every actionable group annotated, and groups
#         whose only possible fix crosses a major moved into `skipped`.
#
# Discovery groups an alert by the major of its *patched* version, which is
# where the fix lands, not where the repository is. When every resolved copy
# of the package sits below that line — path-to-regexp fixed only in 1.9.0
# while the lone copy resolves at 0.2.5, held there by a pre-existing override
# (issue #101) — no override bounded to the resolved major can reach the
# patched version, and validate's other-line check must reject the intended
# move itself. Dispatching such a group is approved doomed work; this stage
# classifies it before anyone approves anything.
#
# Per actionable group, two annotations:
#
#   resolved_majors — the unique majors of the package's resolved copies, as
#     strings, trimmed by the same rule as discovery's `line_of` (strip
#     whitespace and leading v/=, keep a plain nonnegative leading integer,
#     exclude anything else). jq's `unique` sorts them lexicographically as
#     strings: this is a set for membership and reporting, never an ordered
#     list — ordering versions stays behind the adapter (scripts/CLAUDE.md).
#
#   line_status —
#     "resolved"            some copy's major equals `major_line`
#     "requires_major_bump" the package is present, NO copy sits on the line,
#                           and EVERY copy is below it — per copy, the
#                           adapter's `compare_versions <v> <line>.0.0`
#                           answers `.result < 0`
#     "line_absent"         present, none on the line, at least one copy
#                           at-or-above it (the fix would no-op; stays
#                           actionable, annotated, for validate to settle)
#     "unknown"             the adapter call failed, its reply broke the
#                           contract, `present` is false, or `major_line` is
#                           "none"
#
# Routing: `requires_major_bump` groups MOVE from `actionable` to `skipped`
# with `reason: "requires major version bump"`, annotations kept, so the
# report can say "only 0.2.5 is installed; the fix line is 1.x". Everything
# else stays actionable — including "unknown", deliberately: dispatching an
# unknown is safe (validate fail-closes later), while withholding a fixable
# group on a broken read is the wrong direction.
#
# Contract discipline: an adapter reply missing a promised field, of the wrong
# type, or empty on exit 0 is a broken read, checked with `has()` rather than
# papered over with `// default` (scripts/CLAUDE.md). It classifies the group
# "unknown" — fail-closed for this stage, whose only unsafe act is *removing*
# a group from the queue. Hard `{"error": ...}` + non-zero exit is reserved
# for bad input to this script itself: a missing --repo-root, or stdin that is
# not the promised envelope.

set -euo pipefail

REPO_ROOT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-root) REPO_ROOT="${2:?--repo-root requires a value}"; shift 2 ;;
    *)
      printf '{"error":"Unknown argument: %s"}\n' "$1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$REPO_ROOT" ]; then
  printf '{"error":"Usage: classify-lines.sh --repo-root <path> < routed-discovery.json"}\n' >&2
  exit 1
fi
if [ ! -d "$REPO_ROOT" ]; then
  printf '{"error":"--repo-root is not a directory: %s"}\n' "$REPO_ROOT" >&2
  exit 1
fi

input=$(cat)
printf '%s' "$input" | jq empty 2>/dev/null || {
  printf '{"error":"classify-lines.sh expects routed discovery JSON on stdin"}\n' >&2
  exit 1
}

# The same trim rule as discover-alerts.sh's `line_of`, minus the "none"
# fallback: extraction only, never comparison. A version whose leading
# component is not a plain nonnegative integer contributes no major.
MAJOR_OF_JQ='
  def major_of:
    tostring
    | sub("^[[:space:]]+"; "") | sub("[[:space:]]+$"; "")
    | sub("^[v=]+"; "")
    | (split(".")[0] // "")
    | if test("^[0-9]+$") then . else null end;
'

# Wrapped like select-adapter.sh: valid JSON of the wrong shape
# (`"actionable":"oops"`) fails inside jq, and unwrapped that leaves raw jq
# noise where the contract requires a non-zero exit carrying {"error": ...}.
ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

GROUP_ITEMS=$(printf '%s' "$input" \
  | jq -c '(.actionable // []) | .[]' 2>"$ERR_FILE") || {
  printf '{"error":"Failed to read actionable groups: %s"}\n' "$(cat "$ERR_FILE")" >&2
  exit 1
}

# One resolved_versions call per unique (adapter_path, package), cached as a
# JSON array — bash 3.2 has no associative arrays, so jq carries the cache.
# `ok: false` records a failed or contract-breaking read; the classification
# below turns it into "unknown" per group.
PAIRS=$(printf '%s' "$input" | jq -r '
  (.actionable // [])
  | map({a: (.adapter_path // ""), p: (.package // "")})
  | map(select(.a != "" and .p != ""))
  | unique | .[] | [.a, .p] | @tsv' 2>"$ERR_FILE") || {
  printf '{"error":"Failed to read adapter routing from groups: %s"}\n' "$(cat "$ERR_FILE")" >&2
  exit 1
}

CACHE='[]'
if [ -n "$PAIRS" ]; then
  while IFS=$'\t' read -r adapter pkg; do
    [ -n "$adapter" ] || continue
    reply=""
    if reply=$( (cd "$REPO_ROOT" && "$adapter" resolved_versions "$pkg") 2>/dev/null ) \
       && [ -n "$reply" ]; then
      entry=$(printf '%s' "$reply" | jq -c --arg a "$adapter" --arg p "$pkg" "$MAJOR_OF_JQ"'
        if (type == "object"
            and has("present") and (.present | type == "boolean")
            and has("versions") and (.versions | type == "array")
            and (.versions | all(type == "object" and has("version"))))
        then {adapter: $a, package: $p, ok: true, present: .present,
              versions: [.versions[].version | tostring],
              majors: ([.versions[].version | major_of | select(. != null)] | unique)}
        else {adapter: $a, package: $p, ok: false}
        end' 2>/dev/null) \
        || entry=$(jq -nc --arg a "$adapter" --arg p "$pkg" \
             '{adapter: $a, package: $p, ok: false}')
    else
      entry=$(jq -nc --arg a "$adapter" --arg p "$pkg" \
        '{adapter: $a, package: $p, ok: false}')
    fi
    CACHE=$(printf '%s' "$CACHE" | jq -c --argjson e "$entry" '. + [$e]')
  done <<< "$PAIRS"
fi

# Classify each group, in envelope order, into a parallel annotations array.
CLASS='[]'
if [ -n "$GROUP_ITEMS" ]; then
  while IFS= read -r group; do
    pkg=$(printf '%s' "$group" | jq -r '.package // ""')
    line=$(printf '%s' "$group" | jq -r '.major_line // "none"')
    adapter=$(printf '%s' "$group" | jq -r '.adapter_path // ""')

    rec=$(printf '%s' "$CACHE" | jq -c --arg a "$adapter" --arg p "$pkg" \
      '(map(select(.adapter == $a and .package == $p)) | first) // {ok: false}')
    ok=$(printf '%s' "$rec" | jq -r '.ok')
    present=$(printf '%s' "$rec" | jq -r '.present // false')
    majors=$(printf '%s' "$rec" | jq -c '.majors // []')

    if [ "$line" = "none" ] || [ "$ok" != "true" ] || [ "$present" != "true" ]; then
      status="unknown"
    elif [ "$(printf '%s' "$majors" | jq -r --arg l "$line" 'index($l) != null')" = "true" ]; then
      status="resolved"
    else
      # None of the copies sits on the line. Whether the group is a dead end
      # is a version-ordering question, so each copy is put to the adapter;
      # a compare that fails or breaks its contract makes the group
      # "unknown" — "every copy is below" cannot be established from a
      # partial read, and neither can "at least one at-or-above".
      status="requires_major_bump"
      versions=$(printf '%s' "$rec" | jq -r '.versions[]')
      while IFS= read -r v; do
        below=""
        if below=$("$adapter" compare_versions "$v" "$line.0.0" 2>/dev/null \
                     | jq -r 'if (type == "object" and has("result")
                                  and (.result | type == "number"))
                              then (if .result < 0 then "yes" else "no" end)
                              else "bad" end' 2>/dev/null) \
           && [ -n "$below" ]; then :; else below="bad"; fi
        case "$below" in
          yes) ;;
          no)  [ "$status" = "unknown" ] || status="line_absent" ;;
          *)   status="unknown" ;;
        esac
      done <<< "$versions"
    fi

    annotation=$(jq -nc --argjson m "$majors" --arg s "$status" \
      '{resolved_majors: $m, line_status: $s}')
    CLASS=$(printf '%s' "$CLASS" | jq -c --argjson a "$annotation" '. + [$a]')
  done <<< "$GROUP_ITEMS"
fi

annotated=$(printf '%s' "$input" | jq --argjson cls "$CLASS" '
  (.actionable // []) as $groups
  | [range($groups | length) | $groups[.] + $cls[.]] as $all
  | . as $input
  | {
      actionable: [ $all[] | select(.line_status != "requires_major_bump") ],
      skipped: ((.skipped // []) + [
        $all[] | select(.line_status == "requires_major_bump")
               | . + {reason: "requires major version bump"}
      ])
    }
  # Pass through any other top-level keys (e.g. `skipped_repos` at org/user
  # scope) unchanged, exactly as select-adapter.sh does.
  | . as $out
  | ($input | del(.actionable, .skipped)) + $out
  ' 2>"$ERR_FILE") || {
  printf '{"error":"Failed to classify discovery JSON: %s"}\n' "$(cat "$ERR_FILE")" >&2
  exit 1
}
printf '%s\n' "$annotated"
