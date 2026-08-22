#!/usr/bin/env bash
# require-linked-worktree.sh — refuse to act anywhere but inside a linked
# git worktree
#
# Usage: require-linked-worktree.sh [context]
# Exit:  0 when the current directory is inside a linked worktree
#        1 otherwise, with {"error": "..."} on stderr
#
# Cwd-sensitive work (a mutating adapter verb, a check run that drops a log)
# must land in the fix worktree and nowhere else. A lost cwd is not
# hypothetical: no Bash call inherits the previous one's, and a live run
# bumped a package in a real repository that way (issue #18).
#
# The requirement is "inside a LINKED worktree", which is stricter than the
# ".git is a file, not a directory" test this replaces. That test passed in
# any subdirectory of the user's checkout (`.git` is neither file nor
# directory there), in a monorepo package directory, and in a git submodule,
# whose `.git` is also a file.
#
# So the check resolves the enclosing repository top by walking up to the
# first `.git`, then classifies it. These are the gitdir pointers git actually
# writes, verified against real repositories rather than assumed:
#
#   .git is a directory                                  primary checkout, refuse
#   gitdir: /abs/main/.git/worktrees/wt                   linked worktree, proceed
#   gitdir: /abs/bare.git/worktrees/wt                    linked worktree of a
#                                                         bare clone, proceed
#   gitdir: ../.git/modules/sub                           submodule, refuse
#   gitdir: ../../.git/modules/pkgs/deep                  submodule, refuse
#   gitdir: ../../main/.git/worktrees/wt/modules/sub      submodule checked out
#                                                         inside a worktree, refuse
#   no .git found anywhere above                          not a repository, refuse
#
# Two things the earlier unanchored `*/modules/*` test got wrong, both real:
#
#   * a submodule's pointer is RELATIVE (`../.git/modules/sub`), not absolute;
#   * a perfectly ordinary worktree of a repo that happens to live under a
#     directory named `modules` (`/src/modules/app/.git/worktrees/fix`) was
#     diagnosed as a submodule and refused.
#
# So the markers are matched with their `/` separators and the decision is made
# on which one comes LAST, since a submodule inside a linked worktree carries
# both and is still a submodule. The extra `.git/modules/` probe covers the
# reverse pathology, a submodule whose path begins with `worktrees/`
# (`../.git/modules/worktrees/foo`), where the last marker lies. Ambiguity only
# ever resolves toward refusing.
#
# The walk is plain file inspection rather than `git rev-parse` so the
# guard keeps working when git is missing or the cwd is a scratch directory,
# and so it stays testable without building a real repository per example.
#
# Callers invoke this script instead of sourcing a shared function, so one
# implementation serves every guard with no drift: `ecosystems/node.sh` gates
# its mutating verbs with it, and any script that starts writing joins them.

set -uo pipefail

CONTEXT="${1:-refusing to run here}"

refuse() {
  printf '{"error":%s}\n' \
    "$(printf '%s: %s. Create the fix worktree with git worktree add and run the command as: cd <worktree> && <command>.' \
       "$CONTEXT" "$1" | jq -Rs .)" >&2
  exit 1
}

top=""
dir=$PWD
while :; do
  if [ -e "$dir/.git" ]; then
    top=$dir
    break
  fi
  parent=$(dirname "$dir")
  [ "$parent" = "$dir" ] && break
  dir=$parent
done

[ -n "$top" ] || refuse "no git repository at or above $PWD"

if [ -d "$top/.git" ]; then
  if [ "$top" = "$PWD" ]; then
    refuse "this is a primary checkout ($top/.git is a directory)"
  fi
  refuse "this is a subdirectory of the primary checkout at $top"
fi

gitdir=""
first_line=""
IFS= read -r first_line < "$top/.git" || true
case "$first_line" in
  "gitdir: "*) gitdir=${first_line#gitdir: } ;;
esac
[ -n "$gitdir" ] || refuse "$top/.git is not a readable git worktree pointer"

submodule() { refuse "this is a git submodule (its gitdir is $gitdir)"; }

# A trailing `/` so the last path segment can be tested as a marker too, and so
# a worktree or submodule whose own NAME is `modules` never reads as one.
probe="$gitdir/"

case "$probe" in
  */worktrees/*)
    # Everything after the last `/worktrees/`: a `modules/` in there is a
    # submodule nested inside this worktree.
    case "${probe##*/worktrees/}" in
      */modules/*) submodule ;;
    esac
    # And a submodule whose path starts with `worktrees/` puts the last marker
    # in the wrong place; its gitdir is still anchored at `.git/modules/`.
    case "$probe" in
      *.git/modules/*) submodule ;;
    esac
    exit 0
    ;;
  *.git/modules/*) submodule ;;
  *)               refuse "$top is not a linked worktree (its gitdir is $gitdir)" ;;
esac
