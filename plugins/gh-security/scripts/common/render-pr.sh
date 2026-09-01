#!/usr/bin/env bash
# render-pr.sh — deterministic rendering of the phase 6 commit message, PR
# body, labels and `gh pr create` call for one dependency-fix group.
#
# Usage:
#   render-pr.sh commit-msg --state <ready_for_pr.json> --group-json <group.json> --repo <nwo>
#   render-pr.sh body       --state <ready_for_pr.json> --group-json <group.json> --repo <nwo>
#                            [--collateral-note <file>] [--global-override-note <file>]
#   render-pr.sh labels     --repo <nwo> --band <low|medium|high> [--label <name>]...
#                            [--env-prefix "<string>"]
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

# Reads a file into a compact-JSON variable. Prints nothing and sets no exit
# status of its own on a parse failure — jq's own exit is swallowed by `2>&1`
# discipline elsewhere in this file if this were called through a command
# substitution and then die'd from inside it, `die`'s `exit 1` would end only
# that subshell, leaving `{"error": ...}` captured as the caller's "JSON".
# That is exactly the trap fix-group.sh's `adapter_field` comment documents.
# So this prints raw output only; every caller runs `require_ok` on the
# result as its own top-level statement, never inside `$(...)`.
read_json() {
  jq -c '.' "$1" 2>/dev/null
}

# Runs a jq boolean filter against a JSON payload already in hand (a plain
# argument, never re-read from disk) and dies with $3 unless it evaluates to
# `true` — including a parse error or non-boolean result, both read as false.
# Called as a bare statement (never `x=$(require_ok ...)`), so `die`'s `exit`
# actually ends the process: this is fix-group.sh's `adapter_field`/
# `require_json` discipline, generalized to an arbitrary filter instead of a
# fixed field-presence check.
require_ok() {
  printf '%s' "$1" | jq -e "$2" >/dev/null 2>&1 || die "$3"
}

# A field the driver's `ready_for_pr` (or the dispatched `group`) contract
# promises arrives present and non-null, or it is a hard error — never a bare
# `jq -r`, whose answer for an absent key is the STRING "null", which then
# renders into the PR body as literal text or takes a branch of its own
# (scripts/CLAUDE.md, "A field the contract promises..."). `false`, `0`, and
# `[]` are legitimate answers and pass; only an absent key or an explicit
# JSON `null` does not, and jq's own `-r` reader cannot tell those two apart
# from a genuinely missing field either, so this checks with `has` first
# wherever the field can sit under a possibly-absent parent object, and
# collapses missing-parent and missing-key into the same failure — both are
# "this field is not there" from the caller's point of view.
require_field() {
  # $1 payload  $2 dotted path with a leading '.' (e.g. ".action",
  # ".risk.markdown")  $3 description of the payload for the error
  local ok
  ok=$(printf '%s' "$1" | jq -r --arg p "${2#.}" '
    ($p | split(".")) as $ks
    | reduce $ks[] as $k (.; if (. == null or (type != "object")) then null else .[$k] end)
    | if . == null then "false" else "true" end' 2>/dev/null)
  [ "$ok" = "true" ] \
    || die "$3 has no usable '$2'. The driver's contract promises this field; an absent or null value here is never rendered as a default."
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

# parent_of/bare_name mirror fix-group.sh's uncovered_parents/parent_derivation
# (same shape test, same extraction): only an npm-style install path names
# the enclosing parent, immediately before the last `node_modules` segment.
# pnpm's `<name>@<version>` and Yarn Berry's `<name>@npm:<version>` name the
# violating COPY, not a parent, and carry no `node_modules/` segment at all,
# so `parent_of` returns null for them rather than inventing one.
#
# This is a deliberately independent copy, not a shared library — the two
# scripts have no shared-code mechanism (scripts/CLAUDE.md: bash/jq/gh only,
# nothing to `source`) — and it has already diverged from fix-group.sh's
# `uncovered_parents` in one respect that matters: a SCOPED parent
# (`node_modules/@nestjs/core/node_modules/<pkg>`) needs both the `@scope`
# segment and the name segment joined back together, or it reports `core`
# instead of `@nestjs/core` — a real, wrong package name in a PR body, not a
# missing one. fix-group.sh's `parent_of` carries that exact defect as of
# this writing, being fixed there separately; this copy is fixed here and
# specimen-tested for all three managers (spec/render_pr_spec.sh) rather than
# left to wait on that other change landing and being re-copied. When it
# does land, diff the two `parent_of` bodies and reconcile by hand — this
# comment is the pin against silently drifting apart again, since nothing
# in this toolchain can enforce it as code (see the Structural note in issue
# #172's review for why consuming fix-group.sh's `parent_derivation` object
# instead was rejected: it is computed from `validate`'s `violations[]`
# during the apply ladder, a different array from the `requires_major_bump[]`
# entries this table renders — below-line copies the ladder's scoped-parent
# step never touches — so it cannot answer this question no matter how
# current it is).
JQ_DEFS=$(cat <<'JQLIB'
  def bare_name:
    . as $k
    | ($k | rindex("@")) as $i
    | if $i == null or $i == 0 then $k else $k[0:$i] end;
  def parent_of($path):
    ($path | split("/")) as $seg
    | ([ range(0; $seg | length) | select($seg[.] == "node_modules") ] | last) as $i
    | if $i == null or $i == 0 then null
      elif ($i >= 2) and ($seg[$i - 2] | startswith("@"))
        then ($seg[$i - 2] + "/" + $seg[$i - 1] | bare_name)
      else ($seg[$i - 1] | bare_name) end;
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
  state=$(read_json "$state_file")
  require_ok "$state" 'type == "object"' "commit-msg: --state $state_file is not readable JSON, or not a JSON object."
  group=$(read_json "$group_file")
  require_ok "$group" 'type == "object"' "commit-msg: --group-json $group_file is not readable JSON, or not a JSON object."
  require_ok "$group" '(.alerts | type) == "array" and (.alerts | length) > 0' \
    "commit-msg: --group-json $group_file carries no non-empty alerts[]. A dispatched group is never empty; rendering a count and an alert list from zero alerts is a false claim, not a legitimate empty state."
  require_ok "$group" '.alerts | all(.[]; (.number != null) and ((.cve != null) or (.ghsa != null)) and (.severity != null))' \
    "commit-msg: --group-json $group_file has an alert missing 'number', both of 'cve' and 'ghsa', or 'severity'. Every alert line and Refs: trailer needs all three."

  require_field "$state" ".action" "commit-msg: --state $state_file"
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
    require_field "$state" ".override_file" "commit-msg: --state $state_file (action '$action')"
    location=$(printf '%s' "$state" | jq -r '.override_file')
  fi

  require_field "$group" ".package" "commit-msg: --group-json $group_file"
  require_field "$group" ".major_line" "commit-msg: --group-json $group_file"
  require_field "$group" ".highest_fixed_version" "commit-msg: --group-json $group_file"
  local package major_line version n
  package=$(printf '%s' "$group" | jq -r '.package')
  major_line=$(printf '%s' "$group" | jq -r '.major_line')
  version=$(printf '%s' "$group" | jq -r '.highest_fixed_version')
  n=$(printf '%s' "$group" | jq '.alerts | length')

  local alert_lines refs_lines
  alert_lines=$(printf '%s' "$group" | jq -r '.alerts[] | "- #\(.number): \(.cve // .ghsa) (\(.severity))"') \
    || die "commit-msg: could not render the Alerts resolved list from --group-json $group_file."
  refs_lines=$(printf '%s' "$group" | jq -r --arg repo "$repo" \
    '.alerts[] | "Refs: https://github.com/\($repo)/security/dependabot/\(.number)"') \
    || die "commit-msg: could not render the Refs: trailer from --group-json $group_file."

  printf 'fix(deps): resolve %s Dependabot alert(s) for %s %s.x\n\n' "$n" "$package" "$major_line"
  printf '%s to >=%s via %s.\n\n' "$kind" "$version" "$location"
  printf 'Alerts resolved:\n'
  printf '%s\n' "$alert_lines"
  printf '\n'
  printf '%s\n' "$refs_lines"
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
  state=$(read_json "$state_file")
  require_ok "$state" 'type == "object"' "body: --state $state_file is not readable JSON, or not a JSON object."
  group=$(read_json "$group_file")
  require_ok "$group" 'type == "object"' "body: --group-json $group_file is not readable JSON, or not a JSON object."
  require_ok "$group" '(.alerts | type) == "array" and (.alerts | length) > 0' \
    "body: --group-json $group_file carries no non-empty alerts[]. A dispatched group is never empty; a Summary and an Alerts resolved table rendered from zero alerts is a false claim, not a legitimate empty state."
  # A present-but-non-numeric epss_percentile used to pass this check (only
  # `!= null` was asked) and then print as a reassuring `0.0%` next to a
  # possibly-high-severity alert: `awk` errors to its zero-value default on
  # non-numeric input the same way `jq -r`'s missing-key read errors to the
  # string "null" — both are a silent, wrong number where a hole belongs
  # (finding #3).
  require_ok "$group" '.alerts | all(.[]; (.number != null) and ((.cve != null) or (.ghsa != null)) and (.severity != null) and ((.epss_percentile | type) == "number"))' \
    "body: --group-json $group_file has an alert missing 'number', both of 'cve' and 'ghsa', 'severity', or a numeric 'epss_percentile'. Every alerts-table row and Refs: line needs all four."

  require_field "$state" ".action" "body: --state $state_file"
  require_field "$state" ".resolved_version" "body: --state $state_file"
  require_field "$state" ".drift_commit" "body: --state $state_file"
  require_field "$state" ".bare_override" "body: --state $state_file"
  require_field "$state" ".risk.markdown" "body: --state $state_file"
  require_field "$state" ".why_raw" "body: --state $state_file"
  require_field "$state" ".validate.checked" "body: --state $state_file"
  # `other_line_moves` is `null` (no baseline; a real, checked answer) or `[]`
  # or a populated array — every one of those is a legitimate VALUE. Only its
  # outright ABSENCE is a contract violation, and `null` at the jq level
  # cannot be told apart from "missing" by a bare read: `has()` is what tells
  # them apart (finding #8).
  require_ok "$state" 'has("other_line_moves")' \
    "body: --state $state_file has no 'other_line_moves' key at all. \`null\` there is a real, checked answer (no baseline was available); an absent key is not, and rendering the null-case text for it would be a specific factual claim made from a hole in the data."
  # `before` is the same shape: fix-group.sh's score always emits the key,
  # `null` when there was genuinely nothing to report on this line pre-fix
  # (a real, checked answer, not a hole) — so only the key's outright
  # absence is a contract violation, checked the same way as
  # `other_line_moves` (finding #4).
  require_ok "$state" 'has("before")' \
    "body: --state $state_file has no 'before' key at all. \`null\` there is a real, checked answer (nothing to report pre-fix on this line); an absent key is not."

  require_field "$group" ".package" "body: --group-json $group_file"
  require_field "$group" ".major_line" "body: --group-json $group_file"
  require_field "$group" ".highest_fixed_version" "body: --group-json $group_file"
  # `(.major_line | tonumber) + 1` in the Verification section errors to
  # empty on a non-numeric major_line with no `set -e` to catch it, silently
  # truncating the Lockfile-validated claim's version bound (finding #2).
  # Checked here, before any output, not where the arithmetic happens.
  require_ok "$group" '.major_line | test("^[0-9]+$")' \
    "body: --group-json $group_file's major_line is not a plain non-negative integer string."

  local package major_line n action resolved_version before override_file drift bare
  package=$(printf '%s' "$group" | jq -r '.package')
  major_line=$(printf '%s' "$group" | jq -r '.major_line')
  n=$(printf '%s' "$group" | jq '.alerts | length')
  action=$(printf '%s' "$state" | jq -r '.action')
  resolved_version=$(printf '%s' "$state" | jq -r '.resolved_version')
  before=$(printf '%s' "$state" | jq -r '.before // empty')
  drift=$(printf '%s' "$state" | jq -r '.drift_commit')
  bare=$(printf '%s' "$state" | jq -r '.bare_override')

  local moves_raw moves_kind
  moves_raw=$(printf '%s' "$state" | jq -c '.other_line_moves')
  if [ "$moves_raw" = "null" ]; then
    moves_kind="null"
  elif [ "$moves_raw" = "[]" ]; then
    moves_kind="clean"
  else
    require_ok "$state" '(.other_line_moves | type) == "array" and (.other_line_moves | all(.[]; has("class") and has("major") and has("before") and has("after")))' \
      "body: --state $state_file's other_line_moves does not parse as an array of {class, major, before, after} entries."
    if [ "$(printf '%s' "$moves_raw" | jq '[ .[] | select(.class == "fatal") ] | length > 0')" = "true" ]; then
      moves_kind="fatal"
    else
      moves_kind="benign"
    fi
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

  # Every remaining check that can fail is run here too, before the first
  # `printf`, even though its data is only consumed by a section further
  # down: a die() partway through rendering leaves a real, plausible-looking
  # partial body ahead of the {"error": ...} on the same stdout, which is
  # exactly the "render something plausible from data we could not read"
  # class this whole file exists to refuse (finding #1's lesson, applied to
  # every section, not just the top-level read).
  require_ok "$state" '.validate.checked != 0' \
    "body: --state $state_file reports validate.checked: 0. Zero resolved versions checked on the ${major_line}.x line is never a legitimate 'Lockfile validated' claim, whether the field was genuinely zero or silently defaulted from an absent one."
  if [ "$action" != "lockfile-refresh" ]; then
    require_field "$state" ".written" "body: --state $state_file (action '$action')"
  fi
  # `override_file` is only promised when an override was actually written
  # (scoped-override, bare-override) — a direct-update or a lockfile-refresh
  # legitimately has none, which is why commit-msg's own requirement (above)
  # is scoped the same way. `body` used to read it with a bare `// empty`
  # unconditionally, silently dropping the pnpm-workspace.yaml clarification
  # on a truncated field the two subcommands disagreed about (finding #4).
  if [ "$action" = "scoped-override" ] || [ "$action" = "bare-override" ]; then
    require_field "$state" ".override_file" "body: --state $state_file (action '$action')"
  fi
  override_file=$(printf '%s' "$state" | jq -r '.override_file // empty')
  if [ "$bare" != "none" ]; then
    # `.value` is required alongside the entry itself: a written[] row with
    # `{parent: null}` and no `value` passed the old guard and rendered the
    # literal string "null" as the pinned range (finding #1).
    require_ok "$state" '[ .written[]? | select((.parent // null) == null) | select((.value | type) == "string") ] | length > 0' \
      "body: bare_override is '$bare' but --state $state_file's written[] carries no top-level (parent: null) entry with a string value to report the range from. The state file contradicts its own classification; nothing is rendered rather than a fabricated range."
  fi
  require_ok "$state" '(.requires_major_bump // []) | type == "array"' \
    "body: --state $state_file's requires_major_bump is not an array."
  require_ok "$state" '(.requires_major_bump // []) | all(.[]; (.version | type) == "string" and (.path | type) == "string" and ((.vulnerable_ranges // []) | type) == "array")' \
    "body: --state $state_file has a requires_major_bump entry missing 'version' or 'path' as a string, or an unreadable vulnerable_ranges[]. Rendering the table's header with no rows from this would read as \"nothing left open\" — the opposite of the truth — so nothing is rendered instead."
  if [ "$(printf '%s' "$state" | jq '(.requires_major_bump // []) | length > 0')" = "true" ]; then
    require_ok "$group" '.alerts | all(.[]; has("vulnerable_range") and has("ghsa") and has("cve"))' \
      "body: --group-json $group_file has an alert missing 'vulnerable_range', 'ghsa' or 'cve', needed to say which alerts stay open in the Not-fixed-by-this-PR table."
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
  # `epss_percentile` is validated present above (a required field of every
  # alert), so it is always a number here and always rendered as one: EPSS is
  # only ever missing upstream (discover-alerts.sh:385 defaults it to 0 when
  # GitHub's API reports no score), never null on the wire this script reads,
  # so an "unknown" branch here could never legitimately fire — and printing
  # it next to a real 0.0% score would be the false claim, not the fix
  # (finding #7: chosen fix is "always render the number, require the field
  # present"; the alternative of preserving null upstream through
  # discover-alerts.sh was rejected as out of this script's scope and a
  # change to a contract other consumers — score-merge-risk.sh, the
  # orchestrator's aggregation — also read).
  printf '## Alerts resolved\n\n'
  printf '| # | CVE | Severity | EPSS | Summary |\n|---|---|---|---|---|\n'
  local alert_rows
  alert_rows=$(printf '%s' "$group" | jq -r \
    '.alerts[] | [.number, (.cve // .ghsa), .severity, .epss_percentile, (.summary // "" | gsub("\\|"; "\\|") | gsub("\n"; " "))] | @tsv') \
    || die "body: could not render the Alerts resolved table from --group-json $group_file."
  local num cve sev epss summary
  while IFS=$'\t' read -r num cve sev epss summary; do
    [ -n "$num" ] || continue
    local pct
    pct=$(awk -v e="$epss" 'BEGIN { printf "%.1f", e * 100 }')
    printf '| [#%s](https://github.com/%s/security/dependabot/%s) | %s | %s | %s%% | %s |\n' \
      "$num" "$repo" "$num" "$cve" "$sev" "$pct" "$summary"
  done <<EOF
$alert_rows
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
    # The range comes from the top-level (parent: null) entry `written[]`
    # itself carries for a bare override — never a fallback placeholder.
    # Its presence was already asserted before any output was printed
    # (finding #10); a rendering-time failure here would leave the same
    # partial-body-then-error shape this file exists to refuse.
    range=$(printf '%s' "$state" | jq -r '[ .written[]? | select((.parent // null) == null) | .value ] | first')
    parents_tried=$(printf '%s' "$state" | jq -r '(.applied_parents // []) | join(", ")')
    survived=$(printf '%s' "$state" | jq -r '(.validate.resolved_versions // []) | join(", ")')
    if [ "$bare" = "added" ]; then verbed="Added"; else verbed="Tightened"; fi
    printf '## Global override\n\n'
    jq -rn --arg verb "$verbed" --arg pkg "$package" --arg range "$range" \
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
  # Every entry's shape and every alert field this table needs was already
  # asserted before any output was printed (finding #5).
  local bump_count
  bump_count=$(printf '%s' "$state" | jq '(.requires_major_bump // []) | length')
  if [ "$bump_count" -gt 0 ]; then
    printf '## Not fixed by this PR\n\n'
    printf '| Version | Alerts still open | Remediation |\n|---|---|---|\n'
    # A parent name is only derivable from an npm-shaped install path
    # (JQ_DEFS's parent_of). Under pnpm and Yarn Berry the violating copy's
    # own path is all `validate` reports — no parent, and none is invented:
    # the cell says a major bump of the copy's dependent is needed without
    # naming one, rather than rendering an empty or fabricated identifier.
    local bump_rows
    bump_rows=$(printf '%s' "$state" | jq -r --argjson alerts "$(printf '%s' "$group" | jq -c '.alerts')" "$JQ_DEFS"'
      .requires_major_bump[] as $b
      | ($b.vulnerable_ranges // []) as $vr
      | ([ $alerts[] | select((.vulnerable_range // "") as $r | $vr | index($r) != null)
           | (.ghsa // .cve // ("#" + (.number | tostring))) ] | join(", ")) as $open
      | (parent_of($b.path)) as $parent
      | (major_of($b.version)) as $maj
      | (if $parent != null then "needs a major bump of `\($parent)` or dropping it"
         else "needs a major bump of the dependent that pins it (not derivable from this report) or dropping it"
         end) as $remedy
      | [$b.version, $open, "no patched release in the \($maj).x line; \($remedy)"]
      | @tsv') \
      || die "body: could not render the Not-fixed-by-this-PR table from --state $state_file's requires_major_bump."
    printf '%s\n' "$bump_rows" | awk -F'\t' '{ printf "| %s | %s | %s |\n", $1, $2, $3 }'
    printf '\n'
  fi

  # ---- Verification / Collateral ------------------------------------------------
  # `.validate.checked` was already required present and non-zero before any
  # output was printed (finding #3) — a genuinely zero count, and a missing
  # field silently defaulted to zero, are the same failure from here.
  local checked hfv next_major
  checked=$(printf '%s' "$state" | jq -r '.validate.checked')
  hfv=$(printf '%s' "$group" | jq -r '.highest_fixed_version')
  next_major=$(printf '%s' "$group" | jq -r '(.major_line | tonumber) + 1')

  # `After` is a version list, and an empty one is not "nothing to show" —
  # it is the package having no resolved copy left on that line, i.e. gone.
  # Rendering an empty cell there reads as an omission, not as the fact
  # itself (finding #6); this mirrors the empty-backtick rule already
  # applied in the Not-fixed table.
  local collateral_row_filter='.[] | [(.major | tostring) + ".x", (.before | join(", ")), (if (.after | length) == 0 then "(gone)" else (.after | join(", ")) end)] | @tsv'

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
        printf '%s' "$moves_raw" | jq -r "$collateral_row_filter" \
          | awk -F'\t' '{ printf "| %s | %s | %s |\n", $1, $2, $3 }'
        printf '\nThese are within-major dedups by the package manager onto a version each line already resolved before this change, and none of these lines carries an open Dependabot alert.\n\n'
        ;;
      fatal)
        printf '| Line | Before | After |\n|---|---|---|\n'
        printf '%s' "$moves_raw" | jq -r "$collateral_row_filter" \
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
#
# The "already exists" match runs against stderr ALONE, never against
# `2>&1`-combined output: `gh`'s own error text is what carries that phrase,
# and matching the combined stream let any failure whose STDOUT happened to
# contain it — echoed input, an unrelated diagnostic — read as success
# (finding #5).
create_label() {
  local repo=$1 name=$2 color=$3 desc=$4 out err errfile st
  errfile=$(mktemp) || { printf 'cannot create a temporary file'; return 1; }
  out=$(run_env gh label create "$name" --repo "$repo" --color "$color" --description "$desc" 2>"$errfile")
  st=$?
  err=$(cat "$errfile")
  rm -f "$errfile"
  [ "$st" -eq 0 ] && return 0
  case "$err" in
    *"already exists"*) return 0 ;;
    *) printf '%s' "${err:-$out}"; return 1 ;;
  esac
}

cmd_labels() {
  local repo="" band="" env_prefix=""
  local extra_labels=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)       need_value "$1" "${2-}"; repo="$2"; shift 2 ;;
      --band)       need_value "$1" "${2-}"; band="$2"; shift 2 ;;
      --label)      need_value "$1" "${2-}"; extra_labels+=("$2"); shift 2 ;;
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

  # `gh pr create` fails outright on any label that does not already exist
  # in the repository (the old phase 6's own rule, before this script owned
  # label creation), so a caller's dispatcher-required extra labels have to
  # be ensured here too, not only passed to `create`'s `--label` — a name
  # this repository has never seen gets a neutral color and a generic
  # description, since nothing in this flow knows what the requesting
  # CLAUDE.md meant the label for.
  local l created_extra="[]"
  for l in "${extra_labels[@]:-}"; do
    [ -n "$l" ] || continue
    out=$(create_label "$repo" "$l" ededed "Required by this repository's own conventions") \
      || die "gh label create $l failed: $out"
    created_extra=$(jq -cn --argjson a "$created_extra" --arg l "$l" '$a + [$l]')
  done

  jq -n --arg band "$band_lower" --argjson extra "$created_extra" \
    '{status: "ok", labels: (["security", ("merge-risk:" + $band)] + $extra)}'
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
