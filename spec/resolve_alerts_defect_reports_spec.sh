#!/bin/sh
# shellcheck shell=sh
# Orchestrator guidance to file skill-defect reports from field-run evidence
# (issue #148). Nothing in a script enforces this: the guidance is prose in
# resolve-alerts/SKILL.md's Phase 7, referenced (not duplicated) from
# audit-pins.md, so the sentences are the whole implementation and their
# absence is the whole regression. reference_scrub_spec.sh already gates the
# real internal slugs this guidance must never spell; this file asserts the
# guidance itself exists and states its scrub, consent, and identity rules
# generically.

Describe 'the defect-report guidance in resolve-alerts (#148)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
  AUDIT_CMD="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/commands/audit-pins.md"

  # Two readers, as in spec/audit_pins_rules_spec.sh: `rule_in` counts lines
  # and suits a prescribed command or a sentence that fits on one, `phrase_in`
  # flattens the file first and suits anything the wrap may split. Phrases are
  # distinctive fragments, not whole sentences, so a copyedit that reflows or
  # rewords around them does not break the spec — only removing the rule
  # itself does.
  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | tr -s ' ' | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'Phase 7 gains the defect-report sub-block'
    It 'states the check-first-then-file-or-comment practice'
      When call phrase_in "$SKILL" 'Check this repository for an existing issue before drafting a new one'
      The status should be success
      The output should equal '1'
    End

    It 'runs the search against this repository, not the target'
      When call rule_in "$SKILL" 'gh issue list --repo SurveyMonkey/skills --search'
      The status should be success
      The output should equal '1'
    End

    It 'searches closed issues too, since a fixed-and-closed defect is still a hit'
      When call rule_in "$SKILL" 'gh issue list --repo SurveyMonkey/skills --search "<distinguishing terms>" --state all'
      The status should be success
      The output should equal '1'
    End

    It 'names the search itself as the reachability probe for the identity question'
      When call phrase_in "$SKILL" 'This search is also the reachability probe for the identity question below'
      The status should be success
      The output should equal '1'
    End

    It 'treats a second sighting as confirmation, not noise'
      When call phrase_in "$SKILL" 'a second independent field sighting is confirmation, not noise'
      The status should be success
      The output should equal '1'
    End

    It 'requires the run'"'"'s own concrete evidence in the report'
      When call phrase_in "$SKILL" "The report carries the run's own concrete evidence"
      The status should be success
      The output should equal '1'
    End

    It 'excludes target-repo defects from this path'
      When call phrase_in "$SKILL" 'a target repo.s own defect .* is never filed here'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the scrub-rule sentence'
    It 'forbids naming the target repository, owner, org, or topology'
      When call phrase_in "$SKILL" 'Never name the target repository, its owner or org, or its internal directory topology'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the consent sentence'
    It 'gates filing on the user'"'"'s go-ahead, or a prior in-session authorization'
      When call phrase_in "$SKILL" 'Propose the drafted title and body and file only on the user.s go-ahead'
      The status should be success
      The output should equal '1'
    End

    It 'requires the closing report to say what was filed or proposed'
      When call phrase_in "$SKILL" 'the closing report in phase 8 states what was filed'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the identity sentence'
    It 'resolves the reporting identity separately from the batch identity'
      When call phrase_in "$SKILL" 'The identity that files the report is resolved separately from the identity that ran the batch'
      The status should be success
      The output should equal '1'
    End

    It 'names the EMU case as barred from contributing here'
      When call phrase_in "$SKILL" 'an account barred from contributing to outside'
      The status should be success
      The output should equal '1'
    End

    It 'allows switching to a discoverable capable account under the same consent'
      When call phrase_in "$SKILL" 'use it for the report,.*under the same consent that covers the report itself'
      The status should be success
      The output should equal '1'
    End

    It 'never invents a switched identity silently'
      When call phrase_in "$SKILL" 'Switching identities is never invented \+silently'
      The status should be success
      The output should equal '1'
    End

    It 'hands the drafted report to the user when no capable account resolves'
      When call phrase_in "$SKILL" 'the report does not vanish: hand the drafted title and body to'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'Phase 8'"'"'s report-not-a-prompt line is scoped to PR actions'
    It 'scopes the prohibition to what this run did to pull requests'
      When call phrase_in "$SKILL" 'This is a report, not a prompt, for what this run did to pull requests'
      The status should be success
      The output should equal '1'
    End

    It 'says the prohibition does not withdraw the defect-report offer'
      When call phrase_in "$SKILL" 'it does not withdraw phase 7.s defect-report offer'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'Phase 8 carries the defect-report outcome in the closing report'
    It 'states the closing report carries the filing outcome when Filing a skill-defect report applied'
      When call phrase_in "$SKILL" 'the closing report carries its outcome too'
      The status should be success
      The output should equal '1'
    End

    It 'covers both the filed.or-proposed issue and the hand-back-to-the-user case'
      When call phrase_in "$SKILL" 'the filed or proposed issue.s number or URL when one exists, or, when no capable account resolved, the drafted title and body verbatim'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'allowed-tools gains the gh issue entries'
    It 'grants gh issue list'
      When call rule_in "$SKILL" 'Bash(\*gh issue list\*)'
      The status should be success
      The output should equal '1'
    End

    It 'grants gh issue create'
      When call rule_in "$SKILL" 'Bash(\*gh issue create\*)'
      The status should be success
      The output should equal '1'
    End

    It 'grants gh issue comment'
      When call rule_in "$SKILL" 'Bash(\*gh issue comment\*)'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'audit-pins.md carries a reference block, not a duplicate'
    It 'points at the same practice for a contract-violation-shaped defect'
      When call phrase_in "$AUDIT_CMD" 'checked against this repository'"'"'s issues and filed or'
      The status should be success
      The output should equal '1'
    End

    It 'gives a readable path to resolve-alerts/SKILL.md'
      When call phrase_in "$AUDIT_CMD" 'rules .*{CLAUDE_PLUGIN_ROOT}/skills/resolve-alerts/SKILL\.md. states in its'
      The status should be success
      The output should equal '1'
    End

    It 'refers to the named Filing a skill-defect report section, not "Phase 7" generally, and says to read it first'
      When call phrase_in "$AUDIT_CMD" 'Filing a skill-defect report section — read that section before drafting anything, and never re-derive the rules here'
      The status should be success
      The output should equal '1'
    End
  End
End
