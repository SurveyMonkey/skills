#!/usr/bin/env bash
# detect-scope.sh — decide whether a path is inside a git repository, and say which
#
# Usage: detect-scope.sh [path]        (defaults to $PWD)
# Output: {scope, owner, repo, nwo, path, git_remote, default_branch}
#
# Scope comes from git, never from what the directories are named. Inside a
# repository (`git rev-parse --show-toplevel` succeeds) the scope is always
# `repo`, and `nwo` is parsed from `origin`'s remote URL as the only source:
# the remote is the fact, and a directory layout is at best a convention of
# one workspace.
#
#   ~/Code/@example-org/example-repo   (origin git@github.com:example-org/example-repo.git)
#                                      -> repo   example-org/example-repo
#   ~/projects/example-repo            (origin https://github.com/octo/app)
#                                      -> repo   octo/app
#   ~/projects                         (no repository at or above it)
#                                      -> scope null
#
# **A null `scope` is an answer, not an error** (exit stays 0): the path is in
# no repository, so there is nothing to infer, and the caller asks the user
# what to operate on — an org, a user, or a named repo. Guessing org versus
# user from directory names is exactly what this script no longer does.
#
# `owner`, `repo` and `nwo` are also null inside a repository with no `origin`
# remote, or one whose URL yields no `<owner>/<name>` pair. The scope is still
# `repo`: being in a checkout is a fact about git, independent of whether the
# checkout has a remote the caller can reach.

set -euo pipefail

TARGET="${1:-$PWD}"
case "$TARGET" in
  /*) ;;
  *) TARGET="$PWD/$TARGET" ;;
esac

# The whole scope decision. A path outside every repository, and a path that
# does not exist at all, both land here as "not a repository".
if git -C "$TARGET" rev-parse --show-toplevel >/dev/null 2>&1; then
  scope="repo"
else
  scope=""
fi

owner=""
repo=""
git_remote=""
default_branch=""

if [ -n "$scope" ]; then
  # Local, no network.
  git_remote=$(git -C "$TARGET" remote get-url origin 2>/dev/null || printf '')

  # Reduce every URL form to `<owner>/<name>`: strip a trailing slash and a
  # trailing `.git`, drop any `scheme://`, drop everything through the first
  # colon (the scp-style `git@host:owner/name`, and a `host:port` prefix in a
  # ssh URL), then take the last two path segments. Anything that does not
  # yield two segments leaves owner and repo empty rather than guessing.
  url="${git_remote%/}"
  url="${url%.git}"
  url="${url%/}"
  case "$url" in
    *://*) url="${url#*://}" ;;
  esac
  case "$url" in
    *:*) url="${url#*:}" ;;
  esac
  case "$url" in
    */*)
      repo="${url##*/}"
      rest="${url%/*}"
      owner="${rest##*/}"
      ;;
  esac
  if [ -z "$owner" ] || [ -z "$repo" ]; then
    owner=""
    repo=""
  fi

  # Origin's default branch. Local symref first (set by clone; no network),
  # then `remote show` as the network fallback for checkouts where origin/HEAD
  # was never recorded. Null when both fail — callers that need it must stop,
  # not guess. Resolved here rather than in caller prose so no agent prompt
  # carries a shell pipeline for it.
  default_branch=$(git -C "$TARGET" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
    | sed 's@^refs/remotes/origin/@@' || printf '')
  if [ -z "$default_branch" ] && [ -n "$git_remote" ]; then
    default_branch=$(git -C "$TARGET" remote show origin 2>/dev/null \
      | sed -n 's/.*HEAD branch: //p' || printf '')
  fi
fi

jq -n \
  --arg scope "$scope" \
  --arg owner "$owner" \
  --arg repo "$repo" \
  --arg path "$TARGET" \
  --arg remote "$git_remote" \
  --arg default_branch "$default_branch" \
  '{
     scope: (if $scope == "" then null else $scope end),
     owner: (if $owner == "" then null else $owner end),
     repo:  (if $repo  == "" then null else $repo  end),
     nwo:   (if $owner != "" and $repo != "" then "\($owner)/\($repo)" else null end),
     path: $path,
     git_remote: (if $remote == "" then null else $remote end),
     default_branch: (if $default_branch == "" then null else $default_branch end)
   }'
