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
#            validate","detail":"..."}   terminal failure, mapped verbatim onto
#           the agent's result block. Three of the agent's phase names never
#           appear here: `push` and `pr` name work this driver never does, and
#           `install` is the value the AGENT writes after an `install_failure`
#           judgment escape — the driver hands that back as exit 2 carrying
#           `evidence.phase: "install"`, never as an exit-3 phase of its own.
#   exit 1  {"error":"..."}                 usage or internal error
#
# `cleanup` is the one step whose failure can follow completed work: a
# populated `errors[]` makes it exit 3 with phase `worktree`, because a
# workspace left on disk or a registration left live blocks every later run
# against that repository until a human clears it. The agent reports that
# failure AND whatever it had already finished — a PR it opened is still open.
# Its full report is emitted either way, so `work_dir`, `worktree` and
# `errors[]` are readable on both paths.
#
# All JSON goes to stdout; human-readable detail goes to stderr.
#
# `--env-prefix` is an opaque argv prefix (scripts/CLAUDE.md, "`env_prefix` is
# an opaque, optional seam"). It is split on whitespace and prepended verbatim
# to every git, adapter and package-manager invocation, composed **after** any
# `cd`: it injects environment, it does not chdir. Absent means bare.
#
# Dependencies are bash, jq and git only. `gh` is in the plugin's dependency
# set (scripts/CLAUDE.md) but this script never calls it: every remote fact it
# needs comes from a fetched remote-tracking ref. bash 3.2: no associative
# arrays, no `mapfile`, no `${var,,}`.

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

# Exit 2 is the contracted `needs_judgment`, so this helper validates its own
# evidence before handing it to jq. Unvalidated, a jq failure printed nothing
# and the `exit 2` still ran: the contracted code with no payload at all,
# which the agent reads as a judgment escape naming no decision point.
needs_judgment() {
  printf 'fix-group: needs judgment at %s\n' "$1" >&2
  local ev=$2
  if ! printf '%s' "$ev" | jq -e 'true' >/dev/null 2>&1; then
    printf 'fix-group: the evidence for %s could not be assembled\n' "$1" >&2
    jq -n --arg dp "$1" --arg raw "$ev" \
      '{status: "needs_judgment", decision_point: $dp,
        evidence: {error: "the driver could not assemble this decision point'"'"'s evidence as JSON; what it held is quoted verbatim in `raw`", raw: $raw}}'
    exit 2
  fi
  jq -n --arg dp "$1" --argjson ev "$ev" \
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

# Every read distinguishes three outcomes, because collapsing them is how a
# `cleanup` came to report success having removed nothing: jq's status was
# discarded under `2>/dev/null`, so a zero-byte or half-written state.json
# passed `load_state`'s `[ -f ]` check and handed every caller the empty
# string. `$WT` was then empty, `[ -e "" ]` false, and the run proceeded to
# `rm -rf "$WORK"` while the worktree registration under
# `<git-common-dir>/worktrees/` survived — the exact state scripts/CLAUDE.md
# says blocks a later `worktree add` and `branch -D`.
# Prints the value and returns 0; 1 when the file itself could not be read; 2
# when the key is absent, null or empty. It reports rather than dies because
# every caller reads it through a command substitution, and `die` there exits
# only the SUBSHELL — its error JSON would land in the variable it was meant
# to fill and the run would continue on it. `state_ok` does the dying, in the
# caller's own shell.
state_get() {
  local v
  v=$(jq -r "$1" "$STATE" 2>/dev/null) || return 1
  case "$v" in
    ''|null) return 2 ;;
  esac
  printf '%s' "$v"
}

state_ok() {
  case "$1" in
    0) ;;
    1) die "the state file at $STATE could not be read for '$2'. It is unparseable or truncated; nothing was removed or deleted on its say-so." ;;
    *) die "the state file at $STATE has no usable value for '$2'. Run the earlier steps first; an absent or empty value is never read as a legitimate answer here." ;;
  esac
}

# For a key whose empty value is legitimate (`env_prefix`), or whose absence a
# caller checks for itself. `load_state` has already established that the file
# parses as a JSON object, so the remaining failure mode is an absent key.
state_get_opt() {
  local v
  v=$(jq -r "$1" "$STATE" 2>/dev/null) || v=""
  case "$v" in null) v="" ;; esac
  printf '%s' "$v"
}

# The JSON reader, held to `state_get`'s discipline in full: the SAME three
# outcomes — 0 a value, 1 the file could not be read, 2 the key is absent or
# null — so `state_ok` covers absence here exactly as it does there. **There is
# deliberately no unchecked sibling to reach for.** The one this replaced
# discarded jq's status at all twelve of its call sites, every one of them
# inside `$( )`.
#
# Returning `null` at status 0, as an earlier pass did, put `state_ok` in the
# code without the thing it checks for: absence became a *value*. `null.written`
# is `null` rather than an error, so a `score` reading an `apply_result` that a
# run interrupted between `state_set_str override_scope` and
# `state_set apply_result` never wrote emitted `status: "ready_for_pr"` with
# `written: []` at exit 0 — a PR-ready verdict naming no edit at all. Where a
# null IS legitimate the call site says so with an explicit `// <default>`.
state_json() {
  local v
  v=$(jq -c "$1" "$STATE" 2>/dev/null) || return 1
  [ "$v" != "null" ] || return 2
  printf '%s' "$v"
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
  jq -e 'type == "object"' "$STATE" >/dev/null 2>&1 \
    || die "the state file at $STATE is not a readable JSON object. A crashed 'setup' can leave a zero-byte one; inspect $WORK by hand rather than rerunning, because nothing here can tell an interrupted run from a foreign directory."
  REPO_ROOT=$(state_get '.repo_root');       state_ok $? '.repo_root'
  DEFAULT_BRANCH=$(state_get '.default_branch'); state_ok $? '.default_branch'
  BRANCH_NAME=$(state_get '.branch_name');   state_ok $? '.branch_name'
  ADAPTER=$(state_get '.adapter');           state_ok $? '.adapter'
  SCORER=$(state_get '.scorer');             state_ok $? '.scorer'
  WT=$(state_get '.worktree');               state_ok $? '.worktree'
  PACKAGE=$(state_get '.package');           state_ok $? '.package'
  MAJOR_LINE=$(state_get '.major_line');     state_ok $? '.major_line'
  set_env_prefix "$(state_get_opt '.env_prefix')"
}

# ---------------------------------------------------------------------------
# Adapter and git seams
#
# Every git call carries `-C`; every adapter call `cd`s into the worktree in a
# subshell, exactly as scripts/CLAUDE.md's "No Bash snippet may depend on the
# previous call" requires of the prescribed shapes this replaces. The adapter's
# write verbs stay behind require-linked-worktree.sh either way.
# ---------------------------------------------------------------------------

# `git -C ""` is not an error and it is not a no-op: git silently operates on
# the CURRENT directory, so one empty state value would put
# `worktree remove --force` or `branch -D` in the user's own checkout — issue
# #18's failure mode, arriving through a path no `cd` guard covers. The
# adapter and install seams need no equivalent guard: they compose through
# `cd "$WT"`, and `cd ""` fails.
#
# Defence in depth rather than the primary defence: `load_state` refuses an
# empty value for every path it reads, which is what makes an empty `$dir`
# unreachable in the first place. This guard's own `die` cannot be relied on
# to end the run — most callers wrap `git_at` in a command substitution, where
# an exit ends only the subshell — but it does guarantee the git call is never
# made, which is the part that matters.
git_at() {
  local dir=$1
  shift
  [ -n "$dir" ] \
    || die "refusing to run 'git $*' with an empty directory: git -C '' operates on the current directory, which is how a repo-targeted write lands in the user's checkout (#18)."
  run_env git -C "$dir" "$@"
}

# ---------------------------------------------------------------------------
# Path containment, for the one operation that deletes
#
# Copied from `common/reap-agent-artifacts.sh`, which runs the same `rm -rf`
# on the orchestrator's side of the same directory. Both halves of every
# comparison are resolved physically first, so a symlink cannot smuggle a path
# past the prefix test.
# ---------------------------------------------------------------------------

RESOLVE_ERR=""

resolve_path() {
  RESOLVE_ERR=""
  local p=$1 suffix="" parent resolved
  while [ ! -d "$p" ]; do
    suffix="/$(basename "$p")$suffix"
    parent=$(dirname "$p")
    [ "$parent" != "$p" ] || break
    p=$parent
  done
  if [ ! -d "$p" ]; then
    printf '%s' "$1"
    return 0
  fi
  resolved=$( ( CDPATH='' cd -- "$p" 2>/dev/null && pwd -P ) || true )
  if [ -z "$resolved" ]; then
    RESOLVE_ERR="cannot resolve $1: $p exists but could not be entered"
    printf '%s' "$1"
    return 0
  fi
  printf '%s' "$resolved$suffix"
}

no_dotdot() {
  case "$1" in
    *"/../"* | */..) return 1 ;;
  esac
  return 0
}

# $1 = resolved repo root, $2 = the resolved path under test. The trailing
# `?*` is what keeps the worktree root itself out: only a directory *under*
# it is ever accepted.
contained() {
  case "$2" in
    "$1/.claude/worktrees/"?*) return 0 ;;
  esac
  return 1
}

# ---------------------------------------------------------------------------
# Reading a ref, telling "no such ref" from "git failed"
#
# `rev-parse --verify --quiet` answers a missing ref with empty stdout, exit 1
# and no stderr. The two are distinguishable only by that stderr, and folding
# them together reports a branch as absent on a transient failure. Sets
# REF_TIP and REF_ERR; REF_ERR non-empty means the read failed, which is never
# the same fact as an empty REF_TIP.
# ---------------------------------------------------------------------------

REF_TIP=""
REF_ERR=""

read_ref() {
  local errfile st=0
  REF_TIP=""
  REF_ERR=""
  errfile=$(mktemp) || die "cannot create a temporary file"
  REF_TIP=$(git_at "$1" rev-parse --verify --quiet "$2" 2>"$errfile") || st=$?
  if [ "$st" -ne 0 ]; then
    REF_TIP=""
    REF_ERR=$(tr '\n' ' ' < "$errfile")
  fi
  rm -f "$errfile"
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

# ---------------------------------------------------------------------------
# Reading a field the adapter contract promises
#
# "A field the contract promises arrives present and of the promised type, or
# it is a hard error, never a default" (scripts/CLAUDE.md). A bare `jq -r` on
# an absent key yields the STRING `null`, which then takes a branch of its
# own: `.peer_only` stops being `true` so the #103 dead-end check vanishes,
# `.line_present` stops being `false` so its stop is bypassed, and
# `targets_this_package` stops being `true` so a `tightened` bare override is
# reported to the PR body as `added`. `score-merge-risk.sh`'s
# `require_object`/`read_field`/`contract_error` trio is the in-repo pattern;
# this is the same discipline with the driver's phase vocabulary.
#
# The value lands in ADAPTER_FIELD rather than on stdout because `fail_phase`
# exits, and an exit inside a command substitution ends only the subshell —
# the caller would carry on holding the failure JSON as its "value".
# ---------------------------------------------------------------------------

ADAPTER_FIELD=""

adapter_field() {
  # $1 phase, $2 payload, $3 what produced it, $4 key
  ADAPTER_FIELD=""
  printf '%s' "$2" | jq -e 'type == "object"' >/dev/null 2>&1 \
    || fail_phase "$1" "$3 emitted no JSON object on stdout. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); an adapter that cannot answer must exit non-zero, not answer with nothing and let a downstream check be skipped rather than failed."
  printf '%s' "$2" | jq -e --arg k "$4" 'has($k)' >/dev/null 2>&1 \
    || fail_phase "$1" "$3 emitted no '$4' field. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); read straight, an absent field arrives as the string \"null\" and takes a branch of its own instead of failing."
  ADAPTER_FIELD=$(printf '%s' "$2" | jq -r --arg k "$4" '.[$k]') \
    || fail_phase "$1" "$3: reading '$4' out of the reply failed."
}

# Same guarantee for a value about to be handed to `jq --argjson`. `jq -n
# --argjson x ""` dies with exit 2 and NO stdout, which an agent reads as a
# `needs_judgment` with no decision point and then hunts for evidence fields
# that do not exist.
require_json() {
  # $1 phase, $2 value, $3 description
  printf '%s' "$2" | jq -e 'true' >/dev/null 2>&1 \
    || fail_phase "$1" "$3 is not readable JSON, so the step's own report cannot be assembled. Value: '$2'"
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

# Only shapes that name a connection that timed out, reset or could not be
# resolved *this time*. Deliberately NOT here: `ENOTFOUND` (a name that does
# not resolve is a wrong registry host far more often than a transient DNS
# failure — `EAI_AGAIN` is the transient one) and the bare `request to .*
# failed`, which npm also prints for a self-signed certificate chain and for a
# proxy refusing the connection. Retrying either burns an install step proving
# a misconfiguration is still a misconfiguration, and the evidence's
# `registry_timeout_retry: true` then tells the agent a network blip was ruled
# out when nothing of the sort happened.
registry_timeout_shaped() {
  printf '%s' "$1" | grep -Eqi \
    'ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network timeout|Timeout awaiting|registry.*timed? ?out'
}

# Signals an install prints that a later phase has to react to, detected while
# the output is still in hand. `run_install` used to capture the install's
# output and discard it on success, and no payload carried it, so the pnpm 11
# reaction agents/fix-dependency.md requires was unreachable by the agent that
# had to make it (#159).
PNPM_FIELD_IGNORED='The "pnpm" field in package.json is no longer read by pnpm'

install_signals() {
  printf '%s' "$1" | jq -Rs --arg s "$PNPM_FIELD_IGNORED" \
    '[ if index($s) != null then "pnpm_field_no_longer_read" else empty end ]'
}

# Sets INSTALL_ERR, INSTALL_RETRIED and INSTALL_SIGNALS; returns the install's
# exit status.
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
  INSTALL_SIGNALS=$(install_signals "$INSTALL_ERR")
  return "$st"
}

# The union of every signal an install in this run printed, carried in state so
# `apply` and `score` can both report it.
record_install_signals() {
  local prev
  prev=$(state_json '.install_signals // []'); state_ok $? '.install_signals'
  state_set install_signals "$(jq -cn --argjson a "$prev" --argjson b "${INSTALL_SIGNALS:-[]}" \
    '($a + $b) | unique')"
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

# The versions of this group's line, sorted, as a compact JSON array, or a
# non-zero status when the payload could not be read. A payload that is not an
# object, or carries no `versions` array, or carries an entry whose `version`
# is not a string, is an ERROR here and never an empty list: "zero resolved
# versions is an error, never a pass" (scripts/CLAUDE.md).
#
# The drift-cleared test compares two of these, so a failed read must never
# come back as `[]`: two failed reads compare equal, and the run then reports
# `no_op` — "already fixed on the default branch" — discarding the drift
# commit that WAS the fix and leaving the alerts open (#146's inversion).
line_versions() {
  printf '%s' "$1" | jq -c --arg l "$2" '
    if (type != "object") or ((.versions | type) != "array") then
      error("the resolved_versions payload carries no versions array")
    elif any(.versions[]; (.version | type) != "string") then
      error("a resolved_versions entry carries no readable version string")
    else [ .versions[].version | select(test("^" + $l + "([.]|$)")) ] | unique
    end'
}

# Lowest version on the group's major line, in LOWEST_ON_LINE.
#   0  a version was found
#   1  the payload parsed and holds no version on this line
#   2  the payload, or a comparison, could not be read
#
# There is no fall back to the lowest version overall. That fallback reported
# a version from a major line this group does not own as its `after`, which
# then flowed into `--after`, `resolved_version` and F1 — the #76 class. And
# `compare_versions`' status is not discarded, nor its `.result` defaulted:
# with either, a failed comparison left `lowest` at whatever the iteration
# order happened to produce.
lowest_on_line() {
  local payload=$1 line=$2 versions v cmp
  LOWEST_ON_LINE=""
  versions=$(line_versions "$payload" "$line" | jq -r '.[]') || return 2
  [ -n "$versions" ] || return 1
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    if [ -z "$LOWEST_ON_LINE" ]; then
      LOWEST_ON_LINE=$v
      continue
    fi
    adapter_run compare_versions "$v" "$LOWEST_ON_LINE" || return 2
    printf '%s' "$ADAPTER_OUT" | jq -e 'type == "object" and has("result")' >/dev/null 2>&1 \
      || return 2
    cmp=$(printf '%s' "$ADAPTER_OUT" | jq -r '.result')
    case "$cmp" in
      -1) LOWEST_ON_LINE=$v ;;
      0|1) ;;
      *) return 2 ;;
    esac
  done <<EOF
$versions
EOF
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
      # `--env-prefix ""` is legal and means "no prefix", so this cannot use
      # the `${2:?...}` form the other options use. It still has to tell an
      # EMPTY value from an ABSENT one: `${2-}` leaves `shift 2` to fail on a
      # trailing `--env-prefix`, and a failed `shift` shifts nothing, so the
      # `while [ $# -gt 0 ]` loop never terminates.
      --env-prefix)
        [ $# -ge 2 ] || die "setup: --env-prefix requires a value; pass \"\" for no prefix"
        env_prefix="$2"; shift 2 ;;
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
  local missing unusable
  missing=$(printf '%s' "$group" | jq -r '
    ["package","major_line","branch_name","highest_fixed_version","alerts"]
    - (to_entries | map(.key)) | join(", ")')
  [ -z "$missing" ] || die "setup: the group payload is missing: $missing"
  # Presence is not enough. `{"package": null}` passes a key check, and the
  # string `null` then flows into the worktree path and the branch name,
  # producing a `fix-dependabot-null-nullx` workspace that every later guard
  # reads as a legitimate run's leftover.
  unusable=$(printf '%s' "$group" | jq -r '
    def blank_string: (type != "string") or (length == 0);
    [ (select(.package | blank_string) | "package"),
      (select((.major_line | type) != "number" and (.major_line | blank_string))
       | "major_line"),
      (select(.branch_name | blank_string) | "branch_name"),
      (select(.highest_fixed_version | blank_string) | "highest_fixed_version"),
      (select((.alerts | type) != "array" or (.alerts | length) == 0) | "alerts") ]
    | join(", ")')
  [ -z "$unusable" ] || die "setup: the group payload carries no usable value for: $unusable"

  # `major_line` is interpolated into a regex anchor (`test("^" + $l +
  # "([.]|$)")`) by every reader of a resolved_versions payload, so a
  # non-numeric value is a pattern rather than a line: `.*` would match every
  # major in the tree and report the lowest of them as this group's version.
  local ml_check
  ml_check=$(printf '%s' "$group" | jq -r '.major_line | tostring')
  case "$ml_check" in
    ''|*[!0-9]*) die "setup: major_line '$ml_check' is not a number. It is interpolated into a regex that selects this group's line out of the lockfile, so anything else is a pattern matching lines this group does not own." ;;
  esac

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
  # No remote branch of that name is the ordinary case, not an error — but a
  # FAILED fetch is not that case, and discarding the status folded them
  # together. A network failure then leaves a stale `origin/<branch>` in place,
  # a `tip = remote` comparison then reads as a duplicate of pushed work, and
  # `branch -D` deletes on the strength of a ref that may no longer be on
  # origin. Git says "couldn't find remote ref" for the benign one and
  # something else for every other failure.
  local berr
  if ! berr=$(git_at "$repo_root" fetch origin "$branch_name" 2>&1); then
    case "$berr" in
      *"couldn't find remote ref"*|*"Couldn't find remote ref"*) ;;
      *) fail_phase worktree "git fetch origin $branch_name failed, so origin/$branch_name may be stale and cannot be used to judge whether a local branch of that name is a duplicate of pushed work: $berr" ;;
    esac
  fi

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

  # Written through a temp file, exactly as `state_set` does: `> "$STATE"`
  # truncates before jq runs, so a jq failure here leaves the zero-byte
  # state.json that every later step then has to refuse.
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
      drift_commit: false, fix_installs: 0, install_signals: []}' > "$STATE.tmp" \
    || die "setup: cannot write $STATE"
  mv "$STATE.tmp" "$STATE" || die "setup: cannot replace $STATE"

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

  # A peer_only package is a structural dead end: every edge reaching it is
  # pnpm recording a peer resolution rather than a declaration, so no override
  # key can move it. One field run burned four install cycles proving a shape
  # `why` names before any install runs (#103).
  adapter_field classify "$why" "adapter why $PACKAGE" peer_only
  if [ "$ADAPTER_FIELD" = "true" ]; then
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

  # Read straight, an absent `relationship` stored the string "null", which
  # `apply`'s own "run classify first" guard then accepted as a real answer
  # while every later reader saw a relationship that is neither `direct` nor
  # transitive.
  adapter_field classify "$why" "adapter why $PACKAGE" relationship
  local relationship=$ADAPTER_FIELD
  case "$relationship" in
    direct|transitive) ;;
    *) fail_phase classify "adapter why $PACKAGE answered relationship '$relationship', which is not in the contract enum direct|transitive (docs/adr/001-ecosystem-adapter-contract.md). Anything else routes the parent list by falling off the 'direct' branch, so a direct dependency would be pinned through parents it has none of." ;;
  esac

  state_set why "$why"
  state_set declared "$declared"
  state_set eligible_parents "$eligible"
  state_set_str relationship "$relationship"

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
  # The same object assertion the other verbs carry: an adapter exiting 0 with
  # empty stdout otherwise sails past every later `has()` check rather than
  # failing one (scripts/CLAUDE.md).
  adapter_field baseline "$pre_drift" "resolved_versions $PACKAGE (before the control install)" present
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
  adapter_field baseline "$baseline" "resolved_versions $PACKAGE (after the control install)" present
  state_set baseline "$baseline"
  state_set drift_commit "$(jbool "$drift")"
  record_install_signals

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
#
# The counter is PERSISTED, and that is what makes the budget real. One `apply`
# spends at most three (the first call, step 1, step 2), so a process-local
# counter could never reach four and `install_budget_exhausted` was dead code
# advertised in two documents as an escape. Meanwhile the agent doc sanctions
# re-running `apply` once after a diagnosed `install_failure`, which reset the
# counter to zero — so the budget bounded nothing at all. In state it bounds
# the RUN: a re-run resumes the count, the fourth install is the last, and
# "do not extend the budget by re-running" becomes enforced rather than asked
# for. The ladder's own position deliberately does NOT persist: a re-run
# happens only after the agent changed the state the failure complained about,
# and the cheapest scoped shape is the right thing to try again first.
FIX_INSTALL_BUDGET=4
FIX_INSTALLS=0

APPLIED_PARENTS_JSON='[]'
APPLY_RESULT=''
OBSERVATIONS_FIRST='[]'
TIGHTEN_BARE_RAN=false
VALIDATE_JSON=''
VALIDATE_OK=false
PARENT_DERIVATION='null'

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

  # What is known here is that the verb exited non-zero and that no install has
  # run, so the worktree is discarded either way. What is NOT known is whether
  # the manifest was touched: this call did not look, and asserting "nothing
  # was written" from a non-zero status states more than was observed.
  adapter_run apply_constraint "${args[@]}" \
    || fail_phase apply "apply_constraint exited non-zero, so no fix install was run and no PR was opened. Whether it wrote anything before failing is not observed here; the worktree is discarded on cleanup either way. Quoting the adapter verbatim: $(adapter_error_text)"
  APPLY_RESULT=$ADAPTER_OUT
  adapter_field apply "$APPLY_RESULT" "apply_constraint $PACKAGE" written
  printf '%s' "$APPLY_RESULT" | jq -e '(.written | type) == "array"' >/dev/null 2>&1 \
    || fail_phase apply "apply_constraint answered a 'written' that is not an array. It is the only statement of what actually changed (scripts/CLAUDE.md), and every classification below reads it."
  adapter_field apply "$APPLY_RESULT" "apply_constraint $PACKAGE" observations
  printf '%s' "$APPLY_RESULT" | jq -e '(.observations | type) == "array"' >/dev/null 2>&1 \
    || fail_phase apply "apply_constraint answered an 'observations' that is not an array. A missing one silently turns every tightened bare override into an added one in the PR body."

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
$(printf '%s' "$alerts_json" | jq -r '[ .[].vulnerable_range ] | unique | .[]')
EOF
  args+=(--baseline "$baseline_json")
  # `[]` is a real answer and is passed as `[]`. When the field is ABSENT from
  # the payload the flag is omitted entirely, which makes validate class every
  # cross-line move fatal — the intended fail-safe default (#105).
  if [ "$(state_get_opt 'has("group") and (.group | has("sibling_alerts"))')" = "true" ]; then
    local siblings
    siblings=$(state_json '.group.sibling_alerts'); state_ok $? '.group.sibling_alerts'
    args+=(--sibling-alerts "$siblings")
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
  local vjson="${VALIDATE_JSON:-}"
  [ -n "$vjson" ] || vjson=null
  require_json apply "$vjson" "the validate report carried into the install-budget evidence"
  if [ "$FIX_INSTALLS" -ge "$FIX_INSTALL_BUDGET" ]; then
    needs_judgment "install_budget_exhausted" \
      "$(jq -n --argjson n "$FIX_INSTALLS" --argjson v "$vjson" \
        '{fix_installs: $n, budget: '"$FIX_INSTALL_BUDGET"', validate: $v}')"
  fi
  FIX_INSTALLS=$((FIX_INSTALLS + 1))
  state_set fix_installs "$FIX_INSTALLS"
  if ! run_install; then
    record_install_signals
    # Everything the ladder does not cover is the agent's to diagnose: a peer
    # conflict needing a wider range, a version that does not exist. `phase` is
    # `install` and not `apply`: the contract reserves that name for the
    # fix-attributable install (`baseline` covers the ambient control one), and
    # it is the value the agent copies straight into its result block.
    needs_judgment "install_failure" \
      "$(jq -n --arg err "$INSTALL_ERR" --argjson retried "$INSTALL_RETRIED" \
         --argjson n "$FIX_INSTALLS" --argjson written "$(printf '%s' "$APPLY_RESULT" | jq -c '.written')" \
         --argjson signals "${INSTALL_SIGNALS:-[]}" \
         '{phase: "install", error: $err, registry_timeout_retry: $retried,
           fix_installs: $n, install_signals: $signals, written: $written}')"
  fi
  record_install_signals
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

  # Every precondition is checked BEFORE anything is written, because the two
  # that follow used to be checked after `package.json` had been rewritten and
  # a full install had run — or, in the baseline's case, not at all.
  local relationship
  relationship=$(state_get_opt '.relationship')
  [ -n "$relationship" ] || die "apply: run 'classify' first"

  # An unrun `baseline` sent `--baseline null` into validate, which collapses
  # the `null` ("not checked") and `[]` ("checked and clean") distinction
  # `other_line_moves` draws, silently voiding the #146 protection. Only
  # `.relationship` was guarded, so the skip was invisible.
  #
  # `baseline_json` and `alerts_json` are read once here and used again inside
  # `validate_call`, which bash's dynamic scoping makes visible to it. They are
  # read HERE rather than there so both are checked before the first write.
  local baseline_json alerts_json bst
  baseline_json=$(state_json '.baseline'); bst=$?
  case "$bst" in
    0) ;;
    2) die "apply: run 'baseline' first. Without its post-control-install snapshot, validate is handed --baseline null, which reports every cross-line move as 'not checked' rather than as checked and clean (#146)." ;;
    *) state_ok "$bst" '.baseline' ;;
  esac
  alerts_json=$(state_json '.group.alerts'); state_ok $? '.group.alerts'
  printf '%s' "$alerts_json" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1 \
    || die "apply: the group payload carries no alerts array; run 'setup' with a complete group"


  # A `vulnerable_range` that is absent or null is a hard error, never an alert
  # quietly dropped from the set: `--vulnerable` exists precisely so validate
  # can answer whether the alerts were CLEARED, and shrinking the set lets
  # `unresolved_alerts` come back empty for an alert nothing ever checked.
  local unchecked
  unchecked=$(printf '%s' "$alerts_json" | jq -c '
    [ .[] | select((.vulnerable_range | type) != "string" or (.vulnerable_range | length) == 0)
      | (.number // "<unnumbered>") ]')
  [ "$unchecked" = "[]" ] \
    || fail_phase apply "alert(s) $unchecked in this group carry no vulnerable_range, so validate cannot be asked whether they were cleared. Dropping them from --vulnerable would let unresolved_alerts come back empty for an alert nothing checked — the silent partial fix that flag exists to prevent (scripts/CLAUDE.md). Nothing was written."

  local hfv
  hfv=$(state_get '.group.highest_fixed_version'); state_ok $? '.group.highest_fixed_version'

  # Read strictly, like every other precondition. Defaulted to 0 on an absent
  # or unreadable value, the persisted counter re-opens the exact hole
  # persisting it closed: the budget stops bounding the run and
  # `install_budget_exhausted` becomes unreachable again, with nothing said.
  FIX_INSTALLS=$(state_get '.fix_installs'); state_ok $? '.fix_installs'
  case "$FIX_INSTALLS" in
    ''|*[!0-9]*) die "apply: the state file's fix_installs is '$FIX_INSTALLS', which is not a count. The fix-install budget cannot be enforced against it, and defaulting it to zero would silently unbound the run." ;;
  esac

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
    APPLIED_PARENTS_JSON=$(state_json '.eligible_parents'); state_ok $? '.eligible_parents'
  fi

  # The pre-fix observations are captured once per RUN, not once per `apply`
  # call. Recomputed on the budgeted re-run, they describe a manifest this
  # flow has already written the override into, so `targets_this_package`
  # reads true and a bare override this run ADDED gets reported as
  # `tightened` — the pin audit then reads a global pin nobody created.
  # Absence is tested for with `has()`, not read off a null: a stored `[]` is a
  # legitimate value (this run saw no pre-fix observations) and must not be
  # confused with never having looked.
  local stored_obs have_obs
  have_obs=$(state_get_opt 'has("observations_first")')
  if [ "$have_obs" = "true" ]; then
    stored_obs=$(state_json '.observations_first'); state_ok $? '.observations_first'
  else
    stored_obs=""
  fi
  apply_call ""
  if [ -n "$stored_obs" ]; then
    OBSERVATIONS_FIRST=$stored_obs
  else
    OBSERVATIONS_FIRST=$(printf '%s' "$APPLY_RESULT" | jq -c '.observations')
    state_set observations_first "$OBSERVATIONS_FIRST"
  fi

  fix_install_step
  validate_call

  local ladder_step=0
  while [ "$VALIDATE_OK" != true ]; do
    # `line_present` false first: the line is not installed at all, so the
    # override does nothing and no ladder step can change that. Never open a PR
    # for a change with no effect.
    adapter_field validate "$VALIDATE_JSON" "validate --line $MAJOR_LINE $PACKAGE" line_present
    if [ "$ADAPTER_FIELD" = "false" ]; then
      fail_phase validate "line_present is false: nothing on the ${MAJOR_LINE}.x line of $PACKAGE is installed, so there was nothing here to fix and the override applied does nothing. requires_major_bump: $(printf '%s' "$VALIDATE_JSON" | jq -c '.requires_major_bump')"
    fi

    if [ "$ladder_step" -eq 0 ]; then
      # Step 1: uncovered parents. A violating version usually arrives via a
      # parent not in the override list; derive those from the violating
      # copies' paths, and never from parents_other_lines. Under pnpm and Yarn
      # Berry no such derivation is possible at all — see `uncovered_parents`.
      ladder_step=1
      # `path` is promised on every violation, and an absent one is a hard
      # error rather than an entry quietly dropped. Dropped, it counted in
      # neither `paths_naming_a_parent` nor `opaque_paths`, so the run reported
      # `possible: false` carrying the pnpm-and-Yarn reason — a wrong diagnosis
      # presented as a checked fact about a report that had simply stopped
      # answering.
      printf '%s' "$VALIDATE_JSON" \
        | jq -e '(.violations | type) == "array" and all(.violations[]; (.path | type) == "string")' \
          >/dev/null 2>&1 \
        || fail_phase validate "validate reported a violation with no readable 'path', so the ladder's first step cannot tell which copies name a parent and which name only themselves. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); dropped instead, the entry counts in neither total and the run reports the pnpm/Yarn 'no parent in the path shape' finding about a report that simply stopped answering. violations: $(printf '%s' "$VALIDATE_JSON" | jq -c '.violations')"
      uncovered_parents \
        || fail_phase validate "validate's violations[] could not be read for the ladder's first step: $(printf '%s' "$VALIDATE_JSON" | jq -c '.violations')"
      local uncovered
      uncovered=$(printf '%s' "$PARENT_DERIVATION" | jq -c '.parents')
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
      # it is the last thing reached for; step 1 is exhausted above — or, on a
      # pnpm or Yarn Berry repository, was never runnable, which
      # `parent_derivation` in this step's evidence and in the result says
      # rather than presenting an unexhausted step 1 as exhausted.
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
         --argjson li "$li" --argjson pd "$PARENT_DERIVATION" \
         '{validate: $v, written: $w, applied_parents: $parents,
           tighten_bare_applied: $tb, lockfile_invalidated: $li,
           parent_derivation: $pd}')"
  done

  # ---- validate passed -------------------------------------------------

  local porcelain
  porcelain=$(git_at "$WT" status --porcelain 2>&1) \
    || fail_phase validate "git status --porcelain failed in the worktree: $porcelain"

  # `drift` is the third input to the no_op-versus-lockfile-refresh decision,
  # and it gets the same strict read as the two snapshots beside it. Read
  # through `state_get_opt`, an unreadable or absent value mapped to `""`,
  # which is not `true`, which takes the **no_op** branch — the branch that
  # cleans up and leaves the alerts open. A silent default in the unsafe
  # direction is exactly #146's inversion, which the sibling reads already
  # `fail_phase` over.
  local drift action override_scope bare_override shape
  drift=$(state_get '.drift_commit'); state_ok $? '.drift_commit'
  case "$drift" in
    true|false) ;;
    *) fail_phase validate "the state file's drift_commit is '$drift', which is neither true nor false. It decides whether an empty fix diff is a true no-op or a lockfile-refresh, and anything unreadable there defaults toward no_op — reporting a real fix as 'already fixed' and leaving the alerts open (#146)." ;;
  esac

  # The widest shape actually applied, read off what was WRITTEN rather than
  # off `apply_constraint`'s `mode`. `mode` reports the call's INPUT — "direct"
  # means zero parents were passed — and a transitive package whose eligible
  # set came back empty takes exactly that branch, where the adapter writes a
  # top-level BARE override whenever the root manifest declares no key for the
  # package (node.sh's `($parents | length) == 0` arm). Keyed off `mode`, that
  # bare pin was reported as `direct-update` / `--override-scope none` /
  # `bare_override: none`: F6 scored 0 instead of 2, the PR body owed no
  # Global-override section, and the `unscoped_override_added` observation the
  # pin audit reads was never recorded — the audit losing the record of a pin
  # this run created.
  shape=$(printf '%s' "$APPLY_RESULT" | jq -r '
    def is_bare_key($p):
      if   $p[0] == "pnpm"        then ($p | length) == 3 and $p[1] == "overrides"
      elif $p[0] == "overrides"
        or $p[0] == "resolutions" then ($p | length) == 2
      else false end;
    [ .written[] | select((.preserved // false) != true) ] as $w
    | if   any($w[]; (.parent == null) and is_bare_key(.path)) then "bare"
      elif any($w[]; .path[0] == "dependencies" or .path[0] == "devDependencies") then "direct"
      elif ($w | length) > 0 then "scoped"
      else "none" end') \
    || fail_phase apply "apply_constraint's written[] could not be classified: $(printf '%s' "$APPLY_RESULT" | jq -c '.written')"

  # A `--tighten-bare` escalation is bare whatever it wrote: its one shape that
  # lands nowhere near a top-level key is `tighten_rule`, which tightens the
  # pre-existing rule pinning every copy the rule places (#147) — the widest
  # change available on that repository. So the two tests union rather than
  # replace one another.
  [ "$TIGHTEN_BARE_RAN" != true ] || shape=bare

  case "$shape" in
    bare)
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
      action=bare-override ;;
    direct)
      bare_override=none
      override_scope=none
      action=direct-update ;;
    scoped)
      bare_override=none
      override_scope=scoped
      action=scoped-override ;;
    *)
      # Nothing was written and validate passed: the manifest already carried
      # everything this fix needed. The empty-diff branch below decides whether
      # that is a no-op or a lockfile-refresh; until then it is scoped, the
      # narrowest claim available.
      bare_override=none
      override_scope=scoped
      action=scoped-override ;;
  esac

  if [ -z "$porcelain" ]; then
    # The empty-diff case. Phase 3's drift commit already absorbed any ambient
    # drift, so empty porcelain here means the fix install itself changed
    # nothing (#146). What it does not yet say is WHICH install cleared the
    # alerts, and the drift commit answers that.
    #
    # Both sides must be KNOWN to have parsed before they are compared. Read
    # through `2>/dev/null` with the status discarded, three separate routes
    # produced `""` or `[]` on both sides — a jq error on a null `.version`, a
    # a state read handing back the literal `null`, and a genuine zero-version
    # parse — and every one of them compared equal and reported `no_op`. That
    # is "already fixed on the default branch" manufactured out of two failed
    # reads: it discards the drift commit that WAS the fix and leaves the
    # alerts open with nothing to review (#146's inversion).
    local pre_line base_line
    local pre_src base_src
    pre_src=$(state_json '.pre_drift');  state_ok $? '.pre_drift'
    base_src=$(state_json '.baseline');  state_ok $? '.baseline'
    pre_line=$(line_versions "$pre_src" "$MAJOR_LINE") \
      || fail_phase validate "the pre-drift lockfile snapshot could not be read, so whether the control install cleared the ${MAJOR_LINE}.x line cannot be decided. It is never assumed unchanged: that reports a real lockfile-refresh fix as 'already fixed' and leaves the alerts open (#146)."
    base_line=$(line_versions "$base_src" "$MAJOR_LINE") \
      || fail_phase validate "the post-control-install baseline snapshot could not be read, so whether the control install cleared the ${MAJOR_LINE}.x line cannot be decided (#146)."
    # `[]` on either side is a parse that found no copy of this line, while
    # validate has just reported `line_present: true` for it. The two disagree,
    # so neither an equality nor a difference between them is evidence.
    if [ "$pre_line" = "[]" ] || [ "$base_line" = "[]" ]; then
      fail_phase validate "the fix install changed nothing, and telling a true no-op from a lockfile-refresh needs the ${MAJOR_LINE}.x versions on both sides of the control install. One side carries none while validate reports the line present, so the snapshots disagree and 'already fixed on the default branch' is not a conclusion this evidence supports (#146). pre_drift=$pre_line baseline=$base_line"
    fi
    if [ "$drift" != "true" ] || [ "$pre_line" = "$base_line" ]; then
      # A true no-op: the default branch already resolves the fixed versions.
      # Dependabot re-scans on its own schedule, so alerts read as open for a
      # window after the fix merged. A lone unrelated drift commit does not
      # change this; the branch is cleaned up like any other no-op.
      # `resolved_versions` is the whole evidence for "already fixed on the
      # default branch". Read with `[]?`, an absent one became the empty
      # string, interpolated into the reason as "against the resolved " and
      # reported as a success.
      local resolved
      adapter_field validate "$VALIDATE_JSON" "validate --line $MAJOR_LINE $PACKAGE" resolved_versions
      resolved=$(printf '%s' "$VALIDATE_JSON" | jq -r '
        if (.resolved_versions | type) != "array" or (.resolved_versions | length) == 0
        then error("validate reported no resolved_versions to evidence the no-op with")
        else (.resolved_versions | join(", ")) end') \
        || fail_phase validate "the fix install changed nothing and validate names no resolved version of $PACKAGE, so there is no evidence that the ${MAJOR_LINE}.x line is already fixed. A no_op reported on an empty resolved_versions is an assertion, not a finding."

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
  local apply_signals
  apply_signals=$(state_json '.install_signals // []'); state_ok $? '.install_signals'
  state_set apply_result "$APPLY_RESULT"
  state_set validate "$VALIDATE_JSON"
  state_set applied_parents "$APPLIED_PARENTS_JSON"
  state_set tighten_bare "$(jbool "$TIGHTEN_BARE_RAN")"

  require_json apply "$APPLY_RESULT" "apply_constraint's result"
  require_json apply "$VALIDATE_JSON" "validate's report"
  require_json apply "$APPLIED_PARENTS_JSON" "the applied parent list"
  require_json apply "$OBSERVATIONS_FIRST" "the pre-fix observations"
  require_json apply "$PARENT_DERIVATION" "the ladder's parent derivation"
  require_json apply "$apply_signals" "the install signals"
  jq -n --arg action "$action" --arg scope "$override_scope" --arg bare "$bare_override" \
    --argjson apply "$APPLY_RESULT" --argjson validate "$VALIDATE_JSON" \
    --argjson parents "$APPLIED_PARENTS_JSON" --argjson obs0 "$OBSERVATIONS_FIRST" \
    --argjson pd "$PARENT_DERIVATION" \
    --argjson signals "$apply_signals" \
    '{status: "ok", step: "apply", action: $action, override_scope: $scope,
      bare_override: $bare, applied_parents: $parents,
      parent_derivation: $pd, install_signals: $signals,
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
# minus every parent on another major line, into PARENT_DERIVATION alongside
# the evidence for how many paths could be read that way at all.
#
# **The three managers report `path` differently and only one of the three
# names a parent.** `node.sh` emits `node_modules/...`, the lockfile key, for
# npm (`npm_versions`); `<name>@<version>` for pnpm (`pnpm_versions`); and the
# resolution locator `<name>@npm:<version>` for Yarn Berry (`yarn_versions`).
# The last two name the VIOLATING COPY, not its enclosing parent, and carry no
# parent information at all — under pnpm's isolated store and Berry's PnP there
# is no enclosing directory to name. So this step is structurally impossible on
# two of the three toolchains, and the honest answer is to say so rather than
# to invent one: the previous jq assumed npm's shape for every manager and
# yielded `null` for the other two, which made `uncovered_parents` `[]` on
# every pnpm and Yarn repository and escalated the run straight to
# `--tighten-bare`, the widest change the flow can make, with step 1 reported
# as exhausted. (The `.pnpm/<parent>@<ver>/node_modules/<pkg>` branch it also
# carried, and its `sub("^\\.pnpm/"; "")`, were dead: node.sh emits no such
# path.)
uncovered_parents() {
  local other applied
  other=$(state_json '.declared.parents_other_lines // []') || return 1
  applied=$APPLIED_PARENTS_JSON
  PARENT_DERIVATION=$(printf '%s' "$VALIDATE_JSON" | jq -c \
    --argjson other "$other" --argjson applied "$applied" --arg pkg "$PACKAGE" '
    def bare_name:
      . as $k
      | ($k | rindex("@")) as $i
      | if $i == null or $i == 0 then $k else $k[0:$i] end;
    # Only an install-path shape names the enclosing parent, in the segments
    # immediately before the last `node_modules`. A SCOPED parent occupies two
    # of them: `node_modules/@nestjs/core/node_modules/lodash` must yield
    # `@nestjs/core`, and the single-segment read yielded `core` — a package
    # name npm has never heard of. Passed to `apply_constraint` it produced a
    # scoped override naming a parent that does not exist, so the entry moved
    # nothing, validate still failed, and the run escalated to a tree-wide
    # bare pin. Scoped parents are ubiquitous (`@babel/`, `@types/`,
    # `@nestjs/`), and no fixture in any of the three managers carried one,
    # which is why the suite never saw it.
    def parent_of($path):
      ($path | split("/")) as $seg
      | ([ range(0; $seg | length) | select($seg[.] == "node_modules") ] | last) as $i
      | if $i == null or $i == 0 then null
        elif $i >= 2 and ($seg[$i - 2] | startswith("@"))
          then $seg[$i - 2] + "/" + $seg[$i - 1]
        else $seg[$i - 1] end;
    if (.violations | type) != "array" then
      error("validate reported no violations array")
    elif any(.violations[]; (.path | type) != "string") then
      error("a validate violation carries no readable path")
    else
      [ .violations[] | .path ] as $paths
      | [ $paths[] | select(test("(^|/)node_modules/")) ] as $shaped
      | [ $paths[] | select(test("(^|/)node_modules/") | not) ] as $opaque
      | { parents:
            ((([ $shaped[] | parent_of(.) | select(. != null) ]
               | map(bare_name)
               | map(select(. != $pkg and . != "node_modules"))
               | unique)
              - ($other | map(bare_name))) - $applied),
          paths_naming_a_parent: ($shaped | length),
          paths_naming_only_the_copy: ($opaque | length),
          opaque_paths: ($opaque | unique),
          possible: (($shaped | length) > 0),
          reason: (if ($shaped | length) > 0 then null
                   else "no violating copy'"'"'s path names its enclosing parent: pnpm reports <name>@<version> and Yarn Berry the resolution locator <name>@npm:<version>, both of which name the copy itself. No parent can be derived from this report, and none was invented."
                   end) }
    end') || return 1
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
  action=$(state_get_opt '.action')
  [ -n "$action" ] || die "score: run 'apply' first"
  # A true no-op is terminal at `apply`: there is no change to score and no PR
  # to open, so scoring one would manufacture a rating for a diff that does not
  # exist (#34).
  [ "$action" != "no-op" ] || die "score: apply returned no_op, which is terminal. There is no change to score."

  adapter_run resolved_versions "$PACKAGE" \
    || fail_phase validate "resolved_versions $PACKAGE failed after the fix: $(adapter_error_text)"
  local post=$ADAPTER_OUT
  adapter_field validate "$post" "resolved_versions $PACKAGE (after the fix)" present
  state_set post_fix "$post"

  # The why capture gets its own package-qualified name under $WORK: a
  # predictable filename in a shared directory lets a sibling agent overwrite
  # it mid-run (#133), and a scoped name substituted raw would target a
  # directory $WORK never creates (#161's sibling defect).
  local package_path why_file
  package_path=$(state_get '.package_path'); state_ok $? '.package_path'
  why_file="$WORK/why-$package_path.json"
  adapter_run why "$PACKAGE" \
    || fail_phase validate "why $PACKAGE failed after the fix: $(adapter_error_text)"
  # Asserted before it is written, because the same bytes come back in through
  # `--argjson why_json` at the end of this function: an adapter exiting 0 with
  # empty stdout makes that jq die with exit 2 and NO stdout, which an agent
  # reads as a `needs_judgment` and then hunts for a decision point that does
  # not exist.
  local why_out=$ADAPTER_OUT
  adapter_field validate "$why_out" "why $PACKAGE (after the fix)" raw
  printf '%s\n' "$why_out" > "$why_file" \
    || fail_phase validate "the why capture could not be written to $why_file, so the risk scorer has no --why-json to read."

  # Always --line: without it the verb collects every declaration of the name
  # anywhere in the lockfile, and parents on lines the override never touched
  # score as distance this fix crossed (#76).
  adapter_run declared_ranges --line "$MAJOR_LINE" "$PACKAGE" \
    || fail_phase validate "declared_ranges --line $MAJOR_LINE $PACKAGE failed after the fix: $(adapter_error_text)"
  local declared_post=$ADAPTER_OUT
  adapter_field validate "$declared_post" "declared_ranges --line $MAJOR_LINE $PACKAGE (after the fix)" ranges
  state_set declared_post "$declared_post"

  # F1's --before comes from the post-control-install baseline, so the delta is
  # fix-attributable — except on a lockfile-refresh, where the refresh IS the
  # change and the pre-drift snapshot is the honest before.
  local before_src before after st
  if [ "$action" = "lockfile-refresh" ]; then
    before_src=$(state_json '.pre_drift'); state_ok $? '.pre_drift'
  else
    before_src=$(state_json '.baseline'); state_ok $? '.baseline'
  fi
  before=""
  adapter_field validate "$before_src" "the pre-fix resolved_versions snapshot" present
  if [ "$ADAPTER_FIELD" = "true" ]; then
    lowest_on_line "$before_src" "$MAJOR_LINE"
    st=$?
    case "$st" in
      0) before=$LOWEST_ON_LINE ;;
      # Present, but nothing of it on this line. `--before` is then omitted and
      # the scorer's own no-baseline branch scores F1 as a major — the safe
      # direction. What is never done is substituting a version from another
      # major line, which is what the old off-line fallback did (#76).
      1) before="" ;;
      *) fail_phase validate "the pre-fix lockfile snapshot could not be compared for the ${MAJOR_LINE}.x line, so F1's --before cannot be stated. A version taken from another line would be scored as this fix's delta (#76)." ;;
    esac
  fi
  lowest_on_line "$post" "$MAJOR_LINE" \
    || fail_phase validate "the post-fix lockfile carries no comparable ${MAJOR_LINE}.x version of $PACKAGE, so this fix has no resolved version to report. Passed on as an empty --after, this surfaces as the risk scorer failing, which names the scorer for an unreadable lockfile (#76)."
  after=$LOWEST_ON_LINE

  local scope bare_override_final
  scope=$(state_get '.override_scope'); state_ok $? '.override_scope'
  bare_override_final=$(state_get '.bare_override'); state_ok $? '.bare_override'

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

  # A failed scorer is a phase failure, not an internal error: exit 1 is this
  # script's usage-and-internal code, and reporting a step that ran and failed
  # under it puts it in a different bucket from every other failure of the
  # same phase.
  local errfile risk
  errfile=$(mktemp) || die "cannot create a temporary file"
  risk=$( ( cd "$WT" && run_env "$SCORER" "${args[@]}" ) 2>"$errfile" )
  st=$?
  if [ "$st" -ne 0 ]; then
    local serr
    serr=$(cat "$errfile")
    rm -f "$errfile"
    fail_phase validate "score-merge-risk.sh failed: $serr"
  fi
  rm -f "$errfile"
  printf '%s' "$risk" | jq -e 'type == "object" and has("band")' >/dev/null 2>&1 \
    || fail_phase validate "score-merge-risk.sh returned no usable report: $risk"
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

  # Every `--argjson` source below is asserted first. `jq -n --argjson x ""`
  # dies with exit 2 and no stdout, and exit 2 is this contract's
  # `needs_judgment` — so one empty adapter reply here reaches the agent as a
  # judgment escape carrying no decision point and no evidence at all.
  local apply_json validate_json2 parents_json drift_json obs0_json signals_json
  apply_json=$(state_json '.apply_result');     state_ok $? '.apply_result'
  validate_json2=$(state_json '.validate');      state_ok $? '.validate'
  parents_json=$(state_json '.applied_parents // .eligible_parents')
  state_ok $? '.applied_parents // .eligible_parents'
  drift_json=$(state_json '.drift_commit');      state_ok $? '.drift_commit'
  obs0_json=$(state_json '.observations_first'); state_ok $? '.observations_first'
  signals_json=$(state_json '.install_signals // []'); state_ok $? '.install_signals'
  require_json validate "$risk" "the risk scorer's report"
  require_json validate "$apply_json" "the stored apply_constraint result"
  require_json validate "$validate_json2" "the stored validate report"
  require_json validate "$parents_json" "the stored applied/eligible parent list"
  require_json validate "$drift_json" "the stored drift_commit flag"
  require_json validate "$obs0_json" "the stored pre-fix observations"
  require_json validate "$declared_post" "declared_ranges' post-fix report"
  require_json validate "$why_out" "why's post-fix report"

  jq -n \
    --arg pkg "$PACKAGE" --arg line "$MAJOR_LINE" --arg branch "$BRANCH_NAME" \
    --arg work "$WORK" --arg worktree "$WT" --arg why "$why_file" \
    --arg action "$action" --arg scope "$scope" \
    --arg bare "$bare_override_final" \
    --arg before "$before" --arg after "$after" \
    --argjson risk "$risk" \
    --argjson apply "$apply_json" \
    --argjson validate "$validate_json2" \
    --argjson why_json "$why_out" \
    --argjson declared "$declared_post" \
    --argjson obs0 "$obs0_json" \
    --argjson parents "$parents_json" \
    --argjson drift "$drift_json" \
    --argjson signals "$signals_json" \
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
      install_signals: $signals,
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

  # One entry per error. Captured output is flattened to a single line first —
  # the way `read_ref` flattens its own — because the report splits `errors` on
  # newlines, so an embedded one turns a single failure into four findings.
  local errors=""
  note_error() {
    errors="$errors$(printf '%s' "$1" | tr '\n' ' ')
"
  }

  # ---- the containment guard ---------------------------------------------
  #
  # This function runs `rm -rf` on `$WORK`, and `$WORK` arrives from `--work`
  # on the command line rather than from state. The only gate used to be that
  # the directory held a parseable `state.json`. `reap-agent-artifacts.sh` —
  # the sibling that runs the same removal on the orchestrator's side — holds
  # the path to three conditions before its own `rm -rf`, and they are adopted
  # verbatim here: both sides resolved physically first, no `..` segment, and
  # contained under `<repo_root>/.claude/worktrees/`.
  #
  # A fourth compares `--work` against the path `setup` recorded. **It is not
  # independent evidence**, and it should not be read as a fourth lock: both
  # `state.work` and `REPO_ROOT` come out of `$WORK/state.json`, the file
  # inside the very directory about to be deleted, so every one of the four is
  # satisfiable by any directory carrying a self-consistent state file. What
  # the set actually rules out is a path outside this repository's worktree
  # root, a path reached through a `..` segment or a symlink, and a workspace
  # that has been MOVED since `setup` wrote it. A deliberately forged state
  # file is not in scope for any of them.
  #
  # Every check below runs on the resolved path, and every removal further
  # down uses that same resolved string. Checking `$resolved_work` and then
  # removing `$WORK` is a check-vs-use mismatch: with `$WORK` a symlink to a
  # contained directory, `rm -rf` unlinks the link, `[ ! -e "$WORK" ]` is then
  # true, and the run reports `removed` while the workspace it was asked to
  # remove is still there.
  local state_work resolved_work resolved_root resolved_wt
  state_work=$(state_get '.work'); state_ok $? '.work'
  resolved_root=$(resolve_path "$REPO_ROOT")
  [ -z "$RESOLVE_ERR" ] || die "cleanup: $RESOLVE_ERR"
  resolved_work=$(resolve_path "$WORK")
  [ -z "$RESOLVE_ERR" ] || die "cleanup: $RESOLVE_ERR"
  local resolved_state_work
  resolved_state_work=$(resolve_path "$state_work")
  [ -z "$RESOLVE_ERR" ] || die "cleanup: $RESOLVE_ERR"

  no_dotdot "$WORK" || die "cleanup: the work path must not contain a .. segment: $WORK"
  contained "$resolved_root" "$resolved_work" \
    || die "cleanup: the work path is not under $resolved_root/.claude/worktrees/: $resolved_work. Nothing was removed."
  [ "$resolved_work" = "$resolved_state_work" ] \
    || die "cleanup: --work names $resolved_work, but setup recorded this run's workspace as $resolved_state_work. A removal is only ever issued against the path this run created; nothing was removed."

  # `$WT` is resolved and guarded the same way: a symlink there would carry
  # `worktree remove` out of the tree this call proved it owns.
  resolved_wt=$(resolve_path "$WT")
  [ -z "$RESOLVE_ERR" ] || die "cleanup: $RESOLVE_ERR"
  no_dotdot "$WT" || die "cleanup: the worktree path must not contain a .. segment: $WT"
  contained "$resolved_root" "$resolved_wt" \
    || die "cleanup: the worktree path resolves outside $resolved_root/.claude/worktrees/: $resolved_wt. Nothing was removed."

  # ---- the worktree ------------------------------------------------------
  #
  # Three outcomes, never a default of `true`. Initialized to `true` and only
  # ever set false by a failed `worktree remove`, an absent `$WT` reported the
  # worktree as removed by this cleanup when nothing had been removed at all.
  local detail="" removed rerr
  # `worktree remove` names this run's own path and drops its administrative
  # entry: that is the whole cleanup an agent is entitled to. Never
  # `git worktree prune` — it is repository-wide, and a sibling agent very
  # likely shares this repo_root right now (#35).
  if [ ! -e "$resolved_wt" ]; then
    removed=absent
  elif rerr=$(git_at "$REPO_ROOT" worktree remove --force "$resolved_wt" 2>&1); then
    removed=removed
  else
    removed=removal-failed
    detail="git worktree remove --force $resolved_wt failed: $rerr"
    note_error "git worktree remove --force $resolved_wt failed: $rerr"
  fi

  # Read every fact the branch decision needs before $WORK disappears.
  #
  # `rev-parse --verify --quiet` answers a missing ref with empty stdout,
  # exit 1 and NO stderr, so "no such branch" and "git failed" are told apart
  # by the stderr and nowhere else. Folded together, a transient failure — a
  # sibling agent's ref lock is the field specimen — reported the branch as
  # absent, skipped the whole block, and left it behind with
  # `branch_deleted: false, reason: null`. reap-agent-artifacts.sh fixed
  # exactly this (issue #131 review); this rewrite had dropped the split.
  # All THREE reads capture the stderr, not two of them. `remote` used to take
  # only `$REF_TIP`, so a transient failure reading
  # `refs/remotes/origin/$BRANCH_NAME` — the same sibling-ref-lock specimen —
  # left `remote=""`, the `--pushed` arm below could not fire, and the run
  # asserted "the tip is not on origin and is not this flow's own leftover"
  # about a ref nobody had managed to read, with nothing in `errors[]`.
  local tip tip_err dflt dflt_err remote remote_err subjects nsubj names
  read_ref "$REPO_ROOT" "refs/heads/$BRANCH_NAME"
  tip=$REF_TIP; tip_err=$REF_ERR
  read_ref "$REPO_ROOT" "refs/remotes/origin/$DEFAULT_BRANCH"
  dflt=$REF_TIP; dflt_err=$REF_ERR
  read_ref "$REPO_ROOT" "refs/remotes/origin/$BRANCH_NAME"
  remote=$REF_TIP; remote_err=$REF_ERR

  local safe=false reason="" deleted=false
  if [ -n "$tip_err" ]; then
    note_error "git rev-parse refs/heads/$BRANCH_NAME failed: $tip_err"
    detail="${detail:+$detail; }the local branch could not be read, so it was neither classified nor deleted: $tip_err"
  fi
  if [ -n "$dflt_err" ]; then
    note_error "git rev-parse refs/remotes/origin/$DEFAULT_BRANCH failed: $dflt_err"
  fi
  if [ -n "$remote_err" ]; then
    note_error "git rev-parse refs/remotes/origin/$BRANCH_NAME failed: $remote_err"
  fi
  if [ -n "$tip" ] && [ -z "$tip_err" ] && [ -z "$dflt_err" ] && [ -z "$remote_err" ]; then
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

  # Never while the registration is still live. `rm -rf "$WORK"` used to run
  # unconditionally, so a failed `worktree remove` left the directory deleted
  # and its entry under `<git-common-dir>/worktrees/` intact — the exact state
  # scripts/CLAUDE.md describes as blocking both a later `worktree add` on that
  # path and any `branch -D` of its branch, and which `git worktree remove`
  # itself then refuses to clean up.
  local work_action work_err
  if [ "$removed" = "removal-failed" ]; then
    work_action=kept-registration-live
    detail="${detail:+$detail; }$resolved_work was left on disk: deleting it while the worktree registration survives is the state that blocks a later worktree add on this path and any branch -D of $BRANCH_NAME, and git worktree remove refuses to clean it up afterwards. Remove the registration first, by hand."
  elif [ ! -e "$resolved_work" ]; then
    work_action=absent
  else
    # The status was never checked, so a removal that failed — a permission, a
    # busy mount, a read-only parent — reported `worktree_removed: true`,
    # `detail: null`, and no field naming `$WORK` at all. That is verbatim the
    # failure scripts/CLAUDE.md records, on the other side of the same
    # operation. The stderr is kept and quoted, the way the reap keeps it: an
    # operator told only that a removal failed, and then told to finish it by
    # hand, has not been told the one thing that decides how.
    work_err=$(rm -rf "$resolved_work" 2>&1)
    if [ ! -e "$resolved_work" ]; then
      work_action=removed
    else
      work_action=removal-failed
      detail="${detail:+$detail; }rm -rf $resolved_work did not remove the directory${work_err:+, quoting it: $work_err}"
      note_error "rm -rf $resolved_work did not remove the directory${work_err:+: $work_err}"
    fi
  fi

  if [ -n "$tip" ] && [ -z "$tip_err" ] && [ "$safe" = true ] && [ "$removed" != "removal-failed" ]; then
    local derr
    if derr=$(git_at "$REPO_ROOT" branch -D "$BRANCH_NAME" 2>&1); then
      deleted=true
    else
      # Never silenced, and never a failure result on its own: by this point
      # the work either shipped or already failed for its own reason.
      detail="${detail:+$detail; }git branch -D $BRANCH_NAME failed: $derr"
    fi
  elif [ -n "$tip" ] && [ -z "$tip_err" ] && [ -n "$remote_err" ]; then
    reason="left in place: origin/$BRANCH_NAME could not be read, so whether the tip is a duplicate of pushed work is unknown and a branch is never deleted on an unknown"
    detail="${detail:+$detail; }branch $BRANCH_NAME left in place at $tip"
  elif [ -n "$tip" ] && [ -z "$tip_err" ]; then
    reason="left in place: the tip is not on origin and is not this flow's own leftover, and a commit that never reached the remote is the one thing here that cannot be recreated"
    detail="${detail:+$detail; }branch $BRANCH_NAME left in place at $tip"
  fi

  # `worktree` and `work_dir` are two different paths and two different
  # removals — the git registration, and the directory holding it — so each
  # reports its own action, the way reap-agent-artifacts.sh reports
  # `work_dir: {path, action}` beside `errors[]`.
  #
  # And, like the reap, a populated `errors[]` is a FAILURE
  # (reap-agent-artifacts.sh's own last line is `[ -z "$errors" ] || exit 1`).
  # Copying its reporting shape without that line put the fields in the payload
  # and left `status: "ok"` and exit 0 above them, so an orchestrator keying on
  # either — which every other subcommand's contract tells it to do — read a
  # leaked worktree as a clean cleanup. `worktree` is the right phase name for
  # it: a directory gone while its registration survives blocks every later run
  # against this repository until a human clears it.
  local status=ok phase_field=""
  if [ -n "$errors" ]; then
    status=failure
    phase_field=worktree
    printf 'fix-group: cleanup failure: %s\n' "$detail" >&2
  fi
  jq -n --arg removed "$removed" --arg work_action "$work_action" \
    --argjson deleted "$(jbool "$deleted")" \
    --arg wt "$resolved_wt" --arg workdir "$resolved_work" \
    --arg branch "$BRANCH_NAME" --arg tip "$tip" --arg reason "$reason" --arg detail "$detail" \
    --arg errors "$errors" --arg status "$status" --arg phase "$phase_field" \
    '{status: $status, step: "cleanup"}
     + (if $phase == "" then {} else {phase: $phase} end)
     + {worktree_removed: ($removed == "removed"),
        worktree: {path: $wt, action: $removed},
        work_dir: {path: $workdir, action: $work_action},
        branch: $branch, branch_deleted: $deleted,
        branch_tip: (if $tip == "" then null else $tip end),
        reason: (if $reason == "" then null else $reason end),
        detail: (if $detail == "" then null else $detail end),
        errors: ($errors | split("\n") | map(select(length > 0)))}'
  [ -z "$errors" ] || exit 3
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
