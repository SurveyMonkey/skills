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
  # A local `phrase_in`, distinct from the other suites' (spec/audit_pins_rules_spec.sh:78,
  # spec/fix_dependency_branch_spec.sh:24), which flatten without squeezing whitespace and so are
  # sensitive to the extra leading spaces a bullet's indented continuation introduces after
  # `tr '\n' ' '`. This one squeezes runs of spaces first, so a fragment spanning a line-wrap
  # boundary still matches regardless of how the document happens to wrap.
  phrase_in() { tr '\n' ' ' < "$1" | tr -s ' ' | grep -o -e "$2" | wc -l | tr -d ' '; }

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
      When call rule_in "$AGENT" 'Scratch files live under .[$]WORK., never .[/]tmp.'
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

    # The load-bearing generalization: without it, the corepack-shim bullet
    # below is the only place a scratch-file rule exists at all, and a
    # reader never learns the rule covers every scratch file this flow
    # writes. Deleting it must fail the suite (mutation-tested finding);
    # `phrase_in` is used because the sentence spans an indented
    # continuation line.
    It 'generalizes to every scratch file and confines all of them to WORK'
      When call phrase_in "$AGENT" \
        'every scratch or intermediate file this flow writes, not only the tooling case below: name it under .[$]WORK., never in the shared scratchpad'
      The status should be success
      The output should equal '1'
    End

    # The narrower half of the generalization: qualification is required
    # only for a data/intermediate file whose name could otherwise collide
    # or be mistaken between runs, not for every artifact universally -- the
    # corepack shim below is named the same way on every run and needs none.
    It 'scopes the qualified-name requirement to collision-prone files, not every artifact'
      When call phrase_in "$AGENT" \
        'collide or be mistaken between runs.*the driver.s .why. capture is one.*also gets its own qualified name'
      The status should be success
      The output should equal '1'
    End

    It 'carves the fixed-purpose shim out of the qualified-name requirement'
      When call phrase_in "$AGENT" \
        'a fixed-purpose tool like the shim below needs no such qualification'
      The status should be success
      The output should equal '1'
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

  # The why capture itself moved into common/fix-group.sh with #171, which
  # writes it as `$WORK/why-<package_path>.json` and hands that path to
  # score-merge-risk.sh. Both halves are asserted against the driver's own argv
  # in spec/fix_group_apply_spec.sh; what stays here is that the agent
  # definition no longer prescribes a path of its own, and carries no
  # unqualified `why.json` literal anywhere.
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
