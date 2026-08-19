#!/bin/sh
# shellcheck shell=sh
# scripts/common/run-check.sh: one check, outcome as JSON.

Describe 'run-check.sh'
  After 'cleanup_fixture'

  setup_dir() {
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR" || return 1
  }

  It 'reports a passing command with exit 0'
    setup_dir
    When call common_jq run-check.sh '{exit, lines}' sh -c 'echo ok'
    The status should be success
    The output should equal '{"exit":0,"lines":1}'
  End

  # The check failing is data, not an error: the script itself exits 0 and
  # the caller reads .exit.
  It 'reports a failing command without failing itself'
    setup_dir
    When call common_jq run-check.sh '{exit, tail}' sh -c 'echo one; echo two >&2; exit 3'
    The status should be success
    The output should equal '{"exit":3,"tail":["one","two"]}'
  End

  It 'captures stdout and stderr to a log in the working directory'
    setup_dir
    When call common_jq run-check.sh '.log' sh -c 'echo captured'
    The status should be success
    The output should include '.gh-security-check.log'
    The contents of file "$TEST_DIR/.gh-security-check.log" should equal 'captured'
  End

  # A check runs the repository's own scripts, so running it in the user's
  # checkout is the contamination this plugin exists to avoid. Worktrees carry
  # a .git file, primary checkouts a .git directory.
  It 'refuses to run when .git is a directory'
    setup_dir
    mkdir .git
    When run script "$COMMON/run-check.sh" sh -c 'echo ok'
    The status should equal 1
    The stderr should include 'primary checkout'
    The path "$TEST_DIR/.gh-security-check.log" should not be exist
  End

  It 'proceeds when .git is a worktree file'
    setup_dir
    printf 'gitdir: /elsewhere/.git/worktrees/fix\n' > .git
    When call common_jq run-check.sh '{exit, tail}' sh -c 'echo ok'
    The status should be success
    The output should equal '{"exit":0,"tail":["ok"]}'
  End

  It 'requires a command'
    setup_dir
    When run script "$COMMON/run-check.sh"
    The status should equal 1
    The stderr should be present
  End
End
