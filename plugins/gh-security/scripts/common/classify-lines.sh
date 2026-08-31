#!/usr/bin/env bash
# classify-lines.sh — reconcile each actionable group's major line with what
# the repository's lockfile actually resolves
#
# Usage:
#   ... | select-adapter.sh --from-discovery | classify-lines.sh --repo-root <path> \
#         [--base-ref origin/<branch>] [--branch-style slash|flat]
#
# Input:  the routed discovery JSON select-adapter.sh emits on stdout
#         ({actionable, skipped, ...}); actionable groups carry `adapter_path`.
# Output: the same envelope with every actionable group annotated, and groups
#         whose only possible fix crosses a major moved into `skipped`.
#
# --base-ref names the tree the adapter verbs are judged against. Without it
# they read whatever is checked out at --repo-root, which is only correct when
# that checkout happens to sit clean on the default branch; a feature branch
# or a dirty lockfile silently reclassifies groups against a tree no fix agent
# will ever see (issue #158). With `--base-ref origin/<branch>` (the `origin/`
# prefix is required), this script fetches that branch, adds a short-lived
# detached worktree at the fetched ref, runs every adapter verb from that
# tree, and removes the worktree on exit — the same base the fix and audit
# agents pin their own worktrees to. The classification then matches the tree
# the dispatched work will actually branch from, whatever the user has checked
# out. The worktree is the deliberate trade against teaching every adapter to
# read lockfile blobs from a named ref; if the per-run add/remove overhead
# ever matters, blob reads are the direction to revisit.
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
#     "cross_line_collision" resolved on the line, but the package's major
#                           lines share a parent in a shape no override key
#                           in this repo's syntax can scope apart (below);
#                           `collision_parents` names the shared parents
#     "unknown"             the adapter call failed, its reply broke the
#                           contract, `present` is false, or `major_line` is
#                           "none"
#
# Routing: `requires_major_bump` groups MOVE from `actionable` to `skipped`
# with `reason: "requires major version bump"`, annotations kept, so the
# report can say "only 0.2.5 is installed; the fix line is 1.x". So do
# `cross_line_collision` groups, with `reason: "shared parent across major
# lines"`. Everything else stays actionable, including "unknown",
# deliberately: dispatching an unknown is safe (validate fail-closes later),
# while withholding a fixable group on a broken read is the wrong direction.
#
# The collision check (issue #132) runs only for a multi-major package whose
# group line is resolved, and reads two more adapter surfaces, both cached:
# `detect` (once per adapter) for the override syntax, and `declared_ranges
# --line <major>` (once per package line) for each line's eligible parent
# names and its `parents_other_lines` entries. A group is withdrawn ONLY when
# the sibling lines share an eligible parent name AND qualification cannot
# express the separation:
#
#   - Yarn `resolutions` cannot version-qualify today (a range in the key's
#     parent half parses and then silently never matches, and the
#     exact-locator form that could express the separation is unimplemented;
#     scripts/CLAUDE.md, "An override's key is scoped"), so any shared
#     parent name across lines is the collapse shape there.
#   - Under npm and pnpm, qualified keys separate the lines per parent COPY,
#     so the inexpressible shape is a single copy (one `parent@version`)
#     resolving the package on two majors at once: such an entry appears in
#     `parents_other_lines` of EVERY line's query, which is the signature
#     this check keys on. A version-less entry of a shared parent riding
#     that same intersection is treated the same way, conservatively: a
#     copy no version can name is a copy no qualifier can exclude. Both
#     shapes only arise from one manifest declaring the package across a
#     major boundary, and they poison every key naming that parent version.
#     The verdict stays per GROUP: each group whose line shares that parent
#     is withdrawn rather than dispatched to fail closed at validate one
#     install apiece, while a group whose eligible parents are disjoint from
#     every other line's stays actionable.
#
# Every other overlap stays actionable: `apply_constraint` writes
# version-qualified parent keys for npm and pnpm, which is exactly the
# separation this check verifies is available. A failed or
# contract-breaking `detect` or `declared_ranges` read leaves the group
# actionable and records a `classify_errors[]` entry; withdrawing on a
# broken read is this stage's one unsafe act.
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
# every unknown group looking identical. Under --base-ref each entry also
# carries `base_ref`, because the verbs then run in the detached base-ref
# tree: a tree-level failure there (the base branch predating the lockfile,
# say) fails once per package, and without the field every entry reads as a
# package problem reproducible in the user's own checkout, where it is not.
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

# Every hard error speaks the {"error": ...} contract through jq, never a
# printf interpolation: a double quote in a caller-supplied value (--base-ref,
# --repo-root) or in git's own stderr would otherwise emit invalid JSON at
# exactly the moment the caller needs to parse the failure (issue #158 review).
err_json() {
  jq -nc --arg m "$1" '{error: $m}' >&2
}

REPO_ROOT=""
BRANCH_STYLE="slash"
BASE_REF=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-root) REPO_ROOT="${2:?--repo-root requires a value}"; shift 2 ;;
    --base-ref) BASE_REF="${2:?--base-ref requires a value}"; shift 2 ;;
    --base-ref=*) BASE_REF="${1#--base-ref=}"; shift ;;
    --branch-style) BRANCH_STYLE="${2:?--branch-style requires a value}"; shift 2 ;;
    --branch-style=*) BRANCH_STYLE="${1#--branch-style=}"; shift ;;
    *)
      err_json "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [ -z "$REPO_ROOT" ]; then
  err_json 'Usage: classify-lines.sh --repo-root <path> [--base-ref origin/<branch>] [--branch-style slash|flat] < routed-discovery.json'
  exit 1
fi
if [ ! -d "$REPO_ROOT" ]; then
  err_json "--repo-root is not a directory: $REPO_ROOT"
  exit 1
fi
case "$BRANCH_STYLE" in
  slash|flat) ;;
  *)
    err_json "Unknown branch style: $BRANCH_STYLE (expected slash or flat)"
    exit 1
    ;;
esac
# The `origin/` prefix is required, not conventional: the fetch below derives
# the branch to refresh from it, and a local branch name here would classify
# against a ref the fetch never updated.
case "$BASE_REF" in
  ""|origin/?*) ;;
  *)
    err_json "--base-ref must name a remote-tracking ref as origin/<branch>: $BASE_REF"
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
BASE_DIR=""
cleanup() {
  # Every command here tolerates its own failure: this trap runs on the
  # success path too, and a cleanup hiccup flipping a good run's exit 0 to an
  # unexplained 1 breaks the contract in the confusing direction.
  rm -f "$ERR_FILE" || true
  if [ -n "$BASE_DIR" ]; then
    # `worktree remove` drops exactly this script's own registration; never
    # `worktree prune`, which walks every entry in the repository and can
    # delete a sibling agent's live registration (scripts/CLAUDE.md). When
    # the remove fails, KEEP the directory: deleting it anyway would orphan
    # the registration in the user's repository as a path nothing can name
    # again (the mktemp dir is anonymous), which is the exact state
    # scripts/CLAUDE.md documents as blocking later worktree adds — so leave
    # the pair intact and say how to remove it.
    if git -C "$REPO_ROOT" worktree remove --force "$BASE_DIR/tree" >/dev/null 2>&1; then
      rm -rf "$BASE_DIR" || true
    elif [ -e "$BASE_DIR/tree" ]; then
      printf 'classify-lines.sh: could not remove base-ref worktree %s; remove it with: git -C %s worktree remove --force %s\n' \
        "$BASE_DIR/tree" "$REPO_ROOT" "$BASE_DIR/tree" >&2 || true
    else
      # `worktree add` never ran or failed before creating the tree; there is
      # no registration to protect, only the empty temp dir.
      rm -rf "$BASE_DIR" || true
    fi
  fi
}
trap cleanup EXIT

# ADAPTER_ROOT is the tree every adapter verb runs from: the checkout itself
# without --base-ref, the detached base-ref worktree with it (header).
ADAPTER_ROOT="$REPO_ROOT"
if [ -n "$BASE_REF" ]; then
  # --repo-root must be the repository's own top level, not merely a
  # directory inside one: `rev-parse --git-dir` succeeds anywhere in a repo,
  # and accepting a subdirectory would silently retarget the fetch, the
  # worktree, and every adapter verb at the enclosing repository — judging
  # against a tree the caller never named, the defect class this flag exists
  # to close. Both sides resolve through pwd -P so a symlinked path (macOS
  # /tmp -> /private/tmp) cannot fail a genuine root; a linked worktree's own
  # root passes, since --show-toplevel answers per worktree.
  repo_top=$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null) || repo_top=""
  if [ -z "$repo_top" ]; then
    err_json "--base-ref requires --repo-root to be a git repository: $REPO_ROOT"
    exit 1
  fi
  if [ "$(cd "$REPO_ROOT" && pwd -P)" != "$(cd "$repo_top" && pwd -P)" ]; then
    err_json "--base-ref requires --repo-root to be the repository top level, not a subdirectory: $REPO_ROOT (top level: $repo_top)"
    exit 1
  fi
  base_branch="${BASE_REF#origin/}"
  # The refspec is explicit and forced, never `fetch origin <branch>` bare: a
  # narrowed remote.origin.fetch (a --single-branch clone, `git remote
  # set-branches`) makes the bare form exit 0 while updating only FETCH_HEAD,
  # so a stale refs/remotes/origin/<branch> from an earlier full fetch would
  # pass the verify below and classify against stale state reported as fresh.
  if ! git -C "$REPO_ROOT" fetch -q origin \
      "+refs/heads/$base_branch:refs/remotes/origin/$base_branch" 2>"$ERR_FILE"; then
    err_json "git fetch for --base-ref $BASE_REF failed: $(head -n 1 "$ERR_FILE")"
    exit 1
  fi
  if ! git -C "$REPO_ROOT" rev-parse --verify -q "refs/remotes/$BASE_REF" >/dev/null 2>&1; then
    err_json "--base-ref not found after fetch: $BASE_REF"
    exit 1
  fi
  BASE_DIR=$(mktemp -d) || {
    err_json '--base-ref could not create a temporary directory for the detached worktree (mktemp -d failed)'
    exit 1
  }
  if ! git -C "$REPO_ROOT" worktree add -q --detach "$BASE_DIR/tree" \
      "refs/remotes/$BASE_REF" 2>"$ERR_FILE"; then
    err_json "git worktree add for $BASE_REF failed: $(head -n 1 "$ERR_FILE")"
    exit 1
  fi
  ADAPTER_ROOT="$BASE_DIR/tree"
fi

GROUP_ITEMS=$(printf '%s' "$input" \
  | jq -c '(.actionable // []) | .[]' 2>"$ERR_FILE") || {
  err_json "Failed to read actionable groups: $(cat "$ERR_FILE")"
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
  err_json "Failed to read repo scope from actionable groups: $(cat "$ERR_FILE")"
  exit 1
}
if [ "$(printf '%s' "$REPOS" | jq 'length')" -gt 1 ]; then
  err_json "classify-lines.sh: actionable groups span more than one repo ($(printf '%s' "$REPOS" | jq -r 'join(", ")')); pass one repo's groups per invocation"
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
  err_json "Failed to read adapter routing from groups: $(cat "$ERR_FILE")"
  exit 1
}

CACHE='[]'
CLASSIFY_ERRORS='[]'
if [ -n "$PAIRS" ]; then
  while IFS=$'\t' read -r adapter pkg; do
    [ -n "$adapter" ] || continue
    reply=""
    ADAPTER_ERR=$(mktemp)
    if reply=$( (cd "$ADAPTER_ROOT" && "$adapter" resolved_versions "$pkg") 2>"$ADAPTER_ERR" ) \
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
        --arg br "$BASE_REF" \
        '. + [{adapter: $a, package: $p, error: $e}
              + (if $br != "" then {base_ref: $br} else {} end)]')
    fi
    rm -f "$ADAPTER_ERR"
    CACHE=$(printf '%s' "$CACHE" | jq -c --argjson e "$entry" '. + [$e]')
  done <<< "$PAIRS"
fi

# The collision check's two cached adapter reads (issue #132; header). Both
# follow the resolved_versions cache's rules: one call per key, a reply of
# the wrong shape is a broken read recorded as such, and jq carries the
# cache because bash 3.2 has no associative arrays.

# Override syntax per adapter, from `detect`. loc "" records a failed or
# contract-breaking read; err keeps its first stderr line for
# classify_errors[]. The result lands in DETECT_ENTRY rather than on stdout,
# because a command-substitution call would run the function in a subshell
# and silently discard every cache update.
DETECT_CACHE='[]'
DETECT_ENTRY=''
set_detect_entry() {
  _dl_adapter=$1
  DETECT_ENTRY=$(printf '%s' "$DETECT_CACHE" | jq -c --arg a "$_dl_adapter" \
    '(map(select(.adapter == $a)) | first) // "__miss__"')
  if [ "$DETECT_ENTRY" != '"__miss__"' ]; then
    return 0
  fi
  _dl_err_file=$(mktemp)
  _dl_loc=$( (cd "$ADAPTER_ROOT" && "$_dl_adapter" detect) 2>"$_dl_err_file" \
    | jq -r -s 'if (length == 1 and (.[0] | type == "object")
                    and ((.[0].override_location | type) == "string"))
                then .[0].override_location else "" end' 2>/dev/null) \
    || _dl_loc=""
  DETECT_ENTRY=$(jq -nc --arg a "$_dl_adapter" --arg l "$_dl_loc" \
    --arg e "$(head -n 1 "$_dl_err_file" 2>/dev/null)" \
    '{adapter: $a, loc: $l, err: $e}')
  rm -f "$_dl_err_file"
  DETECT_CACHE=$(printf '%s' "$DETECT_CACHE" \
    | jq -c --argjson e "$DETECT_ENTRY" '. + [$e]')
}

# One `declared_ranges --line` read per (adapter, package, line). eligible is
# the fix flow's own eligible-parent rule (parents_read + parents_without_range
# + parents_unreadable, agents/fix-dependency.md phase 2); other is
# parents_other_lines verbatim.
DR_CACHE='[]'
DR_ENTRY=''
set_dr_entry() {
  _dr_adapter=$1; _dr_pkg=$2; _dr_line=$3
  DR_ENTRY=$(printf '%s' "$DR_CACHE" | jq -c --arg a "$_dr_adapter" \
    --arg p "$_dr_pkg" --arg l "$_dr_line" \
    '(map(select(.adapter == $a and .package == $p and .line == $l)) | first) // "__miss__"')
  if [ "$DR_ENTRY" != '"__miss__"' ]; then
    return 0
  fi
  _dr_err_file=$(mktemp)
  _dr_reply=$( (cd "$ADAPTER_ROOT" \
    && "$_dr_adapter" declared_ranges --line "$_dr_line" "$_dr_pkg") \
    2>"$_dr_err_file" ) || _dr_reply=""
  DR_ENTRY=$(printf '%s' "$_dr_reply" | jq -c -s --arg a "$_dr_adapter" \
    --arg p "$_dr_pkg" --arg l "$_dr_line" \
    --arg e "$(head -n 1 "$_dr_err_file" 2>/dev/null)" '
    if (length == 1 and (.[0] | type == "object")
        and ((.[0].parents_read | type) == "array")
        and ((.[0].parents_without_range | type) == "array")
        and ((.[0].parents_unreadable | type) == "array")
        and ((.[0].parents_other_lines | type) == "array"))
    then {adapter: $a, package: $p, line: $l, ok: true, err: $e,
          eligible: ((.[0].parents_read + .[0].parents_without_range
                      + .[0].parents_unreadable) | unique),
          other: (.[0].parents_other_lines | unique)}
    else {adapter: $a, package: $p, line: $l, ok: false, err: $e}
    end' 2>/dev/null) \
    || DR_ENTRY=$(jq -nc --arg a "$_dr_adapter" --arg p "$_dr_pkg" \
         --arg l "$_dr_line" --arg e "$(head -n 1 "$_dr_err_file" 2>/dev/null)" \
         '{adapter: $a, package: $p, line: $l, ok: false, err: $e}')
  rm -f "$_dr_err_file"
  DR_CACHE=$(printf '%s' "$DR_CACHE" | jq -c --argjson e "$DR_ENTRY" '. + [$e]')
}

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
              --arg br "$BASE_REF" \
              '. + [{adapter: $a, package: $p, error: $e}
                    + (if $br != "" then {base_ref: $br} else {} end)]')
            ;;
        esac
        rm -f "$CMP_ERR"
      done <<< "$versions"
    fi

    # The cross-line collision check (issue #132; header). Only a resolved
    # multi-major group can collide: with no copy on the line there is
    # nothing for a shared parent's override to reach, and validate settles
    # the rest.
    collision_parents=null
    if [ "$status" = "resolved" ] \
      && [ "$(printf '%s' "$majors" | jq 'length > 1')" = "true" ]; then
      set_detect_entry "$adapter"
      loc=$(printf '%s' "$DETECT_ENTRY" | jq -r '.loc')
      rows='[]'
      rows_ok=true
      if [ -z "$loc" ]; then
        rows_ok=false
        CLASSIFY_ERRORS=$(printf '%s' "$CLASSIFY_ERRORS" | jq -c \
          --arg a "$adapter" --arg p "$pkg" \
          --arg e "$(printf '%s' "$DETECT_ENTRY" | jq -r '.err // ""')" \
          --arg br "$BASE_REF" \
          '. + [{adapter: $a, package: $p,
                 error: (if $e == "" then "detect failed or broke its contract; collision check skipped" else $e end)}
                + (if $br != "" then {base_ref: $br} else {} end)]')
      else
        while IFS= read -r m; do
          [ -n "$m" ] || continue
          set_dr_entry "$adapter" "$pkg" "$m"
          if [ "$(printf '%s' "$DR_ENTRY" | jq -r '.ok')" != "true" ]; then
            rows_ok=false
            CLASSIFY_ERRORS=$(printf '%s' "$CLASSIFY_ERRORS" | jq -c \
              --arg a "$adapter" --arg p "$pkg" --arg m "$m" \
              --arg e "$(printf '%s' "$DR_ENTRY" | jq -r '.err // ""')" \
              --arg br "$BASE_REF" \
              '. + [{adapter: $a, package: $p,
                     error: (if $e == "" then "declared_ranges --line \($m) failed or broke its contract; collision check skipped" else $e end)}
                    + (if $br != "" then {base_ref: $br} else {} end)]')
            break
          fi
          rows=$(printf '%s' "$rows" | jq -c --argjson e "$DR_ENTRY" '. + [$e]')
        done <<EOF
$(printf '%s' "$majors" | jq -r '.[]')
EOF
      fi
      if [ "$rows_ok" = "true" ]; then
        verdict=$(printf '%s' "$rows" | jq -c --arg line "$line" --arg loc "$loc" '
          # The parent name of a parents_other_lines entry: everything
          # before the last "@" when one qualifies a version, the whole
          # entry otherwise (a scoped name'\''s leading "@" is index 0 and
          # never splits).
          def name_of: (rindex("@") // 0) as $i
            | if $i > 0 then .[0:$i] else . end;
          . as $rows
          # $mine is never null: the check runs only for line_status
          # "resolved", so the group line is one of the queried majors.
          | (map(select(.line == $line)) | first) as $mine
          | ([ $mine.eligible[] | . as $n
               | select(any($rows[];
                   .line != $line and ((.eligible | index($n)) != null))) ]) as $overlap
          | if ($overlap | length) == 0 then {collision: false}
            elif $loc == "resolutions" then {collision: true, parents: $overlap}
            else
              # An entry in EVERY line query'\''s parents_other_lines is a
              # copy resolving the package on more than one major (header).
              (reduce $rows[] as $r ($rows[0].other;
                 . as $acc
                 | [ $r.other[] | . as $e
                     | select(($acc | index($e)) != null) ])) as $shared
              | ([ $shared[] | name_of | select(. as $n | ($overlap | index($n)) != null) ]
                 | unique) as $bad
              | if ($bad | length) > 0 then {collision: true, parents: $bad}
                else {collision: false} end
            end')
        if [ "$(printf '%s' "$verdict" | jq -r '.collision')" = "true" ]; then
          status="cross_line_collision"
          collision_parents=$(printf '%s' "$verdict" | jq -c '.parents')
        fi
      fi
    fi

    annotation=$(jq -nc --argjson m "$majors" --arg s "$status" \
      --argjson cp "$collision_parents" \
      '{resolved_majors: $m, line_status: $s}
       + (if $cp != null then {collision_parents: $cp} else {} end)')
    CLASS=$(printf '%s' "$CLASS" | jq -c --argjson a "$annotation" '. + [$a]')
  done <<< "$GROUP_ITEMS"
fi

annotated=$(printf '%s' "$input" | jq --argjson cls "$CLASS" \
  --argjson classify_errors "$CLASSIFY_ERRORS" --arg branch_style "$BRANCH_STYLE" '
  (.actionable // []) as $groups
  | [range($groups | length) | $groups[.] + $cls[.]] as $all
  | . as $input
  | {
      actionable: [ $all[] | select(.line_status != "requires_major_bump"
                                    and .line_status != "cross_line_collision") ],
      skipped: ((.skipped // []) + [
        $all[] | select(.line_status == "requires_major_bump")
               | . + {reason: "requires major version bump"}
      ] + [
        $all[] | select(.line_status == "cross_line_collision")
               | . + {reason: "shared parent across major lines"}
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
  err_json "Failed to classify discovery JSON: $(cat "$ERR_FILE")"
  exit 1
}
printf '%s\n' "$annotated"
