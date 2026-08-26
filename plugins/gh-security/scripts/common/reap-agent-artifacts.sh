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
# Idempotent: a second run over the same group finds nothing and succeeds
# reporting `absent` for every artifact.
#
# Exit: 1 when an artifact was meant to come off and could not. The report is
# emitted on stdout first either way, like the adapter's `validate`. A
# deliberate leave (a branch tip that is not on origin) is a correct outcome
# and exits 0 with the reason in `branch_ref`.

set -euo pipefail

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
# halfway through a delete.
git check-ref-format "refs/heads/$BRANCH" 2>/dev/null \
  || die "not a valid branch name: $BRANCH"

# Both sides are resolved through the filesystem before they are compared, so
# a caller that spelled `repo_root` through a symlink (macOS `/var` really
# being `/private/var` is the everyday case) still matches the containment
# guard below. `$WORK` may already be gone, which is the idempotent success
# case, so resolution walks up to the deepest ancestor that does exist and
# re-appends the rest; resolving only its immediate parent would fail the
# guard on a second run that finds `.claude/worktrees/` itself already gone.
resolve_path() {
  _p=$1
  _suffix=""
  while [ ! -d "$_p" ]; do
    _suffix="/$(basename "$_p")$_suffix"
    _parent=$(dirname "$_p")
    [ "$_parent" != "$_p" ] || break
    _p=$_parent
  done
  printf '%s%s\n' "$( ( cd "$_p" 2>/dev/null && pwd -P ) || printf '%s' "$_p" )" "$_suffix"
}

REPO_ROOT=$(resolve_path "$REPO_ROOT")
WORK=$(resolve_path "$WORK")

# The containment guard. This script runs `rm -rf` on `$WORK`, so the one path
# it accepts is a directory *under* that repository's own agent worktree root,
# never the root itself and never anything reached through a `..` segment.
case "$WORK" in
  *"/../"* | */..) die "work path must not contain a .. segment: $WORK" ;;
esac
case "$WORK" in
  "$REPO_ROOT/.claude/worktrees/"?*) ;;
  *) die "work path is not under $REPO_ROOT/.claude/worktrees/: $WORK" ;;
esac

WORKTREE="$WORK/fix"

errors=""
left=""
note_error() { errors="$errors$1
"; }
note_left() { left="$left$1
"; }

# --- the git worktree ------------------------------------------------------
#
# A checked-out worktree carries a `.git` pointer file, so its presence is what
# tells a live registration apart from a plain leftover directory, with no need
# to read the repository's worktree list (whose recorded paths normalize
# differently again). A live one must come off through git; a plain directory
# is covered by the `rm -rf` below.
worktree_action="absent"
if [ -e "$WORKTREE/.git" ]; then
  if worktree_err=$(git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" 2>&1); then
    worktree_action="removed"
  else
    worktree_action="failed"
    note_error "worktree remove failed: $worktree_err"
    note_left "$WORKTREE"
  fi
elif [ -d "$WORKTREE" ]; then
  worktree_action="not-a-worktree"
fi

# --- the $WORK directory ---------------------------------------------------
#
# Skipped outright when the worktree is still registered: removing the
# directory out from under a live registration turns a reportable leftover
# into a broken one.
work_action="absent"
if [ "$worktree_action" = "failed" ]; then
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
fi

# --- the local branch ------------------------------------------------------
#
# Order matters: the worktree comes off first. Git refuses to delete a branch
# that is checked out in a worktree, so a delete issued earlier would fail on
# exactly the branch it was meant to reap (issue #84).
local_tip=$(git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$BRANCH" 2>/dev/null || true)
origin_tip=$(git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" 2>/dev/null || true)

branch_action="absent"
branch_reason="no-local-branch"
if [ -n "$local_tip" ]; then
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
