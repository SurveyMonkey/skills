#!/bin/sh
# shellcheck shell=sh
# Pins issue #109's closed set of three merge-risk labels across every place
# it has to agree: `common/render-pr.sh` (which now renders and creates every
# label the fix flow uses, issue #172), the `audit-pins` agent definition
# (which still creates its own risk label inline), and the scorer whose
# `band` field is their only source. A drifted hex, a fourth band, or a
# mismatched color in any one of the three fails this suite.
#
# `fix-dependency.md` itself carries no label vocabulary any more — it calls
# `render-pr.sh labels` and `render-pr.sh create`, and the label behavior
# those calls produce (colors, descriptions, race tolerance, the `--label
# security --label merge-risk:<band>` argv) is exercised end-to-end in
# spec/render_pr_spec.sh, with a mocked `gh`. This file only pins the
# rendering script's own source against drift, the same way it always pinned
# the agent prose.
#
# This lives in its own file rather than spec/audit_pins_rules_spec.sh or
# spec/common_scripts_spec.sh because the thing being pinned spans an agent,
# a script, and the scorer; folding it into either existing file would bury a
# cross-cutting contract inside a suite named for one component.

Describe 'the closed set of merge-risk labels (#109)'
  RENDER_PR="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts/common/render-pr.sh"
  FIX_AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  AUDIT_AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/audit-pins.md"
  README="$SHELLSPEC_PROJECT_ROOT/README.md"

  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  sorted_band_names() { grep -o -e 'merge-risk:[a-z][a-z]*' -- "$1" | sort -u; }

  Describe 'render-pr.sh: label names and colors, one case arm per band'
    Parameters
      low    "low)    color=2da44e; desc=\"Low merge risk\" ;;"
      medium "medium) color=d4a72c; desc=\"Medium merge risk\" ;;"
      high   "high)   color=cf222e; desc=\"High merge risk\" ;;"
    End

    It "creates merge-risk:$1 with the pinned color and description"
      When call rule_in "$RENDER_PR" "$2"
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'audit-pins.md: label names and colors, pinned in the agent definition'
    Parameters
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

  Describe 'no fourth band is inventable: exactly three merge-risk label names'
    sorted_band_case_arms() {
      grep -oE '^ *(low|medium|high|[a-z]+)\)( +color=| ;;)' -- "$1" \
        | sed -E 's/^ *//; s/\).*/\)/' | sort -u
    }

    It 'names exactly low, medium, and high in render-pr.sh'"'"'s labels case, never a fourth'
      When call sorted_band_case_arms "$RENDER_PR"
      The status should be success
      The output should equal "high)
low)
medium)"
    End

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

  Describe 'fix-dependency.md delegates label creation and PR opening to render-pr.sh'
    It 'calls render-pr.sh labels with --repo and --band'
      When call rule_in "$FIX_AGENT" 'render-pr\.sh labels --repo <nwo> --band <band>'
      The status should be success
      The output should equal '1'
    End

    It 'calls render-pr.sh create with --band'
      When call rule_in "$FIX_AGENT" 'render-pr\.sh create --repo <nwo> --head <branch_name> --band <band>'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'render-pr.sh create never passes --draft: PRs open ready for review (ADR 008)'
    It 'builds no --draft flag anywhere in its gh pr create argv'
      When call rule_in "$RENDER_PR" '\-\-draft'
      The status should equal 1
      The output should equal '0'
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

  Describe 'render-pr.sh: the race-tolerance rule for label creation'
    It 'treats "already exists" in gh label create output as success, not an error'
      When call rule_in "$RENDER_PR" '\*"already exists"\*) return 0 ;;'
      The status should be success
      The output should equal '1'
    End

    It 'says creating a label is a deliberate write of repo metadata beyond the PR itself'
      When call phrase_in "$RENDER_PR" 'a deliberate write of repo metadata beyond the PR itself'
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

    It 'says creating a label is a deliberate write of repo metadata beyond the PR itself'
      When call phrase_in "$AUDIT_AGENT" 'a deliberate write of repo metadata beyond the PR itself'
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
