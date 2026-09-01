#!/usr/bin/env bash
# audit-pins-driver.sh — the deterministic driver for one repository's pin audit
#
# Usage:
#   audit-pins-driver.sh list     --work <dir> --worktree <dir> --adapter <path>
#                                 [--scripts-dir <dir>] [--advisories <path>]
#                                 [--env-prefix "<string>"]
#   audit-pins-driver.sh baseline --work <dir>
#   audit-pins-driver.sh test-pin --work <dir> (--key <key> | --path <json array>)
#   audit-pins-driver.sh judge    --work <dir>
#   audit-pins-driver.sh together --work <dir>
#
# This script is the single home of `agents/audit-pins.md` phases 2, 4, 5 and
# 7. **A prose re-derivation of any of it in an agent definition is a bug**
# (scripts/CLAUDE.md, "The fix driver owns phases 1 to 5" — the same rule, one
# flow over): the agent calls the steps below and applies judgment only where
# the driver hands control back. Phase 1 (the worktree and its two `pr`-mode
# guards), phase 3 (provenance), phase 6 (the report) and phase 8 (merge risk
# and the PR) stay with the agent, because each of them reads history or writes
# prose.
#
# Stepped, with a state file at `$WORK/state.json`, rather than one run, for
# `fix-group.sh`'s reasons and one of its own: this flow runs **one install per
# pin**, and a repository with a dozen pins cannot fit inside the Bash tool's
# 10-minute ceiling however the work is arranged. `test-pin` is therefore one
# pin per call, and the state file is what makes the with-all-pins baseline
# outlive the call that took it.
#
# Contract:
#   exit 0  {"status":"ok", ...}              an intermediate step completed
#           {"status":"no_pins", ...}         terminal: this repo pins nothing
#           {"status":"no_candidates", ...}   terminal: nothing came back removable
#           {"status":"partial_map", ...}     terminal: the baseline map is partial
#           {"status":"combined_failed", ...} terminal: neither attempt was clean
#           {"status":"ready_for_pr", ...}    terminal: hand to phase 8
#   exit 2  RESERVED by the checkpoint contract and never emitted here. This
#           driver has no undecidable branch: every one of them is a phase
#           failure, because there is no remediation ladder for an agent to
#           escape into — a pin either tested or it did not. The value still
#           matters, because `jq -n --argjson x ""` exits 2 with NO stdout, so
#           an unguarded empty capture would manufacture a judgment escape
#           carrying no decision point at all. `state_json`, `rv_versions` and
#           `advisory_validate` exist to stop that at each of the three places a
#           payload enters this script, and there is deliberately no
#           `needs_judgment` helper to reach for.
#   exit 3  {"status":"failure","phase":"list|install|restore|advisories|compose",
#            "detail":"..."}   terminal failure, mapped verbatim onto the
#           agent's result block. The agent's other phase names never appear
#           here: `input` and `worktree` name phase 1's work, `verify`, `push`
#           and `pr` name phase 8's, and this driver does none of it. `compose`
#           appears only from `together`, which is phase 7 — the agent's result
#           contract reserves that name for exactly this step's two failures,
#           an edit that did not land and an install that did not finish.
#   exit 1  {"error":"..."}                   usage or internal error
#
# All JSON goes to stdout; human-readable detail goes to stderr.
#
# `--env-prefix` is an opaque argv prefix (scripts/CLAUDE.md, "`env_prefix` is
# an opaque, optional seam"). It is split on whitespace and prepended verbatim
# to every git, adapter, package-manager and `check-advisories.sh` invocation,
# composed **after** any `cd`: it injects environment, it does not chdir.
# Absent means bare. `check-advisories.sh` takes it because it makes its own
# `gh` call.
#
# Dependencies are bash, jq and git only; `check-advisories.sh` makes the one
# `gh` call this flow needs. bash 3.2: no associative arrays, no `mapfile`, no
# `${var,,}`.

set -uo pipefail

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

die() {
  printf '%s\n' "$1" >&2
  jq -n --arg e "$1" '{error: $e}'
  exit 1
}

fail_phase() {
  printf 'audit-pins-driver: %s failure: %s\n' "$1" "$2" >&2
  jq -n --arg p "$1" --arg d "$2" '{status: "failure", phase: $p, detail: $d}'
  exit 3
}

jbool() {
  if [ "$1" = true ]; then printf 'true'; else printf 'false'; fi
}

# A JSON integer, or `null` when the value could not be read. Never `0`: zero
# is the STRONGEST coverage claim this flow makes — "every lockfile entry was
# read" — and reporting it for a number nobody could read fabricates exactly
# the reassurance the unreadable-entries rule exists to withhold (#48).
jq_int_or_null() {
  case "${1:-}" in
    ''|*[!0-9]*) printf 'null' ;;
    *) printf '%s' "$1" ;;
  esac
}

# ---------------------------------------------------------------------------
# env_prefix — see fix-group.sh for why the element count is tracked separately
# (bash 3.2 has no safe empty-array expansion under `set -u`).
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
# State
#
# Every read distinguishes "value", "absent" and "unreadable", for the reason
# fix-group.sh states at length: a discarded jq status turns a truncated
# state.json into empty strings, and an empty path then reaches `git -C ""`,
# which silently operates on the CURRENT directory (#18's failure mode).
# ---------------------------------------------------------------------------

STATE=""

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
    1) die "the state file at $STATE could not be read for '$2'. It is unparseable or truncated; nothing was removed or installed on its say-so." ;;
    *) die "the state file at $STATE has no usable value for '$2'. Run the earlier steps first; an absent or empty value is never read as a legitimate answer here." ;;
  esac
}

state_get_opt() {
  local v
  v=$(jq -r "$1" "$STATE" 2>/dev/null) || v=""
  case "$v" in null) v="" ;; esac
  printf '%s' "$v"
}

# Every JSON value read out of the state file goes through this, and there is
# deliberately no unchecked sibling to reach for.
#
# A bare `jq -c "$f" "$STATE"` read through a command substitution drops its
# status, and a dropped status here is not a small thing: the empty string
# reaches `jq -n --argjson x ""`, which dies with exit 2 and NO stdout, and
# exit 2 is this script's own `needs_judgment`. One unreadable state file would
# therefore arrive at the agent as a judgment escape carrying no
# `decision_point` and no evidence at all, which is the hazard the shape
# predicate below exists for.
#
# The value lands in STATE_JSON rather than on stdout for the reason
# `adapter_field` does the same: `fail_phase` exits, and an exit inside a
# command substitution ends only the subshell.
STATE_JSON=""

state_json() {
  # $1 phase, $2 jq filter, $3 jq predicate the value must satisfy, $4 description
  #
  # The predicate is not decoration. Validating that a state value is JSON
  # says almost nothing — every jq read of a parseable object yields JSON,
  # `null` included — so a `findings` that came back a string, or a
  # `baseline_map` that came back a number, would sail through and take a
  # branch of its own downstream. The shape the step that wrote it promised is
  # the thing worth asserting, and it is what these calls assert.
  # Two failures, and the second subsumes what a bare "is this JSON?" guard
  # would catch: a jq that could not read the file prints nothing, and an empty
  # value reaching `jq -n --argjson x ""` dies with exit 2 and NO stdout — this
  # contract's own `needs_judgment`, arriving with no decision point at all.
  # The shape predicate refuses an empty value along with every other value
  # that is not what the step promised, so there is one check here rather than
  # two, and it is one a fixture can actually fire.
  STATE_JSON=$(jq -c "$2" "$STATE" 2>/dev/null) \
    || fail_phase "$1" "$4 could not be read out of the state file at $STATE. It is unparseable or truncated; nothing was installed or removed on its say-so."
  printf '%s' "$STATE_JSON" | jq -e "$3" >/dev/null 2>&1 \
    || fail_phase "$1" "$4 is in the state file but is not the shape the step that wrote it promised (expected: $3). An earlier step failed part-way, or the file was edited by hand. Value: $STATE_JSON"
}

state_set() {
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
  [ -f "$STATE" ] || die "no state file at $STATE; run 'list' first"
  jq -e 'type == "object"' "$STATE" >/dev/null 2>&1 \
    || die "the state file at $STATE is not a readable JSON object. A crashed 'list' can leave a zero-byte one; inspect $WORK by hand rather than rerunning, because nothing here can tell an interrupted run from a foreign directory."
  WT=$(state_get '.worktree');           state_ok $? '.worktree'
  ADAPTER=$(state_get '.adapter');       state_ok $? '.adapter'
  ADVISORIES=$(state_get '.advisories'); state_ok $? '.advisories'
  OVERRIDE_FILE=$(state_get '.override_file'); state_ok $? '.override_file'
  set_env_prefix "$(state_get_opt '.env_prefix')"
}

# ---------------------------------------------------------------------------
# Adapter and git seams
# ---------------------------------------------------------------------------

# `git -C ""` is not an error and it is not a no-op: git silently operates on
# the CURRENT directory, so one empty state value would put a `checkout` in the
# user's own checkout (#18). Defence in depth: `load_state` already refuses an
# empty value for every path it reads.
git_at() {
  local dir=$1
  shift
  [ -n "$dir" ] \
    || die "refusing to run 'git $*' with an empty directory: git -C '' operates on the current directory, which is how a repo-targeted write lands in the user's checkout (#18)."
  run_env git -C "$dir" "$@"
}

ADAPTER_OUT=""
ADAPTER_ERR=""
ADAPTER_STATUS=0

adapter_run() {
  local errfile
  errfile=$(mktemp) || die "cannot create a temporary file"
  ADAPTER_OUT=$( ( cd "$WT" && run_env "$ADAPTER" "$@" ) 2>"$errfile" )
  ADAPTER_STATUS=$?
  ADAPTER_ERR=$(cat "$errfile")
  rm -f "$errfile"
  return "$ADAPTER_STATUS"
}

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
# Reading a field the adapter contract promises
#
# "A field the contract promises arrives present and of the promised type, or
# it is a hard error, never a default" (scripts/CLAUDE.md). A bare `jq -r` on
# an absent key yields the STRING `null`, which then takes a branch of its own.
# Here that is not an abstraction: `present` read straight stops being `false`,
# so the baseline stop for a parser that cannot find its own pinned package is
# bypassed (#44, #46) — and every later step reads `present: false` as "the
# package left the tree", which is this flow's cue for `removable`. The same
# route reaches `unreadable_entries`, whose absence would read as full coverage
# on every map (#48).
#
# The value lands in ADAPTER_FIELD rather than on stdout because `fail_phase`
# exits, and an exit inside a command substitution ends only the subshell — the
# caller would carry on holding the failure JSON as its "value".
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

# `unreadable_entries` must be present and a non-negative integer. An absent
# field is not zero, and neither is a present-but-untyped one: `jq -r` on a
# missing key yields the string `null`, and a numeric test against it fails on
# stderr inside a conditional that never sees it, so an adapter that stopped
# emitting the field would read as full coverage on every map (#48).
map_unreadable() {
  # $1 phase, $2 map payload, $3 description; answer in MAP_UNREADABLE
  MAP_UNREADABLE=""
  adapter_field "$1" "$2" "$3" unreadable_entries
  case "$ADAPTER_FIELD" in
    ''|*[!0-9]*) fail_phase "$1" "$3 reported unreadable_entries '$ADAPTER_FIELD', which is not a non-negative integer. Treated as anything other than a checked zero, the whole-tree claim is not one (#48)." ;;
  esac
  MAP_UNREADABLE=$ADAPTER_FIELD
}

# The versions a `resolved_versions` payload reports, as a sorted unique list
# of bare version strings, in RV_VERSIONS — or a phase failure.
#
# **`present` being present is not the check.** `adapter_field ... present`
# asserts the KEY exists, and a payload answering `{"present": true}` with
# `versions` absent, or `versions` a string, still yields `[]` through
# `[ .versions[]?.version ]` — `?` swallows the type error by design. That `[]`
# is not a small inaccuracy here: it becomes the baseline AND the after-removal
# list, so the delta is `[]`, and an empty delta is this flow's documented cue
# for `removable` with the detail "no version was judged against the advisory
# database, because none appeared". A parser that found nothing would therefore
# recommend a deletion, and in `pr` mode open the PR, with **zero advisory
# queries run** — the repo's headline rule inverted in the one driver whose
# output deletes things. `fix-group.sh`'s `line_versions` hard-errors on the
# identical payload for the identical reason.
#
# So: `versions` must be an array, every entry must carry a string `version`,
# and the list must agree with `present` in both directions. `present: true`
# with nothing in it is a parser that found nothing; `present: false` with
# entries is a payload contradicting itself. Only `present: false` with an
# empty list is a real answer, and it is the one this flow reads as "the
# package left the tree".
RV_VERSIONS=""

rv_versions() {
  # $1 phase, $2 payload, $3 what produced it
  local present
  adapter_field "$1" "$2" "$3" present
  present=$ADAPTER_FIELD
  case "$present" in
    true|false) ;;
    *) fail_phase "$1" "$3 answered present '$present', which is neither true nor false. Read straight, anything else takes a branch of its own: this flow reads present: false as 'the package left the tree', which is its cue for removable." ;;
  esac
  RV_VERSIONS=$(printf '%s' "$2" | jq -c '
    if (.versions | type) != "array" then
      error("the payload carries no versions array")
    elif any(.versions[]; (.version | type) != "string") then
      error("a versions entry carries no readable version string")
    else [ .versions[].version ] | unique
    end' 2>/dev/null)     || fail_phase "$1" "$3 answered a versions list this flow cannot read: it is not an array, or an entry carries no version string. A parser that found nothing is never read as a package that resolves nothing (scripts/CLAUDE.md); here that reading becomes an empty delta, which is the cue for removable."
  if [ "$present" = "true" ] && [ "$RV_VERSIONS" = "[]" ]; then
    fail_phase "$1" "$3 answered present: true with no versions at all. The two disagree, and the empty list is the dangerous half: it makes the delta empty, which this flow reads as 'nothing new resolved' and reports removable without a single advisory query."
  fi
  if [ "$present" = "false" ] && [ "$RV_VERSIONS" != "[]" ]; then
    fail_phase "$1" "$3 answered present: false while reporting versions $RV_VERSIONS. The payload contradicts itself, and present: false is this flow's cue for 'the package left the tree entirely', which is a removable verdict."
  fi
}

# ---------------------------------------------------------------------------
# The override block's address inside the manifest
#
# `list_pins` reports each pin's `path` RELATIVE to the override block, and
# `override_location` names the block. The two compose into the path jq deletes.
# ---------------------------------------------------------------------------

override_root_json() {
  case "$1" in
    overrides)      printf '["overrides"]' ;;
    resolutions)    printf '["resolutions"]' ;;
    pnpm.overrides) printf '["pnpm","overrides"]' ;;
    *) die "unknown override_location '$1'; this driver knows overrides, resolutions and pnpm.overrides." ;;
  esac
}

# Remove exactly the entries at $2 (a JSON array of pin paths) from
# package.json's override block, and nothing else.
#
# "Remove the whole override block if it is the last entry, and nothing else"
# is implemented as a prune of every ANCESTOR of the removed path that is left
# an empty object — deepest first, **stopping at the override block itself**.
# That is what turns a last entry into a removed block rather than an empty
# `"resolutions": {}` left behind, which is the shape a shipped bug in the
# adapter's own override writer once produced (root CLAUDE.md, SC2086); and
# stopping there is the "and nothing else" half, since an emptied `pnpm` key
# above `pnpm.overrides` is not part of the block this audit was asked to
# edit.
MANIFEST_EDIT_ERR=""

manifest_remove_paths() {
  local root=$1 paths=$2 tmp errfile
  tmp="$WT/package.json.audit-tmp"
  errfile=$(mktemp) || die "cannot create a temporary file"
  MANIFEST_EDIT_ERR=""
  jq --argjson root "$root" --argjson paths "$paths" '
    reduce ($paths[] | ($root + .)) as $full (.;
      delpaths([$full])
      | reduce range(($full | length) - 1; ($root | length) - 1; -1) as $i (.;
          ($full[0:$i]) as $anc
          | if (getpath($anc) | type) == "object" and (getpath($anc) | length) == 0
            then delpaths([$anc]) else . end))
  ' "$WT/package.json" > "$tmp" 2>"$errfile" || {
    MANIFEST_EDIT_ERR=$(cat "$errfile")
    rm -f "$tmp" "$errfile"
    return 1
  }
  rm -f "$errfile"
  mv "$tmp" "$WT/package.json" || return 1
}

# The pnpm-workspace.yaml equivalent (issue #159). jq cannot edit YAML, and the
# adapter's own workspace writer deliberately refuses to delete a pre-existing
# entry ("this write path only adds or updates entries"), so the deletion is
# done here, line-level, over exactly the flat `key: value` block that writer
# round-trips. The block's own `overrides:` line goes with the last entry, which
# is the same "remove the whole block if it is the last entry" rule.
#
# Anything the adapter's reader refuses, this refuses too, by failing on a line
# inside the block it cannot read as an entry: a wrong parse here writes a wrong
# file that pnpm reads on every install.
#
# awk's status is passed through, never collapsed to 1: it distinguishes a
# block this reader refuses (1) from a block that simply has no such entry (2),
# and the caller reports different causes for the two. Collapsed, a missing key
# was diagnosed as "a wrong write corrupts a file pnpm reads on every install",
# sending a reader after a parser bug that is not there.
workspace_remove_key() {
  local target=$1 tmp awkst
  tmp="$WT/pnpm-workspace.yaml.audit-tmp"
  awk -v TARGET="$target" '
    function strip_scalar(s) {
      sub(/[[:space:]]+$/, "", s)
      if (s ~ /^\047.*\047$/) { s = substr(s, 2, length(s) - 2); gsub(/\047\047/, "\047", s); return s }
      if (s ~ /^".*"$/) { return substr(s, 2, length(s) - 2) }
      return s
    }
    function key_of(line,   rest, i, q) {
      rest = substr(line, 3)
      if (rest ~ /^[\047"]/) {
        q = substr(rest, 1, 1)
        i = index(substr(rest, 2), q ": ")
        if (i == 0) return ""
        return strip_scalar(substr(rest, 1, i + 1))
      }
      i = index(rest, ":")
      if (i == 0) return ""
      return substr(rest, 1, i - 1)
    }
    { lines[NR] = $0 }
    inblk && /^[^[:space:]]/ { inblk = 0 }
    !inblk && /^overrides:[[:space:]]*($|#)/ { inblk = 1; blkline = NR; next }
    inblk {
      if ($0 ~ /^[[:space:]]*(#|$)/) next
      k = key_of($0)
      if (k == "") { bad = 1; exit 1 }
      nentries++
      if (k == TARGET) { drop[NR] = 1; found = 1 }
    }
    END {
      if (bad) exit 1
      if (!found) exit 2
      if (nentries == 1) drop[blkline] = 1
      for (i = 1; i <= NR; i++) if (!(i in drop)) print lines[i]
    }
  ' "$WT/pnpm-workspace.yaml" > "$tmp" || { awkst=$?; rm -f "$tmp"; return "$awkst"; }
  mv "$tmp" "$WT/pnpm-workspace.yaml" || return 1
}

# The files every restore, every syntax check and every staging list names.
# `override_file` is package.json everywhere except a pnpm repository keeping
# its live overrides in pnpm-workspace.yaml (#159); there the restore covers
# BOTH files, because package.json is still the manifest the install reads.
restore_paths() {
  if [ "$OVERRIDE_FILE" = "pnpm-workspace.yaml" ]; then
    printf 'package.json\npnpm-workspace.yaml\n'
  else
    printf 'package.json\n'
  fi
}

# `checkout HEAD --` then `diff --quiet HEAD --`. **`HEAD` is load-bearing in
# both, and for the same reason**: without it `checkout` restores from the
# INDEX and `diff` compares against the INDEX, so the restore and the check
# that is supposed to catch a failed restore share one movable reference —
# anything that lands in the index is restored and then confirmed as correct
# (#46).
#
# A non-zero exit from the verification ends the RUN, not the pin. A restore
# that only half completes leaves the previous pin's removal in the tree while
# the next pin is edited out of it, and nothing downstream notices: the
# doubly-modified manifest is still valid, the install succeeds, and both
# parsers happily read a lockfile they have no way to know is wrong. What would
# then be reported is a batch result presented as a per-pin one.
restore_tree() {
  local lockfile paths=() p rerr
  lockfile=$(state_get '.lockfile'); state_ok $? '.lockfile'
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    paths+=("$p")
  done <<EOF
$(restore_paths)
EOF
  paths+=("$lockfile")
  rerr=$(git_at "$WT" checkout HEAD -- "${paths[@]}" 2>&1) || true
  if ! git_at "$WT" diff --quiet HEAD -- "${paths[@]}"; then
    local porcelain
    porcelain=$(git_at "$WT" status --porcelain -- "${paths[@]}" 2>&1)
    fail_phase restore "the worktree could not be returned to its pre-pin state${1:+ after testing $1}, so every later pin would have been tested against a manifest still carrying this removal. git checkout said: ${rerr:-<nothing>}. git status --porcelain -- ${paths[*]}: $porcelain"
  fi
}

# ---------------------------------------------------------------------------
# check-advisories.sh
#
# "Removability is judged against the advisory database, never repo alert
# history" (scripts/CLAUDE.md): a pin keeps vulnerable versions out of the
# lockfile, so every advisory published after the pin produced no alert on this
# repository, and asking the repo's own history asks "was anything reported
# while we were protected", whose answer is no by construction.
#
# Answers are cached per (package, version) under $WORK: one version can be in
# several pins' deltas and in the collateral of another, and the query is a
# network call.
# ---------------------------------------------------------------------------

ADVISORY_JSON=""

# Everything the caller is allowed to assume about an advisory answer, asserted
# on EVERY route into it — the fresh query and the cache alike.
#
# The cache is not this process's own scratch: `$WORK/advisories/` outlives the
# call that wrote it, because `test-pin` and `judge` are separate invocations,
# so a run killed mid-write leaves a half-object for the next one to read. Read
# without this, that half-object reaches `--argjson r`, and `jq -n --argjson x
# "<torn>"` dies with exit 2 and NO stdout — this contract's own
# `needs_judgment`, arriving with no decision point and no evidence.
advisory_validate() {
  # $1 payload, $2 package, $3 version, $4 where it came from, $5 stderr or ''
  printf '%s' "$1" | jq -e 'type == "object"' >/dev/null 2>&1 \
    || fail_phase advisories "$4 for $2 $3 is not a JSON object. A script that cannot answer exits non-zero; answering with nothing lets every check below be skipped rather than failed.${5:+ Quoting stderr: $5}"
  local field
  for field in verdict advisory_count matched_ranges unevaluated_ranges adapter_errors; do
    printf '%s' "$1" | jq -e --arg k "$field" 'has($k)' >/dev/null 2>&1 \
      || fail_phase advisories "$4 for $2 $3 carries no '$field'. The output contract promises all five fields this driver reads; read straight, an absent one arrives as the string \"null\" and takes a branch of its own instead of failing — and for 'adapter_errors' that branch is the test standing between a broken adapter and an audit of inconclusive verdicts with nothing naming the cause."
  done
  # The value, not just the key. `check-advisories.sh` emits exactly four
  # verdicts, plus a JSON `null` when it was given no version at all — and
  # anything outside that set falls off the end of `judge`'s three tests into
  # its terminal `else`, which is `safe`. A found-nothing default in the field
  # that decides whether a pin is deleted is the one place this repo refuses to
  # have one.
  local v
  v=$(printf '%s' "$1" | jq -r '.verdict')
  case "$v" in
    safe|vulnerable|unknown|no-advisories) ;;
    *) fail_phase advisories "$4 answered verdict '$v' for $2 $3, which is not one of safe, vulnerable, unknown or no-advisories. Anything else falls through every verdict test into the last arm, and the last arm cannot be allowed to be a default." ;;
  esac
}

advisory_for() {
  # $1 package, $2 version; result in ADVISORY_JSON. Exits the run on a
  # non-zero exit or an `unknown` that names a broken adapter.
  local pkg=$1 version=$2 slug cache errfile out st verdict errs
  slug=$(printf '%s@%s' "$pkg" "$version" | tr '/' '-')
  cache="$WORK/advisories/$slug.json"
  if [ -f "$cache" ]; then
    ADVISORY_JSON=$(cat "$cache")
    advisory_validate "$ADVISORY_JSON" "$pkg" "$version" "the cached advisory answer at $cache" ""
    return 0
  fi
  mkdir -p "$WORK/advisories" || die "cannot create $WORK/advisories"
  errfile=$(mktemp) || die "cannot create a temporary file"
  out=$( ( cd "$WT" && run_env "$ADVISORIES" --adapter "$ADAPTER" --version "$version" "$pkg" ) 2>"$errfile" )
  st=$?
  errs=$(cat "$errfile")
  rm -f "$errfile"
  # "A non-zero exit from check-advisories.sh is not a verdict."
  [ "$st" -eq 0 ] \
    || fail_phase advisories "check-advisories.sh exited $st for $pkg $version, so there is no verdict for it. A failed query is never read as an absence of advisories. Quoting it: ${errs:-<no stderr>}"
  # The same contract discipline the adapter verbs get, applied to the one
  # script whose answer becomes the removal recommendation.
  advisory_validate "$out" "$pkg" "$version" "check-advisories.sh" "${errs:-<none>}"
  verdict=$(printf '%s' "$out" | jq -r '.verdict')
  # `unknown` with a non-empty adapter_errors[] is NOT the honest-unknown
  # verdict: the adapter broke on a range rather than the range being
  # unreadable, so the answer describes the tooling and not the package, and
  # every pin after it inherits the same broken adapter.
  if [ "$verdict" = "unknown" ] \
     && [ "$(printf '%s' "$out" | jq -r '.adapter_errors | length')" != "0" ]; then
    fail_phase advisories "check-advisories.sh answered 'unknown' for $pkg $version with a non-empty adapter_errors[], which describes the tooling and not the package: $(printf '%s' "$out" | jq -c '.adapter_errors'). Every pin after this one would inherit the same broken adapter."
  fi
  # Temp-plus-`mv`, exactly as `state_set` writes the state file and for the
  # same reason: a truncating `> "$cache"` interrupted part-way leaves a
  # half-object behind in a directory the next invocation reads.
  printf '%s' "$out" > "$cache.tmp" || die "cannot write $cache.tmp"
  mv "$cache.tmp" "$cache" || die "cannot replace $cache"
  ADVISORY_JSON=$out
}

# ---------------------------------------------------------------------------
# list — phase 2
# ---------------------------------------------------------------------------

# The wording each non-`range` kind earns, straight out of the definition's
# table. An alias is not a pin that has become unnecessary; it is how the
# repository gets a substituted implementation, and removing it changes which
# code ships.
kind_detail() {
  case "$1" in
    alias)       printf 'a redirect to a different package, not a version pin: removing it changes which code ships' ;;
    protocol)    printf 'a patch, a local path, a workspace or git target, not a version pin' ;;
    reference)   printf "npm's \"\$pkg\" form, deferring to a declared dependency, not a version pin" ;;
    unparseable) printf 'a value this adapter cannot read, so it is not a version pin this audit can test, and the report says so' ;;
    *)           printf 'not a version pin' ;;
  esac
}

cmd_list() {
  local work="" worktree="" adapter_path="" scripts_dir="" advisories="" env_prefix=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --work)        work="${2:?--work requires a directory}"; shift 2 ;;
      --worktree)    worktree="${2:?--worktree requires a directory}"; shift 2 ;;
      --adapter)     adapter_path="${2:?--adapter requires a path}"; shift 2 ;;
      --scripts-dir) scripts_dir="${2:?--scripts-dir requires a path}"; shift 2 ;;
      # A test seam, like node.sh's shim runner override: the specs replace the
      # advisory lookup with a shim that serves canned verdicts, so no example
      # ever reaches the network.
      --advisories)  advisories="${2:?--advisories requires a path}"; shift 2 ;;
      # `--env-prefix ""` is legal and means "no prefix", so this cannot use
      # the `${2:?...}` form: it still has to tell an EMPTY value from an
      # ABSENT one, because a failed `shift` shifts nothing and the loop would
      # never terminate.
      --env-prefix)
        [ $# -ge 2 ] || die "list: --env-prefix requires a value; pass \"\" for no prefix"
        env_prefix="$2"; shift 2 ;;
      *) die "list: unknown option '$1'" ;;
    esac
  done

  [ -n "$work" ] || die "list requires --work"
  [ -n "$worktree" ] || die "list requires --worktree"
  [ -n "$adapter_path" ] || die "list requires --adapter"
  [ -d "$worktree" ] || die "list: no such worktree: $worktree"
  [ -n "$scripts_dir" ] || scripts_dir="$SELF_DIR"
  [ -n "$advisories" ] || advisories="$scripts_dir/check-advisories.sh"

  mkdir -p "$work" || die "list: cannot create $work"
  set_env_prefix "$env_prefix"
  WT=$worktree
  ADAPTER=$adapter_path

  adapter_run list_pins \
    || fail_phase list "list_pins failed: $(adapter_error_text). A non-zero exit is not an empty result: the adapter fails rather than reporting zero pins when the override block is present but is not an object of entries, and a manifest the adapter refused to read is never reported as a repository that pins nothing."
  local pins_json=$ADAPTER_OUT

  adapter_field list "$pins_json" "list_pins" count
  local count=$ADAPTER_FIELD
  case "$count" in
    ''|*[!0-9]*) fail_phase list "list_pins reported a count of '$count', which is not a non-negative integer." ;;
  esac
  adapter_field list "$pins_json" "list_pins" override_file
  local override_file=$ADAPTER_FIELD
  adapter_field list "$pins_json" "list_pins" override_location
  local override_location=$ADAPTER_FIELD
  adapter_field list "$pins_json" "list_pins" pm
  local pm=$ADAPTER_FIELD
  printf '%s' "$pins_json" | jq -e '(.pins | type) == "array"' >/dev/null 2>&1 \
    || fail_phase list "list_pins answered a 'pins' that is not an array; it is the only statement of what this repository pins."
  [ "$(printf '%s' "$pins_json" | jq -r '.pins | length')" = "$count" ] \
    || fail_phase list "list_pins reported count=$count beside $(printf '%s' "$pins_json" | jq -r '.pins | length') entries. The two disagree, and this flow verifies every later edit against that count."

  # The workspace-file block is addressed by key, not by a path inside a JSON
  # document, so its root is the empty path and each pin's `path` is `[key]`.
  local root_json='[]'
  if [ "$override_file" != "pnpm-workspace.yaml" ]; then
    root_json=$(override_root_json "$override_location") \
      || die "list: list_pins reported an override_location this driver cannot address: $override_location"
  fi

  # `kind` decides whether a pin is yours to test at all. Only `range` entries
  # are version pins; every other kind is a finding, not a test.
  local routed
  routed=$(printf '%s' "$pins_json" | jq -c \
    --arg alias "$(kind_detail alias)" \
    --arg protocol "$(kind_detail protocol)" \
    --arg reference "$(kind_detail reference)" \
    --arg unparseable "$(kind_detail unparseable)" \
    --arg other "$(kind_detail other)" '
    [ .pins[]
      | . + {finding: (if .kind == "range" then "testable" else "not-a-version-pin" end),
             detail: (if .kind == "range" then null
                      elif .kind == "alias" then $alias
                      elif .kind == "protocol" then $protocol
                      elif .kind == "reference" then $reference
                      elif .kind == "unparseable" then $unparseable
                      else $other end)} ]') \
    || fail_phase list "list_pins' entries could not be routed by kind: $pins_json"

  # Bare pins first: they constrain every consumer in the tree, so they are
  # both the most costly and the most likely to be over-broad. `test-pin` is
  # called once per entry, so this order is the order the caller walks.
  local order
  order=$(printf '%s' "$routed" | jq -c '
    [ .[] | select(.finding == "testable") ]
    | (map(select(.scope == "bare")) + map(select(.scope != "bare")))
    | map({key, path, package, scope, value})')

  STATE="$work/state.json"
  jq -n \
    --arg work "$work" --arg worktree "$worktree" --arg adapter "$adapter_path" \
    --arg advisories "$advisories" --arg scripts_dir "$scripts_dir" \
    --arg env_prefix "$env_prefix" \
    --arg override_file "$override_file" --arg override_location "$override_location" \
    --arg pm "$pm" --argjson count "$count" --argjson root "$root_json" \
    --argjson pins "$routed" --argjson order "$order" \
    '{work: $work, worktree: $worktree, adapter: $adapter, advisories: $advisories,
      scripts_dir: $scripts_dir, env_prefix: $env_prefix,
      override_file: $override_file, override_location: $override_location,
      override_root: $root, pm: $pm, pins_count: $count, pins: $pins,
      test_order: $order, findings: [], baseline_done: false}' > "$STATE.tmp" \
    || die "list: cannot write $STATE"
  mv "$STATE.tmp" "$STATE" || die "list: cannot replace $STATE"

  # `count` of 0 is a complete answer, and it is a different answer from a
  # refused manifest: an empty override block is read from structured JSON and
  # cannot mean "the parser failed". In `pr` mode it is `no pins`, which is not
  # `no removable pins found` — one repository has nothing to audit, the other
  # was audited and kept every pin it has.
  if [ "$count" = "0" ]; then
    jq -n --arg f "$override_file" --arg l "$override_location" --arg pm "$pm" \
      '{status: "no_pins", step: "list", pm: $pm, override_file: $f,
        override_location: $l, count: 0, pins: [], test_order: [],
        pr_skipped_reason: "no pins"}'
    exit 0
  fi

  jq -n --arg f "$override_file" --arg l "$override_location" --arg pm "$pm" \
    --argjson count "$count" --argjson pins "$routed" --argjson order "$order" \
    '{status: "ok", step: "list", pm: $pm, override_file: $f,
      override_location: $l, count: $count,
      test_order: $order,
      not_a_version_pin: [ $pins[] | select(.finding == "not-a-version-pin")
                           | {key, path, package, kind, value, detail} ]}'
}

# ---------------------------------------------------------------------------
# baseline — phase 4's head
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

  # The lockfile NAME comes from the adapter, never from `pm`: the mapping is
  # the adapter's to own, and a restore aimed at a file that is not there fails
  # in the one way the restore verification cannot afford.
  adapter_run detect \
    || fail_phase install "adapter detect failed, so the lockfile this phase restores between every pin has no name: $(adapter_error_text)"
  adapter_field install "$ADAPTER_OUT" "adapter detect" lockfile
  local lockfile=$ADAPTER_FIELD
  state_set_str lockfile "$lockfile"

  # One install for the whole audit. The tree is restored between every pin, so
  # both baselines are read once and stay valid for every pin.
  local errfile out st
  errfile=$(mktemp) || die "cannot create a temporary file"
  out=$( ( cd "$WT" && run_env "$ADAPTER" install ) 2>"$errfile" )
  st=$?
  local install_err
  install_err=$(printf '%s\n%s' "$out" "$(cat "$errfile")")
  rm -f "$errfile"
  # Never fall back to testing pins against a tree that could not be built: the
  # baseline is what every later delta is measured against, and a package
  # manager that rewrote part of the lockfile before failing poisons every
  # pin's result at once, silently and in the same direction.
  [ "$st" -eq 0 ] \
    || fail_phase install "the with-all-pins baseline install failed, so no pin was tested. One failure reported honestly beats a whole audit of plausible-looking verdicts. Quoting the package manager: $install_err"

  # `resolution_map` unavailable and `resolution_map` erroring are different
  # facts and take different routes. Exit 2 is the contract's "not implemented"
  # (ADR 001): there is no whole-tree view to be had on this adapter, so the
  # audit still runs and every verdict says it covers the named package only.
  # Any other non-zero exit is a parser refusing a lockfile it could not read,
  # and that refusal is the answer.
  local map_available=false base_map='null' unreadable=0
  adapter_run resolution_map
  st=$ADAPTER_STATUS
  if [ "$st" -eq 0 ]; then
    map_available=true
    base_map=$ADAPTER_OUT
    map_unreadable install "$base_map" "the with-all-pins baseline resolution_map"
    unreadable=$MAP_UNREADABLE
    printf '%s' "$base_map" | jq -e '(.resolutions | type) == "object"' >/dev/null 2>&1 \
      || fail_phase install "the baseline resolution_map carries no resolutions object, so there is nothing to diff a removal against."
  elif [ "$st" -eq 2 ]; then
    map_available=false
    state_set_str map_refusal "the adapter does not implement resolution_map, so no other package's resolution was re-checked"
  else
    fail_phase install "the baseline resolution_map failed on this lockfile: $(adapter_error_text). A parser that refuses a lockfile it could not read is answering, and a diff against a map that was never built reports every package unchanged."
  fi

  # One `resolved_versions` per DISTINCT package among the testable pins.
  local pkgs pkg pkg_baselines='[]' inconclusive='[]'
  state_json install '.test_order' 'type == "array"' "phase 2's test_order"
  local test_order=$STATE_JSON
  pkgs=$(printf '%s' "$test_order" | jq -r '[ .[].package ] | unique | .[]')
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    adapter_run resolved_versions "$pkg" \
      || fail_phase install "the baseline lockfile could not be parsed for $pkg (resolved_versions): $(adapter_error_text). A failed parse is never an empty result (scripts/CLAUDE.md)."
    local rv=$ADAPTER_OUT
    rv_versions install "$rv" "resolved_versions $pkg (the with-all-pins baseline)"
    local present=$ADAPTER_FIELD rv_list=$RV_VERSIONS
    if [ "$present" != "true" ]; then
      # A baseline `present: false` is a hard stop FOR THAT PIN, and it is a
      # claim the parser is making about itself: the manifest pins this package
      # and the tree was just installed from that manifest. Every later step
      # reads `present: false` as "the package left the tree entirely", which
      # is this phase's cue for `removable` — so a parser gap here would become
      # a deletion recommendation for a pin nothing examined. That has been the
      # shape of the last two defects found in the adapter's lockfile parsing
      # (#44, #46), and nothing checked the baseline for it.
      inconclusive=$(jq -cn --argjson a "$inconclusive" --arg p "$pkg" --argjson rv "$rv" \
        '$a + [{package: $p, baseline: $rv,
                detail: ("the with-all-pins baseline reports present: false for \($p), which the manifest pins and the tree was just installed from. That is a claim the parser is making about itself, not about the tree, and every later step reads present: false as \"the package left the tree\" — this flow'"'"'s cue for removable (#44, #46). The pin was not tested.")}]')
    fi
    pkg_baselines=$(jq -cn --argjson a "$pkg_baselines" --arg p "$pkg" \
      --argjson versions "$rv_list" --argjson present "$(jbool "$present")" \
      '$a + [{package: $p, present: $present, versions: $versions}]')
  done <<EOF
$pkgs
EOF

  state_set baseline_map "$base_map"
  state_set map_available "$(jbool "$map_available")"
  state_set baseline_unreadable_entries "$unreadable"
  state_set baseline_packages "$pkg_baselines"
  state_set baseline_inconclusive "$inconclusive"
  state_set baseline_done true

  # Every pin on a `present: false` package is recorded inconclusive here and
  # never tested.
  local findings
  findings=$(printf '%s' "$test_order" | jq -c --argjson inc "$inconclusive" '
    [ .[] as $pin
      | ([ $inc[] | select(.package == $pin.package) ] | first) as $bad
      | select($bad != null)
      | $pin + {status: "inconclusive", tested: false,
                detail: $bad.detail,
                collateral_not_checked_reason: "this pin was never tested, so no other package in the tree was compared",
                resolved_with_pin: null, resolved_without_pin: null,
                attributable_versions: null, sibling_pins: [],
                collateral_changes: null, collateral_verdict: null,
                advisory_verdict: null, advisory_count: null, matched_ranges: []} ]')
  state_set findings "$findings"

  jq -n --arg lockfile "$lockfile" --argjson map "$(jbool "$map_available")" \
    --argjson unreadable "$unreadable" --argjson pkgs "$pkg_baselines" \
    --argjson inc "$inconclusive" --argjson order "$test_order" \
    '{status: "ok", step: "baseline", lockfile: $lockfile,
      resolution_map_available: $map, unreadable_entries: $unreadable,
      whole_tree_view: ($map and $unreadable == 0),
      packages: $pkgs, inconclusive: $inc,
      test_order: [ $order[] | select(.package as $p
                     | ([ $inc[].package ] | index($p)) == null) ]}'
}

# ---------------------------------------------------------------------------
# test-pin — one pin per install, always
#
# Removing several at once changes the resolution of each: a pin removed
# alongside this one may be the reason this package now resolves where it does,
# in either direction. A batch result is not evidence about any individual pin,
# and there is no shortcut that makes it one.
# ---------------------------------------------------------------------------

# Record one finding into state, replacing any earlier record for the same path.
record_finding() {
  local prev merged
  # Any `test-pin` after a `judge` invalidates that judgment: the finding it
  # writes is `tested` again, and `together` selects on status, so the pin
  # would be silently dropped from a candidate set the agent believes is
  # complete. Re-running `judge` is cheap — its advisory answers are cached —
  # and being made to is the point.
  state_set judge_done false
  state_json install '.findings' 'type == "array"' 'the findings recorded so far'
  prev=$STATE_JSON
  merged=$(jq -cn --argjson a "$prev" --argjson f "$1" \
    '[ $a[] | select(.path != $f.path) ] + [$f]')
  state_set findings "$merged"
}

cmd_test_pin() {
  local work="" key="" path_json=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --work) work="${2:?--work requires a directory}"; shift 2 ;;
      --key)  key="${2:?--key requires a value}"; shift 2 ;;
      --path) path_json="${2:?--path requires a JSON array}"; shift 2 ;;
      *) die "test-pin: unknown option '$1'" ;;
    esac
  done
  load_state "$work"
  [ -n "$key" ] || [ -n "$path_json" ] || die "test-pin requires --key or --path"
  [ "$(state_get_opt '.baseline_done')" = "true" ] \
    || die "test-pin: run 'baseline' first. Without the with-all-pins baseline there is nothing to measure a removal against."

  local order pin
  state_json install '.test_order' 'type == "array"' "phase 2's test_order"
  order=$STATE_JSON
  if [ -n "$path_json" ]; then
    printf '%s' "$path_json" | jq -e 'type == "array"' >/dev/null 2>&1 \
      || die "test-pin: --path must be a JSON array, as list_pins reports it"
    pin=$(printf '%s' "$order" | jq -c --argjson p "$path_json" 'map(select(.path == $p)) | .[0] // empty')
    [ -n "$pin" ] || die "test-pin: no testable pin at path $path_json"
  else
    local n
    n=$(printf '%s' "$order" | jq -r --arg k "$key" '[ .[] | select(.key == $k) ] | length')
    [ "$n" != "0" ] || die "test-pin: no testable pin with key '$key'"
    # A manifest key is not unique — npm nests `{"rimraf": {".": ..., "glob": ...}}`
    # under one key — so an ambiguous `--key` is refused rather than resolved by
    # position. The pin's `path` is its identity, and that is what --path takes.
    [ "$n" = "1" ] \
      || die "test-pin: '$key' names $n pins in this manifest, so it does not identify one. Pass --path with the pin's own path array, which list_pins reports."
    pin=$(printf '%s' "$order" | jq -c --arg k "$key" 'map(select(.key == $k)) | .[0]')
  fi

  local pin_key pin_path pin_pkg
  pin_key=$(printf '%s' "$pin" | jq -r '.key')
  pin_path=$(printf '%s' "$pin" | jq -c '.path')
  pin_pkg=$(printf '%s' "$pin" | jq -r '.package')

  state_json install '.baseline_inconclusive' 'type == "array"' "the baseline's inconclusive list"
  [ "$(printf '%s' "$STATE_JSON" | jq -r --arg p "$pin_pkg" 'any(.[]; .package == $p)')" = "false" ] \
    || die "test-pin: the baseline recorded $pin_pkg inconclusive (present: false), so this pin is not tested. Recording it and never testing it is the baseline's answer, not a step to redo."

  local base_count
  base_count=$(state_get '.pins_count'); state_ok $? '.pins_count'

  # ---- step 1: remove exactly that entry ---------------------------------
  if [ "$OVERRIDE_FILE" = "pnpm-workspace.yaml" ]; then
    local wstatus=0
    workspace_remove_key "$pin_key" || wstatus=$?
    case "$wstatus" in
      0) ;;
      2) restore_tree "$pin_key"
         fail_phase install "the pnpm-workspace.yaml overrides block carries no entry '$pin_key', so nothing was removed and an install of it would have been an install of the manifest this audit started with." ;;
      *) restore_tree "$pin_key"
         fail_phase install "the pnpm-workspace.yaml overrides block could not be edited to remove '$pin_key'. This driver reads exactly the flat 'key: value' block the adapter round-trips and refuses anything else, because a wrong write corrupts a file pnpm reads on every install." ;;
    esac
  else
    state_json install '.override_root' 'type == "array"' "the override block's address"
    manifest_remove_paths "$STATE_JSON" "[$pin_path]" \
      || { restore_tree "$pin_key"
           fail_phase install "package.json could not be rewritten to remove $pin_path, so the manifest does not parse and every verdict measured against an install of it would be fiction. The file was restored, not repaired by re-editing around the error. Quoting jq: $MANIFEST_EDIT_ERR"; }
  fi

  # ---- step 2: the manifest must still parse, BEFORE anything installs ----
  # A removal can leave the manifest syntactically broken, and the classic way
  # is a trailing comma where the removed entry was the last one in its block.
  # Reaching `list_pins` with a broken manifest instead makes the corruption
  # surface as whatever that verb happens to do with unparseable JSON, which is
  # not a report of the actual problem. The manifest is restored, never
  # repaired by re-editing around the error.
  #
  # The check does not apply to the YAML file: `list_pins` re-reads that block
  # below and refuses loudly on one it cannot parse.
  if [ "$OVERRIDE_FILE" != "pnpm-workspace.yaml" ]; then
    local jqerr
    if ! jqerr=$( ( cd "$WT" && jq . package.json >/dev/null ) 2>&1 ); then
      restore_tree "$pin_key"
      fail_phase install "package.json does not parse after removing $pin_key, so every verdict measured against an install of it would be fiction. Quoting jq: $jqerr"
    fi
  fi

  # ---- step 3: the edit landed, verified against phase 2's count ---------
  adapter_run list_pins \
    || { restore_tree "$pin_key"
         fail_phase install "list_pins failed after removing $pin_key: $(adapter_error_text)"; }
  local after_pins=$ADAPTER_OUT
  adapter_field install "$after_pins" "list_pins (after removing $pin_key)" count
  local after_count=$ADAPTER_FIELD
  local still_there
  still_there=$(printf '%s' "$after_pins" | jq -r --argjson p "$pin_path" 'any(.pins[]; .path == $p)')
  if [ "$still_there" != "false" ]; then
    restore_tree "$pin_key"
    fail_phase install "the entry at $pin_path is still present after the removal of $pin_key, so the install would have been an install of the manifest this audit started with and the verdict would have read as a tested removal."
  fi
  if [ "$after_count" != "$((base_count - 1))" ]; then
    restore_tree "$pin_key"
    fail_phase install "removing $pin_key left $after_count pins where phase 2 counted $base_count, and one less is $((base_count - 1)). An edit that silently matched nothing, or that matched a similar key elsewhere in the manifest, produces exactly this."
  fi

  # ---- step 4: the install ------------------------------------------------
  local errfile out st install_err
  errfile=$(mktemp) || die "cannot create a temporary file"
  out=$( ( cd "$WT" && run_env "$ADAPTER" install ) 2>"$errfile" )
  st=$?
  install_err=$(printf '%s\n%s' "$out" "$(cat "$errfile")")
  rm -f "$errfile"
  if [ "$st" -ne 0 ]; then
    # An install that fails is a result. A per-pin install failure stops that
    # PIN, not the run — unlike the baseline, whose failure stops everything.
    # Never report a pin as removable off a failed install.
    local f
    f=$(jq -cn --argjson pin "$pin" --arg err "$install_err" \
      '$pin + {status: "inconclusive", tested: false,
               detail: ("the install without this pin failed, so nothing about the removal was observed: " + $err),
               collateral_not_checked_reason: "this pin was not tested to completion, so no other package in the tree was compared",
               resolved_with_pin: null, resolved_without_pin: null,
               attributable_versions: null, sibling_pins: [],
               collateral_changes: null, collateral_verdict: null,
               advisory_verdict: null, advisory_count: null, matched_ranges: []}')
    record_finding "$f"
    restore_tree "$pin_key"
    jq -n --argjson f "$f" '{status: "ok", step: "test-pin", finding: $f}'
    exit 0
  fi

  # ---- step 5: what resolves now -----------------------------------------
  local rv rv_ok=true rv_err=""
  if adapter_run resolved_versions "$pin_pkg"; then
    rv=$ADAPTER_OUT
  else
    rv_ok=false
    rv_err=$(adapter_error_text)
  fi
  if [ "$rv_ok" != true ]; then
    local f
    f=$(jq -cn --argjson pin "$pin" --arg err "$rv_err" \
      '$pin + {status: "inconclusive", tested: true,
               detail: ("the lockfile could not be parsed for this package after the removal, and a failed parse is never an empty result: " + $err),
               collateral_not_checked_reason: "this pin was not tested to completion, so no other package in the tree was compared",
               resolved_with_pin: null, resolved_without_pin: null,
               attributable_versions: null, sibling_pins: [],
               collateral_changes: null, collateral_verdict: null,
               advisory_verdict: null, advisory_count: null, matched_ranges: []}')
    record_finding "$f"
    restore_tree "$pin_key"
    jq -n --argjson f "$f" '{status: "ok", step: "test-pin", finding: $f}'
    exit 0
  fi

  local present without_pin baseline_versions
  rv_versions install "$rv" "resolved_versions $pin_pkg (after removing $pin_key)"
  present=$ADAPTER_FIELD
  without_pin=$RV_VERSIONS
  state_json install '.baseline_packages' 'type == "array"' "the with-all-pins baseline snapshots"
  # The baseline's own entry must exist: `// []` on a package `baseline` never
  # snapshotted would make the delta the whole after-removal list, which is the
  # opposite error to an empty one and just as invented.
  baseline_versions=$(printf '%s' "$STATE_JSON" \
    | jq -ce --arg p "$pin_pkg" '[ .[] | select(.package == $p) ] | first | .versions' 2>/dev/null) \
    || fail_phase install "the with-all-pins baseline holds no snapshot for $pin_pkg, so there is nothing to measure this removal against. Run baseline before test-pin; a missing snapshot read as an empty one would make every version resolving now look newly admitted." 

  # ---- step 6: the whole-tree map ----------------------------------------
  local now_map='null' map_ok=false now_unreadable=0 map_refusal=""
  local base_map map_available base_unreadable
  state_json install '.baseline_map' 'type == "object" or type == "null"' "the with-all-pins baseline resolution_map"
  base_map=$STATE_JSON
  map_available=$(state_get_opt '.map_available')
  base_unreadable=$(state_get_opt '.baseline_unreadable_entries')
  if [ "$map_available" = "true" ]; then
    adapter_run resolution_map
    st=$ADAPTER_STATUS
    if [ "$st" -eq 0 ]; then
      now_map=$ADAPTER_OUT
      map_unreadable install "$now_map" "the resolution_map taken after removing $pin_key"
      now_unreadable=$MAP_UNREADABLE
      map_ok=true
    elif [ "$st" -eq 2 ]; then
      # The same split `baseline` draws, and for the same reason. Exit 2 is the
      # contract's "not implemented" (ADR 001): there is no whole-tree view to
      # be had on this adapter at all.
      map_refusal="the adapter does not implement resolution_map, so no other package's resolution was re-checked"
    else
      # Any other non-zero exit is a parser REFUSING a lockfile it could not
      # read, which is a different fact from the verb being absent and the one
      # a reader needs: a `not-checked` that says only "no whole-tree view was
      # available" hides a parser that broke on this repository's lockfile and
      # will break on it again. The verdict is the same fail-safe narrow claim
      # either way; what changes is that the refusal is reported.
      map_refusal="resolution_map refused this lockfile after removing $pin_key: $(adapter_error_text)"
    fi
  else
    map_refusal="$(state_get_opt '.map_refusal')"
    [ -n "$map_refusal" ] \
      || map_refusal="the with-all-pins baseline found no whole-tree resolution_map, so no other package's resolution was re-checked"
  fi

  # `unreadable_entries` non-zero on EITHER map, or no map at all, is the same
  # narrow claim: a partial view is not a whole-tree view, and `[]` is the
  # stronger claim — it would report an unaudited package as an affirmatively
  # clean one and leave the pin `removable` (#48).
  local whole_tree=false
  if [ "$map_ok" = true ] && [ "$base_unreadable" = "0" ] && [ "$now_unreadable" = "0" ]; then
    whole_tree=true
  fi

  # ---- the two verbs must agree about the tested package -----------------
  # Compared after normalizing BOTH to the same shape — a sorted, deduplicated
  # list of bare version strings. The raw shapes differ by design
  # (`resolved_versions` returns one {version, path} per resolution, the map
  # holds each package's versions once), so comparing them raw reports a
  # disagreement that is not one and a healthy pin comes back inconclusive.
  local disagreement='null'
  if [ "$map_ok" = true ]; then
    local map_list
    map_list=$(printf '%s' "$now_map" | jq -c --arg p "$pin_pkg" '(.resolutions[$p] // []) | unique')
    disagreement=$(jq -cn --argjson m "$map_list" --argjson r "$without_pin" --arg p "$pin_pkg" '
      if $m == $r then null
      elif ($m | length) == 0 and ($r | length) > 0 then
        {shape: "alias-key", map: $m, resolved_versions: $r,
         detail: "this pin is keyed on an npm: alias of the package named in its value, so the map holds that copy under the real package name — the name an advisory query needs — while resolved_versions answers under both. The map therefore has no entry for the key this pin uses, and the two views cannot be compared under one name (#46)."}
      elif ($m | length) > 0 and ($r | length) > 0 and (($m - $r) | length) == 0 then
        {shape: "shared-install-key", map: $m, resolved_versions: $r,
         detail: ("the name \($p) is carried by two different packages in this tree: one entry installs a package under this key while a dependency pulls the real \($p). resolved_versions answers under both senses of the name and merges them; the map keeps each under what it resolves to. The adapter cannot tell which sense the name was meant in, and neither can the key this pin uses (#48; the alias exception in ADR 001).")}
      else
        {shape: "parser-disagreement", map: $m, resolved_versions: $r,
         detail: "resolution_map and resolved_versions disagree about this package after normalizing both to sorted unique version strings. One of the two parsers is wrong; no winner is picked here."}
      end')
  fi

  if [ "$disagreement" != "null" ]; then
    local f
    f=$(jq -cn --argjson pin "$pin" --argjson d "$disagreement" \
      --argjson base "$baseline_versions" --argjson without "$without_pin" \
      '$pin + {status: "inconclusive", tested: true,
               detail: $d.detail, disagreement: $d,
               collateral_not_checked_reason: "this pin was not tested to completion, so no other package in the tree was compared",
               resolved_with_pin: $base, resolved_without_pin: $without,
               attributable_versions: null, sibling_pins: [],
               collateral_changes: null, collateral_verdict: null,
               advisory_verdict: null, advisory_count: null, matched_ranges: []}')
    record_finding "$f"
    restore_tree "$pin_key"
    jq -n --argjson f "$f" '{status: "ok", step: "test-pin", finding: $f}'
    exit 0
  fi

  # ---- the delta ----------------------------------------------------------
  # The versions attributable to THIS pin are the ones present after removal
  # and absent from the baseline. `resolved_versions` reports every resolution
  # of that package name anywhere in the tree, so with two scoped pins on one
  # package the raw list carries the sibling's resolutions and unrelated copies
  # elsewhere. Judging those against the advisory database is how a genuinely
  # safe scoped pin reports `still-required` citing a version that has nothing
  # to do with it.
  local delta
  delta=$(jq -cn --argjson b "$baseline_versions" --argjson w "$without_pin" '$w - $b')

  # ---- the collateral list -----------------------------------------------
  local collateral='null' sampled_families='[]'
  if [ "$whole_tree" = true ]; then
    local raw_collateral
    raw_collateral=$(jq -cn --argjson base "$base_map" --argjson now "$now_map" --arg pkg "$pin_pkg" '
      def norm: (. // []) | unique;
      [ ((($base.resolutions | keys) + ($now.resolutions | keys)) | unique)[]
        | select(. != $pkg)
        | . as $p
        | ($base.resolutions[$p] | norm) as $b
        | ($now.resolutions[$p] | norm) as $w
        | select($b != $w)
        | {package: $p, baseline: $b, without_pin: $w, newly_admitted: ($w - $b)} ]')

    # A large collateral fan-out is CHECKED, not sampled, unless it is a
    # platform-binary family: sibling packages published from a single release
    # of one parent, under one scope or name prefix, at identical versions,
    # **whose only difference is the platform triple in the name**. Removing
    # one pin in a field-test audit run moved 26 `@esbuild/*` packages
    # together.
    #
    # Four conditions, all checked and none assumed. A prefix match alone is
    # not one of them: `@babel/`, `@types/` and `eslint-` all group under it,
    # and a two-member scope moving in lockstep is ordinary, so on the prefix
    # test alone one member's `safe` verdict would come to stand for a package
    # nothing judged. `platform_tail` is the missing test — every member's name
    # past the shared prefix has to END in an `<os>-<arch>` pair, optionally
    # followed by libc/ABI tokens — which admits `@esbuild/linux-x64`,
    # `@rolldown/binding-darwin-arm64`, `lightningcss-darwin-arm64` and
    # `@swc/core-linux-x64-gnu`, and refuses `@types/node` and `eslint-config`.
    # A family with one non-platform member fails as a whole and every member
    # is judged, which is the conservative direction.
    #
    # The last condition — "moved as one unit" — is checked against the whole
    # tree: a family with a member sitting still elsewhere in the lockfile did
    # not move as one unit.
    collateral=$(printf '%s' "$raw_collateral" | jq -c \
      --argjson allkeys "$(jq -cn --argjson base "$base_map" --argjson now "$now_map" \
        '(($base.resolutions | keys) + ($now.resolutions | keys)) | unique')" '
      def famkey:
        if startswith("@") then (split("/")[0] + "/")
        elif (index("-") != null) then .[0:(index("-") + 1)]
        else . end;
      def platform_tail($k):
        (.[($k | length):] | split("-")) as $t
        | ["android","darwin","freebsd","linux","netbsd","openbsd","sunos","win32","win","aix"] as $os
        | ["arm","arm64","ia32","x64","x86","x86_64","mips64el","ppc64","riscv64","s390x","loong64","wasm32","universal"] as $arch
        | ["gnu","musl","gnueabihf","eabi","eabihf","msvc","static"] as $abi
        | ($t | length) as $n
        | any(range(0; $n - 1);
            . as $i
            | ($os | index($t[$i])) != null
            and ($arch | index($t[$i + 1])) != null
            # The trailing token is bound BEFORE the `|`: inside
            # `$abi | index($t[.])` the pipe has already rebound `.` to $abi,
            # so the lookup asks for `$t[["gnu","musl"]]` and every libc-suffixed
            # member of a real family fails the test. Same shape as the
            # `getpath($root + .path)` reading that once kept every pin in the
            # list after a removal.
            and all(range($i + 2; $n);
                    . as $j | ($t[$j]) as $tok | ($abi | index($tok)) != null));
      group_by(.package | famkey)
      | map(
          . as $f
          | ($f[0].package | famkey) as $k
          | ([ $allkeys[] | select(famkey == $k) ] | length) as $intree
          | if ($f | length) >= 2
               and all($f[]; .package | platform_tail($k))
               and (($f | map(.baseline) | unique | length) == 1)
               and (($f | map(.without_pin) | unique | length) == 1)
               and $intree == ($f | length)
            then ($f | sort_by(.package)) as $s
              | ($s[0].package) as $sample
              | [ $s[] | . + {judged: (.package == $sample),
                              represented_by: (if .package == $sample then null else $sample end),
                              family: {key: $k, size: ($s | length),
                                       members: [ $s[].package ],
                                       sample: $sample,
                                       shared_version: ($s[0].without_pin | join(", "))}} ]
            else [ $f[] | . + {judged: true, represented_by: null, family: null} ]
            end)
      | flatten | sort_by(.package)')
    sampled_families=$(printf '%s' "$collateral" | jq -c \
      '[ .[] | select(.family != null) | .family ] | unique_by(.key)')
  fi

  local collateral_verdict='null'
  if [ "$whole_tree" != true ]; then
    collateral_verdict='"not-checked"'
    # A partially-read map is its own reason, and it outranks an absent one:
    # the map WAS built here, and how many entries went unread is the number
    # the report owes the reader (#48).
    if [ "$map_ok" = true ]; then
      map_refusal="the resolution_map could not read $base_unreadable lockfile entries at the baseline and $now_unreadable after this removal, so it is not a whole-tree view"
    fi
  fi

  # ---- present: false after removal --------------------------------------
  # The package left the tree entirely — the pin was the only thing holding it
  # in. That is `removable`, and there is no version to judge.
  local status detail left_tree=false
  if [ "$present" = "false" ]; then
    left_tree=true
    status=tested
    detail="the package is no longer resolved at all: removing this pin took it out of the tree entirely, so nothing new resolved to judge"
  else
    status=tested
    detail="tested; the advisory judgment is phase 5's"
  fi

  local f
  f=$(jq -cn --argjson pin "$pin" --arg status "$status" --arg detail "$detail" \
    --argjson base "$baseline_versions" --argjson without "$without_pin" \
    --argjson delta "$delta" --argjson coll "$collateral" \
    --argjson cverdict "$collateral_verdict" --argjson fams "$sampled_families" \
    --argjson left "$(jbool "$left_tree")" \
    --argjson whole "$(jbool "$whole_tree")" \
    --argjson unread "$(jq_int_or_null "${base_unreadable:-}")" \
    --argjson unread_now "$(jq_int_or_null "${now_unreadable:-}")" \
    --arg refusal "$map_refusal" \
    '$pin + {status: $status, tested: true, left_tree: $left,
             detail: $detail,
             collateral_not_checked_reason: (if $refusal == "" then null else $refusal end),
             resolved_with_pin: $base, resolved_without_pin: $without,
             attributable_versions: $delta,
             sibling_pins: [],
             collateral_changes: $coll, collateral_verdict: $cverdict,
             sampled_families: $fams,
             whole_tree_view: $whole,
             unreadable_entries: {baseline: $unread, without_pin: $unread_now},
             advisory_verdict: null, advisory_count: null, matched_ranges: []}')
  record_finding "$f"

  # ---- step 7: the verified restore, before the next pin ------------------
  restore_tree "$pin_key"

  jq -n --argjson f "$f" '{status: "ok", step: "test-pin", finding: $f}'
}

# ---------------------------------------------------------------------------
# judge — phase 5
# ---------------------------------------------------------------------------

# The four verdicts, mapped exactly as the definition's table says.
#   safe          -> removable
#   vulnerable    -> still-required, naming the ranges
#   unknown       -> inconclusive, naming the unreadable range
#   no-advisories -> inconclusive
# `no-advisories` is NOT a synonym for safe: a pin may exist for a reason that
# was never a security advisory, and a wrong package name or ecosystem produces
# the same empty answer.
cmd_judge() {
  local work=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --work) work="${2:?--work requires a directory}"; shift 2 ;;
      *) die "judge: unknown option '$1'" ;;
    esac
  done
  load_state "$work"

  # `baseline_done` is necessary and nowhere near sufficient. `baseline` itself
  # writes `findings` — the pins it refused on a `present: false` — so a healthy
  # repository has `findings: []` the moment it finishes, and
  # baseline -> judge -> together with **no `test-pin` call at all** used to
  # yield `{"status": "no_candidates", "pr_skipped_reason": "no removable pins
  # found"}` at exit 0. That is the identical false claim the `together` guard
  # was written to stop, reached by the route the guard did not cover, and this
  # step's own error text already promised the check ("run 'baseline' and
  # 'test-pin' first") while making only half of it.
  #
  # The state carries what is needed: every pin in `test_order` that the
  # baseline did not refuse is a pin `test-pin` owes a finding for.
  [ "$(state_get_opt '.baseline_done')" = "true" ] \
    || die "judge: run 'baseline' first. With no with-all-pins baseline there is nothing any finding was measured against."

  local expected recorded
  state_json advisories '.test_order' 'type == "array"' "phase 2's test_order"
  expected=$(printf '%s' "$STATE_JSON" | jq -r 'length')
  # The findings list is read through the shape check FIRST, so a `findings`
  # that came back something other than a list is reported as the shape it is
  # rather than as an arithmetic accident downstream.
  state_json advisories '.findings' 'type == "array"' 'the findings phase 4 recorded'
  recorded=$(printf '%s' "$STATE_JSON" | jq -r 'map(select(.tested == true)) | length')
  if [ "$expected" != "0" ] && [ "$recorded" = "0" ]; then
    die "judge: run 'test-pin' first. phase 2 found $expected testable pin(s) and none has been tested, so every finding on file is one the baseline refused — and judging that set reports an audit that examined nothing as one that kept every pin it has."
  fi

  local findings out='[]' fjson
  state_json advisories '.findings' 'type == "array"' 'the findings phase 4 recorded'
  findings=$STATE_JSON
  local n i
  n=$(printf '%s' "$findings" | jq -r 'length')
  i=0
  while [ "$i" -lt "$n" ]; do
    fjson=$(printf '%s' "$findings" | jq -c ".[$i]")
    i=$((i + 1))
    local st
    st=$(printf '%s' "$fjson" | jq -r '.status')
    if [ "$st" != "tested" ]; then
      out=$(jq -cn --argjson a "$out" --argjson f "$fjson" '$a + [$f]')
      continue
    fi

    local pkg delta left
    pkg=$(printf '%s' "$fjson" | jq -r '.package')
    delta=$(printf '%s' "$fjson" | jq -c '.attributable_versions')
    left=$(printf '%s' "$fjson" | jq -r '.left_tree')

    # `own_verdict` is the TESTED PACKAGE's own answer, carried separately from
    # `verdict` — which is the pin's status, and which the collateral collapse
    # below overwrites. Folding the two put `advisory_verdict: "vulnerable"`
    # with `matched_ranges: []` on a pin whose own delta came back `safe` and
    # whose collateral admitted something else, which reads as "this package is
    # vulnerable, ranges unstated" — the wrong-place reading `detail` exists to
    # prevent. The result contract is explicit: `advisory_verdict`,
    # `advisory_count` and `matched_ranges` come from `check-advisories.sh`
    # verbatim FOR THE TESTED PACKAGE, and a collateral package's result lives
    # in `collateral_verdict`, never folded into these.
    local verdict own_verdict="" count='null' matched='[]' detail
    if [ "$left" = "true" ]; then
      verdict=removable
      count=null
      detail="the package is no longer resolved at all: this pin was the only thing holding it in the tree, so there is no newly resolved version to judge"
    elif [ "$delta" = "[]" ]; then
      # An empty delta is its own finding, not a missing one. Nothing new
      # resolved, so removing the entry changes nothing observable IN THIS
      # MANIFEST AS IT STANDS — which is what a sibling pin on the same package
      # holding the tree looks like. Saying it this way is what stops the report
      # implying the package was independently checked and found safe.
      verdict=removable
      detail="nothing new resolved: removing the entry changes nothing observable in this manifest as it stands, which is what a sibling pin on the same package, or an ordinary dependency range, holding the tree looks like. No version was judged against the advisory database, because none appeared"
    else
      local v verdicts='[]' adv
      while IFS= read -r v; do
        [ -n "$v" ] || continue
        advisory_for "$pkg" "$v"
        adv=$ADVISORY_JSON
        verdicts=$(jq -cn --argjson a "$verdicts" --argjson r "$adv" --arg v "$v" \
          '$a + [{version: $v, verdict: $r.verdict, advisory_count: $r.advisory_count,
                  matched_ranges: $r.matched_ranges,
                  unevaluated_ranges: $r.unevaluated_ranges}]')
      done <<EOF
$(printf '%s' "$delta" | jq -r '.[]')
EOF
      # A pin is `removable` only when EVERY version in the delta comes back
      # `safe`. One version short of that makes the whole pin `still-required`
      # or `inconclusive`; there is no partial removal.
      verdict=$(printf '%s' "$verdicts" | jq -r '
        if any(.[]; .verdict == "vulnerable") then "still-required"
        elif all(.[]; .verdict == "safe") then "removable"
        else "inconclusive" end')
      # Always one of check-advisories.sh's own four values, never a synthesis
      # of them: a delta of several versions collapses to the least reassuring
      # answer any of them earned, in that script's vocabulary.
      own_verdict=$(printf '%s' "$verdicts" | jq -r '
        if any(.[]; .verdict == "vulnerable") then "vulnerable"
        elif any(.[]; .verdict == "unknown") then "unknown"
        elif any(.[]; .verdict == "no-advisories") then "no-advisories"
        else "safe" end')
      # `advisory_count` is the package's advisory total and does not vary by
      # version, so the first answer IS the verbatim value. A `max` across the
      # delta would be a synthesis of several readings of one number.
      count=$(printf '%s' "$verdicts" | jq -c '[ .[].advisory_count ] | first')
      matched=$(printf '%s' "$verdicts" | jq -c '[ .[].matched_ranges[] ] | unique')
      detail=$(printf '%s' "$verdicts" | jq -r '
        [ .[] | "\(.version): \(.verdict)"
          + (if (.matched_ranges | length) > 0 then " (" + (.matched_ranges | join("; ")) + ")" else "" end)
          + (if (.unevaluated_ranges | length) > 0 then " [unreadable range: " + (.unevaluated_ranges | join("; ")) + "]" else "" end) ]
        | join(", ")')
      fjson=$(jq -cn --argjson f "$fjson" --argjson v "$verdicts" '$f + {advisory_versions: $v}')
    fi

    # ---- the collateral list, judged the same way ------------------------
    local cverdict cdetail=""
    cverdict=$(printf '%s' "$fjson" | jq -r '.collateral_verdict // "null"')
    if [ "$cverdict" = '"not-checked"' ] || [ "$cverdict" = "not-checked" ]; then
      cverdict='"not-checked"'
      # The reason travels with the verdict rather than being reconstructed
      # here: "no whole-tree view was available" reads the same for an adapter
      # that does not implement the verb and for a parser that refused this
      # repository's lockfile, and only the second is a defect to chase.
      cdetail="the verdict covers $pkg only: $(printf '%s' "$fjson" | jq -r '.collateral_not_checked_reason // "no whole-tree view was available, so no other package'"'"'s resolution was re-checked"')"
    elif [ "$(printf '%s' "$fjson" | jq -r '(.collateral_changes // []) | length')" = "0" ]; then
      cverdict='"none"'
    else
      local cn ci centry cpkg cv cverdicts='[]'
      cn=$(printf '%s' "$fjson" | jq -r '.collateral_changes | length')
      ci=0
      while [ "$ci" -lt "$cn" ]; do
        centry=$(printf '%s' "$fjson" | jq -c ".collateral_changes[$ci]")
        ci=$((ci + 1))
        [ "$(printf '%s' "$centry" | jq -r '.judged')" = "true" ] || continue
        cpkg=$(printf '%s' "$centry" | jq -r '.package')
        while IFS= read -r cv; do
          [ -n "$cv" ] || continue
          # Each collateral version is judged under THAT ENTRY'S own package
          # name, never the tested pin's.
          advisory_for "$cpkg" "$cv"
          cverdicts=$(jq -cn --argjson a "$cverdicts" --argjson r "$ADVISORY_JSON" \
            --arg p "$cpkg" --arg v "$cv" \
            '$a + [{package: $p, version: $v, verdict: $r.verdict,
                    matched_ranges: $r.matched_ranges}]')
        done <<EOF
$(printf '%s' "$centry" | jq -r '.newly_admitted[]')
EOF
      done
      cverdict=$(printf '%s' "$cverdicts" | jq -c --argjson f "$fjson" '
        if length == 0 then "safe"
        elif any(.[]; .verdict == "vulnerable") then "vulnerable"
        elif all(.[]; .verdict == "safe") then
          (if (($f.sampled_families // []) | length) > 0 then "sampled-family" else "safe" end)
        else "inconclusive" end')
      fjson=$(jq -cn --argjson f "$fjson" --argjson c "$cverdicts" '$f + {collateral_verdicts: $c}')
    fi

    # A `vulnerable` collateral makes the pin `still-required` even when its own
    # package came back clean, and the detail says why in those terms: the pin
    # is not required for the package it names, it is required because removing
    # it admits a vulnerable version of something else.
    case "$cverdict" in
      '"vulnerable"')
        local vict
        vict=$(printf '%s' "$fjson" | jq -r '[ .collateral_verdicts[] | select(.verdict == "vulnerable") | "\(.package) \(.version)" ] | join(", ")')
        verdict="still-required"
        detail="this pin is not required for $pkg; it is required because removing it newly admits $vict elsewhere in the tree, which a published advisory range admits" ;;
      '"inconclusive"')
        [ "$verdict" = "still-required" ] || verdict=inconclusive
        detail="$detail; a package whose resolution moved with this removal could not be cleared: $(printf '%s' "$fjson" | jq -r '[ .collateral_verdicts[] | select(.verdict != "safe") | "\(.package) \(.version): \(.verdict)" ] | join(", ")')" ;;
      '"not-checked"')
        detail="$detail. $cdetail" ;;
    esac

    out=$(jq -cn --argjson a "$out" --argjson f "$fjson" --arg s "$verdict" \
      --arg d "$detail" --argjson c "$count" --argjson m "$matched" \
      --arg av "$own_verdict" --argjson cv "$cverdict" \
      '$a + [ $f + {status: $s, detail: $d,
                    advisory_verdict: (if $av == "" then null else $av end),
                    advisory_count: $c, matched_ranges: $m, collateral_verdict: $cv} ]')
  done

  # ---- the sibling rule ---------------------------------------------------
  # One pin at a time proves each pin removable ON ITS OWN; it proves nothing
  # about a set. When two or more pins on the SAME package come back removable
  # their status is `removable-individually`, and `sibling_pins` names the other
  # pins on that package that were in place during the test. A real run reported
  # four `minimatch` pins with byte-identical results purely because the
  # siblings held those versions during each test, while the fifth was the one
  # holding the line: a reader who deletes all four has not performed four
  # tested operations, they have performed one untested one.
  out=$(printf '%s' "$out" | jq -c '
    [ .[] | select(.status == "removable") | .package ] as $rp
    | (reduce $rp[] as $p ({}; .[$p] = ((.[$p] // 0) + 1))) as $counts
    | [ .[] as $f
        | if $f.status == "removable" and ($counts[$f.package] // 0) > 1
          then $f + {status: "removable-individually",
                     sibling_pins: [ .[] | select(.package == $f.package and .key != $f.key
                                                  and (.path != $f.path)) | .key ]}
          else $f end ]')

  state_set findings "$out"
  state_set judge_done true

  local untested
  untested=$(jq -c '[ .test_order[] as $p
                      | select([ (.findings // [])[] | .path ] | index($p.path) | not)
                      | {key: $p.key, path: $p.path, package: $p.package} ]' "$STATE" 2>/dev/null) \
    || die "judge: the untested-pin list could not be computed from $STATE"

  jq -n --argjson f "$out" --argjson untested "$untested" \
    '{status: "ok", step: "judge", findings: $f, untested: $untested,
      removable: [ $f[] | select(.status == "removable") | .key ],
      removable_individually: [ $f[] | select(.status == "removable-individually") | .key ],
      still_required: [ $f[] | select(.status == "still-required") | .key ],
      inconclusive: [ $f[] | select(.status == "inconclusive") | .key ]}'
}

# ---------------------------------------------------------------------------
# together — phase 7
#
# Phases 4 and 5 tested one pin per install, which is what makes each verdict
# evidence about that pin. It is also why no set of pins has yet been installed
# together, and a PR removes a set. So the PR earns its own test, and the rule
# is absolute: **a PR never removes a set that was not installed and judged as
# a set.** Attempt 1 is that test; attempt 2 is the one fallback, and there is
# no third.
# ---------------------------------------------------------------------------

ATTEMPT_RESULT=""
ATTEMPT_COLLATERAL='[]'
ATTEMPT_VERDICTS='[]'
ATTEMPT_DETAIL=""

remove_candidates() {
  # $1 = JSON array of pins
  local paths keys k
  paths=$(printf '%s' "$1" | jq -c '[ .[].path ]')
  if [ "$OVERRIDE_FILE" = "pnpm-workspace.yaml" ]; then
    keys=$(printf '%s' "$1" | jq -r '.[].key')
    while IFS= read -r k; do
      [ -n "$k" ] || continue
      workspace_remove_key "$k" || {
        restore_tree "the combined set"
        fail_phase compose "the pnpm-workspace.yaml overrides block could not be edited to remove '$k', so the combined set was never installed."
      }
    done <<EOF
$keys
EOF
  else
    state_json compose '.override_root' 'type == "array"' "the override block's address"
    manifest_remove_paths "$STATE_JSON" "$paths" || {
      restore_tree "the combined set"
      fail_phase compose "package.json could not be rewritten to remove the candidate set $paths. Quoting jq: $MANIFEST_EDIT_ERR"
    }
  fi
}

run_attempt() {
  # $1 attempt number, $2 candidate pins JSON. Sets ATTEMPT_RESULT to
  # clean|dirty|partial.
  local attempt=$1 cands=$2
  ATTEMPT_COLLATERAL='[]'
  ATTEMPT_VERDICTS='[]'
  ATTEMPT_DETAIL=""

  remove_candidates "$cands"

  if [ "$OVERRIDE_FILE" != "pnpm-workspace.yaml" ]; then
    local jqerr
    if ! jqerr=$( ( cd "$WT" && jq . package.json >/dev/null ) 2>&1 ); then
      restore_tree "attempt $attempt"
      fail_phase compose "package.json does not parse after removing attempt $attempt's candidate set. Quoting jq: $jqerr"
    fi
  fi

  # Verify the edits landed before installing. A set edit is several removals
  # against one file, and one that silently matched nothing installs a manifest
  # still carrying that pin while everything downstream reports the set as
  # removed. The count catches the opposite mistake too, a removal that took a
  # neighbouring entry with it.
  adapter_run list_pins \
    || { restore_tree "attempt $attempt"
         fail_phase compose "list_pins failed after composing attempt $attempt: $(adapter_error_text)"; }
  local after=$ADAPTER_OUT
  adapter_field compose "$after" "list_pins (attempt $attempt)" count
  local after_count=$ADAPTER_FIELD base_count nremoved still
  base_count=$(state_get '.pins_count'); state_ok $? '.pins_count'
  nremoved=$(printf '%s' "$cands" | jq -r 'length')
  still=$(printf '%s' "$after" | jq -c --argjson c "$cands" \
    '[ .pins[] | select(.path as $p | any($c[]; .path == $p)) | .key ]')
  if [ "$still" != "[]" ]; then
    restore_tree "attempt $attempt"
    fail_phase compose "attempt $attempt still carries the candidate key(s) $still after the removal, so the install would have been an install of a manifest still holding them."
  fi
  if [ "$after_count" != "$((base_count - nremoved))" ]; then
    restore_tree "attempt $attempt"
    fail_phase compose "attempt $attempt left $after_count pins where phase 2 counted $base_count and $nremoved entries were removed, which should leave $((base_count - nremoved))."
  fi

  local errfile out st install_err
  errfile=$(mktemp) || die "cannot create a temporary file"
  out=$( ( cd "$WT" && run_env "$ADAPTER" install ) 2>"$errfile" )
  st=$?
  install_err=$(printf '%s\n%s' "$out" "$(cat "$errfile")")
  rm -f "$errfile"
  if [ "$st" -ne 0 ]; then
    # An install that did not finish is a fact about the ENVIRONMENT; attempt 2
    # exists for a set that installed and came back dirty, which is a fact about
    # the pins. Rerunning with a smaller set would turn a registry timeout or a
    # peer conflict into a narrower PR nobody asked for, and a resolution_map
    # read off a half-written lockfile is worse still, because it parses.
    restore_tree "attempt $attempt"
    fail_phase compose "attempt $attempt's combined install failed, so the map was not read and attempt 2 was not tried: $install_err"
  fi

  # A partial view of the tree fails the attempt CLOSED, never into a PR. In
  # `report` mode a partial view degrades to a narrower claim, which is still
  # only words; here the same gap would ship a deletion nothing checked.
  adapter_run resolution_map
  st=$ADAPTER_STATUS
  if [ "$st" -ne 0 ]; then
    ATTEMPT_DETAIL="attempt $attempt could not read a whole-tree resolution_map: $(adapter_error_text)"
    ATTEMPT_RESULT=partial
    return 0
  fi
  local now_map=$ADAPTER_OUT
  map_unreadable compose "$now_map" "attempt $attempt's resolution_map"
  if [ "$MAP_UNREADABLE" != "0" ]; then
    ATTEMPT_DETAIL="attempt $attempt's resolution_map could not read $MAP_UNREADABLE lockfile entries, so it is not a whole-tree view"
    ATTEMPT_RESULT=partial
    return 0
  fi

  # Diff EVERY package against phase 4's with-all-pins baseline map, not only
  # the ones the removed pins name: an override reaches past its own target, and
  # a set of them reaches further than any one did alone.
  local base_map
  state_json compose '.baseline_map' 'type == "object" or type == "null"' "the with-all-pins baseline resolution_map"
  base_map=$STATE_JSON
  ATTEMPT_COLLATERAL=$(jq -cn --argjson base "$base_map" --argjson now "$now_map" '
    def norm: (. // []) | unique;
    [ ((($base.resolutions | keys) + ($now.resolutions | keys)) | unique)[]
      | . as $p
      | ($base.resolutions[$p] | norm) as $b
      | ($now.resolutions[$p] | norm) as $w
      | select($b != $w)
      | {package: $p, baseline: $b, without_pins: $w, newly_admitted: ($w - $b)} ]')

  local cn ci centry cpkg cv
  cn=$(printf '%s' "$ATTEMPT_COLLATERAL" | jq -r 'length')
  ci=0
  while [ "$ci" -lt "$cn" ]; do
    centry=$(printf '%s' "$ATTEMPT_COLLATERAL" | jq -c ".[$ci]")
    ci=$((ci + 1))
    cpkg=$(printf '%s' "$centry" | jq -r '.package')
    while IFS= read -r cv; do
      [ -n "$cv" ] || continue
      advisory_for "$cpkg" "$cv"
      ATTEMPT_VERDICTS=$(jq -cn --argjson a "$ATTEMPT_VERDICTS" --argjson r "$ADVISORY_JSON" \
        --arg p "$cpkg" --arg v "$cv" \
        '$a + [{package: $p, version: $v, verdict: $r.verdict, matched_ranges: $r.matched_ranges}]')
    done <<EOF
$(printf '%s' "$centry" | jq -r '.newly_admitted[]')
EOF
  done

  # The attempt is CLEAN only when every newly admitted version comes back
  # `safe`. `vulnerable` fails it, and so do `unknown` and `no-advisories`, for
  # the reason phase 5 gives: neither is a synonym for safe, and this is the one
  # place in the audit where the answer becomes a change to a real repository
  # rather than a sentence in a report.
  if [ "$(printf '%s' "$ATTEMPT_VERDICTS" | jq -r 'all(.[]; .verdict == "safe")')" = "true" ]; then
    ATTEMPT_RESULT=clean
  else
    ATTEMPT_RESULT=dirty
    ATTEMPT_DETAIL=$(printf '%s' "$ATTEMPT_VERDICTS" | jq -r \
      --arg n "$attempt" '[ .[] | select(.verdict != "safe")
        | "attempt \($n) admitted \(.package) \(.version) (\(.verdict)"
          + (if (.matched_ranges | length) > 0 then " via " + (.matched_ranges | join("; ")) else "" end) + ")" ]
      | join("; ")')
  fi
}

cmd_together() {
  local work=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --work) work="${2:?--work requires a directory}"; shift 2 ;;
      *) die "together: unknown option '$1'" ;;
    esac
  done
  load_state "$work"

  # Without this guard a skipped `judge` is indistinguishable from an audit
  # that kept every pin: before `judge` runs every finding still carries
  # `status: "tested"`, so the candidate set is empty and this step would
  # terminate exit 0 with `no removable pins found` — a claim about work that
  # was never done, reported to the agent as a successful audit. `test-pin`
  # carries exactly this guard on `baseline_done`.
  [ "$(state_get_opt '.judge_done')" = "true" ] \
    || die "together: run 'judge' first. Before it runs every finding is still 'tested', so the candidate set is empty and this step would report 'no removable pins found' for an advisory judgment that never happened."

  local findings cands1 cands2
  state_json compose '.findings' 'type == "array"' "phase 5's findings"
  findings=$STATE_JSON
  # The candidate set is every finding whose status is `removable` OR
  # `removable-individually` — the two statuses phase 5 judged safe, differing
  # only in whether siblings held the line during the individual test, which is
  # exactly the question this combined install answers. Attempt 1 is the maximal
  # set. Nothing else joins it: `still-required`, `inconclusive`, `not-tested`
  # and `not-a-version-pin` are not confirmed safe, and a PR is not the place to
  # find out.
  cands1=$(printf '%s' "$findings" | jq -c '[ .[] | select(.status == "removable" or .status == "removable-individually") | {key, path, package, value, status} ]')
  cands2=$(printf '%s' "$findings" | jq -c '[ .[] | select(.status == "removable") | {key, path, package, value, status} ]')

  if [ "$cands1" = "[]" ]; then
    jq -n '{status: "no_candidates", step: "together",
            pr_skipped_reason: "no removable pins found",
            pr_skipped_detail: "the audit ran and every pin it tested was kept, so there is nothing to open a PR about"}'
    exit 0
  fi

  # Both maps have to be whole, and the BASELINE is checked first: every diff
  # below is measured against it, so a partial baseline makes both attempts
  # unmeasurable rather than one of them.
  local map_available base_unreadable
  map_available=$(state_get_opt '.map_available')
  base_unreadable=$(state_get_opt '.baseline_unreadable_entries')
  if [ "$map_available" != "true" ] || [ "$base_unreadable" != "0" ]; then
    jq -n --arg u "${base_unreadable:-unavailable}" \
      '{status: "partial_map", step: "together",
        pr_skipped_reason: "partial resolution map",
        pr_skipped_detail: ("the with-all-pins baseline resolution_map was unavailable or partial (unreadable_entries: \($u)), so no combined attempt can be measured against it and none was run")}'
    exit 0
  fi

  # Restore the cache too, where the repository tracks one. Ask git whether it
  # does rather than looking for the directory: an untracked `.yarn/cache` is a
  # perfectly ordinary non-zero-install Berry repository, and `checkout` against
  # a pathspec matching nothing tracked is an error, not a no-op. Phase 4's
  # per-pin restore deliberately leaves those archives alone because they cannot
  # change how the next pin resolves, but there is a commit at the end of this
  # and per-pin residue in it would be an artifact of tests rather than of the
  # change being proposed.
  local tracked cerr
  tracked=$(git_at "$WT" ls-files -- .yarn/cache 2>&1) \
    || fail_phase restore "git ls-files -- .yarn/cache failed in the worktree: $tracked"
  if [ -n "$tracked" ]; then
    cerr=$(git_at "$WT" checkout HEAD -- .yarn/cache 2>&1) \
      || fail_phase restore "git checkout HEAD -- .yarn/cache failed, so per-pin cache residue would have reached the removal commit: $cerr"
  fi

  # The same read `restore_tree` makes, and for the same reason: this value
  # travels into the `ready_for_pr` payload, and phase 8 stages the removal
  # commit by that name. An empty one stages nothing and reports success.
  local LOCKFILE
  LOCKFILE=$(state_get '.lockfile'); state_ok $? '.lockfile'

  run_attempt 1 "$cands1"
  local a1=$ATTEMPT_RESULT a1_detail=$ATTEMPT_DETAIL
  if [ "$a1" = "clean" ]; then
    # Leave the removals in the tree: that diff is what phase 8 commits.
    jq -n --argjson c "$cands1" --argjson coll "$ATTEMPT_COLLATERAL" \
      --argjson v "$ATTEMPT_VERDICTS" --arg lockfile "$LOCKFILE" \
      --arg of "$OVERRIDE_FILE" \
      '{status: "ready_for_pr", step: "together", attempt: 1,
        removed_keys: [ $c[].key ], removed: $c, left_behind: [],
        collateral: $coll, advisory_verdicts: $v,
        lockfile: $lockfile, override_file: $of}'
    exit 0
  fi

  # Restore the tree before attempt 2. An attempt 2 measured against a tree
  # still carrying attempt 1's removals is a result about neither.
  restore_tree "attempt 1"

  # Two ways attempt 2 has nothing left to try, and both stop here rather than
  # running an attempt. The empty set is the documented one. The identical set
  # is the same fact wearing a different shape: with no `removable-individually`
  # finding, attempt 2 drops nothing, so running it would reinstall exactly the
  # set that just came back dirty and report the same failure as `attempt: 2` —
  # a second install spent proving the first one again, and a number in the
  # result that says a narrowing happened when none did.
  if [ "$cands2" = "[]" ] || [ "$cands2" = "$cands1" ]; then
    local why
    if [ "$cands2" = "[]" ]; then
      why="attempt 2 set was empty because every removable finding carried sibling ambiguity"
    else
      why="attempt 2 was not run: no finding was removable-individually, so its set is attempt 1's set and narrowing had nothing to drop"
    fi
    jq -n --arg d "$a1_detail" --arg a "$a1" --arg why "$why" \
      '{status: "combined_failed", step: "together", attempt: 1,
        pr_skipped_reason: (if $a == "partial" then "partial resolution map" else "combined test failed" end),
        pr_skipped_detail: ($d + "; " + $why)}'
    exit 0
  fi

  run_attempt 2 "$cands2"
  local a2=$ATTEMPT_RESULT a2_detail=$ATTEMPT_DETAIL
  if [ "$a2" = "clean" ]; then
    jq -n --argjson c "$cands2" --argjson all "$cands1" --argjson coll "$ATTEMPT_COLLATERAL" \
      --argjson v "$ATTEMPT_VERDICTS" --arg lockfile "$LOCKFILE" \
      --arg of "$OVERRIDE_FILE" --arg why "$a1_detail" \
      '{status: "ready_for_pr", step: "together", attempt: 2,
        removed_keys: [ $c[].key ], removed: $c,
        left_behind: [ $all[] | select(.status == "removable-individually")
                       | {key: .key, reason: ($why + "; excluded from attempt 2")} ],
        collateral: $coll, advisory_verdicts: $v,
        lockfile: $lockfile, override_file: $of}'
    exit 0
  fi

  restore_tree "attempt 2"
  # One `pr_skipped_reason`, and the one that actually stopped the PR is the
  # reason the LAST attempt that ran ended with. Anything else that also applied
  # travels in `pr_skipped_detail`, never in the field.
  jq -n --arg a2 "$a2" --arg d1 "$a1_detail" --arg d2 "$a2_detail" \
    '{status: "combined_failed", step: "together", attempt: 2,
      pr_skipped_reason: (if $a2 == "partial" then "partial resolution map" else "combined test failed" end),
      pr_skipped_detail: ($d1 + "; " + $d2)}'
}

# ---------------------------------------------------------------------------

command -v jq >/dev/null 2>&1 || die "jq is required"

SUB="${1:-}"
[ -n "$SUB" ] || die "usage: audit-pins-driver.sh <list|baseline|test-pin|judge|together> [options]"
shift

case "$SUB" in
  list)     cmd_list "$@" ;;
  baseline) cmd_baseline "$@" ;;
  test-pin) cmd_test_pin "$@" ;;
  judge)    cmd_judge "$@" ;;
  together) cmd_together "$@" ;;
  *) die "audit-pins-driver.sh: unknown subcommand '$SUB'" ;;
esac
