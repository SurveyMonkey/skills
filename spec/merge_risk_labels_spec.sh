#!/bin/sh
# shellcheck shell=sh
# Pins the closed set of three merge-risk labels of issue #109. The
# `audit-pins` agent definition creates its own risk label inline. This suite
# pins its hexes and its three bands. It also pins the hexes in README.md.
#
# The `fix-dependency` agent carries no label vocabulary. It calls
# `render-pr labels` and `render-pr create`, and this suite pins those calls.
# tests/plugins/gh-security/subcommands/render-pr.test.ts tests the labels
# that the calls make, with a mocked `gh`.

Describe 'the closed set of merge-risk labels (#109)'
  FIX_AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  AUDIT_AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/audit-pins.md"
  README="$SHELLSPEC_PROJECT_ROOT/README.md"

  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  sorted_band_names() { grep -o -e 'merge-risk:[a-z][a-z]*' -- "$1" | sort -u; }

  Describe 'audit-pins.md: label names and colors, pinned in the agent definition'
    Parameters
      "$AUDIT_AGENT"  dependencies         0366d6
      "$AUDIT_AGENT"  merge-risk:low       2da44e
      "$AUDIT_AGENT"  merge-risk:medium    d4a72c
      "$AUDIT_AGENT"  merge-risk:high      cf222e
    End

    It "creates $2 with color $3"
      When call rule_in "$1" "gh label create $2 --repo <nwo> --color $3 --description"
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the same three hexes, pinned in README.md too'
    Parameters
      # label name           color word   hex
      merge-risk:low       green        2da44e
      merge-risk:medium    yellow       d4a72c
      merge-risk:high      red          cf222e
    End

    It "documents $1 as $2 (#$3)"
      When call rule_in "$README" "\`$1\` ($2, \`#$3\`)"
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the dependencies label hex, pinned in README.md too'
    It "documents \`dependencies\` as \`#0366d6\`"
      When call rule_in "$README" "\`dependencies\` (\`#0366d6\`"
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'no fourth band is inventable: exactly three merge-risk label names'
    It 'names exactly low, medium, and high in audit-pins.md, never a fourth'
      When call sorted_band_names "$AUDIT_AGENT"
      The status should be success
      The output should equal "merge-risk:high
merge-risk:low
merge-risk:medium"
    End

    It 'never uses a bare risk: prefix in fix-dependency.md, which would read as alert severity'
      When call phrase_in "$FIX_AGENT" 'never a bare .risk:<band>., which would read as alert severity rather than merge risk'
      The status should be success
      The output should equal '1'
    End

    It 'never uses a bare risk: prefix in audit-pins.md, which would read as alert severity'
      When call phrase_in "$AUDIT_AGENT" 'never a bare .risk:<band>., which would read as alert severity rather than merge risk'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'fix-dependency.md delegates label creation and PR opening to render-pr'
    It 'calls render-pr labels with --repo and --band'
      When call rule_in "$FIX_AGENT" 'render-pr labels --repo <nwo> --band <band>'
      The status should be success
      The output should equal '1'
    End

    It 'calls render-pr create with --band'
      When call rule_in "$FIX_AGENT" 'render-pr create --repo <nwo> --head <branch_name> --band <band>'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the audit guards its risk label on a non-null band'
    It 'adds the label only when pr.risk.band is non-null'
      When call phrase_in "$AUDIT_AGENT" 'Add .merge-risk:<band>. only when .pr\.risk\.band. is non-null'
      The status should be success
      The output should equal '1'
    End

    It 'says a null band gets no risk label, never a fake one'
      When call phrase_in "$AUDIT_AGENT" 'gets no risk label at all, never a fake one'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'audit-pins.md: the race-tolerance rule, in the agent definition'
    It 'treats a gh label create failing because the label now exists as success, not an error'
      When call phrase_in "$AUDIT_AGENT" 'gh label create. that fails because *the label now exists is success, *not an error'
      The status should be success
      The output should equal '1'
    End
  End
End
