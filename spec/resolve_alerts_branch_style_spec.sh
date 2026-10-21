#!/bin/sh
# shellcheck shell=sh
# The branch-namespace preflight and flat fallback scheme (issue #123).
#
# The field failure: a target repo carried a pre-existing branch literally
# named `fix` (`refs/heads/fix`). Git refs are a filesystem namespace, so that
# file blocks every `fix/*` ref, and each fix agent finished its entire fix —
# bump, install, validate ok, local commit — before the push failed with
#   ! [remote rejected] fix/dependabot-postcss-8x -> fix/dependabot-postcss-8x (directory file conflict)
# The fix is one probe per checkout before dispatch, and a scheme of names with
# no slash. Since #227 the probe is code: the `prepare-checkout` command runs
# it, retries it once, excludes the checkout on a second failure, and passes
# `--branch-style flat` to discovery after a hit.
# tests/plugins/gh-security/subcommands/prepare-checkout.test.ts has those
# examples, and SKILL.md calls the command (#237). The scheme itself is in discover-alerts
# --branch-style (tests/plugins/gh-security/subcommands/discover-alerts.test.ts),
# in classify-lines --branch-style, and in the notice hook
# (spec/notice_scan_spec.sh). The phase 7 line for a flat repository is in
# summarize-run (tests/plugins/gh-security/subcommands/summarize-run.test.ts).
# This file keeps the prose that is not code: the fix agent, which uses the
# branch name as it is.

Describe 'the branch-namespace preflight (issue #123)'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"

  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'the fix agent stays a dumb consumer of branch_name'
    It 'forbids improvising a branch name at push time'
      When call phrase_in "$AGENT" 'never rename the branch yourself'
      The status should be success
      The output should equal '1'
    End
  End
End
