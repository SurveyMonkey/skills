#!/usr/bin/env bash
# reap-agent-artifacts.sh — remove one finished fix agent's local leftovers,
# after the orchestrator has verified that agent's pull request is open
#
# Usage: reap-agent-artifacts.sh --repo-root <path> --branch <name> --work <path>
#
#   --repo-root  the repository the agent worked in (its primary checkout)
#   --branch     that group's `branch_name`, verbatim, in either spelling:
#                `fix/dependabot-<package>-<line>x` or the flat fallback
#                `fix-dependabot-<package>-<line>x` (issue #123)
#   --work       that group's `$WORK` directory,
#                `<repo_root>/.claude/worktrees/fix-dependabot-<package>-<line>x`.
#                The git worktree itself sits at `<work>/fix`; this is its parent.
#
# Output: {repo_root, branch, work, worktree, work_dir, branch_ref,
#          left_behind, errors}
#
# Example:
#   reap-agent-artifacts.sh \
#     --repo-root /src/@example-org/example-repo \
#     --branch fix/dependabot-example-pkg-6x \
#     --work /src/@example-org/example-repo/.claude/worktrees/fix-dependabot-example-pkg-6x
#
# **Verifying the pull request is the CALLER's job, and this script cannot do
# it.** It makes no network call and asks `gh` nothing. The orchestrator runs
# it from the phase 6 pool loop only after that agent's PR has been confirmed
# open, because an open PR is what makes deleting the local branch safe: the
# pushed tip is on origin, so the local ref is a duplicate of something that
# survives it (the tip-equality safe case in `agents/fix-dependency.md`). An
# agent that ended without a verified PR is never reaped; its leftovers stay
# reported instead.
#
# The tip equality is re-checked here anyway, against the remote-tracking ref
# `origin/<branch>` that the agent's own push updated. A local tip that is not
# on origin is left in place and reported, whatever the caller believes: an
# unpushed commit is the one thing here that cannot be recreated.
#
# **Local scope only.** The remote branch backs the open PR and is never
# touched, and neither is any other worktree or branch. Everything below names
# exactly one path and exactly one ref.
#
# **Never `git worktree prune`.** It walks every worktree entry in the
# repository, so a call timed against a sibling agent's `worktree add` or
# `remove` can delete a live registration, and the breakage surfaces in the
# victim rather than here (issue #35). Sibling agents are in flight by
# construction whenever the pool refills, which is exactly when this runs.
#
# A worktree whose directory is gone while its registration survives is the one
# state that needs an administrative write, and it gets the narrow form of the
# same rule: `git worktree remove` refuses it outright (`is not a working
# tree`), and until the entry goes, `git worktree add` cannot recreate the path
# and `git branch -D` refuses the branch as `used by worktree`. So this removes
# the SINGLE admin entry under `<git-common-dir>/worktrees/` whose `gitdir` file
# names this one path, identified by that content and never by position. One
# path, one entry, no walk over anyone else's.
#
# Both paths are resolved physically before anything is touched, so a
# `.claude/worktrees` that has been relocated behind a symlink resolves outside
# the containment guard and is **refused rather than reaped**. That is the safe
# direction: the cost is a reported leftover the user removes by hand, where
# following the link would put `rm -rf` and `worktree remove` somewhere this
# script never proved it owns.
#
# Idempotent: a second run over the same group finds nothing and succeeds
# reporting `absent` for every artifact.
#
# Exit: 1 when an artifact was meant to come off and could not. The report is
# emitted on stdout first either way, like the adapter's `validate`. A
# deliberate leave (a branch tip that is not on origin) is a correct outcome
# and exits 0 with the reason in `branch_ref`.

set -euo pipefail

# jq is this plugin's one hard dependency and every exit path here is built out
# of it, `die` included. Checked before anything is removed, because a jq that
# is missing kills the script the moment it reports, which without this preflight
# means after the deletions, with no report of what went (issue #131 review).
if ! command -v jq >/dev/null 2>&1; then
  printf '{"error":"jq is required by reap-agent-artifacts.sh"}\n' >&2
  exit 1
fi

die() {
  printf '{"error":%s}\n' "$(printf '%s' "$1" | jq -Rs .)" >&2
  exit 1
}

usage() {
  die "Usage: reap-agent-artifacts.sh --repo-root <path> --branch <name> --work <path>"
}

REPO_ROOT=""
BRANCH=""
WORK=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root) [ "$#" -ge 2 ] || usage; REPO_ROOT=$2; shift 2 ;;
    --branch)    [ "$#" -ge 2 ] || usage; BRANCH=$2;    shift 2 ;;
    --work)      [ "$#" -ge 2 ] || usage; WORK=$2;      shift 2 ;;
    *)           usage ;;
  esac
done

[ -n "$REPO_ROOT" ] || usage
[ -n "$BRANCH" ] || usage
[ -n "$WORK" ] || usage

[ -d "$REPO_ROOT" ] || die "repo_root does not exist: $REPO_ROOT"
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || die "not a git repository: $REPO_ROOT"

# A branch name git would refuse is a caller bug, not something to discover
# halfway through a delete. The leading-dash test is separate because
# `check-ref-format` accepts `refs/heads/-D` happily, and that name reaches
# `git branch -D <name>` as an option rather than as a ref.
case "$BRANCH" in
  -*) die "branch name must not begin with a dash: $BRANCH" ;;
esac
git check-ref-format "refs/heads/$BRANCH" 2>/dev/null \
  || die "not a valid branch name: $BRANCH"

# Both sides are resolved through the filesystem before they are compared, so
# a caller that spelled `repo_root` through a symlink (macOS `/var` really
# being `/private/var` is the everyday case) still matches the containment
# guard below. `$WORK` may already be gone, which is the idempotent success
# case, so resolution walks up to the deepest ancestor that does exist and
# re-appends the rest; resolving only its immediate parent would fail the
# guard on a second run that finds `.claude/worktrees/` itself already gone.
#
# A `cd` that fails on an ancestor that does exist is a permission problem, and
# it is reported as one: returning the unresolved path instead turned it into a
# containment refusal naming the wrong cause (issue #131 review).
RESOLVE_ERR=""
resolve_path() {
  RESOLVE_ERR=""
  _p=$1
  _suffix=""
  while [ ! -d "$_p" ]; do
    _suffix="/$(basename "$_p")$_suffix"
    _parent=$(dirname "$_p")
    [ "$_parent" != "$_p" ] || break
    _p=$_parent
  done
  if [ ! -d "$_p" ]; then
    printf '%s\n' "$1"
    return 0
  fi
  _resolved=$( ( cd "$_p" 2>/dev/null && pwd -P ) || true )
  if [ -z "$_resolved" ]; then
    RESOLVE_ERR="cannot resolve $1: $_p exists but could not be entered"
    printf '%s\n' "$1"
    return 0
  fi
  printf '%s%s\n' "$_resolved" "$_suffix"
}

REPO_ROOT=$(resolve_path "$REPO_ROOT")
[ -z "$RESOLVE_ERR" ] || die "$RESOLVE_ERR"
WORK=$(resolve_path "$WORK")
[ -z "$RESOLVE_ERR" ] || die "$RESOLVE_ERR"

# The containment guard. This script runs `rm -rf` on `$WORK`, so the one path
# it accepts is a directory *under* that repository's own agent worktree root,
# never the root itself and never anything reached through a `..` segment.
no_dotdot() {
  case "$1" in
    *"/../"* | */..) return 1 ;;
  esac
  return 0
}

contained() {
  case "$1" in
    "$REPO_ROOT/.claude/worktrees/"?*) return 0 ;;
  esac
  return 1
}

no_dotdot "$WORK" || die "work path must not contain a .. segment: $WORK"
contained "$WORK" \
  || die "work path is not under $REPO_ROOT/.claude/worktrees/: $WORK"

# `$WORK/fix` is resolved the same way and held to the same guard: a symlink
# there would otherwise carry `worktree remove` out of the tree this script
# proved it owns.
WORKTREE=$(resolve_path "$WORK/fix")
[ -z "$RESOLVE_ERR" ] || die "$RESOLVE_ERR"
no_dotdot "$WORKTREE" || die "worktree path must not contain a .. segment: $WORKTREE"
contained "$WORKTREE" \
  || die "worktree path resolves outside $REPO_ROOT/.claude/worktrees/: $WORKTREE"

errors=""
left=""
note_error() { errors="$errors$1
"; }
note_left() { left="$left$1
"; }

# --- the git worktree ------------------------------------------------------
#
# A checked-out worktree carries a `.git` pointer file, so its presence is what
# tells a live registration apart from a plain leftover directory. A live one
# must come off through git; a plain directory is covered by the `rm -rf`
# below; and a registration whose directory is gone is the stale case the
# header describes.
registered() {
  git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null \
    | grep -Fqx "worktree $WORKTREE"
}

# The one admin entry whose `gitdir` file names this worktree, found by that
# content rather than by a name pattern: git numbers the directories itself
# (`fix`, `fix1`, ...) and two agents in the same repo both want `fix`.
admin_entry() {
  _common=$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null) || return 1
  case "$_common" in
    /*) ;;
    *) _common="$REPO_ROOT/$_common" ;;
  esac
  for _entry in "$_common"/worktrees/*; do
    [ -f "$_entry/gitdir" ] || continue
    _recorded=""
    IFS= read -r _recorded < "$_entry/gitdir" 2>/dev/null || true
    [ "$_recorded" = "$WORKTREE/.git" ] || continue
    printf '%s\n' "$_entry"
    return 0
  done
  return 1
}

worktree_action="absent"
worktree_blocked=0
if [ -e "$WORKTREE/.git" ]; then
  if worktree_err=$(git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" 2>&1); then
    worktree_action="removed"
  else
    worktree_action="failed"
    worktree_blocked=1
    note_error "worktree remove failed: $worktree_err"
    note_left "$WORKTREE"
  fi
elif registered; then
  entry=$(admin_entry) || entry=""
  if [ -z "$entry" ]; then
    worktree_action="stale-registration"
    worktree_blocked=1
    note_error "a registration for $WORKTREE survives and no admin entry names it"
    note_left "$WORKTREE"
  elif admin_err=$(rm -rf "$entry" 2>&1); then
    worktree_action="stale-registration-removed"
  else
    worktree_action="stale-registration"
    worktree_blocked=1
    note_error "could not remove the admin entry $entry: $admin_err"
    note_left "$WORKTREE"
  fi
elif [ -d "$WORKTREE" ]; then
  worktree_action="not-a-worktree"
fi

# --- the $WORK directory ---------------------------------------------------
#
# Skipped outright while the worktree is still registered: removing the
# directory out from under a live registration turns a reportable leftover into
# a broken one.
work_action="absent"
if [ "$worktree_blocked" -eq 1 ]; then
  work_action="skipped"
  note_left "$WORK"
elif [ -d "$WORK" ]; then
  if work_err=$(rm -rf "$WORK" 2>&1); then
    work_action="removed"
  else
    work_action="failed"
    note_error "rm -rf failed: $work_err"
    note_left "$WORK"
  fi
elif [ -e "$WORK" ]; then
  # Something is there and it is not a directory. No agent of this flow makes
  # that, so it is reported rather than deleted: `absent` would be a false
  # claim about the user's disk.
  work_action="not-a-directory"
  note_error "work path exists and is not a directory: $WORK"
  note_left "$WORK"
fi

# --- the local branch ------------------------------------------------------
#
# Order matters: the worktree comes off first. Git refuses to delete a branch
# that is checked out in a worktree, so a delete issued earlier would fail on
# exactly the branch it was meant to reap (issue #84).
#
# `rev-parse --verify --quiet` answers a missing ref with an empty stdout, exit
# 1 and no stderr, so "missing" and "git failed" are told apart by the stderr
# and nowhere else. Folding both into an empty tip reported a branch as `absent`
# while it was still there, on exactly the transient a sibling's ref lock
# produces (issue #131 review).
TIP=""
TIP_ERR=""
tip_err_file=$(mktemp 2>/dev/null) || die "cannot create a temporary file"
trap 'rm -f "$tip_err_file"' EXIT

read_tip() {
  TIP=""
  TIP_ERR=""
  : > "$tip_err_file"
  _st=0
  TIP=$(git -C "$REPO_ROOT" rev-parse --verify --quiet "$1" 2>"$tip_err_file") || _st=$?
  if [ "$_st" -ne 0 ]; then
    TIP=""
    TIP_ERR=$(tr '\n' ' ' < "$tip_err_file")
  fi
}

spoke() { case "$1" in *[![:space:]]*) return 0 ;; *) return 1 ;; esac; }

read_tip "refs/heads/$BRANCH"
local_tip=$TIP
local_err=$TIP_ERR
read_tip "refs/remotes/origin/$BRANCH"
origin_tip=$TIP
origin_err=$TIP_ERR

branch_action="absent"
branch_reason="no-local-branch"
if spoke "$local_err" || spoke "$origin_err"; then
  branch_action="left"
  branch_reason="tip-read-failed"
  note_error "rev-parse failed: ${local_err}${origin_err}"
  note_left "$BRANCH"
elif [ -n "$local_tip" ]; then
  if [ -z "$origin_tip" ]; then
    branch_action="left"
    branch_reason="no-remote-tracking-ref"
    note_left "$BRANCH"
  elif [ "$local_tip" != "$origin_tip" ]; then
    branch_action="left"
    branch_reason="tip-not-on-origin"
    note_left "$BRANCH"
  elif branch_err=$(git -C "$REPO_ROOT" branch -D "$BRANCH" 2>&1); then
    branch_action="deleted"
    branch_reason="tip-on-origin"
  else
    branch_action="left"
    branch_reason="delete-failed"
    note_error "branch -D failed: $branch_err"
    note_left "$BRANCH"
  fi
fi

# `--rawfile`-free on purpose: the two lists are newline-delimited strings
# built above, and jq splits them, so an empty list is `[]` rather than `[""]`.
jq -n \
  --arg repo_root "$REPO_ROOT" \
  --arg branch "$BRANCH" \
  --arg work "$WORK" \
  --arg worktree_path "$WORKTREE" \
  --arg worktree_action "$worktree_action" \
  --arg work_action "$work_action" \
  --arg branch_action "$branch_action" \
  --arg branch_reason "$branch_reason" \
  --arg local_tip "$local_tip" \
  --arg origin_tip "$origin_tip" \
  --arg left "$left" \
  --arg errors "$errors" '
  def lines: split("\n") | map(select(length > 0));
  {
    repo_root: $repo_root,
    branch: $branch,
    work: $work,
    worktree: {path: $worktree_path, action: $worktree_action},
    work_dir: {path: $work, action: $work_action},
    branch_ref: {
      action: $branch_action,
      reason: $branch_reason,
      local_tip: (if $local_tip == "" then null else $local_tip end),
      origin_tip: (if $origin_tip == "" then null else $origin_tip end)
    },
    left_behind: ($left | lines),
    errors: ($errors | lines)
  }'

[ -z "$errors" ] || exit 1
