#!/usr/bin/env bash
# ensure-worktree-exclude.sh — keep the agents' worktree directory out of
# `git status`, once per repository, before any agent is dispatched
#
# Usage: ensure-worktree-exclude.sh <repo_root>
# Output: {repo_root, exclude_path, line, action}
#         action is "already-present" or "added"
#
# Agents used to append this line themselves in their own phase 1. Two agents
# dispatched in ONE message start within milliseconds of each other — the
# orchestrator's required dispatch pattern — so a read-then-append from both
# could duplicate the line or interleave a partial write; `.git/info/exclude`
# has no locking discipline of its own (issue #35). The orchestrator already
# knows the repo set, so writing the line here, before the wave, removes the
# race by construction instead of narrowing it.
#
# It is also idempotent and safe on its own account: the read-modify-write
# runs under a `mkdir` lock and publishes with a single rename, so even
# several of these racing leave one line and no torn file.
#
# `--git-common-dir` rather than `<repo_root>/.git`: the path must resolve to
# the SHARED git directory, since `.git/info/exclude` is repository-wide and a
# linked worktree's own gitdir is not.

set -euo pipefail

LINE='.claude/worktrees/'

REPO_ROOT="${1:-}"
if [ -z "$REPO_ROOT" ]; then
  printf '{"error":"Usage: ensure-worktree-exclude.sh <repo_root>"}\n' >&2
  exit 1
fi
if [ ! -d "$REPO_ROOT" ]; then
  printf '{"error":"repo_root does not exist: %s"}\n' "$REPO_ROOT" >&2
  exit 1
fi

if ! common_dir=$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null); then
  printf '{"error":"not a git repository: %s"}\n' "$REPO_ROOT" >&2
  exit 1
fi
case "$common_dir" in
  /*) ;;
  *) common_dir="$REPO_ROOT/$common_dir" ;;
esac

INFO_DIR="$common_dir/info"
EXCLUDE="$INFO_DIR/exclude"

emit() {
  jq -n --arg root "$REPO_ROOT" --arg path "$EXCLUDE" \
        --arg line "$LINE" --arg action "$1" \
    '{repo_root: $root, exclude_path: $path, line: $line, action: $action}'
}

has_line() { [ -f "$EXCLUDE" ] && grep -Fqx "$LINE" "$EXCLUDE"; }

if has_line; then
  emit already-present
  exit 0
fi

mkdir -p "$INFO_DIR"
LOCK="$INFO_DIR/.exclude.gh-security.lock"

# The rename below is atomic, but read-then-rewrite as a whole is not: two
# callers can both read a file without the line and the second's rename then
# publishes a copy carrying it twice. `mkdir` is the portable atomic test-and-
# set, so the whole sequence runs under it.
acquired=0
attempt=0
while [ "$attempt" -lt 50 ]; do
  if mkdir "$LOCK" 2>/dev/null; then
    acquired=1
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
    break
  fi
  # A lock left behind by a killed process would otherwise block every later
  # run forever. Nothing here holds it for anywhere near a minute.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
  fi
  sleep 0.1
  attempt=$((attempt + 1))
done

if [ "$acquired" -eq 0 ]; then
  printf '{"error":"could not acquire %s"}\n' "$LOCK" >&2
  exit 1
fi

# Another holder may have written it while we waited.
if has_line; then
  emit already-present
  exit 0
fi

tmp=$(mktemp "$INFO_DIR/.exclude.XXXXXX")
if [ -f "$EXCLUDE" ]; then
  # -p keeps the mode git created the file with; mktemp's own is 0600.
  cp -p "$EXCLUDE" "$tmp"
  # A file whose last line has no newline would otherwise absorb ours.
  if [ -s "$tmp" ] && [ "$(tail -c 1 "$tmp" | wc -l)" -eq 0 ]; then
    printf '\n' >> "$tmp"
  fi
else
  chmod 644 "$tmp"
fi
printf '%s\n' "$LINE" >> "$tmp"
mv "$tmp" "$EXCLUDE"

emit added
