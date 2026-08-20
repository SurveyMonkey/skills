#!/bin/sh
# shellcheck shell=sh
# scripts/common/ensure-worktree-exclude.sh: the orchestrator writes the
# worktrees ignore line once, before any agent is dispatched (issue #35).

Describe 'ensure-worktree-exclude.sh'
  After 'cleanup_fixture'

  make_repo() {
    TEST_DIR=$(mktemp -d)
    REPO="$TEST_DIR/repo"
    mkdir -p "$REPO"
    git -c init.defaultBranch=main -C "$REPO" init --quiet
  }

  exclude_path() { printf '%s' "$REPO/.git/info/exclude"; }

  line_count() { grep -Fcx '.claude/worktrees/' "$(exclude_path)"; }

  It 'creates the exclude file when the repository has none'
    make_repo
    rm -f "$REPO/.git/info/exclude"
    When call common_jq ensure-worktree-exclude.sh '{action, line}' "$REPO"
    The status should be success
    The output should equal '{"action":"added","line":".claude/worktrees/"}'
    The path "$REPO/.git/info/exclude" should be exist
  End

  It 'appends to an existing exclude file, preserving its content'
    make_repo
    printf '# user rules\nbuild/\n' > "$(exclude_path)"
    "$COMMON/ensure-worktree-exclude.sh" "$REPO" > /dev/null
    When call cat "$REPO/.git/info/exclude"
    The status should be success
    The line 1 of output should equal '# user rules'
    The line 2 of output should equal 'build/'
    The line 3 of output should equal '.claude/worktrees/'
  End

  # A file whose last line carries no newline would otherwise absorb ours.
  It 'does not join the line onto an unterminated last line'
    make_repo
    printf 'build/' > "$(exclude_path)"
    "$COMMON/ensure-worktree-exclude.sh" "$REPO" > /dev/null
    When call line_count
    The status should be success
    The output should equal '1'
  End

  It 'is idempotent: a second call reports already-present and writes nothing'
    make_repo
    "$COMMON/ensure-worktree-exclude.sh" "$REPO" > /dev/null
    When call common_jq ensure-worktree-exclude.sh '.action' "$REPO"
    The status should be success
    The output should equal '"already-present"'
    The result of function line_count should equal '1'
  End

  # The race issue #35 reports: two agents dispatched in one message append
  # concurrently. Not flaky by construction, and the reason is that they do NOT
  # interleave: the `mkdir` lock serializes the read-modify-write completely, so
  # each caller after the first finds the line already present and writes
  # nothing. What this contends for is the lock; what it asserts is that
  # serialization holds under real contention (issue #42).
  It 'leaves exactly one line when several callers contend for the lock'
    make_repo
    printf 'build/\n' > "$(exclude_path)"
    for _i in 1 2 3 4 5 6; do
      "$COMMON/ensure-worktree-exclude.sh" "$REPO" > /dev/null &
    done
    wait
    When call line_count
    The status should be success
    The output should equal '1'
    The contents of file "$REPO/.git/info/exclude" should equal 'build/
.claude/worktrees/'
  End

  # `.git/info/exclude` is repository-wide, so a linked worktree must resolve
  # to the shared git directory rather than its own gitdir.
  It 'writes to the shared git directory from inside a linked worktree'
    make_repo
    git -C "$REPO" -c user.email=t@e -c user.name=t commit --quiet --allow-empty -m init
    git -C "$REPO" worktree add --quiet --detach "$TEST_DIR/wt" HEAD 2>/dev/null
    "$COMMON/ensure-worktree-exclude.sh" "$TEST_DIR/wt" > /dev/null
    When call line_count
    The status should be success
    The output should equal '1'
  End

  # Every other failure emits {"error": ...}; the first write did not, because
  # `mkdir -p` sat outside any guard under bare `set -e` and aborted with a raw
  # `mkdir:` diagnostic. The caller treats a failure here as non-fatal, so what
  # broke was parseability, not correctness (issue #42).
  Describe 'a read-only .git still honors the JSON error contract'
    unwritable_git_run() {
      rm -rf "$REPO/.git/info"
      chmod 555 "$REPO/.git"
      _st=0
      "$COMMON/ensure-worktree-exclude.sh" "$REPO" || _st=$?
      chmod 755 "$REPO/.git"
      return "$_st"
    }

    It 'reports {"error": ...} rather than a raw mkdir diagnostic'
      make_repo
      Skip if 'root ignores the mode bits' [ "$(id -u)" -eq 0 ]
      When call unwritable_git_run
      The status should equal 1
      The stderr should include '{"error":"cannot create '
      The stderr should not include 'Permission denied'
      The output should equal ''
    End
  End

  It 'rejects a directory that is not a git repository'
    make_repo
    rm -rf "$REPO/.git"
    When call common_jq ensure-worktree-exclude.sh '.' "$REPO"
    The status should equal 1
    The stderr should include 'not a git repository'
  End

  It 'rejects a missing repo_root'
    When call common_jq ensure-worktree-exclude.sh '.' /nonexistent-repo-root
    The status should equal 1
    The stderr should include 'does not exist'
  End

  It 'rejects a missing argument'
    When run script "$COMMON/ensure-worktree-exclude.sh"
    The status should equal 1
    The stderr should include 'Usage'
  End
End
