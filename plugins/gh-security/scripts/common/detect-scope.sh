#!/usr/bin/env bash
# detect-scope.sh — map a working directory to an alert-discovery scope
#
# Usage: detect-scope.sh [path]        (defaults to $PWD)
# Output: {scope, owner, repo, path, git_remote}
#
# The workspace convention is one `@`-prefixed directory per GitHub owner, with
# repositories checked out inside it. Owner directories may nest (an umbrella
# `@org/` containing several `@sub-org/` directories), so the *innermost*
# `@`-segment is the owner and the next non-`@` segment is the repository.
#
#   ~/Code/@momentive_emu/@mntv-analysis/analysis-web -> repo  mntv-analysis/analysis-web
#   ~/Code/@SurveyMonkey/skills                       -> repo  SurveyMonkey/skills
#   ~/Code/@SurveyMonkey                              -> org   SurveyMonkey
#   ~/Code                                            -> user  <authenticated login>
#
# Phase 1 consumes only repo scope. Org and user are classified now so Phase 3
# (issue #6) inherits the mapping rather than reimplementing it.

set -euo pipefail

TARGET="${1:-$PWD}"
case "$TARGET" in
  /*) ;;
  *) TARGET="$PWD/$TARGET" ;;
esac

# Walk the path segments, remembering the last `@`-prefixed one and whatever
# followed it. Reading left to right means the last match wins, which is the
# innermost owner directory.
owner=""
repo=""
saved_ifs="$IFS"
IFS="/"
for segment in $TARGET; do
  [ -n "$segment" ] || continue
  case "$segment" in
    @*)
      owner="${segment#@}"
      repo=""
      ;;
    *)
      # Only the segment immediately following the owner is the repository.
      # Anything deeper is a subdirectory of that repository.
      if [ -n "$owner" ] && [ -z "$repo" ]; then
        repo="$segment"
      fi
      ;;
  esac
done
IFS="$saved_ifs"

if [ -n "$owner" ] && [ -n "$repo" ]; then
  scope="repo"
elif [ -n "$owner" ]; then
  scope="org"
else
  scope="user"
  # No owner directory in the path, so the only sensible owner is whoever the
  # active gh session belongs to. Non-fatal: report null and let the caller
  # decide, rather than failing a scope lookup on a network hiccup.
  owner=$(gh api user --jq '.login' 2>/dev/null || printf '')
fi

# Local, no network. A cross-check for the caller: if the path convention and
# the actual remote disagree, the path convention is probably wrong.
git_remote=$(git -C "$TARGET" remote get-url origin 2>/dev/null || printf '')

jq -n \
  --arg scope "$scope" \
  --arg owner "$owner" \
  --arg repo "$repo" \
  --arg path "$TARGET" \
  --arg remote "$git_remote" \
  '{
     scope: $scope,
     owner: (if $owner == "" then null else $owner end),
     repo:  (if $repo  == "" then null else $repo  end),
     nwo:   (if $owner != "" and $repo != "" then "\($owner)/\($repo)" else null end),
     path: $path,
     git_remote: (if $remote == "" then null else $remote end)
   }'
