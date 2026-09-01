#!/usr/bin/env bash
# post-agent.sh — the one call phase 6 makes per completed fix agent: verify
# its pull request, reap its local artifacts when that verification allows
# it, and report the outcome for phase 7
#
# Usage:
#   post-agent.sh --result <file> --repo-root <path> [--env-prefix "<string>"]
#                 [--package <pkg>] [--major-line <line>] [--branch <name>]
#
#   --result      path to a file holding the completed agent's final message
#                 (or just its fenced JSON result block). Read, never written.
#   --repo-root   the repository the agent worked in (its primary checkout)
#   --env-prefix  OPTIONAL, opaque, threaded to the pull-request read only
#                 (see "Why env_prefix stops at the PR read" below)
#   --package, --major-line, --branch
#                 the dispatch payload's own `package`, `major_line` and
#                 `branch_name` for this group. OPTIONAL, but the only source
#                 of those three facts when the result block cannot supply
#                 them — an agent that crashed before printing one, or wrote
#                 one this script cannot parse, still leaves a worktree and a
#                 branch that need to be found and reported by name.
#
# This is `agents/fix-dependency.md`'s Result contract and
# `skills/resolve-alerts/SKILL.md` phase 6's reap step, collapsed into one
# script for the same reason `fix-group.sh` collapsed phases 1-5
# (scripts/CLAUDE.md, "The fix driver owns phases 1 to 5"): every branch here
# was an enumerated branch of that prose first, and a prose re-derivation of
# it in the skill is a bug, not a fallback.
#
# Output (always printed, whatever the outcome — like the adapter's
# `validate` and every script in this directory, report and continue rather
# than report-or-abort):
#
#   {
#     package, major_line, branch, worktree_path,
#     result_status: "success" | "no-op" | "failure" | "unparsable" | "missing",
#     pr_url, pr_state,       // both null unless result_status is "success"
#     reaped: true | false,
#     reason: "..." | null,  // why NOT reaped; null when reaped
#     left_behind: [...],    // paths/refs still on disk, whether reap left
#                             // them or this script never attempted a reap
#     errors: [...]          // every failure message gathered along the way
#   }
#
# `worktree_path` is built here, never taken from the result block or the
# dispatch payload — no field in either carries it — from the same template
# `reap-agent-artifacts.sh`'s own header documents:
#   <repo_root>/.claude/worktrees/fix-dependabot-<package_path>-<major_line>x
# where <package_path> is <package> with every `/` replaced by `-`. This is
# the whole point of the script: interpolating a scoped package's raw name
# leaves an interposed `fix-dependabot-@scope/` directory behind forever
# while the reap still reports a clean sweep, because the leaf it was handed
# was never the directory the fix agent actually created
# (issue #161, scripts/CLAUDE.md).
#
# Exit: 1 only for a usage or internal error — a required argument missing,
# or a repo_root/package/major_line/branch this script cannot resolve from
# either the result block or the fallback flags. Everything downstream of
# that — a failed PR read, a reap that left something behind, a reap that
# printed nothing at all — is reported in the JSON on stdout and this exits
# 0 (like `fix-group.sh cleanup`): a completed group that could not be
# reaped, or whose reap left something behind, is reported in the JSON, and
# the exit status must never be what stalls the orchestrator's pool
# (scripts/CLAUDE.md, "A reap that could not finish must never stall the
# pool").
#
# Why env_prefix stops at the PR read
# ------------------------------------
# `pr-status.sh` reads a pull request through `gh`, which needs the identity
# this repo's environment resolves — the same reason every other repo-facing
# `gh`/`git` call in this plugin takes the prefix (scripts/CLAUDE.md,
# "env_prefix is an opaque, optional seam"). `reap-agent-artifacts.sh` reaches
# no remote and no service at all: it removes one local worktree directory
# and deletes one local branch ref, entirely inside the path and the
# repository it is handed. There is no identity for a prefix to inject there,
# so it never receives one — this is stated once, here, rather than
# rediscovered by an engineer who assumes every repo-targeted call is
# symmetric.
#
# Lessons the layer below (fix-group.sh, reap-agent-artifacts.sh) learned the
# hard way, applied here rather than repeated:
#   - `git -C ""` silently operates on the current directory, so an empty
#     `--repo-root` is refused outright, before it reaches either downstream
#     script.
#   - `jq -r` on a missing key yields the string "null" and takes a branch
#     silently, so every field the result contract promises is read through
#     `has()`, never through a bare `-r`.
#   - A verdict is never defaulted to its optimistic value. There is no
#     bare `reaped=true` that later flips to false; `reaped` starts false and
#     is set true only at the one place a reap actually completed and
#     printed a report.

set -euo pipefail

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

# jq is this script's one hard dependency and `die` itself is built out of
# it, so a jq-less box has to be caught before `die` is ever called — the
# same preflight reap-agent-artifacts.sh runs, for the same reason (its own
# header: without it, `die` prints no JSON and the caller sees only a bare
# non-zero exit with nothing to parse).
if ! command -v jq >/dev/null 2>&1; then
  printf '{"error":"jq is required by post-agent.sh"}\n' >&2
  exit 1
fi

# Both temp files are declared once, up front, so one trap covers whichever
# of them end up created — a second `trap ... EXIT` later would silently
# replace this one and leak the first file. `INT TERM` match pr-status.sh's
# own trap (pr-status.sh:128): EXIT alone misses a killed run.
PR_ERR_FILE=""
REAP_ERR_FILE=""
trap 'rm -f "$PR_ERR_FILE" "$REAP_ERR_FILE"' EXIT INT TERM

die() {
  printf 'post-agent: %s\n' "$1" >&2
  jq -n --arg e "$1" '{error: $e}'
  exit 1
}

usage() {
  die "Usage: post-agent.sh --result <file> --repo-root <path> [--env-prefix \"<string>\"] [--package <pkg>] [--major-line <line>] [--branch <name>]"
}

RESULT_FILE=""
REPO_ROOT=""
ENV_PREFIX_RAW=""
FALLBACK_PACKAGE=""
FALLBACK_MAJOR_LINE=""
FALLBACK_BRANCH=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --result)      [ "$#" -ge 2 ] || usage; RESULT_FILE=$2;         shift 2 ;;
    --repo-root)   [ "$#" -ge 2 ] || usage; REPO_ROOT=$2;           shift 2 ;;
    --env-prefix)  [ "$#" -ge 2 ] || usage; ENV_PREFIX_RAW=$2;      shift 2 ;;
    --package)     [ "$#" -ge 2 ] || usage; FALLBACK_PACKAGE=$2;    shift 2 ;;
    --major-line)  [ "$#" -ge 2 ] || usage; FALLBACK_MAJOR_LINE=$2; shift 2 ;;
    --branch)      [ "$#" -ge 2 ] || usage; FALLBACK_BRANCH=$2;     shift 2 ;;
    *)             usage ;;
  esac
done

[ -n "$RESULT_FILE" ] || usage
[ -n "$REPO_ROOT" ] || die "--repo-root must not be empty (an empty value would let git operate on the current directory instead)"

# ---------------------------------------------------------------------------
# env_prefix: opaque argv prefix, split on whitespace, threaded to
# pr-status.sh only. bash 3.2 has no safe empty-array expansion under `set
# -u`, so the element count is tracked rather than read off the array
# (mirrors fix-group.sh).
# ---------------------------------------------------------------------------

ENV_PREFIX_ARGV=()
ENV_PREFIX_N=0
case "$ENV_PREFIX_RAW" in
  '') ;;
  *)
    read -r -a ENV_PREFIX_ARGV <<EOF
$ENV_PREFIX_RAW
EOF
    ENV_PREFIX_N=${#ENV_PREFIX_ARGV[@]}
    ;;
esac

run_env() {
  if [ "$ENV_PREFIX_N" -gt 0 ]; then
    "${ENV_PREFIX_ARGV[@]}" "$@"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Parse the result block
# ---------------------------------------------------------------------------
#
# `--result` may hold either the bare JSON object or the agent's whole final
# message with the JSON as a fenced ```json block inside it — the contract
# only promises the file carries the block, not that nothing else is in it.
# Both are tried: a whole-file parse first, then the LAST ```json fence in
# the file, because a transcript can carry earlier JSON that is not the
# agent's final answer.
#
# **The last fence must be closed, or nothing is extracted at all.** Recording
# `last` only at a closing ``` means a cut-off final block — the agent hung or
# was truncated mid-result — silently falls back to whatever CLOSED block came
# before it, which can be a fully-formed, well-typed decoy: a quoted copy of
# the Result *template* from `agents/fix-dependency.md` elsewhere in the same
# message, complete with literal `"<package>"`/`"<branch_name>"` placeholders
# that pass every `has()`/type/non-empty check below. That is a false
# `success` built from prose, not a parsed result, and it is exactly the case
# the dispatch-payload fallback flags exist to catch — so a still-open capture
# at EOF (the true last block was never closed) discards `last` rather than
# handing back a stale one, and the caller falls through to `unparsable`.
extract_fenced_json() {
  awk '
    /^```json[[:space:]]*$/ { capturing = 1; buf = ""; next }
    /^```[[:space:]]*$/     { if (capturing) { capturing = 0; last = buf; closed = 1 }; next }
    capturing                { buf = buf $0 "\n" }
    END {
      if (capturing) { exit }
      if (closed && length(last) > 0) printf "%s", last
    }
  ' "$1"
}

RESULT_STATE=""
R_PACKAGE=""
R_MAJOR_LINE=""
R_BRANCH=""
R_PR_URL=""

if [ ! -s "$RESULT_FILE" ]; then
  RESULT_STATE="missing"
else
  RESULT_JSON=""
  if jq -e 'type == "object"' "$RESULT_FILE" >/dev/null 2>&1; then
    RESULT_JSON=$(cat "$RESULT_FILE")
  else
    CANDIDATE=$(extract_fenced_json "$RESULT_FILE")
    if [ -n "$CANDIDATE" ] \
        && printf '%s' "$CANDIDATE" | jq -e 'type == "object"' >/dev/null 2>&1; then
      RESULT_JSON="$CANDIDATE"
    fi
  fi

  if [ -z "$RESULT_JSON" ]; then
    RESULT_STATE="unparsable"
  else
    STATUS=$(printf '%s' "$RESULT_JSON" | jq -r '.status // empty')
    # `package` and `major_line` are promised on every result regardless of
    # status (`agents/fix-dependency.md`'s Result schema nulls `pr_url`,
    # `action`, `resolved_version`, and `risk` on a non-success, never these
    # two) and they are exactly the two fields that build the path handed to
    # a deleting script, so they get the same has()/type/non-empty gate as
    # `branch` and `pr_url` — never a bare `// empty` that lets an absent
    # `package` silently fall through to a DIFFERENT field's source below. A
    # block missing any promised field is unparsable as a whole: partially
    # trusting it is how a validated `branch` from this result ends up paired
    # with a `package` pulled from the dispatch-payload fallback of what is,
    # from this field's point of view, an unrelated group — issue #161's
    # failure mode arriving through a different door.
    case "$STATUS" in
      success)
        # A promised field arriving absent, null, or empty is the same hard
        # error as it being missing entirely (scripts/CLAUDE.md) — never
        # defaulted, and never treated as a usable branch or PR to check.
        if printf '%s' "$RESULT_JSON" | jq -e '
              has("branch") and has("pr_url") and has("package") and has("major_line")
              and (.branch | type == "string") and (.branch | length > 0)
              and (.pr_url | type == "string") and (.pr_url | length > 0)
              and (.package | type == "string") and (.package | length > 0)
              and (.major_line | type == "string") and (.major_line | length > 0)
            ' >/dev/null 2>&1; then
          RESULT_STATE="success"
          R_BRANCH=$(printf '%s' "$RESULT_JSON" | jq -r '.branch')
          R_PR_URL=$(printf '%s' "$RESULT_JSON" | jq -r '.pr_url')
          R_PACKAGE=$(printf '%s' "$RESULT_JSON" | jq -r '.package')
          R_MAJOR_LINE=$(printf '%s' "$RESULT_JSON" | jq -r '.major_line')
        else
          RESULT_STATE="unparsable"
        fi
        ;;
      no-op | failure)
        if printf '%s' "$RESULT_JSON" | jq -e '
              has("branch") and has("package") and has("major_line")
              and (.branch | type == "string") and (.branch | length > 0)
              and (.package | type == "string") and (.package | length > 0)
              and (.major_line | type == "string") and (.major_line | length > 0)
            ' >/dev/null 2>&1; then
          RESULT_STATE="$STATUS"
          R_BRANCH=$(printf '%s' "$RESULT_JSON" | jq -r '.branch')
          R_PACKAGE=$(printf '%s' "$RESULT_JSON" | jq -r '.package')
          R_MAJOR_LINE=$(printf '%s' "$RESULT_JSON" | jq -r '.major_line')
        else
          RESULT_STATE="unparsable"
        fi
        ;;
      *)
        RESULT_STATE="unparsable"
        ;;
    esac
  fi
fi

# errors[] is collected from here on, so it can carry both the
# result/fallback disagreement below and everything the PR read and the reap
# add later.
ERRORS=""
note_error() { ERRORS="$ERRORS$1
"; }

# ---------------------------------------------------------------------------
# Resolve package / major_line / branch — from the result when it parsed
# (never mixed field-by-field with the fallback: the has() gate above means
# R_PACKAGE, R_MAJOR_LINE, and R_BRANCH are either all set together, from the
# same result block, or all empty), from the dispatch-payload fallback when
# it did not parse.
# ---------------------------------------------------------------------------

PACKAGE="$R_PACKAGE"
[ -n "$PACKAGE" ] || PACKAGE="$FALLBACK_PACKAGE"
MAJOR_LINE="$R_MAJOR_LINE"
[ -n "$MAJOR_LINE" ] || MAJOR_LINE="$FALLBACK_MAJOR_LINE"
BRANCH="$R_BRANCH"
[ -n "$BRANCH" ] || BRANCH="$FALLBACK_BRANCH"

[ -n "$PACKAGE" ] || die "no package name available: the result block at $RESULT_FILE is $RESULT_STATE and no --package fallback was given"
[ -n "$MAJOR_LINE" ] || die "no major line available: the result block at $RESULT_FILE is $RESULT_STATE and no --major-line fallback was given"
[ -n "$BRANCH" ] || die "no branch name available: the result block at $RESULT_FILE is $RESULT_STATE and no --branch fallback was given"

# A result/fallback disagreement is a signal worth reporting rather than a
# side to silently prefer. SKILL.md phase 6 passes the fallback flags
# unconditionally, naming the SAME group the result block is for, so the two
# should always agree when the result parsed; a mismatch means the caller
# handed this script two different groups' facts. The result's own value is
# still what gets used — it passed the has()/type/non-empty gate above — this
# only makes the disagreement visible rather than silent.
note_disagreement() {
  # $1 flag name, $2 result value, $3 fallback value
  if [ -n "$2" ] && [ -n "$3" ] && [ "$2" != "$3" ]; then
    note_error "the result block's $1 ('$2') disagrees with the --$1 fallback ('$3')"
  fi
}
note_disagreement "package" "$R_PACKAGE" "$FALLBACK_PACKAGE"
note_disagreement "major-line" "$R_MAJOR_LINE" "$FALLBACK_MAJOR_LINE"
note_disagreement "branch" "$R_BRANCH" "$FALLBACK_BRANCH"

# <package_path> is <package> with every `/` replaced by `-`, exactly the
# template reap-agent-artifacts.sh's header requires: a scoped package name
# interpolated raw would split into a directory the fix agent never created
# (issue #161).
PACKAGE_PATH=$(printf '%s' "$PACKAGE" | tr '/' '-')
WORKTREE_PATH="$REPO_ROOT/.claude/worktrees/fix-dependabot-${PACKAGE_PATH}-${MAJOR_LINE}x"

# ---------------------------------------------------------------------------
# Verify the pull request — success only, since no-op/failure/unparsable/
# missing never carry a pr_url to check.
# ---------------------------------------------------------------------------

PR_STATE=""
REASON=""

case "$RESULT_STATE" in
  success)
    PR_ERR_FILE=$(mktemp)
    PR_STDOUT=""
    if PR_STDOUT=$(run_env "$SELF_DIR/pr-status.sh" "$R_PR_URL" 2>"$PR_ERR_FILE"); then
      :
    fi
    PR_ENTRY=$(printf '%s' "$PR_STDOUT" | jq -c '.prs[0] // empty' 2>/dev/null) || PR_ENTRY=""
    if [ -z "$PR_ENTRY" ]; then
      REASON="pr-status.sh produced no readable output for $R_PR_URL"
      note_error "$REASON: $(cat "$PR_ERR_FILE")"
    elif printf '%s' "$PR_ENTRY" | jq -e 'has("error")' >/dev/null 2>&1; then
      PR_ERR=$(printf '%s' "$PR_ENTRY" | jq -r '.error')
      REASON="pr-status.sh could not read the pull request: $PR_ERR"
      note_error "$REASON"
    elif printf '%s' "$PR_ENTRY" | jq -e 'has("state") and (.state | type == "string")' >/dev/null 2>&1; then
      PR_STATE=$(printf '%s' "$PR_ENTRY" | jq -r '.state')
      if [ "$PR_STATE" != "OPEN" ]; then
        REASON="pull request is not open (state=$PR_STATE)"
      fi
    else
      REASON="pr-status.sh returned an entry with no usable state for $R_PR_URL"
      note_error "$REASON"
    fi
    ;;
  no-op)
    REASON="no-op: the agent made no fix, so there is nothing to verify or reap"
    ;;
  failure)
    REASON="failure: the agent's result was a failure"
    ;;
  unparsable)
    REASON="unparseable result block at $RESULT_FILE"
    ;;
  missing)
    REASON="missing result block at $RESULT_FILE"
    ;;
esac

# ---------------------------------------------------------------------------
# Reap — only when the PR read came back OPEN. Bare, deliberately: see the
# header note on why env_prefix stops at the PR read.
# ---------------------------------------------------------------------------

REAPED=false
LEFT_BEHIND=""
note_left() { LEFT_BEHIND="$LEFT_BEHIND$1
"; }

if [ "$RESULT_STATE" = "success" ] && [ "$PR_STATE" = "OPEN" ]; then
  REAP_ERR_FILE=$(mktemp)
  REAP_STDOUT=""
  REAP_EXIT=0
  REAP_STDOUT=$("$SELF_DIR/reap-agent-artifacts.sh" \
      --repo-root "$REPO_ROOT" --branch "$BRANCH" --work "$WORKTREE_PATH" \
      2>"$REAP_ERR_FILE") || REAP_EXIT=$?

  # `reap-agent-artifacts.sh:385-399` promises `worktree`, `work_dir`,
  # `branch_ref`, `left_behind`, and `errors` on every report it prints — an
  # `{}` or a bare `{"error": "..."}` on stdout is *an* object, but it is not
  # *that* report, and treating any object as a completed reap is the same
  # found-nothing-is-a-pass mistake the adjacent branch below refuses. So the
  # promised keys are asserted, not just the JSON type.
  REAP_SHAPE_OK=false
  if [ -n "$REAP_STDOUT" ] && printf '%s' "$REAP_STDOUT" | jq -e '
        type == "object"
        and has("worktree") and has("work_dir") and has("branch_ref")
        and has("left_behind") and (.left_behind | type == "array")
        and has("errors") and (.errors | type == "array")
      ' >/dev/null 2>&1; then
    REAP_SHAPE_OK=true
  fi

  REAP_AGREES=false
  if [ "$REAP_SHAPE_OK" = true ]; then
    REAP_ERRORS_COUNT=$(printf '%s' "$REAP_STDOUT" | jq '.errors | length')
    # The real script's own invariant is `[ -z "$errors" ] || exit 1`
    # (reap-agent-artifacts.sh:401): its exit status and its own `errors`
    # array always agree. A report that disagrees with the process's exit
    # status is not trustworthy, whatever it claims — never read as a clean
    # sweep just because it parses.
    if { [ "$REAP_EXIT" -eq 0 ] && [ "$REAP_ERRORS_COUNT" -eq 0 ]; } \
        || { [ "$REAP_EXIT" -ne 0 ] && [ "$REAP_ERRORS_COUNT" -gt 0 ]; }; then
      REAP_AGREES=true
    fi
  fi

  if [ "$REAP_AGREES" = true ]; then
    # Ran and reported, whatever it found: reaped for this group's purposes,
    # because the pool step happened. Its own left_behind/errors carry the
    # detail — a worktree it could not remove is a fact about the group,
    # never a reason to say the reap did not run.
    REAPED=true
    # A `while read` fed through a pipe runs in a subshell, and note_left /
    # note_error would then update a copy of $LEFT_BEHIND / $ERRORS that
    # vanishes when the subshell exits. Capturing jq's output into a
    # variable first and reading it back through a heredoc keeps the loop in
    # this shell.
    REAP_LEFT=$(printf '%s' "$REAP_STDOUT" | jq -r '.left_behind[]? // empty')
    if [ -n "$REAP_LEFT" ]; then
      while IFS= read -r item; do
        [ -n "$item" ] && note_left "$item"
      done <<EOF
$REAP_LEFT
EOF
    fi
    REAP_ERRORS=$(printf '%s' "$REAP_STDOUT" | jq -r '.errors[]? // empty')
    if [ -n "$REAP_ERRORS" ]; then
      while IFS= read -r item; do
        [ -n "$item" ] && note_error "$item"
      done <<EOF
$REAP_ERRORS
EOF
    fi
  elif [ "$REAP_SHAPE_OK" = true ]; then
    # A well-shaped report whose own errors[] disagrees with the process's
    # exit status: not trusted, whatever it says was removed.
    REASON="reap-agent-artifacts.sh's exit status ($REAP_EXIT) disagrees with its own errors array (count=$REAP_ERRORS_COUNT); the report cannot be trusted"
    note_error "$REASON"
    note_left "$WORKTREE_PATH"
    note_left "$BRANCH"
  else
    # Either nothing was printed at all (a rejected argument or a refused
    # path: reap-agent-artifacts.sh dies before printing anything, so it
    # removed nothing), or something was printed that is not the promised
    # report shape. Either way nothing here is trusted as a clean sweep —
    # exactly the false "found nothing, so all clear" this plugin's scripts
    # refuse elsewhere (scripts/CLAUDE.md, "The rule that matters most").
    if [ -z "$REAP_STDOUT" ]; then
      REASON="reap-agent-artifacts.sh exited without printing a report; nothing was removed"
    else
      REASON="reap-agent-artifacts.sh printed JSON that is not the promised report shape (missing worktree/work_dir/branch_ref/left_behind/errors)"
    fi
    note_error "$REASON: $(cat "$REAP_ERR_FILE")"
    note_left "$WORKTREE_PATH"
    note_left "$BRANCH"
  fi
elif [ "$RESULT_STATE" = "success" ] && [ "$PR_STATE" != "OPEN" ]; then
  note_left "$WORKTREE_PATH"
  note_left "$BRANCH"
else
  note_left "$WORKTREE_PATH"
  note_left "$BRANCH"
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

jq -n \
  --arg package "$PACKAGE" \
  --arg major_line "$MAJOR_LINE" \
  --arg branch "$BRANCH" \
  --arg worktree_path "$WORKTREE_PATH" \
  --arg result_status "$RESULT_STATE" \
  --arg pr_url "$R_PR_URL" \
  --arg pr_state "$PR_STATE" \
  --argjson reaped "$REAPED" \
  --arg reason "$REASON" \
  --arg left_behind "$LEFT_BEHIND" \
  --arg errors "$ERRORS" '
  # No unique: the sibling reap-agent-artifacts.sh deliberately does not
  # dedupe either (its own "lines" def), and an errors entry can
  # legitimately repeat from two different sources — the reap and the PR
  # read failure text can coincide, and deduping would collapse that into
  # one, silently understating how many things went wrong.
  def lines: split("\n") | map(select(length > 0));
  {
    package: $package,
    major_line: $major_line,
    branch: $branch,
    worktree_path: $worktree_path,
    result_status: $result_status,
    pr_url: (if $pr_url == "" then null else $pr_url end),
    pr_state: (if $pr_state == "" then null else $pr_state end),
    reaped: $reaped,
    reason: (if $reason == "" then null else $reason end),
    left_behind: ($left_behind | lines),
    errors: ($errors | lines)
  }'

exit 0
