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

    # Scoped to the frontmatter block, not the whole file: an unscoped grep is
    # satisfied by a body line, so a renamed key plus any stray `name: testing`
    # in the prose would keep this green.
    frontmatter_name() {
      sed -n '2,/^---$/p' "$SKILL_DIR/SKILL.md" | grep -c '^name: testing$'
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
      When call frontmatter_name
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'cited paths'
    # Every `spec/...` path the three files mention, deduped. `grep` over the
    # set rather than per-file: the claim is about the skill as a whole, and
    # one failure naming the missing path is what a reader needs.
    #
    # Both extensions, because the skill documents the vitest suite as well as
    # the shell one: an `.sh`-only pattern left `spec/js/harness.mjs` and
    # `spec/js/generated/workflow.mjs` ungated the moment they were cited.
    # `grep -E` and not a BRE alternation: BSD grep reads `\|` as a literal
    # bar, which is the vacuity this skill documents in tests.md.
    cited_specs() {
      grep -Eho 'spec/[A-Za-z0-9_./-]*\.(sh|mjs)' \
        "$SKILL_DIR/SKILL.md" "$SKILL_DIR/tests.md" "$SKILL_DIR/mocking.md" \
        | sort -u
    }

    # `spec/js/generated/` is gitignored: generate.mjs writes the projection
    # before the vitest suite runs, so it is legitimately absent on a clean
    # checkout and cannot be existence-checked here.
    missing_specs() {
      cited_specs | while IFS= read -r p; do
        case "$p" in
          spec/js/generated/*) continue ;;
        esac
        [ -f "$SHELLSPEC_PROJECT_ROOT/$p" ] || printf '%s\n' "$p"
      done
    }

    # A pass value of zero proves nothing unless the scan is shown to find
    # anything at all, and an empty citation list would pass `missing_specs`
    # silently. These two `include` lines are the positive control: each dies
    # on a scan that returns nothing, and the second dies specifically on an
    # `.sh`-only pattern.
    It 'cites spec files at all, in both suites'
      When call cited_specs
      The output should include 'spec/spec_helper.sh'
      The output should include 'spec/js/harness.mjs'
    End

    It 'cites no spec file that does not exist'
      When call missing_specs
      The output should equal ''
    End
  End

  Describe 'relative links'
    # Same silent rot class as a cited spec path: a moved target still reads
    # correctly in prose. Each link is resolved against the file carrying it.
    # Only relative targets; a URL has no on-disk answer to check.
    link_targets() {
      for f in "$SKILL_DIR"/*.md; do
        grep -o ']([A-Za-z0-9_.][A-Za-z0-9_./-]*)' "$f" \
          | sed 's/^](//; s/)$//' \
          | while IFS= read -r target; do
              printf '%s\t%s\n' "$f" "$target"
            done
      done
    }

    broken_links() {
      link_targets | while IFS="$(printf '\t')" read -r f target; do
        [ -e "${f%/*}/$target" ] || printf '%s -> %s\n' "${f##*/}" "$target"
      done
    }

    # Positive control: an empty scan would pass `broken_links` silently.
    It 'finds the reference files linked from SKILL.md'
      When call link_targets
      The output should include 'tests.md'
      The output should include 'mocking.md'
      The output should include '../../../CLAUDE.md'
    End

    It 'resolves every relative link it carries'
      When call broken_links
      The output should equal ''
    End
  End

  Describe 'cited helpers'
    # `common_jq`, `adapter_jq`, `use_fixture` and the `mock_gh_*` registration
    # functions are each named in the skill as living in spec_helper.sh, which
    # is what makes the title below true of every row. `phrase_in`, `count_in`
    # and `rule_in` are named as prose-pin helpers and are deliberately
    # per-file, so they are not asserted here.
    Parameters
      common_jq
      adapter_jq
      use_fixture
      mock_gh_reset
      mock_gh_reply
      mock_gh_fail
      mock_gh_requests
    End

    It "finds $1 where the skill says it lives"
      When call grep -c "^$1()" "$SHELLSPEC_PROJECT_ROOT/spec/spec_helper.sh"
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the path rule that points at it'
    # An unanchored `spec/**` is the one form whose behavior is not documented
    # (matched relative to the project root, or against an absolute path?), and
    # a pattern that matches nothing fails silently: the skill simply never
    # loads. The three pre-existing rules all anchor with a leading `**/`.
    It 'anchors its paths glob the way every other rule in this repo does'
      When call grep -c '^  - "\*\*/spec/\*\*"$' "$RULE"
      The status should be success
      The output should equal '1'
    End

    # The backtick-delimited name, not the bare word: `grep -c testing` is
    # kept alive by the surrounding prose, so renaming the skill to
    # `testing-strategy` left the rule pointing at nothing and the example
    # green. The backticks are escaped inside double quotes rather than
    # single-quoted, which is what keeps ShellCheck's SC2016 quiet without a
    # directive.
    It 'names the skill it points at'
      When call grep -c "\`testing\`" "$RULE"
      The status should be success
      The output should not equal '0'
    End
  End

  Describe 'the New script pointer from the root CLAUDE.md'
    # Neither existing gate above catches this class of rot: "cited paths"
    # only scans for `spec/*.sh`/`.mjs`, and "relative links" only reads
    # $SKILL_DIR/*.md, not the root CLAUDE.md that links into it. A renamed
    # or deleted "## New script" heading would leave CLAUDE.md's link
    # resolving to nothing and this file's guidance silently orphaned.
    ROOT_CLAUDE="$SHELLSPEC_PROJECT_ROOT/CLAUDE.md"

    It 'links from the root CLAUDE.md to the New script section'
      When call grep -c '\.claude/skills/testing/SKILL\.md#new-script)' "$ROOT_CLAUDE"
      The status should be success
      The output should equal '1'
    End

    It 'still has the heading that link names'
      When call grep -c '^## New script$' "$SKILL_DIR/SKILL.md"
      The status should be success
      The output should equal '1'
    End
  End
End
