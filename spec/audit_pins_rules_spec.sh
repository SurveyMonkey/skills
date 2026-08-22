#!/bin/sh
# shellcheck shell=sh
# Rules agents/audit-pins.md states as prose, checked against the adapter output
# they read.
#
# The adapter can only carry the fact; the verdict is the definition's. A spec
# that stops at the adapter's JSON passes while the hazard survives, so each
# example below pairs the number the adapter emits with the sentence in the
# definition that acts on it. Its sibling spec/audit_restore_spec.sh does the
# same for phase 4 step 7's two git commands.

Describe 'the audit rules that read a partially-parsed map'
  After 'cleanup_fixture'

  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/audit-pins.md"

  # A single unreadable locator passes the ratio guard and removes its package
  # from both snapshots, so the step-6 diff sees no change and `[]` claims
  # nothing else moved — the stronger of the two claims, about a package nobody
  # audited (issue #48). Both halves have to hold: the map has to say so, and
  # the definition has to turn that into `null` + `not-checked`.
  # Every ecosystem owes the same number, because the rule below is written
  # once and acts on all of them. npm's count was derived from a *different*
  # predicate than its map rows — `.value.version != null` against the rows'
  # extra leading-digit test — so a `{"version":"v1.2.3"}` entry left the map
  # while the coverage field still said full coverage, and the hazard this
  # whole pairing exists to close was open on npm by construction (issue #49).
  Describe 'the count that the rule reads'
    Parameters
      yarn-partial-read
      npm-partial-read
    End

    It "has an adapter that reports the unread count in $1"
      use_fixture "$1"
      When call adapter_jq '.unreadable_entries > 0' resolution_map
      The status should be success
      The output should equal 'true'
    End
  End

  rule() { grep -c "$1" "$AGENT"; }

  It 'has a definition that maps a non-zero count onto collateral_changes null'
    When call rule 'unreadable_entries` is'
    The status should be success
    The output should equal '1'
  End

  It 'has a definition that maps a non-zero count onto not-checked'
    When call rule 'unreadable_entries` non-zero'
    The status should be success
    The output should equal '1'
  End

  # The phase-6 alias carve-out used to be illustrated with a `kind: alias`
  # pin, which phase 2 files `not-a-version-pin` and never tests, so the
  # illustration named a pin the audit cannot reach (issue #48).
  It 'illustrates the alias carve-out with a pin phase 2 actually tests'
    When call rule '^">=4.18.0"` is a version pin'
    The status should be success
    The output should equal '1'
  End

  It 'says the alias-valued form never reaches that comparison'
    When call rule 'never reaches this comparison'
    The status should be success
    The output should equal '1'
  End
End

# The removal PR (issue #72) is where a finding stops being words and becomes a
# deletion in someone's repository, so the definition's own guards are what
# stand between a plausible per-pin verdict and a bad merge. Each example below
# names one guard and fails if the sentence carrying it leaves the file.
Describe 'the rules that gate the removal PR'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/audit-pins.md"

  rule_in() { grep -c "$2" "$1"; }

  # Phases 4 and 5 test one pin per install, on purpose, which is exactly why
  # no set has ever been installed together, and a PR removes a set. Without
  # this sentence the PR would ship N individually-tested deletions as one
  # untested operation, which is the `removable-individually` hazard wearing a
  # commit.
  It 'requires the combined test before any PR'
    When call rule_in "$AGENT" 'installed and judged as a set'
    The status should be success
    The output should equal '1'
  End

  # A single unreadable locator drops its package from both snapshots, so the
  # diff reports no change for it. In report mode that degrades to a narrower
  # claim; here it would ship a deletion nothing checked, so it fails closed.
  It 'fails an attempt closed on a partially-read map'
    When call rule_in "$AGENT" 'fails the attempt closed'
    The status should be success
    The output should equal '1'
  End

  # Attempt 2 is the narrowing fallback. Keeping the individually-tested pins
  # in it would re-run the set that just failed, minus nothing that mattered.
  It 'narrows attempt 2 by dropping the individually-tested pins'
    When call rule_in "$AGENT" 'drops every pin whose finding was'
    The status should be success
    The output should equal '1'
  End

  # Promotion is the dispatcher's call with check state and auto-merge state in
  # front of the user (ADR 002). An agent that promotes its own PR removes the
  # checkpoint entirely, and where auto-merge is armed it merges it.
  It 'never lets the agent mark its own PR ready'
    When call rule_in "$AGENT" 'Never mark the PR ready'
    The status should be success
    The output should equal '1'
  End

  # PR mode first at every dispatch point, because the audit already did the
  # work a removal PR needs; a report-first default makes a human re-derive the
  # diff by hand, which is the step most likely to be skipped entirely.
  Describe 'PR mode leads the choice wherever the mode is asked'
    Parameters
      "$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/commands/audit-pins.md"
      "$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
    End

    It "offers it first in $1"
      When call rule_in "$1" 'first option and the recommended'
      The status should be success
      The output should equal '1'
    End
  End
End
