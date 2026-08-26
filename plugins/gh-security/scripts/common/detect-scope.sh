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
#
# **Only a host-bearing URL yields an nwo**, and only when its path is exactly
# two segments. GitHub NWOs are exactly two segments; a deeper path is not a
# GitHub repository, and a local path, a `file://` URL or a relative `../`
# remote names no host at all. All of those answer null rather than the last
# two path segments of whatever they are: a fabricated `src/other-repo` reads
# downstream as a real repository, and the only stop condition left is a null
# nwo.
#
# A **bare** repository answers a null scope, deliberately: `rev-parse
# --show-toplevel` fails without a work tree, and there is no tree for an
# agent to branch, install or validate in. A **linked worktree** is the
# opposite case and answers `repo`: it has its own toplevel and shares the
# repository's `origin`.

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

  # Split the URL into a host and a path, and demand both. Two forms carry a
  # host: `scheme://[user[:pass]@]host[:port]/owner/name`, and the scp-style
  # `[user@]host:owner/name` that also covers an ssh-config alias
  # (`gh-alias:owner/name`). Anything else — a local path, a `file://` URL, a
  # relative `../sibling` — has no host and yields no nwo. Then the path must
  # be exactly two segments: taking the last two of a deeper path is how
  # `https://host/a/b/c` becomes a plausible, wrong `b/c`.
  url="${git_remote%/}"
  url="${url%.git}"
  url="${url%/}"
  host=""
  url_path=""
  case "$url" in
    *://*)
      rest="${url#*://}"
      case "$rest" in
        */*)
          host="${rest%%/*}"
          url_path="${rest#*/}"
          ;;
      esac
      ;;
    *:*)
      host="${url%%:*}"
      url_path="${url#*:}"
      # A colon inside a path (`/tmp/we:ird/a/b`) is not a host separator.
      case "$host" in
        */*) host="" ;;
      esac
      ;;
  esac
  host="${host##*@}"   # drop any credentials
  host="${host%%:*}"   # drop any port
  case "$url_path" in
    */*/*) ;;          # three segments or more: not a GitHub repository
    */*)
      owner="${url_path%%/*}"
      repo="${url_path#*/}"
      ;;
  esac
  if [ -z "$host" ] || [ -z "$owner" ] || [ -z "$repo" ]; then
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
