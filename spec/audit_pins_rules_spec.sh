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
  It 'has an adapter that reports the unread count'
    use_fixture yarn-partial-read
    When call adapter_jq '.unreadable_entries > 0' resolution_map
    The status should be success
    The output should equal 'true'
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
