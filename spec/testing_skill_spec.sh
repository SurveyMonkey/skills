#!/bin/sh
# shellcheck shell=sh
# The project `testing` skill at .claude/skills/testing/.
#
# The skill is dense with citations: spec paths, helper names and quoted
# blocks. Three wrong ones shipped in its first draft (a `Mock gh` inventory
# counting a file whose only match was a comment, and two collaborator
# examples that were pipeline neighbours rather than caller and callee), so
# the citations that are machine-checkable are checked here rather than left
# to a reader noticing. A cited path that has been renamed or deleted is the
# same class of rot, and it is silent: the prose still reads correctly.
#
# Only the structural half is gated. Whether a quoted snippet still matches
# the file it came from, and whether a claim about a spec is true, stays on
# review; this gate keeps the paths honest so that review starts from a file
# that exists.

Describe 'the testing skill'
  SKILL_DIR="$SHELLSPEC_PROJECT_ROOT/.claude/skills/testing"
  RULE="$SHELLSPEC_PROJECT_ROOT/.claude/rules/path-spec.md"

  It 'ships the skill and both reference files'
    When call test -f "$SKILL_DIR/SKILL.md" -a -f "$SKILL_DIR/tests.md" \
      -a -f "$SKILL_DIR/mocking.md"
    The status should be success
  End

  Describe 'frontmatter'
    # The Skill tool discovers a project skill by its frontmatter, so a
    # malformed block is not a cosmetic defect: the skill silently does not
    # load and `/testing` does not exist. `name` must equal the directory.
    frontmatter() {
      sed -n '2,/^---$/p' "$SKILL_DIR/SKILL.md" | sed '/^---$/d' | cut -d: -f1
    }

    It 'opens with a delimiter on line 1'
      When call head -n 1 "$SKILL_DIR/SKILL.md"
      The output should equal '---'
    End

    It 'declares exactly name and description, in that order'
      When call frontmatter
      The status should be success
      The output should equal 'name
description'
    End

    It 'names the skill after its directory'
      When call grep -c '^name: testing$' "$SKILL_DIR/SKILL.md"
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'cited paths'
    # Every `spec/...` path the three files mention, deduped. `grep -o` over
    # the set rather than per-file: the claim is about the skill as a whole,
    # and one failure naming the missing path is what a reader needs.
    cited_specs() {
      grep -ho 'spec/[A-Za-z0-9_./-]*\.sh' \
        "$SKILL_DIR/SKILL.md" "$SKILL_DIR/tests.md" "$SKILL_DIR/mocking.md" \
        | sort -u
    }

    missing_specs() {
      cited_specs | while IFS= read -r p; do
        [ -f "$SHELLSPEC_PROJECT_ROOT/$p" ] || printf '%s\n' "$p"
      done
    }

    # A pass value of zero proves nothing unless the scan is shown to find
    # anything at all, and an empty citation list would pass `missing_specs`
    # silently. This is the positive control.
    It 'cites spec files at all'
      When call cited_specs
      The status should be success
      The output should include 'spec/spec_helper.sh'
      The lines of output should not equal 0
    End

    It 'cites no spec file that does not exist'
      When call missing_specs
      The status should be success
      The output should equal ''
    End
  End

  Describe 'cited helpers'
    # `common_jq` and `adapter_jq` are named as living in spec_helper.sh.
    # `phrase_in`, `count_in` and `rule_in` are named as prose-pin helpers
    # and are deliberately per-file, so they are not asserted here.
    Parameters
      common_jq
      adapter_jq
      use_fixture
    End

    It "finds $1 where the skill says it lives"
      When call grep -c "^$1()" "$SHELLSPEC_PROJECT_ROOT/spec/spec_helper.sh"
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the path rule that auto-loads it'
    # An unanchored `spec/**` is the one form whose behavior is not documented
    # (matched relative to the project root, or against an absolute path?), and
    # a pattern that matches nothing fails silently: the skill simply never
    # loads. The three pre-existing rules all anchor with a leading `**/`.
    It 'anchors its paths glob the way every other rule in this repo does'
      When call grep -c '^  - "\*\*/spec/\*\*"$' "$RULE"
      The status should be success
      The output should equal '1'
    End

    It 'points at the skill'
      When call grep -c 'testing' "$RULE"
      The status should be success
      The output should not equal '0'
    End
  End
End
