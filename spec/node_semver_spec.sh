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

# declared_ranges replaces a shell loop in the agent definition that no
# permission rule can pre-approve, that discarded every per-parent error, and
# that never looked at optionalDependencies.
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
# The fixture is trimmed from the Yarn Berry field-test repository at the commit that
# opened its fix PR: undici resolved at 5.29.0, 6.27.0 and 7.28.0 simultaneously,
# five parents declaring across all three lines, and a fix scoped to line 7 moving
# 7.28.0 -> 7.29.0. Collecting every declaration of the name regardless of
# which copy the parent resolves to scored that minor bump as two major lines
# crossed plus a crossed pin, on the strength of 5.x and 6.x parents a
# line-bounded override never touches.
Describe 'node.sh declared_ranges --line'
  After 'cleanup_fixture'

  It 'collects every line without --line, the shape that mis-scored the field-test fix PR'
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
  # worktree a fix runs in) about nothing at all. On the Yarn Berry field-test repository
  # the live run returned `parents_read: []`, `parents_unreadable: ["minimatch"]`
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

  # A scoped package occupies two path segments, so `NPM_COPY_ROWS_JQ`'s
  # single-segment strip could not shorten a lockfile key ending in
  # `@scope/name`: `sub()` returned its input unchanged and `prefixes` recursed
  # on the same path until jq's allocator failed. On the npm field-test monorepo
  # that OOMed `declared_ranges --line` for 10 of 12 dispatched groups: every
  # group with a parent copy declared under a
  # `node_modules/@scope/name/node_modules/<parent>` key
  # ([#121](https://github.com/SurveyMonkey/skills/issues/121)).
  #
  # The fixture is that run's shape, trimmed to public names: `minimatch`
  # copies declared under `@npmcli/arborist` and `@nx/devkit`, each resolving
  # its own `brace-expansion`, and no installed manifest for the multi-copy
  # parent, so classification runs on the lockfile rows whose `resolved:`
  # candidate walk is where the recursion lived. Every example here ran
  # forever before the fix, so each runs under `deadline_adapter_jq`: a
  # regression fails in seconds instead of hanging the suite.
  Describe 'parents declared under scoped package paths'
    # Portable wall-clock guard. `timeout` is not part of stock macOS, so
    # where it is absent the adapter is backgrounded and polled; either way a
    # hang becomes a fast non-zero exit. The poll is deliberate: an earlier
    # version used a backgrounded `( sleep; kill )` watcher, and killing the
    # watcher does not kill its `sleep` child, so a finished example left an
    # orphaned sleep holding every pipe it inherited — the command
    # substitution in `deadline_adapter_jq` and shellspec's own capture fds —
    # and each passing example idled the full deadline. Polling leaves no
    # background process behind, at the cost of up to one second of
    # granularity on a kill that only fires on a regression.
    run_with_deadline() {
      _secs=$1
      shift
      if command -v timeout >/dev/null 2>&1; then
        timeout "$_secs" "$@"
        return $?
      fi
      "$@" &
      _cmd=$!
      _i=0
      while kill -0 "$_cmd" 2>/dev/null; do
        if [ "$_i" -ge "$_secs" ]; then
          kill -9 "$_cmd" 2>/dev/null
          break
        fi
        sleep 1
        _i=$((_i + 1))
      done
      wait "$_cmd"
      return $?
    }

    # `adapter_jq`, under the deadline.
    deadline_adapter_jq() {
      _filter=$1
      shift
      _st=0
      _out=$(run_with_deadline 30 "$ADAPTER" "$@") || _st=$?
      if [ -n "$_out" ]; then
        printf '%s' "$_out" | jq -c "$_filter"
        _jq=$?
        # A jq failure must not vanish behind the adapter's success: the
        # adapter's own failure stays the reported status, as in adapter_jq,
        # and jq's status fills in only when the adapter succeeded.
        [ "$_st" -ne 0 ] || _st=$_jq
      fi
      return "$_st"
    }

    # The verdict the field run never reached: the on-line copies sit under
    # scoped packages, their range is collected, and the off-line copies are
    # named away, exactly as the unscoped multi-copy examples above.
    It 'terminates and classifies parent copies declared under scoped packages'
      use_fixture npm-scoped-parents
      When call deadline_adapter_jq '{ranges, parents_read, parents_unreadable, parents_other_lines}' \
        declared_ranges --line 5 brace-expansion
      The status should be success
      The output should equal '{"ranges":["^5.0.5"],"parents_read":["minimatch"],"parents_unreadable":[],"parents_other_lines":["minimatch@7.4.9","packages/tool@1.0.0"]}'
    End

    It 'takes the unscoped copy for the 2.x line and names the scoped ones away'
      use_fixture npm-scoped-parents
      When call deadline_adapter_jq '{ranges, parents_read, parents_other_lines}' \
        declared_ranges --line 2 brace-expansion
      The status should be success
      The output should equal '{"ranges":["^2.0.2"],"parents_read":["minimatch","packages/tool"],"parents_other_lines":["minimatch@10.0.3","minimatch@10.2.5"]}'
    End

    # The second trigger shape from the field run: the declaring path ITSELF
    # ends in a scoped segment (`node_modules/@nx/devkit`), so the very first
    # strip failed to match, so a scoped parent's own declaration could never be
    # read at all.
    It 'walks a path ending in a scoped segment for a scoped parent'
      use_fixture npm-scoped-parents
      When call deadline_adapter_jq '{ranges, root_range, parents_read, parents_unreadable}' \
        declared_ranges minimatch
      The status should be success
      The output should equal '{"ranges":["10.2.5","^10.0.3","^7.4.9"],"root_range":"^7.4.9","parents_read":["@npmcli/arborist","@nx/devkit"],"parents_unreadable":[]}'
    End

    # Scoped under scoped: the field-test lockfile carries
    # `node_modules/@npmcli/arborist/node_modules/@npmcli/fs/node_modules/semver`,
    # trimmed into the fixture verbatim (all public names). The child copy's
    # walk peels two consecutive scoped segments, and the declaring path is
    # itself a scoped key nested under another scoped key.
    It 'walks a scoped parent nested under another scoped parent'
      use_fixture npm-scoped-parents
      When call deadline_adapter_jq '{ranges, parents_read, parents_unreadable}' \
        declared_ranges semver
      The status should be success
      The output should equal '{"ranges":["^7.3.5"],"parents_read":["@npmcli/fs"],"parents_unreadable":[]}'
    End

    # The progress guard, through the verb. `packages/tool` is a workspace key
    # the strip cannot shorten at all, having no `node_modules/` segment to remove,
    # so without the guard `prefixes` recurses on it forever, scoped or not.
    # With it the walk degrades to the path plus the root — for a workspace
    # key that two-entry list is the complete upward walk — and the workspace
    # parent's declaration is read and classified like any other.
    It 'degrades a path the strip cannot shorten to a finite prefix list'
      use_fixture npm-scoped-parents
      When call deadline_adapter_jq '{ranges, parents_read, parents_unreadable}' \
        declared_ranges brace-expansion
      The status should be success
      The output should equal '{"ranges":["^2.0.2","^5.0.5"],"parents_read":["minimatch","packages/tool"],"parents_unreadable":[]}'
    End

    # The guard's other branch: an unshrinkable path that still CONTAINS
    # `node_modules/` degrades to the path alone, WITHOUT the root. Offering
    # the root would let a root copy at another version become `resolved` and
    # misfile the parent into `parents_other_lines`, dropping its range; with
    # no candidates the copy resolves nowhere and the undeterminable-line rule
    # keeps the range. This branch is pinned with bare jq against the def
    # extracted from the adapter source, not through the verb: every
    # `packages` key npm actually writes ends in a package-name segment, which
    # the scoped-aware strip always shortens, so no realistic v3 lockfile
    # reaches this branch — it exists precisely for shapes not anticipated.
    prefixes_of() {
      _def=$(sed -n '/^def prefixes:/,/^  end;/p' "$ADAPTER")
      jq -cn --arg p "$1" "$_def"' ($p | prefixes)'
    }

    It 'degrades a workspace key to itself plus the root'
      When call prefixes_of 'packages/tool'
      The status should be success
      The output should equal '["packages/tool",""]'
    End

    It 'degrades an unshrinkable node_modules path to itself alone'
      When call prefixes_of 'node_modules/foo/'
      The status should be success
      The output should equal '["node_modules/foo/"]'
    End
  End

  # The verdict, not the parse: what mattered on the field-test fix PR is the number that
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

    It 'reproduces the F7 of 2 the unscoped collection produced on the field-test fix PR'
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

# pnpm's turn at the same defect family (issue #100, the field run's dominant
# one: 3 of 6 failures). The isolated store never nests the child under
# `node_modules/<parent>/` and links only direct dependencies into
# `node_modules` at all, so both of `resolved_major_for_parent`'s probes miss:
# every parent came back `parents_unreadable`, `parents_other_lines` stayed
# empty while 11 of 15 parents sat on another line, and the hoisted fallback
# attributed the ROOT's copy to whichever parent was asked about. The
# lockfile's `snapshots:` blocks record the child version each copy of each
# parent resolves — exactly what `--line` classifies on — while still
# recording no declared specifier, so the range stays honestly unread.
#
# The fixture is the run's brace-expansion shape: one parent name at three
# majors, each resolving its own major of the child, no node_modules on disk.
Describe 'node.sh declared_ranges --line (pnpm, lockfile snapshots)'
  After 'cleanup_fixture'

  It 'files other-line pnpm parents under parents_other_lines, never unreadable'
    use_fixture pnpm-cross-line
    When call adapter_jq '{ranges, parents_read, parents_unreadable, parents_other_lines, parents_without_range}' \
      declared_ranges --line 5 brace-expansion
    The status should be success
    The output should equal '{"ranges":[],"parents_read":[],"parents_unreadable":["minimatch"],"parents_other_lines":["minimatch@3.1.5","minimatch@5.1.6"],"parents_without_range":[]}'
  End

  # The same parent, the oldest line: only the 1.x copy stays in scope, and
  # the copies excluded are named with their own versions, exactly as the
  # yarn rows above name theirs.
  It 'classifies the same parent for the 1.x line'
    use_fixture pnpm-cross-line
    When call adapter_jq '{ranges, parents_unreadable, parents_other_lines}' \
      declared_ranges --line 1 brace-expansion
    The status should be success
    The output should equal '{"ranges":[],"parents_unreadable":["minimatch"],"parents_other_lines":["minimatch@10.0.3","minimatch@10.2.5","minimatch@5.1.6"]}'
  End

  # snapshots record what resolved, never the specifier it was declared with,
  # so the parent's range is still a range nobody could read: unreadable, not
  # `parents_without_range`, which claims a read that never happened.
  It 'keeps the parent unreadable, not rangeless, when no line is given'
    use_fixture pnpm-cross-line
    When call adapter_jq '{ranges, parents_unreadable, parents_without_range, parents_other_lines}' \
      declared_ranges brace-expansion
    The status should be success
    The output should equal '{"ranges":[],"parents_unreadable":["minimatch"],"parents_without_range":[],"parents_other_lines":[]}'
  End

  # The svgo shape from the run: a single-copy parent whose manifest IS on
  # disk (a direct dependency, post-install) was filed on the HOISTED copy's
  # line, because the probe's fallback reads `node_modules/<pkg>` — the
  # root's copy, here 10.x — so the real 5.x parent landed in
  # parents_other_lines and its range was lost. The lockfile edge answers for
  # the parent's own copy; the manifest still supplies the range.
  It 'derives a single-copy parent line from the lockfile, not the hoisted copy'
    use_fixture pnpm-cross-line
    mkdir -p node_modules/filelist node_modules/minimatch
    printf '{"name":"filelist","version":"1.0.4","dependencies":{"minimatch":"^5.0.1"}}' \
      > node_modules/filelist/package.json
    printf '{"name":"minimatch","version":"10.2.5"}' \
      > node_modules/minimatch/package.json
    When call adapter_jq '{ranges, parents_read, parents_unreadable, parents_other_lines}' \
      declared_ranges --line 5 minimatch
    The status should be success
    The output should equal '{"ranges":["^5.0.1"],"parents_read":["filelist"],"parents_unreadable":[],"parents_other_lines":["__root__","@ts-morph/common@0.26.1","glob@7.2.3"]}'
  End

  # The root, with NO node_modules at all — the state every pre-install
  # worktree is in. `resolved_major_for_parent __root__` probes the installed
  # tree, so root_major came back empty and the root's range was silently
  # kept on EVERY queried line: issue #100's third signature, js-yaml "5.2.3"
  # reported as root_range for a line the root does not serve. The lockfile's
  # `importers:` section records what the root resolves, exactly as the
  # snapshots do for the parents.
  It 'files an off-line root under parents_other_lines with no node_modules'
    use_fixture pnpm-cross-line
    When call adapter_jq '{root_range, parents_unreadable, parents_other_lines}' \
      declared_ranges --line 5 minimatch
    The status should be success
    The output should equal '{"root_range":null,"parents_unreadable":["filelist"],"parents_other_lines":["__root__","@ts-morph/common@0.26.1","glob@7.2.3"]}'
  End

  It 'keeps root_range on the line the root importer resolves'
    use_fixture pnpm-cross-line
    When call adapter_jq '{root_range, parents_unreadable, parents_other_lines}' \
      declared_ranges --line 10 minimatch
    The status should be success
    The output should equal '{"root_range":"^10.2.5","parents_unreadable":["@ts-morph/common"],"parents_other_lines":["filelist@1.0.4","glob@7.2.3"]}'
  End

  # The issue #160 specimen: dompurify is reached ONLY through jspdf's
  # `optionalDependencies:` edge, which the dependencies-only walk skipped —
  # zero parents, so `apply_constraint` had no key to write. The parent is
  # now filed exactly where an on-line pnpm copy with no manifest belongs:
  # `parents_unreadable` (the snapshots record what resolved, never the
  # declared specifier), NOT absent.
  It 'classifies an optionalDependencies-only parent on its line'
    use_fixture pnpm-optional-parent
    When call adapter_jq '{ranges, parents_read, parents_unreadable, parents_other_lines, parents_without_range}' \
      declared_ranges --line 3 dompurify
    The status should be success
    The output should equal '{"ranges":[],"parents_read":[],"parents_unreadable":["jspdf"],"parents_other_lines":[],"parents_without_range":[]}'
  End

  # The same edge classifies AWAY from a line the copy does not serve, named
  # with the parent's own version like every other off-line pnpm copy.
  It 'files an optionalDependencies-only parent off-line by its own version'
    use_fixture pnpm-optional-parent
    When call adapter_jq '{parents_unreadable, parents_other_lines}' \
      declared_ranges --line 2 dompurify
    The status should be success
    The output should equal '{"parents_unreadable":[],"parents_other_lines":["jspdf@4.2.1"]}'
  End
End

# Peer-variant snapshot keys: one parent VERSION, several edges. pnpm keys
# `react-redux@8.1.3(react@17.0.2)` and `react-redux@8.1.3(react@18.2.0)`
# collapse to a single `parent_version`, while each variant resolves the
# child at its own major. With the parent's manifest on disk the single-copy
# path classified from the FIRST edge row: a parent genuinely serving the
# queried line was filed in `parents_other_lines` — which the fix flow
# promises never receives a scoped entry — so its child copy stayed
# vulnerable while the group reported fixed. ANY edge on the line keeps the
# parent; the fixture orders the 17.x variant first so a first-row shortcut
# cannot pass.
Describe 'node.sh declared_ranges --line (pnpm, peer-variant edges)'
  After 'cleanup_fixture'

  install_parent_manifest() {
    mkdir -p node_modules/react-redux
    printf '{"name":"react-redux","version":"8.1.3","peerDependencies":{"react":"^16.8 || ^17.0 || ^18.0"}}' \
      > node_modules/react-redux/package.json
  }

  It 'keeps the parent eligible on the line its later edge serves'
    use_fixture pnpm-peer-variant
    install_parent_manifest
    When call adapter_jq '{ranges, parents_read, parents_unreadable, parents_other_lines}' \
      declared_ranges --line 18 react
    The status should be success
    The output should equal '{"ranges":["^16.8 || ^17.0 || ^18.0","^18.2.0"],"parents_read":["react-redux"],"parents_unreadable":[],"parents_other_lines":[]}'
  End

  It 'keeps the same single parent version eligible on the 17 line too'
    use_fixture pnpm-peer-variant
    install_parent_manifest
    When call adapter_jq '{ranges, parents_read, parents_other_lines}' \
      declared_ranges --line 17 react
    The status should be success
    The output should equal '{"ranges":["^16.8 || ^17.0 || ^18.0"],"parents_read":["react-redux"],"parents_other_lines":["__root__"]}'
  End

  # A line NO edge serves still classifies the parent away, from the rows.
  It 'files the parent under parents_other_lines for a line no edge serves'
    use_fixture pnpm-peer-variant
    install_parent_manifest
    When call adapter_jq '{ranges, parents_read, parents_other_lines}' \
      declared_ranges --line 16 react
    The status should be success
    The output should equal '{"ranges":[],"parents_read":[],"parents_other_lines":["__root__","react-redux"]}'
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
