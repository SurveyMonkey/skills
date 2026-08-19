#!/bin/sh
# shellcheck shell=sh
# node.sh validate: line scoping and alert-completeness.
#
# Range satisfaction itself is covered in node_semver_spec.sh. What lives here
# is the check that makes validate authoritative on whether the alerts were
# actually cleared (issue #19): meeting a major-bounded constraint on the copy
# you fixed says nothing about the copies you did not.
#
# The yarn-multi-major fixture reproduces the report: undici resolved at 5.29.0,
# 6.24.1 and 7.27.2 at once, with the 5.x copy patched only in the 6.x line.

Describe 'node.sh validate --line'
  After 'cleanup_fixture'

  # `--line` refuses to run without alert ranges (see the completeness Describe
  # below), so the line-scoping examples pass one that no resolved copy matches.
  # It exercises the scoping question and nothing else.
  NOHIT='< 1.0.0'

  # Without scoping, no single major-bounded range can pass a package resolved
  # at three majors, so every line's fix would look like a failure.
  It 'fails an unscoped major-bounded range against a multi-major package'
    use_fixture yarn-multi-major
    When call adapter_jq '{ok, violations: [.violations[].version]}' validate undici '>=7.27.0 <8'
    The status should not equal 0
    The output should equal '{"ok":false,"violations":["5.29.0","6.24.1"]}'
  End

  It 'checks only the targeted line and ignores the other lines'
    use_fixture yarn-multi-major
    When call adapter_jq '{ok, line, checked, resolved_count, violations}' \
      validate --line 7 --vulnerable "$NOHIT" undici '>=7.0.0 <8'
    The status should be success
    The output should equal '{"ok":true,"line":"7","checked":1,"resolved_count":3,"violations":[]}'
  End

  Describe 'line membership'
    Parameters
      # line  constraint       checked  exit
      5       '>=5.0.0 <6'     1        0
      6       '>=6.0.0 <7'     1        0
      7       '>=7.0.0 <8'     1        0
      9       '>=9.0.0 <10'    0        1   # nothing resolved in that line
    End

    It "counts the copies in the $1.x line"
      use_fixture yarn-multi-major
      When call adapter_jq '.checked' validate --line "$1" --vulnerable "$NOHIT" undici "$2"
      The status should equal "$4"
      The output should equal "$3"
    End
  End

  # A group whose line is not installed at all validated nothing; reporting that
  # as a pass is the same class of bug as treating zero parsed lockfile entries
  # as a clean result.
  It 'refuses to pass a line with no resolved copy'
    use_fixture yarn-multi-major
    When call adapter_jq '{ok, line_present, checked}' \
      validate --line 9 --vulnerable "$NOHIT" undici '>=9.0.0 <10'
    The status should not equal 0
    The output should equal '{"ok":false,"line_present":false,"checked":0}'
  End

  It 'rejects a non-numeric line'
    use_fixture yarn-multi-major
    When run script "$ADAPTER" validate --line six undici '>=6.0.0 <7'
    The status should not equal 0
    The stderr should include 'must be a major number'
  End

  # The completeness guarantee has to be a mechanism, not prose in the agent
  # definition: a line-scoped run with no alert ranges checked one narrow
  # constraint and reported ok, while copies in the line still matched the
  # group's advisories.
  It 'refuses a line-scoped run carrying no alert ranges'
    use_fixture yarn-multi-major
    When run script "$ADAPTER" validate --line 7 undici '>=7.0.0 <8'
    The status should not equal 0
    The stderr should include '--line requires at least one --vulnerable range'
  End

  It 'rejects an unknown option rather than treating it as a package name'
    use_fixture yarn-multi-major
    When run script "$ADAPTER" validate --nope undici '>=6.0.0 <7'
    The status should not equal 0
    The stderr should include 'unknown option'
  End
End

Describe 'node.sh validate --vulnerable (completeness)'
  After 'cleanup_fixture'

  # The exact shape of the silent partial fix: the constraint is satisfied by
  # every copy in the line, and the alert is still open against one of them.
  # Constraint-only validation reported that as success.
  It 'fails a satisfied constraint when a copy still matches an alert range'
    use_fixture yarn-multi-major
    When call adapter_jq '{ok, violations, unresolved: [.unresolved_alerts[].version]}' \
      validate --line 6 --vulnerable '< 6.28.0' undici '>=6.24.0 <7'
    The status should not equal 0
    The output should equal '{"ok":false,"violations":[],"unresolved":["6.24.1"]}'
  End

  It 'passes when no resolved copy matches any alert range'
    use_fixture yarn-multi-major
    When call adapter_jq '{ok, unresolved_alerts, requires_major_bump}' \
      validate --line 7 --vulnerable '>= 7.0.0, < 7.27.0' undici '>=7.0.0 <8'
    The status should be success
    The output should equal '{"ok":true,"unresolved_alerts":[],"requires_major_bump":[]}'
  End

  # The 5.29.0 copy matches `< 6.28.0`, whose only patched version lives in the
  # 6.x line: no override bounded to 5.x can clear it, so it is reported for a
  # major bump rather than counted as an ordinary miss.
  It 'reports a copy below the line as requiring a major bump'
    use_fixture yarn-multi-major
    When call adapter_jq '{bump: [.requires_major_bump[] | {version, vulnerable_ranges}], unresolved: [.unresolved_alerts[].version]}' \
      validate --line 6 --vulnerable '< 6.28.0' undici '>=6.28.0 <7'
    The status should not equal 0
    The output should equal '{"bump":[{"version":"5.29.0","vulnerable_ranges":["< 6.28.0"]}],"unresolved":["6.24.1"]}'
  End

  # Once the 6.x line is actually fixed, the 5.x copy is all that remains, and
  # it must not silently pass as a clean result either.
  It 'keeps a major-bump copy visible after its own line is clear'
    use_fixture yarn-multi-major
    When call adapter_jq '{ok, bump: [.requires_major_bump[].version], unresolved: [.unresolved_alerts[].version]}' \
      validate --line 6 --vulnerable '< 6.24.0' undici '>=6.24.0 <7'
    The status should be success
    The output should equal '{"ok":true,"bump":["5.29.0"],"unresolved":[]}'
  End

  # Advisory syntax puts a space after the operator, which the range tokenizer
  # used to split into a bare "<" and a bare version: read as "less than
  # nothing AND exactly 6.28.0", and fatal on the empty version.
  Describe 'advisory range syntax'
    Parameters
      # advisory range                             versions it still flags   exit
      '< 6.28.0'                                   '["5.29.0","6.24.1"]'     1
      '>= 7.0.0, < 7.29.0'                         '["7.27.2"]'              1
      '>= 6.0.0, < 6.24.2'                         '["6.24.1"]'              1
      '< 5.29.0'                                   '[]'                      0
      '>= 5.0.0, < 5.30.0 || >= 7.0.0, < 7.28.0'   '["5.29.0","7.27.2"]'     1
    End

    It "matches resolved copies against $1"
      use_fixture yarn-multi-major
      When call adapter_jq '[(.unresolved_alerts[], .requires_major_bump[]) | .version] | sort' \
        validate --vulnerable "$1" undici '>=5.0.0'
      The status should equal "$3"
      The output should equal "$2"
    End
  End

  # Range satisfaction answers false for a token it cannot read. On the
  # constraint side that is the safe answer; here it would mark every resolved
  # copy not vulnerable, so an unreadable range has to be an error naming
  # itself rather than a silent pass.
  Describe 'unparseable alert ranges'
    Parameters
      typo       'foo'
      wildcard   '*'
      operator   '>= '
      words      'all versions before 6.28.0'
    End

    It "refuses the range $2"
      use_fixture yarn-multi-major
      When run script "$ADAPTER" validate --vulnerable "$2" undici '>=5.0.0'
      The status should not equal 0
      The stderr should include 'is not a parseable version range'
    End
  End

  It 'refuses an empty alert range rather than dropping it'
    use_fixture yarn-multi-major
    When run script "$ADAPTER" validate --vulnerable '' undici '>=5.0.0'
    The status should not equal 0
    The stderr should include '--vulnerable requires a range'
  End

  # The forms real advisories use. Each is chosen to match no resolved copy, so
  # a pass here means the strict parse accepted it, not that the fixture
  # happened to be clean of that range. The matching side is covered above.
  Describe 'accepted advisory range forms'
    Parameters
      simple     '< 1.0.0'
      comma      '>= 7.0.0, < 7.27.0'
      spaceless  '>=6.0.0 <6.24.0'
      alternates '>= 2.0.0, < 3.0.0 || >= 8.0.0, < 9.0.0'
      exact      '= 4.0.0'
      prerelease '>= 1.0.0-beta.1, < 1.0.0'
    End

    It "accepts $2"
      use_fixture yarn-multi-major
      When call adapter_jq '{ok, unresolved_alerts}' validate --vulnerable "$2" undici '>=5.0.0'
      The status should be success
      The output should equal '{"ok":true,"unresolved_alerts":[]}'
    End
  End

  It 'stays backward compatible when no alert ranges are supplied'
    use_fixture yarn-berry
    When call adapter_jq '{ok, checked, unresolved_alerts, requires_major_bump}' validate undici '>=5.0.0'
    The status should be success
    The output should equal '{"ok":true,"checked":2,"unresolved_alerts":[],"requires_major_bump":[]}'
  End
End
