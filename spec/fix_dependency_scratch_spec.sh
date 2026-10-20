#!/bin/sh
# shellcheck shell=sh
# Scratch-file isolation rules agents/fix-dependency.md states as prose
# (issue #133). A field run's fix-dependency agent wrote its `why.json`
# scratch file to the shared session scratchpad rather than $WORK, and a
# sibling agent fixing a different package overwrote it mid-run — caught
# before scoring, but only by luck of timing. Nothing in a script enforces
# this: the definition's sentences are the whole implementation, and their
# absence is the whole regression. Model text: agents/audit-pins.md's
# equivalent Hard rule and its `$WORK/why-<package>.json` scratch path.

Describe 'scratch-file isolation in fix-dependency (#133)'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"

  # `rule_in`, as in spec/fix_dependency_branch_spec.sh and
  # spec/audit_pins_rules_spec.sh: counts matching lines, so every phrase
  # below is chosen to fit within a single wrapped line rather than spanning
  # a bullet's indented continuation (where flattening would need to account
  # for the extra leading spaces the wrap introduces).
  rule_in() { grep -c -e "$2" -- "$1"; }
  # `grep -c` exits 1 on no match, which is the expected answer for a shape
  # that must be ABSENT, so this reports the count without failing on it.
  count_in() { grep -c -e "$2" -- "$1" || true; }

  Describe 'the Hard rules cluster names the shared scratchpad for every scratch file'
    # The pre-#133 wording stated only the $WORK-vs-/tmp rule, with the
    # sibling-collision hazard buried later in the corepack-shim bullet where
    # it read as advice about tooling only, not about scratch files in
    # general. This is the load-bearing sentence that generalizes it.
    It 'says the session scratchpad is shared with agents running beside you'
      When call rule_in "$AGENT" \
        'the session scratchpad is shared with agents running beside'
      The status should be success
      The output should not equal '0'
    End

    It 'still states the WORK-not-tmp rule the shared-scratchpad sentence extends'
      When call rule_in "$AGENT" 'Scratch files live under .<work>., never .[/]tmp.'
      The status should be success
      The output should not equal '0'
    End

    # #133's actual incident: not the sibling's cleanup deleting a file, but a
    # sibling writing the same predictable name mid-run and clobbering it.
    # Deleting this sentence must fail the suite (mutation-tested finding).
    It 'names the predictable-filename hazard, not just cleanup deletion'
      When call rule_in "$AGENT" \
        'a predictable filename there lets a sibling overwrite yours mid-run'
      The status should be success
      The output should not equal '0'
    End

    # The corepack-shim bullet's own collision warning is precedent, not
    # replaced text; it must still be there, scoped to the shim.
    It 'keeps the sibling-collision warning in the corepack-shim bullet'
      When call rule_in "$AGENT" 'never place one in the'
      The status should be success
      The output should not equal '0'
    End

    It 'keeps the collision rationale naming the shared parallel directory'
      When call rule_in "$AGENT" \
        'session scratchpad: that directory is shared with agents running in parallel'
      The status should be success
      The output should not equal '0'
    End
  End

  # The `gh-security fix-group` command writes the why capture as
  # `$WORK/why-<package_path>.json` and hands it to the scorer. What stays
  # here is that the agent definition no longer prescribes a path of its own,
  # and carries no unqualified `why.json` literal anywhere.
  Describe 'the why capture is the driver.s, and no unqualified literal survives'
    It 'has no remaining unqualified why.json literal'
      When call count_in "$AGENT" 'why\.json'
      The status should be success
      The output should equal '0'
    End

    It 'no longer prescribes a why-capture redirect of its own'
      When call count_in "$AGENT" '[$]ADAPTER why <package> >'
      The status should be success
      The output should equal '0'
    End
  End
End
