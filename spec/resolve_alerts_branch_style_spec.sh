#!/bin/sh
# shellcheck shell=sh
# The branch-namespace preflight and flat fallback scheme (issue #123).
#
# The field failure: a target repo carried a pre-existing branch literally
# named `fix` (`refs/heads/fix`). Git refs are a filesystem namespace, so that
# file blocks every `fix/*` ref, and each fix agent finished its entire fix —
# bump, install, validate ok, local commit — before the push failed with
#   ! [remote rejected] fix/dependabot-postcss-8x -> fix/dependabot-postcss-8x (directory file conflict)
# The fix is one probe per checkout before dispatch, and a naming scheme with
# no slash. Since #227 the probe is code: the `prepare-checkout` command runs
# it, retries it once, excludes the checkout on a second failure, and passes
# `--branch-style flat` to discovery after a hit.
# tests/plugins/gh-security/subcommands/prepare-checkout.test.ts has those
# examples. SKILL.md still states the probe in prose, with no pin, until #237
# makes the skill call the command. The scheme itself is in discover-alerts
# --branch-style (tests/plugins/gh-security/subcommands/discover-alerts.test.ts),
# in classify-lines --branch-style, and in the notice hook
# (spec/notice_scan_spec.sh). This file keeps the prose that is
# not code: the phase 7 summary, and the fix agent, which uses the branch
# name as it is.

Describe 'the branch-namespace preflight (issue #123)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"

  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'the flat scheme in the SKILL.md summary'
    # pin: mechanical, retired by summarize-run.sh
    It 'reports every flat-scheme repo in the phase 7 summary'
      When call phrase_in "$SKILL" 'name every repo whose batch ran under the flat branch scheme'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the fix agent stays a dumb consumer of branch_name'
    It 'consumes either spelling verbatim'
      When call phrase_in "$AGENT" 'you never choose or rewrite the spelling'
      The status should be success
      The output should equal '1'
    End

    # The field push-rejection string is the specimen for the one
    # classification the agent makes: this rejection is a preflight miss,
    # never a transient push failure. The count below only proves the
    # specimen is carried verbatim, not that the surrounding prose
    # classifies it (testing skill, "Prose pins" checklist item 6).
    It 'carries the field push-rejection specimen verbatim'
      When call phrase_in "$AGENT" '! \[remote rejected\] fix/dependabot-postcss-8x -> fix/dependabot-postcss-8x (directory file conflict)'
      The status should be success
      The output should equal '1'
    End

    It 'forbids improvising a branch name at push time'
      When call phrase_in "$AGENT" 'never rename the branch yourself'
      The status should be success
      The output should equal '1'
    End
  End
End
