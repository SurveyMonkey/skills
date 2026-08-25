#!/usr/bin/env bash
# classify-lines.sh — reconcile each actionable group's major line with what
# the repository's lockfile actually resolves
#
# Usage:
#   ... | select-adapter.sh --from-discovery | classify-lines.sh --repo-root <path> \
#         [--branch-style slash|flat]
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
# not the promised envelope, or an envelope whose actionable groups span more
# than one repo (below) — this script reads one lockfile at `--repo-root`, so
# a second repo's groups would be classified, and potentially withdrawn, from
# the wrong checkout entirely.
#
# "Zero resolved versions is an error, never a pass" (scripts/CLAUDE.md)
# applies here too: `present: true` with an empty `versions[]` is a
# parser-failure shape, not "the package resolves nowhere", so it is folded
# into the same contract check as a missing field rather than left to reach
# the per-copy compare loop on nothing.
#
# A broken adapter call — a failing `resolved_versions` or `compare_versions`,
# or one that breaks its contract — is recorded in the top-level
# `classify_errors[]` (adapter, package, the call's first stderr line),
# mirroring `check-advisories.sh`'s `adapter_errors[]`: the group still
# classifies "unknown", but the reply names what broke instead of leaving
# every unknown group looking identical.
#
# --branch-style flat rewrites every group's `branch_name` from the slash
# scheme (`fix/dependabot-...`) to the flat one (`fix-dependabot-...`), and
# `slash` (the default) rewrites nothing. The scheme is a per-repo fact — a
# remote branch literally named `fix` blocks every `fix/*` push (issue #123;
# discover-alerts.sh's header carries the mechanism) — and this script is the
# one stage of the cross-repo flow that runs once per repo with that repo's
# groups on stdin (resolve-alerts SKILL.md phase 5), which is why the rewrite
# sits here. A branch_name not carrying the slash prefix (another tool's
# name, or one already flat) passes through unchanged.

set -euo pipefail

REPO_ROOT=""
BRANCH_STYLE="slash"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-root) REPO_ROOT="${2:?--repo-root requires a value}"; shift 2 ;;
    --branch-style) BRANCH_STYLE="${2:?--branch-style requires a value}"; shift 2 ;;
    --branch-style=*) BRANCH_STYLE="${1#--branch-style=}"; shift ;;
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
case "$BRANCH_STYLE" in
  slash|flat) ;;
  *)
    printf '{"error":"Unknown branch style: %s (expected slash or flat)"}\n' "$BRANCH_STYLE" >&2
    exit 1
    ;;
esac

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

# The `resolved_versions` contract: a reply of the wrong shape, or `present:
# true` backed by zero versions, is a broken read, never a legitimate empty
# answer (scripts/CLAUDE.md's "zero resolved versions is never a pass").
CONTRACT_JQ='
  def valid_reply:
    type == "object"
    and has("present") and (.present | type == "boolean")
    and has("versions") and (.versions | type == "array")
    and (.versions | all(type == "object" and has("version")))
    and ((.present | not) or (.versions | length > 0));
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

# One repo per invocation. Discovery sets `repo` on every group unconditionally
# (`group_repo_alerts`, discover-alerts.sh), at repo scope as much as org/user
# scope, but the check treats an absent value the same as a present one for
# defense in depth: either way, more than one distinct value means the caller
# handed this script groups from more than one checkout, and `--repo-root`
# only names one of them.
REPOS=$(printf '%s' "$input" \
  | jq -c '[(.actionable // [])[].repo // empty] | unique' 2>"$ERR_FILE") || {
  printf '{"error":"Failed to read repo scope from actionable groups: %s"}\n' "$(cat "$ERR_FILE")" >&2
  exit 1
}
if [ "$(printf '%s' "$REPOS" | jq 'length')" -gt 1 ]; then
  printf '{"error":"classify-lines.sh: actionable groups span more than one repo (%s); pass one repo'\''s groups per invocation"}\n' \
    "$(printf '%s' "$REPOS" | jq -r 'join(", ")')" >&2
  exit 1
fi

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
CLASSIFY_ERRORS='[]'
if [ -n "$PAIRS" ]; then
  while IFS=$'\t' read -r adapter pkg; do
    [ -n "$adapter" ] || continue
    reply=""
    ADAPTER_ERR=$(mktemp)
    if reply=$( (cd "$REPO_ROOT" && "$adapter" resolved_versions "$pkg") 2>"$ADAPTER_ERR" ) \
       && [ -n "$reply" ]; then
      # `-s` (slurp) plus a length check is deliberate: an adapter reply of
      # two JSON documents on one exit-0 stdout (a stray extra print, a
      # concatenated retry) is not "the object we asked for" just because the
      # first document looks right. Unslurped, `jq -c` streams both documents
      # out of this filter and the second `--argjson e "$entry"` below chokes
      # on the multi-value string with raw jq noise instead of the {"error":
      # ...} contract requires (ADR 001).
      entry=$(printf '%s' "$reply" | jq -c -s --arg a "$adapter" --arg p "$pkg" \
        "$MAJOR_OF_JQ$CONTRACT_JQ"'
        if (length == 1 and (.[0] | valid_reply))
        then (.[0] | {adapter: $a, package: $p, ok: true, present: .present,
              versions: [.versions[].version | tostring],
              majors: ([.versions[].version | major_of | select(. != null)] | unique)})
        else {adapter: $a, package: $p, ok: false}
        end' 2>/dev/null) \
        || entry=$(jq -nc --arg a "$adapter" --arg p "$pkg" \
             '{adapter: $a, package: $p, ok: false}')
    else
      entry=$(jq -nc --arg a "$adapter" --arg p "$pkg" \
        '{adapter: $a, package: $p, ok: false}')
    fi
    if [ "$(printf '%s' "$entry" | jq -r '.ok')" != "true" ]; then
      CLASSIFY_ERRORS=$(printf '%s' "$CLASSIFY_ERRORS" | jq -c \
        --arg a "$adapter" --arg p "$pkg" --arg e "$(head -n 1 "$ADAPTER_ERR" 2>/dev/null)" \
        '. + [{adapter: $a, package: $p, error: $e}]')
    fi
    rm -f "$ADAPTER_ERR"
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
        CMP_ERR=$(mktemp)
        if below=$("$adapter" compare_versions "$v" "$line.0.0" 2>"$CMP_ERR" \
                     | jq -r 'if (type == "object" and has("result")
                                  and (.result | type == "number"))
                              then (if .result < 0 then "yes" else "no" end)
                              else "bad" end' 2>/dev/null) \
           && [ -n "$below" ]; then :; else below="bad"; fi
        case "$below" in
          yes) ;;
          no)  [ "$status" = "unknown" ] || status="line_absent" ;;
          *)
            status="unknown"
            CLASSIFY_ERRORS=$(printf '%s' "$CLASSIFY_ERRORS" | jq -c \
              --arg a "$adapter" --arg p "$pkg" --arg e "$(head -n 1 "$CMP_ERR" 2>/dev/null)" \
              '. + [{adapter: $a, package: $p, error: $e}]')
            ;;
        esac
        rm -f "$CMP_ERR"
      done <<< "$versions"
    fi

    annotation=$(jq -nc --argjson m "$majors" --arg s "$status" \
      '{resolved_majors: $m, line_status: $s}')
    CLASS=$(printf '%s' "$CLASS" | jq -c --argjson a "$annotation" '. + [$a]')
  done <<< "$GROUP_ITEMS"
fi

annotated=$(printf '%s' "$input" | jq --argjson cls "$CLASS" \
  --argjson classify_errors "$CLASSIFY_ERRORS" --arg branch_style "$BRANCH_STYLE" '
  (.actionable // []) as $groups
  | [range($groups | length) | $groups[.] + $cls[.]] as $all
  | . as $input
  | {
      actionable: [ $all[] | select(.line_status != "requires_major_bump") ],
      skipped: ((.skipped // []) + [
        $all[] | select(.line_status == "requires_major_bump")
               | . + {reason: "requires major version bump"}
      ]),
      classify_errors: $classify_errors
    }
  # Pass through any other top-level keys (e.g. `skipped_repos` at org/user
  # scope) unchanged, exactly as select-adapter.sh does.
  | . as $out
  | ($input | del(.actionable, .skipped, .classify_errors)) + $out
  # The flat rewrite covers skipped groups too: a report naming a slash
  # branch on a repo whose remote cannot hold one would be wrong the same
  # way. Groups without a string branch_name pass through untouched.
  | if $branch_style == "flat" then
      (.actionable, .skipped) |= map(
        if (.branch_name? | type) == "string"
        then .branch_name |= sub("^fix/dependabot-"; "fix-dependabot-")
        else . end)
    else . end
  ' 2>"$ERR_FILE") || {
  printf '{"error":"Failed to classify discovery JSON: %s"}\n' "$(cat "$ERR_FILE")" >&2
  exit 1
}
printf '%s\n' "$annotated"
