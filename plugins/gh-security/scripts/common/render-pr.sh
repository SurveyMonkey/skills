#!/usr/bin/env bash
# render-pr.sh — deterministic rendering of the phase 6 commit message, PR
# body, labels and `gh pr create` call for one dependency-fix group.
#
# Usage:
#   render-pr.sh commit-msg --state <ready_for_pr.json> --group-json <group.json> --repo <nwo>
#   render-pr.sh body       --state <ready_for_pr.json> --group-json <group.json> --repo <nwo>
#                            [--collateral-note <file>] [--global-override-note <file>]
#   render-pr.sh labels     --repo <nwo> --band <low|medium|high> [--env-prefix "<string>"]
#   render-pr.sh create     --repo <nwo> --head <branch> --title <string> --body-file <file>
#                            --band <low|medium|high> [--label <name>]... [--env-prefix "<string>"]
#
# `--state` is the driver's `ready_for_pr` payload (`fix-group.sh score`'s
# stdout, exit 0). `--group-json` is the group payload the driver's `setup`
# step was given (`package`, `major_line`, `branch_name`, `highest_fixed_version`,
# `alerts[]`).
#
# `commit-msg` and `body` are pure: they read the two JSON files and write
# text (commit-msg) or markdown (body) to stdout, with no `gh` or `git` call.
# `labels` and `create` are the only subcommands that shell out, and only to
# `gh`.
#
# Two rendered shapes require narrative only the calling agent can supply,
# because they name evidence the state file does not carry: the `fatal`
# variant of `## Collateral` (a human re-dispatch, never a routine run) and
# the `## Global override` section's reasoning (why no scoped form covered
# every path). Pass `--collateral-note <file>` / `--global-override-note
# <file>` for those; omitting a required note is a clear `{"error": ...}`,
# never invented prose (scripts/CLAUDE.md's zero-found-is-an-error rule
# applied to narrative: a missing explanation is a hole, not an empty one to
# paper over).
#
# Dependencies are bash, jq and gh only (scripts/CLAUDE.md). bash 3.2, jq 1.7:
# no associative arrays, `//` parenthesized before `as`.

set -uo pipefail

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

die() {
  printf 'render-pr: %s\n' "$1" >&2
  jq -n --arg e "$1" '{error: $e}'
  exit 1
}

need_file() {
  [ -n "${2:-}" ] || die "$1 requires a file"
  [ -f "$2" ] || die "$1: no such file: $2"
}

need_value() {
  [ -n "${2:-}" ] || die "$1 requires a value"
}

read_json() {
  jq -c '.' "$1" 2>/dev/null || die "$2: not readable JSON: $1"
}

# ---------------------------------------------------------------------------
# env_prefix — the same opaque, optional seam as fix-group.sh. Only `labels`
# and `create` need it; commit-msg and body run no external command at all.
# ---------------------------------------------------------------------------

ENV_PREFIX_ARGV=()
ENV_PREFIX_N=0

set_env_prefix() {
  ENV_PREFIX_ARGV=()
  ENV_PREFIX_N=0
  case "${1:-}" in
    ''|null) return 0 ;;
  esac
  read -r -a ENV_PREFIX_ARGV <<EOF
$1
EOF
  ENV_PREFIX_N=${#ENV_PREFIX_ARGV[@]}
}

run_env() {
  if [ "$ENV_PREFIX_N" -gt 0 ]; then
    "${ENV_PREFIX_ARGV[@]}" "$@"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Shared jq helpers, inlined into every filter that needs them.
# ---------------------------------------------------------------------------

# parent_of/bare_name mirror fix-group.sh's uncovered_parents: the enclosing
# package directory of a violation path, with a pnpm store prefix and any
# trailing @version qualifier stripped.
JQ_DEFS=$(cat <<'JQLIB'
  def bare_name:
    . as $k
    | ($k | rindex("@")) as $i
    | if $i == null or $i == 0 then $k else $k[0:$i] end;
  def parent_of($path):
    ($path | split("/")) as $seg
    | ([ range(0; $seg | length) | select($seg[.] == "node_modules") ] | last) as $i
    | if $i == null or $i == 0 then null
      else ($seg[0:$i] | last | sub("^\\.pnpm/"; "") | bare_name) end;
  def major_of($v):
    ($v | sub("^[vV=]*"; "") | sub("[^0-9].*$"; ""));
JQLIB
)

# ---------------------------------------------------------------------------
# commit-msg
# ---------------------------------------------------------------------------

cmd_commit_msg() {
  local state_file="" group_file="" repo=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --state)      need_value "$1" "${2-}"; state_file="$2"; shift 2 ;;
      --group-json) need_value "$1" "${2-}"; group_file="$2"; shift 2 ;;
      --repo)       need_value "$1" "${2-}"; repo="$2"; shift 2 ;;
      *) die "commit-msg: unknown option '$1'" ;;
    esac
  done
  need_file --state "$state_file"
  need_file --group-json "$group_file"
  [ -n "$repo" ] || die "commit-msg requires --repo"

  local state group
  state=$(read_json "$state_file" "--state")
  group=$(read_json "$group_file" "--group-json")

  local action
  action=$(printf '%s' "$state" | jq -r '.action')
  if [ "$action" = "lockfile-refresh" ]; then
    die "commit-msg: action is lockfile-refresh — there is nothing to commit beyond phase 3's drift commit, which is already on the branch. Skip straight to push."
  fi

  local kind
  case "$action" in
    direct-update)   kind="Direct update" ;;
    scoped-override) kind="Scoped override" ;;
    bare-override)   kind="Bare override" ;;
    *) die "commit-msg: unrecognized action '$action'" ;;
  esac

  local location
  if [ "$action" = "direct-update" ]; then
    location="package.json"
  else
    location=$(printf '%s' "$state" | jq -r '.override_file // empty')
    [ -n "$location" ] || die "commit-msg: state carries no override_file for action '$action'"
  fi

  local package major_line version n
  package=$(printf '%s' "$group" | jq -r '.package')
  major_line=$(printf '%s' "$group" | jq -r '.major_line')
  version=$(printf '%s' "$group" | jq -r '.highest_fixed_version')
  n=$(printf '%s' "$group" | jq '.alerts | length')

  printf 'fix(deps): resolve %s Dependabot alert(s) for %s %s.x\n\n' "$n" "$package" "$major_line"
  printf '%s to >=%s via %s.\n\n' "$kind" "$version" "$location"
  printf 'Alerts resolved:\n'
  printf '%s' "$group" | jq -r '.alerts[] | "- #\(.number): \(.cve // .ghsa) (\(.severity))"'
  printf '\n'
  printf '%s' "$group" | jq -r --arg repo "$repo" \
    '.alerts[] | "Refs: https://github.com/\($repo)/security/dependabot/\(.number)"'
}

# ---------------------------------------------------------------------------
# body
# ---------------------------------------------------------------------------

action_verb() {
  case "$1" in
    direct-update)    printf 'updating the direct dependency' ;;
    scoped-override)  printf 'adding scoped overrides' ;;
    bare-override)    printf 'adding an unscoped override' ;;
    lockfile-refresh) printf 'refreshing the lockfile' ;;
    *) printf 'updating %s' "$1" ;;
  esac
}

cmd_body() {
  local state_file="" group_file="" repo="" collateral_note="" override_note=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --state)                need_value "$1" "${2-}"; state_file="$2"; shift 2 ;;
      --group-json)           need_value "$1" "${2-}"; group_file="$2"; shift 2 ;;
      --repo)                 need_value "$1" "${2-}"; repo="$2"; shift 2 ;;
      --collateral-note)      need_value "$1" "${2-}"; collateral_note="$2"; shift 2 ;;
      --global-override-note) need_value "$1" "${2-}"; override_note="$2"; shift 2 ;;
      *) die "body: unknown option '$1'" ;;
    esac
  done
  need_file --state "$state_file"
  need_file --group-json "$group_file"
  [ -n "$repo" ] || die "body requires --repo"
  [ -z "$collateral_note" ] || need_file --collateral-note "$collateral_note"
  [ -z "$override_note" ] || need_file --global-override-note "$override_note"

  local state group
  state=$(read_json "$state_file" "--state")
  group=$(read_json "$group_file" "--group-json")

  local package major_line n action resolved_version before override_file drift bare
  package=$(printf '%s' "$group" | jq -r '.package')
  major_line=$(printf '%s' "$group" | jq -r '.major_line')
  n=$(printf '%s' "$group" | jq '.alerts | length')
  action=$(printf '%s' "$state" | jq -r '.action')
  resolved_version=$(printf '%s' "$state" | jq -r '.resolved_version')
  before=$(printf '%s' "$state" | jq -r '.before // empty')
  override_file=$(printf '%s' "$state" | jq -r '.override_file // empty')
  drift=$(printf '%s' "$state" | jq -r '.drift_commit')
  bare=$(printf '%s' "$state" | jq -r '.bare_override')

  local moves_raw moves_kind
  moves_raw=$(printf '%s' "$state" | jq -c '.other_line_moves')
  if [ "$moves_raw" = "null" ]; then
    moves_kind="null"
  elif [ "$moves_raw" = "[]" ]; then
    moves_kind="clean"
  elif [ "$(printf '%s' "$moves_raw" | jq '[ .[] | select(.class == "fatal") ] | length > 0')" = "true" ]; then
    moves_kind="fatal"
  else
    moves_kind="benign"
  fi

  # Every required note is checked before anything is printed: a partial
  # markdown body followed by a trailing {"error": ...} is not the clear,
  # unambiguous failure this contract promises.
  if [ "$bare" != "none" ] && [ -z "$override_note" ]; then
    die "body: bare_override is '$bare', so the PR needs a ## Global override section, and its reasoning (why no scoped form covered every path, and which resolved copies it pins) is evidence only the agent has. Pass --global-override-note <file>."
  fi
  if [ "$moves_kind" = "fatal" ] && [ -z "$collateral_note" ]; then
    die "body: other_line_moves carries a fatal entry, which only happens on a human re-dispatch, and the narrative explaining why the move was accepted is evidence only the agent has. Pass --collateral-note <file>."
  fi

  # ---- Summary ------------------------------------------------------------
  printf '## Summary\n\n'
  jq -rn --arg n "$n" --arg pkg "$package" --arg line "$major_line" \
    --arg verb "$(action_verb "$action")" \
    --arg hfv "$(printf '%s' "$group" | jq -r '.highest_fixed_version')" \
    --arg resolved "$resolved_version" '
    "- Resolves \($n) Dependabot alert(s) for `\($pkg)` in the \($line).x line by \($verb)",
    "- Target version: >=\($hfv)",
    "- Resolved version: \($resolved)",
    "- Other major lines of this package, if any, are fixed by their own PRs"
  '
  printf '\n'

  # ---- Alerts resolved ------------------------------------------------------
  printf '## Alerts resolved\n\n'
  printf '| # | CVE | Severity | EPSS | Summary |\n|---|---|---|---|---|\n'
  local num cve sev epss summary
  while IFS=$'\t' read -r num cve sev epss summary; do
    [ -n "$num" ] || continue
    local pct
    if [ -n "$epss" ] && [ "$epss" != "null" ]; then
      pct=$(awk -v e="$epss" 'BEGIN { printf "%.1f", e * 100 }')
      pct="${pct}%"
    else
      pct="unknown"
    fi
    printf '| [#%s](https://github.com/%s/security/dependabot/%s) | %s | %s | %s | %s |\n' \
      "$num" "$repo" "$num" "$cve" "$sev" "$pct" "$summary"
  done <<EOF
$(printf '%s' "$group" | jq -r '.alerts[] | [.number, (.cve // .ghsa), .severity, (.epss_percentile // ""), (.summary // "" | gsub("\\|"; "\\|") | gsub("\n"; " "))] | @tsv')
EOF
  printf '\n'

  # ---- Merge risk (scorer markdown, verbatim) ------------------------------
  printf '%s' "$state" | jq -r '.risk.markdown'
  printf '\n'

  # ---- Dependency chain -----------------------------------------------------
  printf '## Dependency chain\n\n```\n'
  printf '%s' "$state" | jq -r '.why_raw'
  printf '```\n\n'

  # ---- Changes ---------------------------------------------------------------
  printf '## Changes\n\n'
  if [ "$action" = "lockfile-refresh" ]; then
    jq -rn --arg before "${before:-an unresolved version}" --arg line "$major_line" \
      --arg after "$resolved_version" \
      '"The fix is a no-change lockfile refresh: the manifest already admits the fixed version, but the committed lockfile pinned `\($before)` on the \($line).x line. Re-resolving it against the unchanged manifests moves it to `\($after)`."'
    printf '\n'
  else
    printf '```json\n'
    printf '%s' "$state" | jq '.written'
    printf '```\n\n'
    if [ "$override_file" = "pnpm-workspace.yaml" ]; then
      jq -rn '"The override lives in `pnpm-workspace.yaml`; the block above quotes the entries `apply_constraint` wrote even though the file itself is YAML."'
      printf '\n'
    fi
    if [ "$drift" = "true" ]; then
      printf 'The first commit is a no-change lockfile refresh — the default branch'"'"'s lockfile is stale relative to its manifests, so any install re-resolves these entries; the second commit is the fix.\n\n'
    fi
  fi

  # ---- Global override --------------------------------------------------------
  if [ "$bare" != "none" ]; then
    local range parents_tried survived verbed
    range=$(printf '%s' "$state" | jq -r '[ .written[]? | select((.parent // null) == null) | .value ] | first // empty')
    parents_tried=$(printf '%s' "$state" | jq -r '(.applied_parents // []) | join(", ")')
    survived=$(printf '%s' "$state" | jq -r '(.validate.resolved_versions // []) | join(", ")')
    if [ "$bare" = "added" ]; then verbed="Added"; else verbed="Tightened"; fi
    printf '## Global override\n\n'
    jq -rn --arg verb "$verbed" --arg pkg "$package" --arg range "${range:-N/A}" \
      --arg parents "$parents_tried" --arg survived "$survived" '
      ("\($verb) an unscoped override `\($pkg): \"\($range)\"`."
       + (if $parents != "" then " Scoped entries were tried on: \($parents)." else "" end)
       + (if $survived != "" then " Resolved copies after the fix: \($survived)." else "" end))
    '
    printf '\n'
    cat "$override_note"
    printf '\n\n'
  fi

  # ---- Not fixed by this PR ----------------------------------------------------
  local bump_count
  bump_count=$(printf '%s' "$state" | jq '(.requires_major_bump // []) | length')
  if [ "$bump_count" -gt 0 ]; then
    printf '## Not fixed by this PR\n\n'
    printf '| Version | Alerts still open | Remediation |\n|---|---|---|\n'
    printf '%s' "$state" | jq -r --argjson alerts "$(printf '%s' "$group" | jq -c '.alerts')" "$JQ_DEFS"'
      .requires_major_bump[] as $b
      | ($b.vulnerable_ranges // []) as $vr
      | ([ $alerts[] | select((.vulnerable_range // "") as $r | $vr | index($r) != null)
           | (.ghsa // .cve // ("#" + (.number | tostring))) ] | join(", ")) as $open
      | (parent_of($b.path)) as $parent
      | (major_of($b.version)) as $maj
      | [$b.version, $open,
         "no patched release in the \($maj).x line; needs a major bump of `" +
         ($parent // "the dependent that pins it") + "` or dropping it"]
      | @tsv' | awk -F'\t' '{ printf "| %s | %s | %s |\n", $1, $2, $3 }'
    printf '\n'
  fi

  # ---- Verification / Collateral ------------------------------------------------
  local checked hfv next_major
  checked=$(printf '%s' "$state" | jq -r '.validate.checked // 0')
  hfv=$(printf '%s' "$group" | jq -r '.highest_fixed_version')
  next_major=$(printf '%s' "$group" | jq -r '(.major_line | tonumber) + 1')

  if [ "$moves_kind" != "clean" ]; then
    printf '## Collateral\n\n'
    case "$moves_kind" in
      null)
        jq -rn --arg pkg "$package" \
          '"No baseline was available to check other major lines of `\($pkg)` against, so this PR makes no claim about them."'
        printf '\n'
        ;;
      benign)
        printf '| Line | Before | After |\n|---|---|---|\n'
        printf '%s' "$moves_raw" | jq -r '.[] | [(.major | tostring) + ".x", (.before | join(", ")), (.after | join(", "))] | @tsv' \
          | awk -F'\t' '{ printf "| %s | %s | %s |\n", $1, $2, $3 }'
        printf '\nThese are within-major dedups by the package manager onto a version each line already resolved before this change, and none of these lines carries an open Dependabot alert.\n\n'
        ;;
      fatal)
        printf '| Line | Before | After |\n|---|---|---|\n'
        printf '%s' "$moves_raw" | jq -r '.[] | [(.major | tostring) + ".x", (.before | join(", ")), (.after | join(", "))] | @tsv' \
          | awk -F'\t' '{ printf "| %s | %s | %s |\n", $1, $2, $3 }'
        printf '\n'
        cat "$collateral_note"
        printf '\n\n'
        ;;
    esac
  fi

  printf '## Verification\n\n'
  jq -rn --arg checked "$checked" --arg line "$major_line" --arg hfv "$hfv" --arg next "$next_major" \
    --arg pkg "$package" --argjson clean "$([ "$moves_kind" = "clean" ] && printf true || printf false)" '
    "- [x] Lockfile validated: \($checked) resolved version(s) in the \($line).x line satisfy",
    "      `>=\($hfv) <\($next)`, and no resolved copy still matches any alert'"'"'s vulnerable range",
    (if $clean then
      "- [x] No collateral: every copy of `\($pkg)` on the other major lines resolves exactly as it did\n" +
      "      before this change (`other_line_moves: []`, against the baseline recorded after a no-change\n" +
      "      control install, so the comparison excludes stale-lockfile drift and measures only this\n" +
      "      change)"
     else empty end),
    "- CI on this PR is the verifier; coverage and CI presence are scored above"
  '
  printf '\n'

  # ---- References ------------------------------------------------------------
  printf '## References\n\n'
  printf '%s' "$group" | jq -r --arg repo "$repo" '.alerts[] | "- https://github.com/\($repo)/security/dependabot/\(.number)"'
}

# ---------------------------------------------------------------------------
# labels
# ---------------------------------------------------------------------------

# Capture-and-branch, never `2>/dev/null || true`: a duplicate label and a
# real failure (a token that cannot create labels) both discard silently
# under `|| true`, and only one of them is safe to continue past. A `gh
# label create` that fails because the label now exists is success, not an
# error: sibling agents fixing other packages in the same batch race to
# create the same band label, and the loser's failure means the label is
# there, which is what it wanted.
#
# Creating a label at all is a deliberate write of repo metadata beyond the PR itself, the same trade audit-pins.md makes for its own risk label.
create_label() {
  local repo=$1 name=$2 color=$3 desc=$4 out
  out=$(run_env gh label create "$name" --repo "$repo" --color "$color" --description "$desc" 2>&1) && return 0
  case "$out" in
    *"already exists"*) return 0 ;;
    *) printf '%s' "$out"; return 1 ;;
  esac
}

cmd_labels() {
  local repo="" band="" env_prefix=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)       need_value "$1" "${2-}"; repo="$2"; shift 2 ;;
      --band)       need_value "$1" "${2-}"; band="$2"; shift 2 ;;
      --env-prefix) env_prefix="${2-}"; shift 2 ;;
      *) die "labels: unknown option '$1'" ;;
    esac
  done
  [ -n "$repo" ] || die "labels requires --repo"
  local band_lower color desc
  band_lower=$(printf '%s' "$band" | tr '[:upper:]' '[:lower:]')
  case "$band_lower" in
    low)    color=2da44e; desc="Low merge risk" ;;
    medium) color=d4a72c; desc="Medium merge risk" ;;
    high)   color=cf222e; desc="High merge risk" ;;
    *) die "labels: --band must be low, medium, or high, got '$band'" ;;
  esac
  set_env_prefix "$env_prefix"

  local out
  out=$(create_label "$repo" security D93F0B "Security fix") \
    || die "gh label create security failed: $out"
  out=$(create_label "$repo" "merge-risk:$band_lower" "$color" "$desc") \
    || die "gh label create merge-risk:$band_lower failed: $out"

  jq -n --arg band "$band_lower" \
    '{status: "ok", labels: ["security", ("merge-risk:" + $band)]}'
}

# ---------------------------------------------------------------------------
# create
# ---------------------------------------------------------------------------

cmd_create() {
  local repo="" head="" title="" body_file="" band="" env_prefix=""
  local extra_labels=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)       need_value "$1" "${2-}"; repo="$2"; shift 2 ;;
      --head)       need_value "$1" "${2-}"; head="$2"; shift 2 ;;
      --title)      need_value "$1" "${2-}"; title="$2"; shift 2 ;;
      --body-file)  need_value "$1" "${2-}"; body_file="$2"; shift 2 ;;
      --band)       need_value "$1" "${2-}"; band="$2"; shift 2 ;;
      --label)      need_value "$1" "${2-}"; extra_labels+=("$2"); shift 2 ;;
      --env-prefix) env_prefix="${2-}"; shift 2 ;;
      *) die "create: unknown option '$1'" ;;
    esac
  done
  [ -n "$repo" ] || die "create requires --repo"
  [ -n "$head" ] || die "create requires --head"
  [ -n "$title" ] || die "create requires --title"
  need_file --body-file "$body_file"
  local band_lower
  band_lower=$(printf '%s' "$band" | tr '[:upper:]' '[:lower:]')
  case "$band_lower" in
    low|medium|high) ;;
    *) die "create: --band must be low, medium, or high, got '$band'" ;;
  esac
  set_env_prefix "$env_prefix"

  local args=(gh pr create --repo "$repo" --head "$head" \
              --label security --label "merge-risk:$band_lower")
  local l
  for l in "${extra_labels[@]:-}"; do
    [ -n "$l" ] || continue
    args+=(--label "$l")
  done
  args+=(--title "$title" --body-file "$body_file")

  local out
  out=$(run_env "${args[@]}" 2>&1) || die "gh pr create failed: $out"
  local url
  url=$(printf '%s\n' "$out" | grep -Eo 'https://github.com/[^[:space:]]+' | tail -n1)
  [ -n "$url" ] || die "gh pr create produced no PR URL. Output: $out"

  jq -n --arg url "$url" '{status: "ok", pr_url: $url}'
}

# ---------------------------------------------------------------------------

command -v jq >/dev/null 2>&1 || die "jq is required"

SUB="${1:-}"
[ -n "$SUB" ] || die "usage: render-pr.sh <commit-msg|body|labels|create> [options]"
shift

case "$SUB" in
  commit-msg) cmd_commit_msg "$@" ;;
  body)       cmd_body "$@" ;;
  labels)     cmd_labels "$@" ;;
  create)     cmd_create "$@" ;;
  *) die "render-pr.sh: unknown subcommand '$SUB'" ;;
esac
