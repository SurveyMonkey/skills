#!/bin/sh
# shellcheck shell=sh
# Pins issue #109's closed set of three merge-risk labels across every place
# it has to agree: the two agent definitions that create and apply the
# labels, and the scorer whose `band` field is their only source. A drifted
# hex, a fourth band, or a mismatched emoji in any one of the three fails
# this suite.
#
# This lives in its own file rather than spec/audit_pins_rules_spec.sh or
# spec/common_scripts_spec.sh because the thing being pinned spans both
# agents and the scorer; folding it into either existing file would bury a
# cross-cutting contract inside a suite named for one component.

Describe 'the closed set of merge-risk labels (#109)'
  FIX_AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  AUDIT_AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/audit-pins.md"
  README="$SHELLSPEC_PROJECT_ROOT/README.md"

  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  sorted_band_names() { grep -o -e 'merge-risk:[a-z][a-z]*' -- "$1" | sort -u; }

  Describe 'label names and colors, pinned in both agent definitions'
    Parameters
      # agent file    label name           hex color
      "$FIX_AGENT"    merge-risk:low       2da44e
      "$FIX_AGENT"    merge-risk:medium    d4a72c
      "$FIX_AGENT"    merge-risk:high      cf222e
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

  Describe 'no fourth band is inventable: exactly three merge-risk label names, in each agent'
    Parameters
      "$FIX_AGENT"
      "$AUDIT_AGENT"
    End

    It 'names exactly low, medium, and high, never a fourth'
      When call sorted_band_names "$1"
      The status should be success
      The output should equal "merge-risk:high
merge-risk:low
merge-risk:medium"
    End

    It 'never uses a bare risk: prefix, which would read as alert severity'
      When call phrase_in "$1" 'never a bare .risk:<band>., which would read as alert severity rather than merge risk'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the fix agent applies its own band on the gh pr create call it just built'
    It 'adds --label merge-risk:<band> alongside --label security'
      When call rule_in "$FIX_AGENT" 'gh pr create --repo <nwo> --head <branch_name> --label security --label merge-risk:<band>'
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

  Describe 'the race-tolerance rule, in both agent definitions'
    Parameters
      "$FIX_AGENT"
      "$AUDIT_AGENT"
    End

    It 'treats a gh label create failing because the label now exists as success, not an error'
      When call phrase_in "$1" 'gh label create. that fails because *the label now exists is success, *not an error'
      The status should be success
      The output should equal '1'
    End

    It 'says creating a label is a deliberate write of repo metadata beyond the PR itself'
      When call phrase_in "$1" 'a deliberate write of repo metadata beyond the PR itself'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the scorer emits the matching emoji for each band, in the PR-body markdown'
    After 'cleanup_fixture'

    Parameters
      # fixture           rel     dev    before  after   expected band  expected emoji
      tooling-only        direct  true   1.0.0   1.0.1   Low            🟢
      coverage-partial    direct  false  1.0.0   1.1.0   Medium         🟡
      coverage-none       direct  false  1.0.0   2.0.0   High           🔴
    End

    score_band_line() {
      use_fixture "$1"
      jq -n --arg rel "$2" --argjson dev "$3" \
        '{relationship: $rel, dev_only: $dev, parents: [], package: "lodash"}' > why.json
      "$COMMON/score-merge-risk.sh" --package lodash --before "$4" --after "$5" \
        --adapter "$ADAPTER" --why-json why.json --override-scope none --declared-range none \
        | jq -r '.markdown' | head -1
    }

    It "puts $7 on the Merge risk line for a $6 band"
      When call score_band_line "$1" "$2" "$3" "$4" "$5"
      The status should be success
      The output should include "## Merge risk: $7 $6 ("
    End
  End
End
