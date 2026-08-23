#!/bin/sh
# shellcheck shell=sh
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

  # The delta saturates at "major" by design; the distance is what tells a
  # one-major bump apart from a jump that skips a whole line (issue #21).
  Describe 'major distance'
    Parameters
      "9.0.1"    "11.1.1"   2
      "9.0.1"    "10.0.0"   1
      "1.0.0"    "1.9.9"    0
      "11.1.1"   "9.0.1"    2   # a downgrade is the same distance
      "0.5.3"    "0.6.0"    0
    End

    It "measures $1 -> $2 as $3 major line(s)"
      When call adapter_jq '.major_distance' compare_versions "$1" "$2"
      The status should be success
      The output should equal "$3"
    End
  End

  It 'requires two versions'
    When run script "$ADAPTER" compare_versions 1.0.0
    The status should not equal 0
    The stderr should be present
  End
End

# range_facts answers what a dependent's declared range says about the version
# a fix landed on: is it still admitted, how many major lines past the range's
# floor is it, and was the range a pin rather than a caret.
Describe 'node.sh range_facts'
  Describe 'floor, distance, and pin shape'
    Parameters
      # range              version   satisfied pinned floor ahead
      "^9"                 11.1.1    false     false  9     2
      "^9"                 9.5.0     true      false  9     0
      "^11"                11.1.1    true      false  11    0
      "~6.14.0"            6.14.3    true      true   6     0
      "~6.14.0"            7.0.0     false     true   6     1
      "1.0.0"              2.0.0     false     true   1     1
      ">=1.0.0 <2.0.0"     3.0.0     false     true   1     2
      ">=1.0.0"            3.0.0     true      false  1     2
      "^5.28.0 || ^6.19.0" 6.19.8    true      false  5     1
      "^9"                 7.0.0     false     false  9     0   # below the floor
      "1.x"                1.9.9     true      false  1     0   # x-range is ^1
      "1.x"                2.0.0     false     false  1     1
      "1.2.x"              1.2.9     true      true   1     0   # bounded to a minor
    End

    It "reads '$1' against $2"
      When call adapter_jq '[.satisfied, .pinned, .floor_major, .majors_ahead]' \
        range_facts "$1" "$2"
      The status should be success
      The output should equal "[$3,$4,$5,$6]"
    End
  End

  # A wildcard has no floor to measure from. Reporting 0 would be a lie the
  # scorer could not tell apart from "declared exactly this major".
  It 'reports no floor for a range with no lower bound'
    When call adapter_jq '{parseable, satisfied, floor_major, majors_ahead}' range_facts '*' 11.1.1
    The status should be success
    The output should equal '{"parseable":true,"satisfied":true,"floor_major":null,"majors_ahead":null}'
  End

  # A specifier that is not a version range at all. `satisfies` answers false
  # for anything it cannot tokenize, which read as "this dependent was left
  # behind by the fix" — a fact nobody established.
  Describe 'specifiers that are not version ranges'
    Parameters
      "latest"
      "workspace:^"
      "git+https://github.com/example/pkg.git"
      "npm:other-pkg@^1.0.0"
      "file:../local"
    End

    It "reports '$1' as unreadable rather than unsatisfied"
      When call adapter_jq '[.parseable, .satisfied, .pinned, .floor_major, .majors_ahead]' \
        range_facts "$1" 11.2.0
      The status should be success
      The output should equal '[false,null,null,null,null]'
    End
  End

  It 'requires a range and a version'
    When run script "$ADAPTER" range_facts '^9'
    The status should not equal 0
    The stderr should be present
  End
End

# declared_ranges replaces a shell loop in the agent definition that the
# preflight catalog could not pre-approve, discarded every per-parent error,
# and never looked at optionalDependencies.
Describe 'node.sh declared_ranges'
  After 'cleanup_fixture'

  # The npm fixture installs express and not test-exclude. The installed
  # manifest answers for express; test-exclude has none, so its declaration is
  # read from the lockfile rather than lost (issue #85).
  It 'unions the parent declarations and the root manifest'
    use_fixture npm-v3
    When call adapter_jq '{ranges, root_range}' declared_ranges lodash
    The status should be success
    The output should equal '{"ranges":["^3.0.0","^4.17.20","^4.17.21"],"root_range":"^4.17.21"}'
  End

  # `parents_unreadable` is now what it says: nobody could read the
  # declaration, from either source. A parent with no installed manifest is not
  # that, as long as the lockfile records what it declares — reporting it as
  # unreadable is what put the field test's only parent in that list and left
  # the fix with no range at all (issue #85).
  It 'reads a parent with no installed manifest out of the lockfile'
    use_fixture npm-v3
    When call adapter_jq '{parents_read, parents_unreadable}' declared_ranges lodash
    The status should be success
    The output should equal '{"parents_read":["express","test-exclude"],"parents_unreadable":[]}'
  End

  # The lockfile records sha.js under express's optionalDependencies and under
  # serve-static's peerDependencies, so this reads two ranges the
  # `.dependencies`-only parent query never reached the manifest to find.
  It 'reads optionalDependencies and peerDependencies, which the loop it replaced did not'
    use_fixture npm-v3
    When call adapter_jq '.ranges' declared_ranges 'sha.js'
    The status should be success
    The output should equal '["^2.4.0","^2.4.11"]'
  End

  # A parent whose installed manifest declares the package in no block at all
  # is legitimate under version skew, and it is not the same fact as a parent
  # nobody could read. `express` is a lockfile parent of @babel/core; its
  # installed manifest never mentions it, and the installed manifest is what
  # answers for a parent that has one.
  It 'separates a parent that declared nothing from one it could not read'
    use_fixture npm-v3
    When call adapter_jq '{ranges, parents_read, parents_without_range, parents_unreadable}' declared_ranges '@babel/core'
    The status should be success
    The output should equal '{"ranges":[],"parents_read":["express"],"parents_without_range":["express"],"parents_unreadable":[]}'
  End

  # A manifest on disk that will not parse dropped its range and still counted
  # as read, so the partial-view disclosure in the PR body never fired for it.
  # It stays unreadable rather than falling back to the lockfile: a corrupt
  # install is a fact the reviewer needs, not one to paper over.
  It 'files a parent with an unparseable manifest as unreadable, not read'
    use_fixture npm-v3
    printf 'not json at all\n' > node_modules/express/package.json
    When call adapter_jq '{ranges, parents_read, parents_unreadable, parents_malformed}' declared_ranges lodash
    The status should be success
    The output should equal '{"ranges":["^3.0.0","^4.17.21"],"parents_read":["test-exclude"],"parents_unreadable":["express"],"parents_malformed":["express"]}'
  End

  # `npm_parents` and `yarn_parents` count a parent that declares the package
  # through an `npm:` alias, but this verb looked the package up under its own
  # name only — so that parent came back in `parents_without_range`, labelled as
  # declaring nothing, with node.sh's own comment rationalizing the label as
  # version skew. It in fact declares `npm:lodash@^4.18.0`, a live range that
  # keeps readmitting vulnerable versions and never reaches the PR body
  # (issue #48). The alias is read under either source: `alias-parent` from its
  # installed manifest, `dupe-parent` from the lockfile.
  It 'reads the range out of a parent alias declaration'
    use_fixture npm-alias-installed
    When call adapter_jq '{ranges, parents_read, parents_without_range, parents_unreadable}' declared_ranges lodash
    The status should be success
    The output should equal '{"ranges":["^4.17.21","^4.18.0"],"parents_read":["alias-parent","dupe-parent"],"parents_without_range":[],"parents_unreadable":[]}'
  End

  # The root is a dependent like any other, and this one declares lodash only
  # through `aliased: "npm:lodash@4.17.21"`. Reported as no root range at all,
  # it took the fix's most reliable input away on precisely the repositories
  # where the copy is hardest to find (issues #47, #48).
  It 'reads the root range out of an alias declaration too'
    use_fixture yarn-alias
    When call adapter_jq '{ranges, root_range}' declared_ranges lodash
    The status should be success
    The output should equal '{"ranges":["4.17.21"],"root_range":"4.17.21"}'
  End

  # Yarn PnP installs no node_modules at all. Every parent range used to
  # vanish with it, leaving the root manifest as the whole answer; the lockfile
  # has them, and a fix worktree before `install` is in exactly this state
  # (issue #85).
  It 'reads every parent from the lockfile when no manifest is installed'
    use_fixture yarn-berry
    When call adapter_jq '{ranges, parents_read, parents_unreadable}' declared_ranges lodash
    The status should be success
    The output should equal '{"ranges":["^4.17.20","^4.17.21"],"parents_read":["express"],"parents_unreadable":[]}'
  End

  It 'requires a package name'
    use_fixture npm-v3
    When run script "$ADAPTER" declared_ranges
    The status should not equal 0
    The stderr should include 'requires a package name'
  End
End

# --line, the F7 scoping fix (issue #76).
#
# The fixture is trimmed from arsenalamerica/app at the commit that opened its
# PR #300: undici resolved at 5.29.0, 6.27.0 and 7.28.0 simultaneously, five
# parents declaring across all three lines, and a fix scoped to line 7 moving
# 7.28.0 -> 7.29.0. Collecting every declaration of the name regardless of
# which copy the parent resolves to scored that minor bump as two major lines
# crossed plus a crossed pin, on the strength of 5.x and 6.x parents a
# line-bounded override never touches.
Describe 'node.sh declared_ranges --line'
  After 'cleanup_fixture'

  It 'collects every line without --line, the shape that mis-scored #300'
    use_fixture yarn-line-scoped
    When call adapter_jq '{ranges, line, parents_other_lines}' declared_ranges undici
    The status should be success
    The output should equal '{"ranges":["5.28.4","5.29.0","^6.22.0","^6.23.0","^7.27.1"],"line":null,"parents_other_lines":[]}'
  End

  It 'keeps only the ranges of parents resolved on the fix line'
    use_fixture yarn-line-scoped
    When call adapter_jq '{ranges, line}' declared_ranges --line 7 undici
    The status should be success
    The output should equal '{"ranges":["^7.27.1"],"line":7}'
  End

  # The excluded parents must not be laundered through a list that means
  # something else: they were read fine and they declare a range, it is simply
  # a range for a copy this fix does not move.
  It 'files the excluded parents under their own field, not as unread or rangeless'
    use_fixture yarn-line-scoped
    When call adapter_jq '{parents_read, parents_other_lines, parents_without_range, parents_unreadable, parents_malformed}' \
      declared_ranges --line 7 undici
    The status should be success
    The output should equal '{"parents_read":["@vercel/sandbox"],"parents_other_lines":["@sentry/cli","@vercel/blob","@vercel/node","vercel"],"parents_without_range":[],"parents_unreadable":[],"parents_malformed":[]}'
  End

  # Dropping a range on a guess lowers a risk score silently, so a parent whose
  # own copy cannot be found on disk is kept rather than excluded.
  It 'keeps a parent whose resolved copy cannot be determined'
    use_fixture yarn-line-scoped
    rm -rf node_modules/undici node_modules/vercel/node_modules node_modules/@vercel/sandbox/node_modules
    When call adapter_jq '{ranges, parents_other_lines}' declared_ranges --line 7 undici
    The status should be success
    The output should equal '{"ranges":["5.28.4","5.29.0","^6.22.0","^6.23.0","^7.27.1"],"parents_other_lines":[]}'
  End

  It 'rejects a --line that is not a major number'
    use_fixture yarn-line-scoped
    When run script "$ADAPTER" declared_ranges --line 7.x undici
    The status should not equal 0
    The stderr should include 'must be a major number'
  End

  # A parent in the tree at two versions is the shape the installed manifest
  # cannot describe: one file, one range, and `resolved_major_for_parent`
  # answering about the hoisted copy or (under PnP, and in the pre-install
  # worktree a fix runs in) about nothing at all. On arsenalamerica/app the
  # live run returned `parents_read: []`, `parents_unreadable: ["minimatch"]`
  # and no ranges, while the lockfile recorded both copies and both
  # declarations ([#85](https://github.com/SurveyMonkey/skills/issues/85)).
  Describe 'a parent resolved at more than one version'
    It 'takes the range from the copy that resolves on the fix line'
      use_fixture yarn-cross-line
      When call adapter_jq '{ranges, parents_read, parents_unreadable, parents_other_lines}' \
        declared_ranges --line 5 brace-expansion
      The status should be success
      The output should equal '{"ranges":["^5.0.5"],"parents_read":["minimatch"],"parents_unreadable":[],"parents_other_lines":["minimatch@3.1.5"]}'
    End

    # The same parent, the other line: neither copy is the parent's "real" one,
    # so the version is what makes the two legible in the two lists.
    It 'takes the other copy for the other line'
      use_fixture yarn-cross-line
      When call adapter_jq '{ranges, parents_read, parents_other_lines}' \
        declared_ranges --line 1 brace-expansion
      The status should be success
      The output should equal '{"ranges":["^1.1.7"],"parents_read":["minimatch"],"parents_other_lines":["minimatch@10.2.5"]}'
    End

    It 'unions both copies when no line is given'
      use_fixture yarn-cross-line
      When call adapter_jq '{ranges, parents_other_lines}' declared_ranges brace-expansion
      The status should be success
      The output should equal '{"ranges":["^1.1.7","^5.0.5"],"parents_other_lines":[]}'
    End

    # npm nests the second copy instead of listing it twice at the top level,
    # and the walk up `node_modules` is what says which copy `test-exclude`
    # reaches. `express` has an installed manifest and one copy, so its range
    # still comes from disk; its own lodash copy is not on disk at all, which
    # keeps it in the over-reporting direction rather than dropping its range.
    It 'walks up node_modules for an npm parent with a nested copy'
      use_fixture npm-v3
      When call adapter_jq '{ranges, parents_read, parents_other_lines}' declared_ranges --line 4 lodash
      The status should be success
      The output should equal '{"ranges":["^4.17.20","^4.17.21"],"parents_read":["express"],"parents_other_lines":["test-exclude@6.0.0"]}'
    End

    # The verdict: the range that reaches the PR body is what the scorer turns
    # into a merge-risk number, and collecting the 1.x parent's declaration for
    # a 5.x fix scores a patch bump as four major lines crossed.
    Describe 'the score those ranges produce'
      score_brace() {
        "$ADAPTER" why brace-expansion > why.json 2>/dev/null || true
        set -- --package brace-expansion --before 5.0.6 --after 5.0.9 \
               --adapter "$ADAPTER" --why-json why.json --override-scope scoped "$@"
        "$COMMON/score-merge-risk.sh" "$@" \
          | jq -c '{f7: .factors[6].score, evidence: .factors[6].evidence}'
      }

      It 'scores the fix on the ranges --line 5 returns'
        use_fixture yarn-cross-line
        When call score_brace --declared-range '^5.0.5'
        The status should be success
        The output should equal '{"f7":0,"evidence":"no major line crossed; dependents declare ^5.0.5"}'
      End

      It 'reproduces the score the unfiltered collection would have produced'
        use_fixture yarn-cross-line
        When call score_brace --declared-range '^1.1.7' --declared-range '^5.0.5'
        The status should be success
        The output should equal '{"f7":2,"evidence":"4 major lines crossed; dependents declare ^1.1.7, ^5.0.5"}'
      End
    End
  End

  # The verdict, not the parse: what mattered on #300 is the number that
  # reached the PR body, so both halves are scored through score-merge-risk.sh.
  Describe 'the score those ranges produce'
    score_undici() {
      "$ADAPTER" why undici > why.json 2>/dev/null || true
      _scope=$1
      shift
      set -- --package undici --before 7.28.0 --after 7.29.0 \
             --adapter "$ADAPTER" --why-json why.json --override-scope "$_scope" "$@"
      "$COMMON/score-merge-risk.sh" "$@" \
        | jq -c '{f7: .factors[6].score, evidence: .factors[6].evidence}'
    }

    It 'reproduces the F7 of 2 the unscoped collection produced on #300'
      use_fixture yarn-line-scoped
      When call score_undici scoped --declared-range 5.28.4 --declared-range 5.29.0 \
        --declared-range '^6.22.0' --declared-range '^6.23.0' --declared-range '^7.27.1'
      The status should be success
      The output should equal '{"f7":2,"evidence":"2 major lines crossed; dependents declare 5.28.4, 5.29.0, ^6.22.0, ^6.23.0, ^7.27.1; crosses the pinned range 5.28.4"}'
    End

    It 'scores the same fix 0 on the ranges --line 7 returns'
      use_fixture yarn-line-scoped
      When call score_undici scoped --declared-range '^7.27.1'
      The status should be success
      The output should equal '{"f7":0,"evidence":"no major line crossed; dependents declare ^7.27.1"}'
    End
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
