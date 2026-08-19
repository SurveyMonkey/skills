#!/bin/sh
# shellcheck shell=sh
# scripts/common/run-check.sh: one check, outcome as JSON.

Describe 'run-check.sh'
  After 'cleanup_fixture'

  # A check is cwd-sensitive (it drops a log beside the repository's own
  # scripts), so it runs only inside a linked worktree; every example that is
  # not about the guard fakes one.
  setup_dir() {
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR" || return 1
    fake_linked_worktree
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

  # Running a check in the user's checkout is the contamination this plugin
  # exists to avoid, and the log lands there too.
  It 'refuses to run in a primary checkout'
    setup_dir
    fake_primary_checkout
    When run script "$COMMON/run-check.sh" sh -c 'echo ok'
    The status should equal 1
    The stderr should include 'primary checkout'
    The path "$TEST_DIR/.gh-security-check.log" should not be exist
  End

  # The log this wrote into the user's tree from spec/ is what exposed the
  # old current-directory-only test.
  It 'refuses to run in a subdirectory of a primary checkout'
    setup_dir
    fake_primary_checkout
    mkdir sub
    cd sub || return 1
    When run script "$COMMON/run-check.sh" sh -c 'echo ok'
    The status should equal 1
    The stderr should include 'subdirectory of the primary checkout'
    The path "$TEST_DIR/sub/.gh-security-check.log" should not be exist
  End

  It 'refuses to run outside a git repository'
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR" || return 1
    When run script "$COMMON/run-check.sh" sh -c 'echo ok'
    The status should equal 1
    The stderr should include 'no git repository'
    The path "$TEST_DIR/.gh-security-check.log" should not be exist
  End

  It 'refuses to run in a git submodule'
    setup_dir
    fake_linked_worktree '/parent/.git/modules/vendor'
    When run script "$COMMON/run-check.sh" sh -c 'echo ok'
    The status should equal 1
    The stderr should include 'submodule'
    The path "$TEST_DIR/.gh-security-check.log" should not be exist
  End

  It 'proceeds in a linked worktree'
    setup_dir
    When call common_jq run-check.sh '{exit, tail}' sh -c 'echo ok'
    The status should be success
    The output should equal '{"exit":0,"tail":["ok"]}'
  End

  It 'proceeds in a subdirectory of a linked worktree'
    setup_dir
    mkdir packages
    cd packages || return 1
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
