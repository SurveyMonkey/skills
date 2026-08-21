#!/bin/sh
# shellcheck shell=sh
# scripts/check.sh is the single entry point for the quality gates, so its
# refusal paths are what keep "found nothing" from reading as a pass: the
# hooks and the workflow both trust it to fail on empty discovery. Only the
# refusals and the target listing are covered here. The happy paths need the
# ShellCheck binary, the claude CLI, and the suite itself (recursion), and CI
# runs them for real via .github/workflows/gates.yml.

Describe 'scripts/check.sh'
  CHECK="$SHELLSPEC_PROJECT_ROOT/scripts/check.sh"

  # A scratch git repository: check.sh anchors itself with
  # `git rev-parse --show-toplevel` and discovers targets from the index, so
  # every example gets its own repo rather than this one.
  scratch_repo() {
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR" || return 1
    git init -q .
  }

  After cleanup_fixture

  Describe 'argument handling'
    Before scratch_repo

    It 'refuses an unknown subcommand'
      When run "$CHECK" frobnicate
      The status should eq 2
      The stderr should include 'usage:'
    End

    It 'refuses a missing subcommand'
      When run "$CHECK"
      The status should eq 2
      The stderr should include 'usage:'
    End
  End

  Describe 'targets'
    Before scratch_repo

    It 'lists tracked shell files from the index, staged included'
      mkdir -p sub
      touch tracked.sh sub/nested.sh untracked.sh
      git add tracked.sh sub/nested.sh
      When run "$CHECK" targets
      The line 1 of output should equal 'sub/nested.sh'
      The line 2 of output should equal 'tracked.sh'
      The lines of output should eq 2
    End

    It 'lists .githooks entries despite their missing .sh suffix'
      mkdir -p .githooks
      touch .githooks/pre-commit
      git add .githooks/pre-commit
      When run "$CHECK" targets
      The output should equal '.githooks/pre-commit'
    End
  End

  Describe 'empty discovery refuses instead of passing'
    Before scratch_repo

    It 'fails lint when no shell files are tracked'
      When run "$CHECK" lint
      The status should eq 2
      The stderr should include 'no shell files discovered'
    End

    It 'fails validate when the marketplace manifest is absent'
      When run "$CHECK" validate
      The status should eq 2
      The stderr should include 'marketplace manifest missing'
    End

    It 'fails validate when no plugin carries a manifest'
      mkdir -p .claude-plugin plugins/empty
      printf '{}' > .claude-plugin/marketplace.json
      When run "$CHECK" validate
      The status should eq 2
      The stderr should include 'no plugin manifests found'
    End

    It 'fails spec when no spec files exist'
      When run "$CHECK" spec
      The status should eq 2
      The stderr should include 'no spec files found'
    End
  End
End
