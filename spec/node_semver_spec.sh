#!/bin/sh
# shellcheck shell=sh
# ShellCheck cannot follow shellspec's DSL: after a Mock/End block it treats
# every later Describe/It as unreachable, and the DSL blocks as uncalled
# functions. Both are inference failures, not findings.
# shellcheck disable=SC2317,SC2329
# node.sh compare_versions, and the range predicate behind validate.
#
# The ordering chain below is the example from semver.org section 11. It exists
# because a real bug shipped here: jq's `tonumber?` emits *empty* rather than
# null for a non-numeric identifier, which silently dropped that identifier from
# the comparison and reversed results such as rc.1 vs beta.11.

Describe 'node.sh compare_versions'

  Describe 'ordering'
    Parameters
      # left            right             expected result
      "4.17.15"         "4.18.2"          -1   # numeric core
      "9.0.0"           "10.0.0"          -1   # 9 below 10, not lexically above
      "1.2.3"           "1.10.0"          -1
      "2.0.0"           "1.9.9"            1
      "1.0.0"           "1.0.0"            0
      "1.0.0+build.1"   "1.0.0"            0   # build metadata ignored
      "v2.0.0"          "2.0.0"            0   # leading v tolerated
      "1.0.0-alpha"     "1.0.0"           -1   # prerelease below its release
      "1.0.0-alpha"     "1.0.0-alpha.1"   -1   # prefix below longer prerelease
      "1.0.0-alpha.1"   "1.0.0-alpha.beta" -1  # numeric ident below alphanumeric
      "1.0.0-alpha.beta" "1.0.0-beta"     -1
      "1.0.0-beta.2"    "1.0.0-beta.11"   -1   # identifiers compare numerically
      "1.0.0-beta.11"   "1.0.0-rc.1"      -1
      "1.0.0-rc.1"      "1.0.0-beta.11"    1   # rc outranks beta
    End

    It "orders $1 against $2"
      When call adapter_jq '.result' compare_versions "$1" "$2"
      The status should be success
      The output should equal "$3"
    End
  End

  Describe 'delta classification'
    Parameters
      "1.0.0"         "2.0.0"         major
      "1.0.0"         "1.1.0"         minor
      "1.0.0"         "1.0.1"         patch
      "0.5.3"         "0.5.4"         patch
      "0.5.3"         "0.6.0"         minor
      "1.0.0"         "1.0.0"         none
      "1.0.0-alpha"   "1.0.0"         prerelease
      "4.0.18"        "4.1.0"         minor
    End

    It "classifies $1 -> $2 as $3"
      When call adapter_jq '.delta' compare_versions "$1" "$2"
      The status should be success
      The output should equal "\"$3\""
    End
  End

  It 'requires two versions'
    When run script "$ADAPTER" compare_versions 1.0.0
    The status should not equal 0
    The stderr should be present
  End
End

# `satisfies` is internal, so it is exercised through validate against a fixture
# whose resolved versions are known: undici resolves to 5.28.4 and 6.19.8, and
# lodash to 4.17.21.
Describe 'node.sh validate (range satisfaction)'
  After 'cleanup_fixture'

  It 'accepts only the in-range version for a major-bounded range'
    use_fixture yarn-berry
    When call adapter_jq '{ok, violations: [.violations[].version]}' validate undici '>=6.19.0 <7'
    The status should not equal 0
    The output should equal '{"ok":false,"violations":["5.28.4"]}'
  End

  It 'passes when the range covers every resolved version'
    use_fixture yarn-berry
    When call adapter_jq '{ok, checked}' validate undici '>=5.0.0'
    The status should be success
    The output should equal '{"ok":true,"checked":2}'
  End

  It 'expands a caret to a major bound'
    use_fixture yarn-berry
    When call adapter_jq '[.violations[].version]' validate undici '^6.19.0'
    The status should not equal 0
    The output should equal '["5.28.4"]'
  End

  It 'expands a tilde to a minor bound'
    use_fixture yarn-berry
    When call adapter_jq '.ok' validate lodash '~4.17.0'
    The status should be success
    The output should equal 'true'
  End

  It 'rejects a tilde bound the version falls outside'
    use_fixture yarn-berry
    When call adapter_jq '.ok' validate lodash '~4.16.0'
    The status should not equal 0
    The output should equal 'false'
  End

  # A bug here collapsed alternatives into one impossible conjunction, which
  # made every || range unsatisfiable.
  It "ORs || alternatives rather than merging them into one conjunction"
    use_fixture yarn-berry
    When call adapter_jq '{ok, checked}' validate undici '^5.28.0 || ^6.19.0'
    The status should be success
    The output should equal '{"ok":true,"checked":2}'
  End

  It 'ANDs comma-separated comparators'
    use_fixture yarn-berry
    When call adapter_jq '.ok' validate lodash '>=4.17.0, <5'
    The status should be success
    The output should equal 'true'
  End

  It 'accepts an exact pin'
    use_fixture yarn-berry
    When call adapter_jq '.ok' validate lodash '4.17.21'
    The status should be success
    The output should equal 'true'
  End

  It 'refuses when the package is absent rather than reporting a pass'
    use_fixture yarn-berry
    When run script "$ADAPTER" validate not-installed-anywhere '>=1.0.0'
    The status should not equal 0
    The stderr should include 'no versions'
  End
End
