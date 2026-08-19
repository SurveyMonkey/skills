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
# first `.git`, then classifies it:
#
#   .git directory                 -> primary checkout, refuse
#   .git file, gitdir .../modules/ -> submodule of somebody's checkout, refuse
#   .git file, gitdir .../worktrees/ -> linked worktree, proceed
#   nothing found                  -> not a repository at all, refuse
#
# `git worktree add` writes a gitdir pointing into `<main>/.git/worktrees/<name>`,
# while a submodule's points into `<parent>/.git/modules/<name>`; that is the
# one byte-level difference between the two, and it is what separates them
# here. The walk is plain file inspection rather than `git rev-parse` so the
# guard keeps working when git is missing or the cwd is a scratch directory,
# and so it stays testable without building a real repository per example.
#
# Both callers invoke this script instead of sourcing a shared function:
# `ecosystems/node.sh` gates its mutating verbs with it, `common/run-check.sh`
# gates every check run. One implementation, no drift.

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

# Order matters: a submodule checked out inside a linked worktree has both
# markers in its gitdir, and it is still a submodule.
case "$gitdir" in
  */modules/*)   refuse "this is a git submodule (its gitdir is $gitdir)" ;;
  */worktrees/*) exit 0 ;;
  *)             refuse "$top is not a linked worktree (its gitdir is $gitdir)" ;;
esac
