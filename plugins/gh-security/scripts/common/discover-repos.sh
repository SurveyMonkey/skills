#!/usr/bin/env bash
# discover-repos.sh — list the repository checkouts a target directory holds
#
# Usage: discover-repos.sh [path]      (defaults to $PWD; a relative path
#                                       resolves against $PWD)
# Output: {target, repos}
#
# Scope comes from the target, so no caller has to classify it:
#
#   - the target is inside a git repo -> that repo's checkout root
#   - the target is not a git repo    -> every immediate subdirectory that is
#                                        the root of a checkout, non-recursively
#
# Subdirectories that are not git repos, and subdirectories that are merely
# *inside* a repo rather than its root, are skipped without comment.
#
#   ~/projects/example-repo/src   (inside a checkout)
#                                 -> ["~/projects/example-repo"]
#   ~/projects                    (holding two checkouts and a scratch folder)
#                                 -> ["~/projects/app", "~/projects/lib"]
#
# **Nothing is ever cloned.** The repos in scope are the checkouts already on
# disk; a repository the user has not checked out is not in scope, and this
# script never reaches the network to discover, enumerate or fetch one.
#
# **Every error exits 1 with `{"error": ...}` on stderr and nothing on stdout**,
# so a caller that parses stdout never reads a failure as a scope. Both tools
# the contract depends on are preflighted for that reason — a missing `jq`
# otherwise exits 127 with a bash error, which is not the contract either.
#
# A target that is not a directory is an **error**. A target with no
# repositories in it is not: it yields an empty list and exit 0, because "this
# directory holds no checkouts" is an answer.
#
# **An unreadable directory is an error too, never "no repositories"** — the
# target itself, and equally an immediate child that cannot be entered.
# Answering the second question when the first was asked returns a result
# indistinguishable from a tidy, empty workspace. The target is checked for
# read and traverse permission up front and named as such; a child that cannot
# be entered is reported with the message the shell itself printed.
#
# **A git failure is classified, never read as "there is no repository here".**
# Only git's own `not a git repository` is that answer (matched
# case-insensitively on the leading letter: git capitalized it before 2.18);
# dubious ownership (`safe.directory`), a `.git` with no traverse permission, a
# checkout missing `HEAD`, a pointer file naming a gitdir that is gone, a git
# directory handed in as the path, and git missing from `PATH` are all errors,
# and each error names git's exit status beside its message, because git can
# fail with nothing on stderr at all. Each of those otherwise came back as an
# empty list and exit 0, which is the same failure as the unreadable directory
# wearing git's clothes.
#
# **"Not a git repository" is believed only when no `.git` exists at or above
# the path on the path's own filesystem**, so the walk climbs rather than
# stopping at the path itself: a target *below* a broken checkout (`repo/src`,
# where `repo/.git` has no `HEAD`) got the same words as a plain directory and
# reported its holder empty. It stops where git's own discovery stops, at a
# mount point: a checkout on the far side of one (a versioned home directory
# holding a mounted volume) is one git never examined and never failed in, so
# it is not blamed, while a broken checkout on the near side is still caught.
# A dangling `.git` symlink counts as present — `-e` follows the link and
# answers false for one, which is a broken checkout, not an absent one.
#
# The git environment is stripped for the same reason: `GIT_DIR`,
# `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES` and
# `GIT_DISCOVERY_ACROSS_FILESYSTEM` each let the answer come out of the
# environment instead of the target. An ambient `GIT_DIR` makes *any* directory
# answer that repository's toplevel; an ambient `GIT_CEILING_DIRECTORIES`
# covering the enclosing checkout makes a directory inside it answer as though
# it were in no repository at all.
#
# Paths are symlink-resolved, because git reports resolved paths and callers
# compare against them (on macOS `/tmp` and `/var` are both symlinks, so an
# unresolved target and git's own answer disagree about the same directory).
#
# **Identity is compared with `-ef`, and every emitted path is git's own.** On
# a case-insensitive or Unicode-normalizing filesystem — APFS by default — the
# caller's spelling and the spelling on disk are two names for one directory,
# and a string compare against git's toplevel makes a target typed as `holder`
# for an on-disk `Holder` answer with no repositories at all. `-ef` compares
# device and inode, which is the question actually being asked. For the same
# reason the resolved target is taken from the external `/bin/pwd -P`, which
# calls `getcwd` and so reports the on-disk spelling, rather than from the
# shell builtin, which echoes the caller's.
#
# **A symlinked child is followed**, because organizing checkouts through links
# is a workspace the user meant to build. What is listed is the **resolved**
# root, so two links to one checkout collapse to one entry and a link whose
# target lives outside the directory is still listed under the path it
# resolves to. The list is sorted by those emitted paths, not by the link
# names the glob saw. A link into a checkout's *subdirectory* is not a
# checkout root and is skipped like any other non-root directory.
#
# **A child whose resolved path contains a newline is refused**, rather than
# listed: the roots are collected one per line to be sorted, and such a path
# split into two entries neither of which is a repository.
#
# A **linked worktree** is a checkout root in its own right — it has its own
# toplevel, as `detect-scope.sh` says — so it is listed both as a child of the
# target and as the target's own answer.
#
# Dot-directories are skipped: the glob in the loop below does not match a
# leading dot without `dotglob`, by design, and a checkout parked under one
# (`.claude/worktrees/...`) is infrastructure rather than a workspace entry. A
# **bare** repository is skipped as well, for the reason `detect-scope.sh`
# answers a null scope for one: `rev-parse --show-toplevel` fails without a
# work tree, and there is no tree to branch, install or validate in. It is
# skipped by whichever of the two refusals git raises for it — the work-tree
# one, or `safe.bareRepository=explicit`'s outright refusal to use it.

set -euo pipefail

# Sorting is part of the contract, so the collation is pinned rather than
# inherited: the `sort -u` below orders the emitted paths by LC_COLLATE, which
# differs between a user's shell and CI. It also keeps git's own messages in
# English, which is what the failure classification matches on.
export LC_ALL=C

# Each of these lets the environment answer instead of the target (header).
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_CEILING_DIRECTORIES \
  GIT_DISCOVERY_ACROSS_FILESYSTEM

# The one JSON this script does not build with jq, because it is what a missing
# jq has to say: a fixed literal carrying no path, no git output and no other
# caller data, so there is nothing in it for a quote to break. Everything after
# this point goes through `die`.
if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' '{"error":"jq is required by discover-repos.sh but is not on PATH"}' >&2
  exit 1
fi

# Every error speaks the {"error": ...} contract through jq rather than a
# printf interpolation: a double quote in a path would otherwise emit invalid
# JSON at exactly the moment the caller needs to parse the failure.
die() {
  jq -nc --arg m "$1" '{error: $m}' >&2
  exit 1
}

# Preflight so a missing git is named as such. Without it the first call
# below fails with exit 127 and bash's own `command not found` text, which the
# generic `git failed` error would relay, correctly but obscurely.
command -v git >/dev/null 2>&1 || die "git is required but was not found on PATH"

# One scratch file for the stderr of everything whose message is reported
# rather than guessed at: git's, and the shell's own for a failed `cd`.
ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

TARGET="${1:-$PWD}"
GIVEN="$TARGET"
case "$TARGET" in
  /*) ;;
  *) TARGET="$PWD/$TARGET" ;;
esac

# A missing path and a regular file are the same answer: there is no directory
# here to look in. The path is echoed as the caller gave it, which is what they
# have to correct.
if [ ! -d "$TARGET" ]; then
  die "not a directory: $GIVEN"
fi

# Read and traverse permission, checked before anything that would silently
# come back empty without them (see the header).
if [ ! -r "$TARGET" ] || [ ! -x "$TARGET" ]; then
  die "could not read $TARGET: permission denied"
fi

# `/bin/pwd -P`, not the builtin: the builtin echoes the spelling the caller
# typed, and only `getcwd` reports the one on disk (header).
RESOLVED=$({ cd -P "$TARGET" && /bin/pwd -P; } 2>"$ERR_FILE") \
  || die "could not enter $TARGET: $(cat "$ERR_FILE")"

# Ask git for a path's checkout root, and classify a failure instead of reading
# every failure as "there is no repository here".
#
# Sets GIT_TOPLEVEL and returns 0 when the path is inside a checkout with a
# work tree. Returns 1 only for the two shapes git can legitimately answer "no"
# about: a directory in no repository at all, and a bare repository. Every
# other failure dies.
#
# The answer travels in a global because `die` has to run in the caller's own
# shell — inside `$( )` an exit ends the subshell only, and the classification
# would come back as an empty toplevel.
GIT_TOPLEVEL=""

# The filesystem a path sits on, as `df` names its source device, or empty
# when `df` cannot say. POSIX `df -P`, because the BSD and GNU `stat` flags
# for the same fact disagree.
fs_of() {
  df -P -- "$1" 2>/dev/null | awk 'NR == 2 { print $1 }'
}

# The nearest `.git` at or above a path, in `dotgit_at`, or return 1. `-L`
# beside `-e` because `-e` follows a symlink and so answers false for a
# dangling one, which is a broken checkout rather than an absent one (header).
#
# The walk never leaves the path's own filesystem. Git's discovery does not
# cross a mount point either, so an ancestor on another device is one git
# never looked at, and a healthy checkout there (a versioned home directory
# above a mounted volume) is not what failed. A device `df` cannot name is
# treated as the same one, which keeps the walk going rather than stopping
# early: stopping early is the silent-skip direction.
dotgit_at=""
find_dotgit_upward() {
  dotgit_at=""
  walk="$1"
  walk_fs=$(fs_of "$walk")
  while :; do
    if [ -e "$walk/.git" ] || [ -L "$walk/.git" ]; then
      dotgit_at="$walk"
      return 0
    fi
    [ "$walk" = "/" ] && return 1
    parent="${walk%/*}"
    [ -n "$parent" ] || parent="/"
    parent_fs=$(fs_of "$parent")
    if [ -n "$walk_fs" ] && [ -n "$parent_fs" ] && [ "$walk_fs" != "$parent_fs" ]; then
      return 1
    fi
    walk="$parent"
  done
}

git_toplevel() {
  GIT_TOPLEVEL=""
  git_st=0
  GIT_TOPLEVEL=$(git -C "$1" rev-parse --show-toplevel 2>"$ERR_FILE") || git_st=$?
  if [ "$git_st" -eq 0 ]; then
    return 0
  fi
  GIT_TOPLEVEL=""
  git_msg=$(cat "$ERR_FILE")
  case "$git_msg" in
    *[Nn]"ot a git repository"*)
      # The ordinary answer for a plain directory — and the very same words
      # for a checkout whose `.git` git could not read: a missing `HEAD`, a
      # `.git` with no traverse permission, a pointer file naming a gitdir
      # that is gone. A `.git` that is present and unreadable is a broken
      # checkout, and dropping it silently is how a repository in scope
      # disappears from the list. The search runs upward because the path
      # handed in may sit *below* the broken checkout, and stops at the
      # path's own filesystem boundary because git's discovery stopped there
      # too (the helper says why).
      if find_dotgit_upward "$1"; then
        die "git failed in $dotgit_at (exit $git_st): $git_msg"
      fi
      return 1
      ;;
    *"must be run in a work tree"*)
      # A bare repository and a git directory handed in as the path say the
      # same thing here, so bare-ness is asked for rather than inferred. Bare
      # is skipped (header); a git directory whose work tree is elsewhere is
      # the caller pointing at the wrong path.
      git_bare=$(git -C "$1" rev-parse --is-bare-repository 2>/dev/null || printf 'no')
      if [ "$git_bare" = "true" ]; then
        return 1
      fi
      die "git failed in $1 (exit $git_st): $git_msg"
      ;;
    *"cannot use bare repository"*)
      # `safe.bareRepository=explicit` refuses a bare repository before it can
      # be asked anything about itself, so this is the same skip the work-tree
      # route reaches — git has already named the shape.
      return 1
      ;;
  esac
  die "git failed in $1 (exit $git_st): $git_msg"
}

# The character the roots list cannot carry, held in a variable so the `case`
# pattern below reads as what it tests.
NEWLINE='
'

repos=()
if git_toplevel "$RESOLVED"; then
  # Inside a checkout, at its root or anywhere below it: one repo, the root.
  repos+=("$GIT_TOPLEVEL")
else
  # Not in a repository, so the target is a directory that may *hold* some.
  # Only immediate children, and only ones that are a checkout root in their
  # own right: a directory that merely sits inside some enclosing repository
  # answers that repository's toplevel, which is not this entry.
  #
  # Roots are collected as lines and sorted with duplicates collapsed at the
  # end, because the glob's order is the order of the *names on disk* while
  # the contract is about the resolved paths actually emitted — two links to
  # one checkout are one entry, and a link out of the directory sorts where
  # its target is (header).
  resolved_roots=""
  for entry in "$RESOLVED"/*/; do
    [ -d "$entry" ] || continue
    sub="${entry%/}"
    # Tested on the name the glob saw, not on a resolved copy: command
    # substitution strips trailing newlines, so a name ending in one would
    # pass a check on `sub_resolved` and then fail the `-ef` compare silently.
    case "$sub" in
      *"$NEWLINE"*)
        die "could not list $sub: a path containing a newline cannot be listed one per line"
        ;;
    esac
    # The builtin is enough here, unlike the target's: this value is only ever
    # compared, with `-ef`, and never emitted.
    sub_resolved=$({ cd -P "$sub" && pwd -P; } 2>"$ERR_FILE") \
      || die "could not enter $sub: $(cat "$ERR_FILE")"
    git_toplevel "$sub" || continue
    # `-ef`, not a string compare: on a case-insensitive or normalizing
    # filesystem the two spellings of one directory differ as strings and the
    # child would be dropped (header). What is emitted is git's own spelling.
    [ "$GIT_TOPLEVEL" -ef "$sub_resolved" ] || continue
    resolved_roots="${resolved_roots}${GIT_TOPLEVEL}"$'\n'
  done

  if [ -n "$resolved_roots" ]; then
    while IFS= read -r root; do
      [ -n "$root" ] || continue
      repos+=("$root")
    done <<<"$(printf '%s' "$resolved_roots" | sort -u)"
  fi
fi

# The empty case is split out rather than expanded: under `set -u`, bash 3.2
# errors on "${repos[@]}" for an empty array.
if [ ${#repos[@]} -eq 0 ]; then
  jq -n --arg target "$RESOLVED" '{target: $target, repos: []}'
else
  jq -n --arg target "$RESOLVED" \
    '{target: $target, repos: $ARGS.positional}' --args "${repos[@]}"
fi
