#!/usr/bin/env bash
# fix-group.sh — the deterministic driver for one dependency-fix group
#
# Usage:
#   fix-group.sh setup    --group-json <file> --repo-root <path>
#                         --default-branch <name> --adapter <path>
#                         [--env-prefix "<string>"] [--scorer <path>]
#   fix-group.sh classify --work <dir>
#   fix-group.sh baseline --work <dir>
#   fix-group.sh apply    --work <dir>
#   fix-group.sh score    --work <dir>
#   fix-group.sh cleanup  --work <dir> [--pushed]
#
# This script is the single home of `agents/fix-dependency.md` phases 1 to 5
# and Cleanup. Every branch it takes was an enumerated branch of that document
# first, each one added to fix a field defect (#83, #84, #103, #105, #122,
# #123, #124, #132, #146, #147, #161), and a fully enumerated decision tree is
# a script that has not been written yet (#171). **A prose re-derivation of any
# of this in an agent definition is a bug**: the agent calls the steps below
# and applies judgment only where the driver hands control back.
#
# Stepped, with a state file at `$WORK/state.json`, rather than one run. The
# Bash tool's 10-minute ceiling cannot wrap a control install plus a fix
# install (field runs: ~4 minutes each, up to ~17 minutes total), and the
# remediation ladder needs a seam where judgment can escape to the agent.
#
# Contract:
#   exit 0  {"status":"ok", ...}            an intermediate step completed
#           {"status":"no_op", ...}         terminal: nothing to fix (apply)
#           {"status":"ready_for_pr", ...}  terminal: hand to phase 6 (score)
#   exit 2  {"status":"needs_judgment","decision_point":"...","evidence":{...}}
#           a branch the tree cannot decide. Fail closed, never guess.
#   exit 3  {"status":"failure","phase":"worktree|classify|baseline|apply|
#            install|validate","detail":"..."}   terminal failure, mapped
#           verbatim onto the agent's result block. `push` and `pr` stay
#           agent-side; they name work this driver never does.
#   exit 1  {"error":"..."}                 usage or internal error
#
# All JSON goes to stdout; human-readable detail goes to stderr.
#
# `--env-prefix` is an opaque argv prefix (scripts/CLAUDE.md, "`env_prefix` is
# an opaque, optional seam"). It is split on whitespace and prepended verbatim
# to every git, adapter and package-manager invocation, composed **after** any
# `cd`: it injects environment, it does not chdir. Absent means bare.
#
# Dependencies are bash, jq and gh only (scripts/CLAUDE.md). bash 3.2: no
# associative arrays, no `mapfile`, no `${var,,}`.

set -uo pipefail

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

# The drift commit's subject is load-bearing in three places — the stale-branch
# guard (setup), the commit itself (baseline), and the cleanup safety check —
# so it is spelled once.
DRIFT_SUBJECT='chore(deps): refresh lockfile (control install, no manifest change)'

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

die() {
  printf '%s\n' "$1" >&2
  jq -n --arg e "$1" '{error: $e}'
  exit 1
}

fail_phase() {
  printf 'fix-group: %s failure: %s\n' "$1" "$2" >&2
  jq -n --arg p "$1" --arg d "$2" '{status: "failure", phase: $p, detail: $d}'
  exit 3
}

needs_judgment() {
  printf 'fix-group: needs judgment at %s\n' "$1" >&2
  jq -n --arg dp "$1" --argjson ev "$2" \
    '{status: "needs_judgment", decision_point: $dp, evidence: $ev}'
  exit 2
}

# `true`/`false` as a JSON literal, for the many places a shell boolean has to
# become one. Written once rather than as an `&&`/`||` chain per site.
jbool() {
  if [ "$1" = true ]; then printf 'true'; else printf 'false'; fi
}

# ---------------------------------------------------------------------------
# env_prefix
#
# An opaque argv prefix, split on whitespace and prepended verbatim. bash 3.2
# has no safe empty-array expansion under `set -u`, so the element count is
# tracked in its own variable rather than read off the array.
# ---------------------------------------------------------------------------

ENV_PREFIX_ARGV=()
ENV_PREFIX_N=0

set_env_prefix() {
  ENV_PREFIX_ARGV=()
  ENV_PREFIX_N=0
  case "${1:-}" in
    ''|null) return 0 ;;
  esac
  # `read -a` splits on IFS, which is the whitespace splitting this wants,
  # without the unquoted expansion an array literal would need.
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
# State
# ---------------------------------------------------------------------------

STATE=""

state_get() {
  jq -r "$1" "$STATE" 2>/dev/null
}

state_getj() {
  jq -c "$1" "$STATE" 2>/dev/null
}

state_set() {
  # One key per call, written through a temp file so a jq failure cannot
  # truncate the state a later step depends on.
  local tmp
  tmp="$STATE.tmp"
  jq --arg k "$1" --argjson v "$2" '.[$k] = $v' "$STATE" > "$tmp" \
    || die "cannot update state key '$1'"
  mv "$tmp" "$STATE" || die "cannot replace state file"
}

state_set_str() {
  local tmp
  tmp="$STATE.tmp"
  jq --arg k "$1" --arg v "$2" '.[$k] = $v' "$STATE" > "$tmp" \
    || die "cannot update state key '$1'"
  mv "$tmp" "$STATE" || die "cannot replace state file"
}

load_state() {
  WORK="${1:?--work is required}"
  STATE="$WORK/state.json"
  [ -f "$STATE" ] || die "no state file at $STATE; run 'setup' first"
  REPO_ROOT=$(state_get '.repo_root')
  DEFAULT_BRANCH=$(state_get '.default_branch')
  BRANCH_NAME=$(state_get '.branch_name')
  ADAPTER=$(state_get '.adapter')
  SCORER=$(state_get '.scorer')
  WT=$(state_get '.worktree')
  PACKAGE=$(state_get '.package')
  MAJOR_LINE=$(state_get '.major_line')
  set_env_prefix "$(state_get '.env_prefix')"
}

# ---------------------------------------------------------------------------
# Adapter and git seams
#
# Every git call carries `-C`; every adapter call `cd`s into the worktree in a
# subshell, exactly as scripts/CLAUDE.md's "No Bash snippet may depend on the
# previous call" requires of the prescribed shapes this replaces. The adapter's
# write verbs stay behind require-linked-worktree.sh either way.
# ---------------------------------------------------------------------------

git_at() {
  local dir=$1
  shift
  run_env git -C "$dir" "$@"
}

# Run an adapter verb capturing stdout and stderr separately.
# Sets ADAPTER_OUT, ADAPTER_ERR, ADAPTER_STATUS.
adapter_run() {
  local errfile
  errfile=$(mktemp) || die "cannot create a temporary file"
  ADAPTER_OUT=$( ( cd "$WT" && run_env "$ADAPTER" "$@" ) 2>"$errfile" )
  ADAPTER_STATUS=$?
  ADAPTER_ERR=$(cat "$errfile")
  rm -f "$errfile"
  return "$ADAPTER_STATUS"
}

# The adapter reports failures as {"error": "..."} on stderr; quote that when
# it is there and the raw stream when it is not.
adapter_error_text() {
  local msg
  msg=$(printf '%s' "$ADAPTER_ERR" | jq -r 'if type == "object" and has("error") then .error else empty end' 2>/dev/null)
  if [ -n "$msg" ]; then
    printf '%s' "$msg"
  else
    printf '%s' "$ADAPTER_ERR"
  fi
}

# ---------------------------------------------------------------------------
# Installs
#
# One sanctioned retry per install invocation, and only on a registry-timeout
# shape. Never a bare repeat of the same command for any other failure: a verb
# that exited non-zero twice on the same inputs with no remediation in between
# has failed its phase (#122).
# ---------------------------------------------------------------------------

registry_timeout_shaped() {
  printf '%s' "$1" | grep -Eqi \
    'ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|request to .* failed|Timeout awaiting|read ECONNRESET|registry.*timed? ?out'
}

# Sets INSTALL_ERR and INSTALL_RETRIED; returns the install's exit status.
run_install() {
  local errfile out st
  INSTALL_RETRIED=false
  errfile=$(mktemp) || die "cannot create a temporary file"
  out=$( ( cd "$WT" && run_env "$ADAPTER" install ) 2>"$errfile" )
  st=$?
  INSTALL_ERR=$(printf '%s\n%s' "$out" "$(cat "$errfile")")
  if [ "$st" -ne 0 ] && registry_timeout_shaped "$INSTALL_ERR"; then
    INSTALL_RETRIED=true
    out=$( ( cd "$WT" && run_env "$ADAPTER" install ) 2>"$errfile" )
    st=$?
    INSTALL_ERR=$(printf '%s\n%s' "$out" "$(cat "$errfile")")
  fi
  rm -f "$errfile"
  return "$st"
}

# ---------------------------------------------------------------------------
# Paths the drift commit may carry
#
# The lockfile always; the regenerated PnP artifacts; and, in a zero-install
# Yarn Berry repository, every `.yarn/cache/` path the install moved.
# Never `package.json`: the control install had no manifest edit to make, so
# a modified manifest here is the anomaly the residual check exists to catch.
# ---------------------------------------------------------------------------

drift_path_allowed() {
  case "$1" in
    package-lock.json|npm-shrinkwrap.json|pnpm-lock.yaml|yarn.lock) return 0 ;;
    .pnp.cjs|.pnp.loader.mjs) return 0 ;;
    .yarn/cache/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Print one path per line from `git status --porcelain` output. A rename keeps
# its destination; a quoted path (one carrying bytes git escapes) is emitted
# verbatim, which `drift_path_allowed` then refuses, so it lands in the
# residual report rather than in a commit.
porcelain_paths() {
  local line p
  printf '%s\n' "$1" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    p=${line:3}
    case "$p" in
      *' -> '*) p=${p##* -> } ;;
    esac
    printf '%s\n' "$p"
  done
}

# ---------------------------------------------------------------------------
# Version helpers — comparison stays behind the adapter (scripts/CLAUDE.md)
# ---------------------------------------------------------------------------

# Lowest version on the group's major line, from a `resolved_versions` payload.
# Falls back to the lowest version overall when the line holds none, and prints
# nothing when the payload carries no versions at all.
lowest_on_line() {
  local payload=$1 line=$2 versions v lowest cmp
  versions=$(printf '%s' "$payload" | jq -r --arg l "$line" '
    [ .versions[]? | .version
      | select(test("^" + $l + "([.]|$)")) ] | .[]' 2>/dev/null)
  if [ -z "$versions" ]; then
    versions=$(printf '%s' "$payload" | jq -r '[ .versions[]? | .version ] | .[]' 2>/dev/null)
  fi
  lowest=""
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    if [ -z "$lowest" ]; then
      lowest=$v
      continue
    fi
    cmp=$( ( cd "$WT" && run_env "$ADAPTER" compare_versions "$v" "$lowest" ) 2>/dev/null \
           | jq -r '.result // empty')
    if [ "$cmp" = "-1" ]; then lowest=$v; fi
  done <<EOF
$versions
EOF
  printf '%s' "$lowest"
}

# The versions of this group's line, sorted, as a compact JSON array. The
# drift-cleared test compares two of these.
line_versions() {
  printf '%s' "$1" | jq -c --arg l "$2" \
    '[ .versions[]? | .version | select(test("^" + $l + "([.]|$)")) ] | unique' 2>/dev/null
}

# ---------------------------------------------------------------------------
# setup — phase 1
# ---------------------------------------------------------------------------

cmd_setup() {
  local group_file="" repo_root="" default_branch="" adapter_path="" env_prefix="" scorer=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --group-json)     group_file="${2:?--group-json requires a file}"; shift 2 ;;
      --repo-root)      repo_root="${2:?--repo-root requires a path}"; shift 2 ;;
      --default-branch) default_branch="${2:?--default-branch requires a name}"; shift 2 ;;
      --adapter)        adapter_path="${2:?--adapter requires a path}"; shift 2 ;;
      --env-prefix)     env_prefix="${2-}"; shift 2 ;;
      # A test seam, like node.sh's shim runner override: the specs replace the
      # scorer with a shim that records its argv.
      --scorer)         scorer="${2:?--scorer requires a path}"; shift 2 ;;
      *) die "setup: unknown option '$1'" ;;
    esac
  done

  [ -n "$group_file" ] || die "setup requires --group-json"
  [ -n "$repo_root" ] || die "setup requires --repo-root"
  [ -n "$default_branch" ] || die "setup requires --default-branch"
  [ -n "$adapter_path" ] || die "setup requires --adapter"
  [ -f "$group_file" ] || die "setup: no such group file: $group_file"
  [ -d "$repo_root" ] || die "setup: no such repo root: $repo_root"
  [ -n "$scorer" ] || scorer="$SELF_DIR/score-merge-risk.sh"

  local group
  group=$(jq -c '.' "$group_file") || die "setup: --group-json is not readable JSON"
  local missing
  missing=$(printf '%s' "$group" | jq -r '
    ["package","major_line","branch_name","highest_fixed_version","alerts"]
    - (to_entries | map(.key)) | join(", ")')
  [ -z "$missing" ] || die "setup: the group payload is missing: $missing"

  local package major_line branch_name package_path work
  package=$(printf '%s' "$group" | jq -r '.package')
  major_line=$(printf '%s' "$group" | jq -r '.major_line | tostring')
  branch_name=$(printf '%s' "$group" | jq -r '.branch_name')

  # The `/` replacement is not cosmetic. A scoped name interpolated verbatim
  # turns into a directory separator, leaving an interposed
  # `fix-dependabot-@scope/` directory behind forever while the reap — handed
  # the leaf — reports a clean sweep (#161).
  package_path=$(printf '%s' "$package" | tr '/' '-')
  work="$repo_root/.claude/worktrees/fix-dependabot-$package_path-${major_line}x"

  set_env_prefix "$env_prefix"

  # 1. Crashed-run guard. A surviving $WORK means a failed or crashed run, or a
  #    session that is not this flow at all. Neither is ours to clear.
  if [ -e "$work" ]; then
    fail_phase worktree "a previous run's workspace already exists at $work. A run that completed removes it, so this is a crashed or failed run's leftover. Inspect it, then remove it by hand: git -C $repo_root worktree remove --force $work/fix, then delete the directory. Never reuse or silently delete it."
  fi

  # 2. Stale-branch guard. It verifies rather than stops on sight: stopping on
  #    the mere existence of a local branch deadlocked the flow against its own
  #    leftovers (#84).
  local ferr
  ferr=$(git_at "$repo_root" fetch origin "$default_branch" 2>&1) \
    || fail_phase worktree "git fetch origin $default_branch failed: $ferr"
  # No remote branch of that name is the ordinary case, not an error.
  git_at "$repo_root" fetch origin "$branch_name" >/dev/null 2>&1

  local listed tip dflt remote
  listed=$(git_at "$repo_root" branch --list "$branch_name" 2>&1) \
    || fail_phase worktree "git branch --list $branch_name failed: $listed"
  dflt=$(git_at "$repo_root" rev-parse "origin/$default_branch" 2>&1) \
    || fail_phase worktree "git rev-parse origin/$default_branch failed: $dflt"

  if [ -n "$listed" ]; then
    tip=$(git_at "$repo_root" rev-parse "$branch_name" 2>&1) \
      || fail_phase worktree "git rev-parse $branch_name failed: $tip"
    remote=$(git_at "$repo_root" rev-parse "origin/$branch_name" 2>/dev/null) || remote=""

    local safe=false reason=""
    if [ "$tip" = "$dflt" ]; then
      safe=true
      reason="tip equals origin/$default_branch: a previous run created the branch and committed nothing to it"
    elif [ -n "$remote" ] && [ "$tip" = "$remote" ]; then
      safe=true
      reason="tip equals origin/$branch_name: a previous run pushed it and the remote still carries the same commits"
    else
      # The third recognized tip: a single drift commit, and it is recognized
      # by BOTH checks, never either alone (#152).
      local subjects nsubj names ok=true
      subjects=$(git_at "$repo_root" log --format=%s "origin/$default_branch..$branch_name" 2>/dev/null)
      nsubj=$(printf '%s\n' "$subjects" | grep -c . || true)
      names=$(git_at "$repo_root" diff --name-only "origin/$default_branch" "$branch_name" 2>/dev/null)
      if [ "$nsubj" != "1" ] || [ "$subjects" != "$DRIFT_SUBJECT" ]; then
        ok=false
      fi
      if [ "$ok" = true ]; then
        local n
        while IFS= read -r n; do
          [ -n "$n" ] || continue
          drift_path_allowed "$n" || { ok=false; break; }
        done <<EOF
$names
EOF
        [ -n "$names" ] || ok=false
      fi
      if [ "$ok" = true ]; then
        safe=true
        reason="the only commit beyond origin/$default_branch is this flow's drift commit, over the lockfile and tracked install artifacts alone"
      fi
    fi

    if [ "$safe" = true ]; then
      local derr
      derr=$(git_at "$repo_root" branch -D "$branch_name" 2>&1) \
        || fail_phase worktree "git branch -D $branch_name failed ($reason): $derr"
    else
      fail_phase worktree "the local branch $branch_name is not this flow's own leftover, so it may hold unpushed work. Inspect it before rerunning; it was not deleted. tip=$tip origin/$default_branch=$dflt origin/$branch_name=${remote:-<none>}"
    fi
  fi

  local aerr
  aerr=$(mkdir -p "$repo_root/.claude/worktrees" 2>&1) \
    || fail_phase worktree "cannot create $repo_root/.claude/worktrees: $aerr"
  aerr=$(git_at "$repo_root" worktree add "$work/fix" -b "$branch_name" "origin/$default_branch" 2>&1) \
    || fail_phase worktree "git worktree add $work/fix failed: $aerr"

  STATE="$work/state.json"
  jq -n \
    --argjson group "$group" \
    --arg repo_root "$repo_root" \
    --arg default_branch "$default_branch" \
    --arg adapter "$adapter_path" \
    --arg scorer "$scorer" \
    --arg env_prefix "$env_prefix" \
    --arg work "$work" \
    --arg worktree "$work/fix" \
    --arg branch_name "$branch_name" \
    --arg package "$package" \
    --arg package_path "$package_path" \
    --arg major_line "$major_line" \
    '{group: $group, repo_root: $repo_root, default_branch: $default_branch,
      adapter: $adapter, scorer: $scorer, env_prefix: $env_prefix,
      work: $work, worktree: $worktree, branch_name: $branch_name,
      package: $package, package_path: $package_path, major_line: $major_line,
      drift_commit: false}' > "$STATE" \
    || die "setup: cannot write $STATE"

  jq -n --arg work "$work" --arg worktree "$work/fix" --arg branch "$branch_name" \
    --arg package "$package" --arg line "$major_line" \
    '{status: "ok", step: "setup", work: $work, worktree: $worktree,
      branch: $branch, package: $package, major_line: $line}'
}

# ---------------------------------------------------------------------------
# classify — phase 2
#
# Runs on the never-installed tree, before the control install: `why` and
# `declared_ranges` parse the lockfile, so a dead end this phase can name costs
# no install at all (#103).
# ---------------------------------------------------------------------------

cmd_classify() {
  local work=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --work) work="${2:?--work requires a directory}"; shift 2 ;;
      *) die "classify: unknown option '$1'" ;;
    esac
  done
  load_state "$work"

  adapter_run why "$PACKAGE" \
    || fail_phase classify "adapter why $PACKAGE failed: $(adapter_error_text)"
  local why=$ADAPTER_OUT
  printf '%s' "$why" | jq -e 'type == "object"' >/dev/null 2>&1 \
    || fail_phase classify "adapter why $PACKAGE did not return a JSON object"

  # A peer_only package is a structural dead end: every edge reaching it is
  # pnpm recording a peer resolution rather than a declaration, so no override
  # key can move it. One field run burned four install cycles proving a shape
  # `why` names before any install runs (#103).
  if [ "$(printf '%s' "$why" | jq -r '.peer_only')" = "true" ]; then
    local peers optional
    peers=$(printf '%s' "$why" | jq -c '.peer_parents')
    optional=$(printf '%s' "$why" | jq -c '.optional_peer_parents')
    fail_phase classify "peer_only_dependency: $PACKAGE is reached only through peer resolutions, so no override key can move it. peer_parents=$peers optional_peer_parents=$optional. The remedy is human work no override can substitute for: a major bump of one of the REQUIRED peer parents wide enough to require a patched range, or a real dependency declaration that gives the package an edge an override can reach. Bumping a parent that merely tolerates the package cannot force a patched range."
  fi

  adapter_run declared_ranges --line "$MAJOR_LINE" "$PACKAGE" \
    || fail_phase classify "adapter declared_ranges --line $MAJOR_LINE $PACKAGE failed: $(adapter_error_text)"
  local declared=$ADAPTER_OUT
  printf '%s' "$declared" | jq -e 'type == "object"' >/dev/null 2>&1 \
    || fail_phase classify "adapter declared_ranges did not return a JSON object"

  # The eligible set is parents_read + parents_unreadable + parents_without_range,
  # minus nothing else. Only parents_other_lines are excluded: their copy is on
  # another major, a sibling agent owns it (#83). An undeterminable line is not
  # evidence of a different one, so an all-unreadable parent list stays eligible
  # (#76). Scope by parent NAME: an entry may carry the parent's resolved
  # version when the exclusion was decided per copy (#85).
  local eligible
  eligible=$(printf '%s' "$declared" | jq -c '
    def bare_name:
      . as $k
      | ($k | rindex("@")) as $i
      | if $i == null or $i == 0 then $k else $k[0:$i] end;
    [ (.parents_read // [])[],
      (.parents_unreadable // [])[],
      (.parents_without_range // [])[] ]
    | map(bare_name) | unique')

  state_set why "$why"
  state_set declared "$declared"
  state_set eligible_parents "$eligible"
  state_set_str relationship "$(printf '%s' "$why" | jq -r '.relationship')"

  jq -n --argjson why "$why" --argjson declared "$declared" --argjson eligible "$eligible" \
    '{status: "ok", step: "classify",
      relationship: $why.relationship,
      eligible_parents: $eligible,
      parents_read: ($declared.parents_read // []),
      parents_without_range: ($declared.parents_without_range // []),
      parents_unreadable: ($declared.parents_unreadable // []),
      parents_malformed: ($declared.parents_malformed // []),
      parents_other_lines: ($declared.parents_other_lines // []),
      ranges: ($declared.ranges // [])}'
}

# ---------------------------------------------------------------------------
# baseline — phase 3
# ---------------------------------------------------------------------------

cmd_baseline() {
  local work=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --work) work="${2:?--work requires a directory}"; shift 2 ;;
      *) die "baseline: unknown option '$1'" ;;
    esac
  done
  load_state "$work"

  # The pre-drift snapshot: the lockfile exactly as origin/<default_branch>
  # committed it, parsed before any install. Kept verbatim and separate from
  # the baseline; the drift-cleared test and, on a lockfile-refresh, phase 5's
  # `--before` both read it.
  adapter_run resolved_versions "$PACKAGE" \
    || fail_phase baseline "the lockfile could not be parsed before the control install (resolved_versions $PACKAGE): $(adapter_error_text). A failed parse is never an empty result."
  local pre_drift=$ADAPTER_OUT
  state_set pre_drift "$pre_drift"

  # The control install: the manifest exactly as the default branch declares
  # it, no fix applied. A failure here is phase `baseline`, never `install` —
  # it is ambient and will hit every group dispatched against this repo.
  if ! run_install; then
    local retried_note=""
    if [ "$INSTALL_RETRIED" = true ]; then
      retried_note=" (including one sanctioned retry after a registry-timeout-shaped failure)"
    fi
    fail_phase baseline "the control install${retried_note}, with no manifest change, failed. Quoting the package manager: $INSTALL_ERR"
  fi

  local porcelain
  porcelain=$(git_at "$WT" status --porcelain 2>&1) \
    || fail_phase baseline "git status --porcelain failed in the worktree: $porcelain"

  local drift=false
  if [ -n "$porcelain" ]; then
    local paths staged=0 p
    paths=$(porcelain_paths "$porcelain")
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if drift_path_allowed "$p"; then
        local aerr
        aerr=$(git_at "$WT" add -- "$p" 2>&1) \
          || fail_phase baseline "git add $p failed: $aerr"
        staged=$((staged + 1))
      fi
    done <<EOF
$paths
EOF
    if [ "$staged" -gt 0 ]; then
      local cerr
      cerr=$(git_at "$WT" commit -m "$DRIFT_SUBJECT" 2>&1) \
        || fail_phase baseline "the drift commit failed, quoting the repository's own output (never bypass a hook, never edit anything to satisfy one): $cerr"
      drift=true
    fi

    porcelain=$(git_at "$WT" status --porcelain 2>&1) \
      || fail_phase baseline "git status --porcelain failed in the worktree: $porcelain"
    if [ -n "$porcelain" ]; then
      fail_phase baseline "the control install touched paths other than the lockfile and its tracked install artifacts, and what an install writes outside those paths is evidence, never noise to absorb. Residual git status --porcelain: $porcelain"
    fi
  fi

  # Only then the baseline. The ordering is the point (#146): the snapshot
  # describes the post-control-install tree, so validate's other_line_moves
  # measures only movement the fix itself causes.
  adapter_run resolved_versions "$PACKAGE" \
    || fail_phase baseline "the lockfile could not be parsed after the control install (resolved_versions $PACKAGE): $(adapter_error_text). A failed parse is never an empty result."
  local baseline=$ADAPTER_OUT
  state_set baseline "$baseline"
  state_set drift_commit "$(jbool "$drift")"

  jq -n --argjson drift "$(jbool "$drift")" \
    --argjson baseline "$baseline" --argjson pre "$pre_drift" \
    '{status: "ok", step: "baseline", drift_commit: $drift,
      baseline_present: ($baseline.present // false),
      pre_drift_present: ($pre.present // false)}'
}

# ---------------------------------------------------------------------------
# apply — phase 4
# ---------------------------------------------------------------------------

# The fix installs this phase is allowed, across the whole remediation ladder.
# The bound is the ladder's, not the retry rule's: a sanctioned registry-timeout
# retry rides inside one invocation and does not spend a step.
FIX_INSTALL_BUDGET=4
FIX_INSTALLS=0

APPLIED_PARENTS_JSON='[]'
APPLY_RESULT=''
OBSERVATIONS_FIRST='[]'
TIGHTEN_BARE_RAN=false
VALIDATE_JSON=''
VALIDATE_OK=false

apply_call() {
  # $1 = "--tighten-bare" or ""; remaining = parents
  local tighten=$1
  shift
  local args=()
  [ -z "$tighten" ] || args+=("$tighten")
  args+=("$PACKAGE" "$RANGE")
  local p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    args+=("$p")
  done <<EOF
$(printf '%s' "$APPLIED_PARENTS_JSON" | jq -r '.[]')
EOF

  adapter_run apply_constraint "${args[@]}" \
    || fail_phase apply "apply_constraint refused or failed, and nothing was written. Quoting the adapter verbatim: $(adapter_error_text)"
  APPLY_RESULT=$ADAPTER_OUT
  printf '%s' "$APPLY_RESULT" | jq -e 'type == "object"' >/dev/null 2>&1 \
    || fail_phase apply "apply_constraint did not return a JSON object"

  # Reject a written `npm:` value naming a different package. Entries carrying
  # `preserved: true` are skipped first: those quote a pre-existing value the
  # adapter kept while restructuring a string-valued rule into its `"."` self
  # key, so failing the run on one aborts a correct fix (#49, #147).
  local retarget
  retarget=$(printf '%s' "$APPLY_RESULT" | jq -c --arg pkg "$PACKAGE" '
    [ .written[]?
      | select((.preserved // false) != true)
      | select((.value | type) == "string" and (.value | startswith("npm:")))
      | . as $e
      | (.value[4:]) as $rest
      | ($rest | rindex("@")) as $i
      | (if $i == null or $i == 0 then $rest else $rest[0:$i] end) as $named
      | select($named != $pkg) ] | first // empty')
  if [ -n "$retarget" ]; then
    fail_phase apply "apply_constraint retargeted a declaration that merely collides with this package's name: $retarget. The adapter cannot tell the two senses of the key apart and neither can this flow, so the fix install was not run and no PR was opened. Escalate as a repository that needs the name collision resolved by hand (#49)."
  fi
}

validate_call() {
  local args=(validate --line "$MAJOR_LINE")
  local r
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    args+=(--vulnerable "$r")
  done <<EOF
$(state_getj '.group.alerts' | jq -r '[ .[].vulnerable_range | select(. != null) ] | unique | .[]')
EOF
  args+=(--baseline "$(state_getj '.baseline')")
  # `[]` is a real answer and is passed as `[]`. When the field is ABSENT from
  # the payload the flag is omitted entirely, which makes validate class every
  # cross-line move fatal — the intended fail-safe default (#105).
  if [ "$(state_get 'has("group") and (.group | has("sibling_alerts"))')" = "true" ]; then
    args+=(--sibling-alerts "$(state_getj '.group.sibling_alerts')")
  fi
  args+=("$PACKAGE" "$RANGE")

  adapter_run "${args[@]}"
  local st=$ADAPTER_STATUS
  VALIDATE_JSON=$ADAPTER_OUT
  if ! printf '%s' "$VALIDATE_JSON" | jq -e 'type == "object" and has("ok")' >/dev/null 2>&1; then
    fail_phase validate "validate produced no readable report: $(adapter_error_text)"
  fi
  if [ "$st" -eq 0 ]; then VALIDATE_OK=true; else VALIDATE_OK=false; fi

  # Any fatal cross-line move stops the run. This is fail-closed and not a
  # judgement call: the constraint and completeness checks are both scoped to
  # --line and structurally cannot see an out-of-line copy (#83).
  local fatal
  fatal=$(printf '%s' "$VALIDATE_JSON" | jq -c '[ .other_line_moves[]? | select(.class == "fatal") ]')
  if [ "$fatal" != "[]" ]; then
    fail_phase validate "the install moved a copy of $PACKAGE on a major line this group does not own. Narrowing the key is not the remedy; escalate the repository. other_line_moves fatal entries: $fatal. Entries apply_constraint wrote: $(printf '%s' "$APPLY_RESULT" | jq -c '.written')"
  fi
}

fix_install_step() {
  if [ "$FIX_INSTALLS" -ge "$FIX_INSTALL_BUDGET" ]; then
    needs_judgment "install_budget_exhausted" \
      "$(jq -n --argjson n "$FIX_INSTALLS" --argjson v "${VALIDATE_JSON:-null}" \
        '{fix_installs: $n, validate: $v}')"
  fi
  FIX_INSTALLS=$((FIX_INSTALLS + 1))
  if ! run_install; then
    # Everything the ladder does not cover is the agent's to diagnose: a peer
    # conflict needing a wider range, a version that does not exist.
    needs_judgment "install_failure" \
      "$(jq -n --arg err "$INSTALL_ERR" --argjson retried "$INSTALL_RETRIED" \
         --argjson n "$FIX_INSTALLS" --argjson written "$(printf '%s' "$APPLY_RESULT" | jq -c '.written')" \
         '{phase: "apply", error: $err, registry_timeout_retry: $retried,
           fix_installs: $n, written: $written}')"
  fi
}

cmd_apply() {
  local work=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --work) work="${2:?--work requires a directory}"; shift 2 ;;
      *) die "apply: unknown option '$1'" ;;
    esac
  done
  load_state "$work"

  local hfv relationship
  hfv=$(state_get '.group.highest_fixed_version')
  relationship=$(state_get '.relationship')
  [ "$relationship" != "null" ] || die "apply: run 'classify' first"

  # A major-bounded range, always: an unbounded one would auto-install future
  # majors. 3.1.2 becomes >=3.1.2 <4; 0.5.3 becomes >=0.5.3 <1.
  local hfv_major next_major
  hfv_major=$(printf '%s' "$hfv" | sed -e 's/^[vV=]*//' -e 's/[^0-9].*$//')
  case "$hfv_major" in
    ''|*[!0-9]*) die "apply: highest_fixed_version '$hfv' has no readable major" ;;
  esac
  next_major=$((hfv_major + 1))
  RANGE=">=$hfv <$next_major"
  state_set_str range "$RANGE"

  if [ "$relationship" = "direct" ]; then
    APPLIED_PARENTS_JSON='[]'
  else
    APPLIED_PARENTS_JSON=$(state_getj '.eligible_parents')
  fi

  apply_call ""
  OBSERVATIONS_FIRST=$(printf '%s' "$APPLY_RESULT" | jq -c '.observations // []')
  state_set observations_first "$OBSERVATIONS_FIRST"

  fix_install_step
  validate_call

  local ladder_step=0
  while [ "$VALIDATE_OK" != true ]; do
    # `line_present` false first: the line is not installed at all, so the
    # override does nothing and no ladder step can change that. Never open a PR
    # for a change with no effect.
    if [ "$(printf '%s' "$VALIDATE_JSON" | jq -r '.line_present')" = "false" ]; then
      fail_phase validate "line_present is false: nothing on the ${MAJOR_LINE}.x line of $PACKAGE is installed, so there was nothing here to fix and the override applied does nothing. requires_major_bump: $(printf '%s' "$VALIDATE_JSON" | jq -c '.requires_major_bump')"
    fi

    if [ "$ladder_step" -eq 0 ]; then
      # Step 1: uncovered parents. A violating version usually arrives via a
      # parent not in the override list; derive those from the violating
      # copies' paths, and never from parents_other_lines.
      ladder_step=1
      local uncovered
      uncovered=$(uncovered_parents)
      if [ "$uncovered" != "[]" ]; then
        APPLIED_PARENTS_JSON=$(jq -cn --argjson a "$APPLIED_PARENTS_JSON" --argjson b "$uncovered" \
          '($a + $b) | unique')
        state_set applied_parents "$APPLIED_PARENTS_JSON"
        apply_call ""
        fix_install_step
        validate_call
        continue
      fi
    fi

    if [ "$ladder_step" -le 1 ]; then
      # Step 2: the bare global override. Widest change this flow can make, so
      # it is the last thing reached for; step 1 is exhausted above.
      ladder_step=2
      TIGHTEN_BARE_RAN=true
      apply_call "--tighten-bare"
      fix_install_step
      validate_call
      continue
    fi

    # Step 3: a stale lockfile. Under npm apply_constraint already invalidated
    # the target line's stale entries, so a copy that still resists means
    # something that pass could not judge.
    local li
    li=$(printf '%s' "$APPLY_RESULT" | jq -c '.lockfile_invalidated // {}')
    if [ "$(printf '%s' "$li" | jq -r 'if (.performed == false and has("reason")) then "stop" elif (.performed == true and ((.keys // []) | length) == 0) then "stop" else "" end')" = "stop" ]; then
      fail_phase validate "validation still fails and the lockfile-invalidation pass cannot account for it: $li. Deleting a whole lockfile needs interactive confirmation this flow cannot obtain, so lockfile regeneration is likely required and needs a human-driven session."
    fi

    # Step 4 is line_present, handled at the top of the loop. Anything left is
    # not the ladder's to decide.
    needs_judgment "validate_failed_after_ladder" \
      "$(jq -n --argjson v "$VALIDATE_JSON" --argjson w "$(printf '%s' "$APPLY_RESULT" | jq -c '.written')" \
         --argjson parents "$APPLIED_PARENTS_JSON" --argjson tb "$TIGHTEN_BARE_RAN" \
         --argjson li "$li" \
         '{validate: $v, written: $w, applied_parents: $parents,
           tighten_bare_applied: $tb, lockfile_invalidated: $li}')"
  done

  # ---- validate passed -------------------------------------------------

  local porcelain
  porcelain=$(git_at "$WT" status --porcelain 2>&1) \
    || fail_phase validate "git status --porcelain failed in the worktree: $porcelain"

  local drift action override_scope bare_override
  drift=$(state_get '.drift_commit')

  # The widest shape actually applied. Scoped entries plus an escalation to a
  # bare override is bare-*, never scoped.
  if [ "$TIGHTEN_BARE_RAN" = true ]; then
    # `tightened` requires a matching pre-fix observation; without one, what
    # happened was `added`. The observations captured BEFORE the first
    # apply_constraint call are what distinguish the two.
    if [ "$(printf '%s' "$OBSERVATIONS_FIRST" | jq -r 'any(.[]; (.targets_this_package // false) == true)')" = "true" ]; then
      bare_override=tightened
      override_scope=bare-tightened
    else
      bare_override=added
      override_scope=bare-added
    fi
    action=bare-override
  elif [ "$(printf '%s' "$APPLY_RESULT" | jq -r '.mode')" = "direct" ]; then
    bare_override=none
    override_scope=none
    action=direct-update
  else
    bare_override=none
    override_scope=scoped
    action=scoped-override
  fi

  if [ -z "$porcelain" ]; then
    # The empty-diff case. Phase 3's drift commit already absorbed any ambient
    # drift, so empty porcelain here means the fix install itself changed
    # nothing (#146). What it does not yet say is WHICH install cleared the
    # alerts, and the drift commit answers that.
    local pre_line base_line
    pre_line=$(line_versions "$(state_getj '.pre_drift')" "$MAJOR_LINE")
    base_line=$(line_versions "$(state_getj '.baseline')" "$MAJOR_LINE")
    if [ "$drift" != "true" ] || [ "$pre_line" = "$base_line" ]; then
      # A true no-op: the default branch already resolves the fixed versions.
      # Dependabot re-scans on its own schedule, so alerts read as open for a
      # window after the fix merged. A lone unrelated drift commit does not
      # change this; the branch is cleaned up like any other no-op.
      local resolved
      resolved=$(printf '%s' "$VALIDATE_JSON" | jq -r '[ .resolved_versions[]? ] | join(", ")')
      state_set_str action no-op
      jq -n --arg pkg "$PACKAGE" --arg line "$MAJOR_LINE" --arg resolved "$resolved" \
        --argjson v "$VALIDATE_JSON" --argjson drift "$(jbool "$drift")" \
        '{status: "no_op",
          package: $pkg, major_line: $line,
          resolved_version: $resolved,
          drift_commit: $drift,
          no_op: {
            reason: ("the \($line).x line is already fixed on the default branch: the fix install changed nothing and validate clears every alert in this group against the resolved \($resolved)"
                     + (if $drift then ". A drift commit exists but left this line where the committed lockfile had it, so it clears none of the alerts in this group" else "" end)),
            evidence: {
              diff: "",
              resolved_version: $resolved,
              validate: {ok: $v.ok, violations: $v.violations,
                         unresolved_alerts: $v.unresolved_alerts,
                         other_line_moves: $v.other_line_moves, checked: $v.checked},
              merged_pr_url: null
            }
          }}'
      exit 0
    fi
    # A drift commit exists and this line's resolved versions differ across it:
    # the control install itself resolved the vulnerable copy away. This is a
    # real fix whose content is the drift commit, not a no-op — reporting it as
    # "already fixed" leaves the alerts open with nothing to review.
    action=lockfile-refresh
    bare_override=none
    override_scope=none
  fi

  state_set_str action "$action"
  state_set_str override_scope "$override_scope"
  state_set_str bare_override "$bare_override"
  state_set apply_result "$APPLY_RESULT"
  state_set validate "$VALIDATE_JSON"
  state_set applied_parents "$APPLIED_PARENTS_JSON"
  state_set tighten_bare "$(jbool "$TIGHTEN_BARE_RAN")"

  jq -n --arg action "$action" --arg scope "$override_scope" --arg bare "$bare_override" \
    --argjson apply "$APPLY_RESULT" --argjson validate "$VALIDATE_JSON" \
    --argjson parents "$APPLIED_PARENTS_JSON" --argjson obs0 "$OBSERVATIONS_FIRST" \
    '{status: "ok", step: "apply", action: $action, override_scope: $scope,
      bare_override: $bare, applied_parents: $parents,
      written: $apply.written, superseded_keys: $apply.superseded_keys,
      alias_lookup: $apply.alias_lookup,
      lockfile_invalidated: $apply.lockfile_invalidated,
      override_file: $apply.override_file,
      observations: $apply.observations, observations_pre_fix: $obs0,
      requires_major_bump: ($validate.requires_major_bump // []),
      other_line_moves: $validate.other_line_moves,
      benign_moves: [ $validate.other_line_moves[]? | select(.class == "benign_dedup") ]}'
}

# Parents of the violating copies, minus the ones already carrying an entry and
# minus every parent on another major line. Derived from the violation paths the
# adapter reports — the enclosing package directory of each violating copy —
# intersected with nothing, because a parent the lockfile places is a parent an
# entry can name.
uncovered_parents() {
  local other applied
  other=$(state_getj '.declared.parents_other_lines // []')
  applied=$APPLIED_PARENTS_JSON
  printf '%s' "$VALIDATE_JSON" | jq -c \
    --argjson other "$other" --argjson applied "$applied" --arg pkg "$PACKAGE" '
    def bare_name:
      . as $k
      | ($k | rindex("@")) as $i
      | if $i == null or $i == 0 then $k else $k[0:$i] end;
    # node_modules/<parent>/node_modules/<pkg> (npm, hoisted yarn) and
    # .pnpm/<parent>@<ver>/node_modules/<pkg> (pnpm) both put the enclosing
    # parent immediately before the last node_modules segment.
    def parent_of($path):
      ($path | split("/")) as $seg
      | ([ range(0; $seg | length) | select($seg[.] == "node_modules") ] | last) as $i
      | if $i == null or $i == 0 then null
        else ($seg[0:$i] | last | sub("^\\.pnpm/"; "")) end;
    ([ .violations[]? | parent_of(.path) | select(. != null) ]
     | map(bare_name)
     | map(select(. != $pkg and . != "node_modules"))
     | unique)
    - ($other | map(bare_name))
    - $applied'
}

# ---------------------------------------------------------------------------
# score — phase 5
# ---------------------------------------------------------------------------

cmd_score() {
  local work=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --work) work="${2:?--work requires a directory}"; shift 2 ;;
      *) die "score: unknown option '$1'" ;;
    esac
  done
  load_state "$work"

  local action
  action=$(state_get '.action')
  [ "$action" != "null" ] || die "score: run 'apply' first"
  # A true no-op is terminal at `apply`: there is no change to score and no PR
  # to open, so scoring one would manufacture a rating for a diff that does not
  # exist (#34).
  [ "$action" != "no-op" ] || die "score: apply returned no_op, which is terminal. There is no change to score."

  adapter_run resolved_versions "$PACKAGE" \
    || fail_phase validate "resolved_versions $PACKAGE failed after the fix: $(adapter_error_text)"
  local post=$ADAPTER_OUT
  state_set post_fix "$post"

  # The why capture gets its own package-qualified name under $WORK: a
  # predictable filename in a shared directory lets a sibling agent overwrite
  # it mid-run (#133), and a scoped name substituted raw would target a
  # directory $WORK never creates (#161's sibling defect).
  local package_path why_file
  package_path=$(state_get '.package_path')
  why_file="$WORK/why-$package_path.json"
  adapter_run why "$PACKAGE" \
    || fail_phase validate "why $PACKAGE failed after the fix: $(adapter_error_text)"
  printf '%s\n' "$ADAPTER_OUT" > "$why_file" || die "score: cannot write $why_file"

  # Always --line: without it the verb collects every declaration of the name
  # anywhere in the lockfile, and parents on lines the override never touched
  # score as distance this fix crossed (#76).
  adapter_run declared_ranges --line "$MAJOR_LINE" "$PACKAGE" \
    || fail_phase validate "declared_ranges --line $MAJOR_LINE $PACKAGE failed after the fix: $(adapter_error_text)"
  local declared_post=$ADAPTER_OUT
  state_set declared_post "$declared_post"

  # F1's --before comes from the post-control-install baseline, so the delta is
  # fix-attributable — except on a lockfile-refresh, where the refresh IS the
  # change and the pre-drift snapshot is the honest before.
  local before_src before after
  if [ "$action" = "lockfile-refresh" ]; then
    before_src=$(state_getj '.pre_drift')
  else
    before_src=$(state_getj '.baseline')
  fi
  before=""
  if [ "$(printf '%s' "$before_src" | jq -r '.present // false')" = "true" ]; then
    before=$(lowest_on_line "$before_src" "$MAJOR_LINE")
  fi
  after=$(lowest_on_line "$post" "$MAJOR_LINE")

  local scope
  scope=$(state_get '.override_scope')

  local args=(--package "$PACKAGE" --after "$after" --adapter "$ADAPTER"
              --why-json "$why_file" --override-scope "$scope")
  [ -z "$before" ] || args+=(--before "$before")

  # One --declared-range per distinct range. `none` is the sentinel for an
  # empty ranges[]; omitting the flag is a usage error, because its silent
  # absence made the multi-major escalation unreachable.
  local ranges r nranges=0
  ranges=$(printf '%s' "$declared_post" | jq -r '.ranges[]?')
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    args+=(--declared-range "$r")
    nranges=$((nranges + 1))
  done <<EOF
$ranges
EOF
  [ "$nranges" -gt 0 ] || args+=(--declared-range none)

  local errfile risk st
  errfile=$(mktemp) || die "cannot create a temporary file"
  risk=$( ( cd "$WT" && run_env "$SCORER" "${args[@]}" ) 2>"$errfile" )
  st=$?
  if [ "$st" -ne 0 ]; then
    local serr
    serr=$(cat "$errfile")
    rm -f "$errfile"
    die "score-merge-risk.sh failed: $serr"
  fi
  rm -f "$errfile"
  printf '%s' "$risk" | jq -e 'type == "object" and has("band")' >/dev/null 2>&1 \
    || die "score-merge-risk.sh returned no usable report"
  state_set risk "$risk"

  # The `--declared-range none` sentinel has two causes and they are different
  # facts: nothing could be READ, or parents were read and declared nothing.
  local ranges_cause=null
  if [ "$nranges" -eq 0 ]; then
    if [ "$(printf '%s' "$declared_post" | jq -r '(.parents_read // []) | length')" = "0" ]; then
      ranges_cause='"none_readable"'
    else
      ranges_cause='"parents_declared_nothing"'
    fi
  fi

  jq -n \
    --arg pkg "$PACKAGE" --arg line "$MAJOR_LINE" --arg branch "$BRANCH_NAME" \
    --arg work "$WORK" --arg worktree "$WT" --arg why "$why_file" \
    --arg action "$action" --arg scope "$scope" \
    --arg bare "$(state_get '.bare_override')" \
    --arg before "$before" --arg after "$after" \
    --argjson risk "$risk" \
    --argjson apply "$(state_getj '.apply_result')" \
    --argjson validate "$(state_getj '.validate')" \
    --argjson why_json "$(cat "$why_file")" \
    --argjson declared "$declared_post" \
    --argjson obs0 "$(state_getj '.observations_first')" \
    --argjson parents "$(state_getj '.applied_parents // .eligible_parents')" \
    --argjson drift "$(state_getj '.drift_commit')" \
    --argjson ranges_cause "$ranges_cause" \
    '{status: "ready_for_pr",
      package: $pkg, major_line: $line, branch: $branch,
      work: $work, worktree: $worktree, why_json: $why,
      action: $action, override_scope: $scope, bare_override: $bare,
      drift_commit: $drift,
      resolved_version: $after,
      before: (if $before == "" then null else $before end),
      risk: {band: $risk.band, score: $risk.score,
             f4: ([ $risk.factors[]? | select(.id == "F4") | .score ] | first),
             f5: ([ $risk.factors[]? | select(.id == "F5") | .score ] | first),
             markdown: $risk.markdown, coverage: $risk.coverage, ci: $risk.ci},
      written: ($apply.written // []),
      superseded_keys: ($apply.superseded_keys // []),
      override_file: $apply.override_file,
      alias_lookup: $apply.alias_lookup,
      lockfile_invalidated: $apply.lockfile_invalidated,
      observations: ($apply.observations // []),
      observations_pre_fix: $obs0,
      applied_parents: $parents,
      requires_major_bump: ($validate.requires_major_bump // []),
      other_line_moves: $validate.other_line_moves,
      benign_moves: [ $validate.other_line_moves[]? | select(.class == "benign_dedup") ],
      validate: $validate,
      why_raw: $why_json.raw,
      declared_ranges: ($declared.ranges // []),
      declared_ranges_cause: $ranges_cause,
      parents_unreadable: ($declared.parents_unreadable // []),
      parents_malformed: ($declared.parents_malformed // [])}'
}

# ---------------------------------------------------------------------------
# cleanup — every exit path
# ---------------------------------------------------------------------------

cmd_cleanup() {
  local work="" pushed=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --work) work="${2:?--work requires a directory}"; shift 2 ;;
      --pushed) pushed=true; shift ;;
      *) die "cleanup: unknown option '$1'" ;;
    esac
  done
  load_state "$work"

  local detail="" removed=true rerr
  # `worktree remove` names this run's own path and drops its administrative
  # entry: that is the whole cleanup an agent is entitled to. Never
  # `git worktree prune` — it is repository-wide, and a sibling agent very
  # likely shares this repo_root right now (#35).
  if [ -e "$WT" ]; then
    rerr=$(git_at "$REPO_ROOT" worktree remove --force "$WT" 2>&1) || {
      removed=false
      detail="git worktree remove --force $WT failed: $rerr"
    }
  fi

  # Read every fact the branch decision needs before $WORK disappears.
  local tip dflt remote subjects nsubj names
  tip=$(git_at "$REPO_ROOT" rev-parse "$BRANCH_NAME" 2>/dev/null) || tip=""
  dflt=$(git_at "$REPO_ROOT" rev-parse "origin/$DEFAULT_BRANCH" 2>/dev/null) || dflt=""
  remote=$(git_at "$REPO_ROOT" rev-parse "origin/$BRANCH_NAME" 2>/dev/null) || remote=""

  local safe=false reason="" deleted=false
  if [ -n "$tip" ]; then
    if [ "$pushed" = true ] && [ -n "$remote" ] && [ "$tip" = "$remote" ]; then
      safe=true
      reason="pushed: the remote carries the same commits, so the local ref is a duplicate"
    elif [ -n "$dflt" ] && [ "$tip" = "$dflt" ]; then
      safe=true
      reason="tip still equals origin/$DEFAULT_BRANCH: there is nothing on the branch to lose"
    else
      subjects=$(git_at "$REPO_ROOT" log --format=%s "origin/$DEFAULT_BRANCH..$BRANCH_NAME" 2>/dev/null)
      nsubj=$(printf '%s\n' "$subjects" | grep -c . || true)
      names=$(git_at "$REPO_ROOT" diff --name-only "origin/$DEFAULT_BRANCH" "$BRANCH_NAME" 2>/dev/null)
      if [ "$nsubj" = "1" ] && [ "$subjects" = "$DRIFT_SUBJECT" ] && [ -n "$names" ]; then
        local ok=true n
        while IFS= read -r n; do
          [ -n "$n" ] || continue
          drift_path_allowed "$n" || { ok=false; break; }
        done <<EOF
$names
EOF
        if [ "$ok" = true ]; then
          safe=true
          reason="the only commit is this flow's drift commit, which a rerun's control install regenerates equivalently from the same manifests"
        fi
      fi
    fi
  fi

  rm -rf "$WORK"

  if [ -n "$tip" ] && [ "$safe" = true ]; then
    local derr
    if derr=$(git_at "$REPO_ROOT" branch -D "$BRANCH_NAME" 2>&1); then
      deleted=true
    else
      # Never silenced, and never a failure result on its own: by this point
      # the work either shipped or already failed for its own reason.
      detail="${detail:+$detail; }git branch -D $BRANCH_NAME failed: $derr"
    fi
  elif [ -n "$tip" ]; then
    reason="left in place: the tip is not on origin and is not this flow's own leftover, and a commit that never reached the remote is the one thing here that cannot be recreated"
    detail="${detail:+$detail; }branch $BRANCH_NAME left in place at $tip"
  fi

  jq -n --argjson removed "$(jbool "$removed")" \
    --argjson deleted "$(jbool "$deleted")" \
    --arg branch "$BRANCH_NAME" --arg tip "$tip" --arg reason "$reason" --arg detail "$detail" \
    '{status: "ok", step: "cleanup", worktree_removed: $removed,
      branch: $branch, branch_deleted: $deleted,
      branch_tip: (if $tip == "" then null else $tip end),
      reason: (if $reason == "" then null else $reason end),
      detail: (if $detail == "" then null else $detail end)}'
}

# ---------------------------------------------------------------------------

command -v jq >/dev/null 2>&1 || die "jq is required"

SUB="${1:-}"
[ -n "$SUB" ] || die "usage: fix-group.sh <setup|classify|baseline|apply|score|cleanup> [options]"
shift

case "$SUB" in
  setup)    cmd_setup "$@" ;;
  classify) cmd_classify "$@" ;;
  baseline) cmd_baseline "$@" ;;
  apply)    cmd_apply "$@" ;;
  score)    cmd_score "$@" ;;
  cleanup)  cmd_cleanup "$@" ;;
  *) die "fix-group.sh: unknown subcommand '$SUB'" ;;
esac
