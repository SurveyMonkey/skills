#!/bin/sh
# shellcheck shell=sh
# The pin audit's `why-<package>.json` scratch path (issue #142). A scoped
# package name substituted raw breaks the redirect: `$ADAPTER why @babel/traverse
# > "$WORK/why-@babel/traverse.json"` targets a directory `$WORK` never creates,
# because the slash in the package name reads as a path separator. Sibling
# spec/fix_dependency_scratch_spec.sh pins the same slug rule in
# agents/fix-dependency.md, the definition this one was mirrored from.

Describe 'the why-file scratch path is package-qualified (#142)'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/audit-pins.md"

  # `rule_in`/`count_in`, as in spec/audit_pins_rules_spec.sh and
  # spec/fix_dependency_scratch_spec.sh: counts matching lines.
  rule_in() { grep -c -e "$2" -- "$1"; }
  # `grep -c` exits 1 on no match, which is the expected answer for a shape
  # that must be ABSENT, so this reports the count without failing on it.
  count_in() { grep -c -e "$2" -- "$1" || true; }
  # A local `phrase_in`, distinct from spec/audit_pins_rules_spec.sh's (line 78),
  # which flattens without squeezing whitespace and so is sensitive to the extra
  # leading spaces a bullet's indented continuation introduces after
  # `tr '\n' ' '`. This one squeezes runs of spaces first, matching
  # spec/fix_dependency_scratch_spec.sh's helper, so a fragment spanning a
  # line-wrap boundary still matches regardless of how the document wraps.
  phrase_in() { tr '\n' ' ' < "$1" | tr -s ' ' | grep -o -e "$2" | wc -l | tr -d ' '; }

  # The scratch-inventory mention (phase 1's `$WORK` container description),
  # the write site (phase 5's merge-risk scoring), and the `--why-json` consume
  # site: three lines carry the literal.
  It 'names the package-qualified path three times: inventory, write, consume'
    When call rule_in "$AGENT" 'why-<package>\.json'
    The status should be success
    The output should equal '3'
  End

  It 'writes the why capture to a package-qualified path'
    When call rule_in "$AGENT" \
      '[$]ADAPTER why <package> > "[$]WORK/why-<package>[.]json"'
    The status should be success
    The output should not equal '0'
  End

  It 'passes the same package-qualified path to score-merge-risk.sh'
    When call rule_in "$AGENT" \
      '--why-json "[$]WORK/why-<package>[.]json"'
    The status should be success
    The output should not equal '0'
  End

  # No unqualified why.json literal should remain anywhere in the document.
  # "why-<package>.json" never contains the bare substring "why.json", so this
  # pattern only matches a literal that skipped qualification.
  It 'has no remaining unqualified why.json literal'
    When call count_in "$AGENT" 'why\.json'
    The status should be success
    The output should equal '0'
  End

  # Finding: `<package>` substituted raw breaks the redirect for a scoped
  # package, since `$WORK/why-@babel/` is never created
  # (`$WORK/why-@babel/traverse.json`). The doc must say to slash-to-dash slug
  # the name before it goes into this one filename. Deleting the rule must fail
  # the suite (mutation-tested finding).
  It 'states the slash-to-dash slug rule for a scoped package name'
    When call rule_in "$AGENT" 'Slug .<package>. before it goes into that filename'
    The status should be success
    The output should not equal '0'
  End

  It 'gives the slug rule the concrete scoped-package example'
    When call rule_in "$AGENT" 'why-@babel-traverse\.json'
    The status should be success
    The output should not equal '0'
  End

  # audit-pins scores many packages inside one $WORK, sequentially, unlike
  # fix-dependency's one-package-per-agent shape; the slug rule's rationale
  # must say what qualification actually prevents here, not borrow
  # fix-dependency's sibling-agent framing verbatim.
  It 'grounds the slug rule in scoring many packages in the same WORK'
    When call phrase_in "$AGENT" \
      'This run scores many packages in the same .[$]WORK., one after another'
    The status should be success
    The output should equal '1'
  End
End
