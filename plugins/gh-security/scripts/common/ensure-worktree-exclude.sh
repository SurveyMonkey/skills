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

# Every failure leaves the same {"error": "..."} on stderr, so a caller parses
# one shape whatever went wrong. jq does the escaping: a repo path may carry a
# quote, and a raw printf would emit invalid JSON exactly when something is
# already wrong (issue #42).
die() {
  printf '{"error":%s}\n' "$(printf '%s' "$1" | jq -Rs .)" >&2
  exit 1
}

REPO_ROOT="${1:-}"
[ -n "$REPO_ROOT" ] || die "Usage: ensure-worktree-exclude.sh <repo_root>"
[ -d "$REPO_ROOT" ] || die "repo_root does not exist: $REPO_ROOT"

if ! common_dir=$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null); then
  die "not a git repository: $REPO_ROOT"
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

# Guarded like every other failure path: a read-only `.git` (chmod 555) makes
# this the first write to fail, and under bare `set -e` it aborted with a raw
# `mkdir:` line instead of the JSON contract every other exit here honors.
mkdir -p "$INFO_DIR" 2>/dev/null || die "cannot create $INFO_DIR"
LOCK="$INFO_DIR/.exclude.gh-security.lock"

# The rename below is atomic, but read-then-rewrite as a whole is not: two
# callers can both read a file without the line and the second's rename then
# publishes a copy carrying it twice. `mkdir` is the portable atomic test-and-
# set, so the whole sequence runs under it.
#
# The temp file is dropped here too: a `cp` or `mv` that fails leaves one
# behind inside `.git/info/`, where git would otherwise carry it forever.
release() {
  if [ -n "${tmp:-}" ]; then rm -f "$tmp"; fi
  rmdir "$LOCK" 2>/dev/null || true
}

acquired=0
attempt=0
while [ "$attempt" -lt 50 ]; do
  if mkdir "$LOCK" 2>/dev/null; then
    acquired=1
    trap release EXIT
    break
  fi
  # A lock left behind by a killed process is never reclaimed on its own, so
  # every later run would wait out all 50 attempts and fail until someone
  # removed it by hand. The bound below already rules out "forever"; this rules
  # out "broken until a human notices". Nothing here holds it for anywhere near
  # a minute.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
  fi
  sleep 0.1
  attempt=$((attempt + 1))
done

if [ "$acquired" -eq 0 ]; then
  die "could not acquire $LOCK"
fi

# Another holder may have written it while we waited.
if has_line; then
  emit already-present
  exit 0
fi

# Each write is guarded for the same reason `mkdir -p` above is: `.git` can be
# read-only, or out of space, and a raw shell diagnostic is not this script's
# contract.
tmp=$(mktemp "$INFO_DIR/.exclude.XXXXXX" 2>/dev/null) \
  || die "cannot create a temporary file in $INFO_DIR"
if [ -f "$EXCLUDE" ]; then
  # -p keeps the mode git created the file with; mktemp's own is 0600.
  cp -p "$EXCLUDE" "$tmp" 2>/dev/null || die "cannot read $EXCLUDE"
  # A file whose last line has no newline would otherwise absorb ours.
  if [ -s "$tmp" ] && [ "$(tail -c 1 "$tmp" | wc -l)" -eq 0 ]; then
    printf '\n' >> "$tmp"
  fi
else
  chmod 644 "$tmp" 2>/dev/null || die "cannot set the mode of $tmp"
fi
printf '%s\n' "$LINE" >> "$tmp" || die "cannot write $tmp"
mv "$tmp" "$EXCLUDE" 2>/dev/null || die "cannot publish $EXCLUDE"

emit added
