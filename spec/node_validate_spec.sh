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

  # A locator whose version carried Berry's `::` binding parameters still
  # ranked as its core version, so a wide range admitted it while the narrow
  # `>= 2.5.0, < 2.5.3` shape advisories publish rejected it: the completeness
  # check found nothing, and `safe` is what agents/audit-pins.md maps to
  # `removable`. `__archiveUrl` is written for every non-default registry, so
  # this is the ordinary shape in the repositories this plugin targets
  # (issue #46).
  It 'flags a copy whose locator carries binding parameters'
    use_fixture yarn-binding-params
    When call adapter_jq '{ok, unresolved: [.unresolved_alerts[].version], ranges: [.unresolved_alerts[].vulnerable_ranges[]]}' \
      validate --line 2 --vulnerable '>= 2.5.0, < 2.5.3' privreg '>=2.5.3 <3'
    The status should not equal 0
    The output should equal '{"ok":false,"unresolved":["2.5.0"],"ranges":[">= 2.5.0, < 2.5.3"]}'
  End

  # A patch of a patch resolved to nothing, so validate died on "resolves to no
  # versions in the lockfile" — for a package sitting in the tree at a real
  # registry version, whose `present: false` the audit reads as `removable`.
  It 'validates a package reached through nested patch locators'
    use_fixture yarn-patch-nested
    When call adapter_jq '{ok, checked, resolved_versions}' \
      validate --line 5 --vulnerable '< 5.1.6' typescript '>=5.1.6 <6'
    The status should be success
    The output should equal '{"ok":true,"checked":1,"resolved_versions":["5.1.6"]}'
  End

  # A copy installed under an `npm:` alias key is a copy of the aliased package,
  # and the completeness check has to see it: no `--vulnerable` range would ever
  # match a name no registry has. This is the deliberate shift the identity rule
  # carries into validate — `apply_constraint` writes the alias key, so the
  # stricter answer is actionable rather than a dead end (issue #46).
  It 'counts a copy installed under an npm: alias key'
    use_fixture npm-alias
    When call adapter_jq '{ok, unresolved: [.unresolved_alerts[] | {version, path}]}' \
      validate --line 4 --vulnerable '>= 4.18.0, < 4.18.2' lodash '>=4.18.2 <5'
    The status should not equal 0
    The output should equal '{"ok":false,"unresolved":[{"version":"4.18.1","path":"node_modules/lodash-alias"}]}'
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

# ---------------------------------------------------------------------------
# --baseline: the cross-line collateral check (issue #83)
#
# The specimen is the field-test repository at origin/main, trimmed:
# `minimatch@3.1.5` declaring `brace-expansion: "npm:^1.1.7"` and `minimatch@10.2.5` declaring
# `"npm:^5.0.5"`, resolving to 1.1.18 and 5.0.6. The collapsed fixture is the
# lockfile a real `yarn install` produced there after the resolutions key
# `minimatch/brace-expansion` was written, which Yarn applies to every copy of
# minimatch regardless of version.
#
# These assert the VERDICT, not the parse. The first example is the shipped
# defect: the fix for line 5 passes validation while minimatch@3's 1.x copy has
# been dragged across a major. The rest are the fail-closed path that stops it.
# ---------------------------------------------------------------------------
Describe 'node.sh validate --baseline'
  After 'cleanup_fixture'

  # `resolved_versions` in the pre-fix worktree, verbatim, as phase 2 records it.
  BASELINE='{"pm":"yarn","package":"brace-expansion","present":true,"count":2,"versions":[{"version":"1.1.18","path":"brace-expansion@npm:1.1.18"},{"version":"5.0.6","path":"brace-expansion@npm:5.0.6"}],"lockfile_entries":10}'

  It 'passes the collapsed tree when no baseline is supplied'
    use_fixture yarn-cross-line-collapsed
    When call adapter_jq '{ok, checked, other_line_moves, resolved_versions}' \
      validate --line 5 --vulnerable '< 5.0.9' brace-expansion '>=5.0.9 <6'
    The status should be success
    The output should equal '{"ok":true,"checked":1,"other_line_moves":null,"resolved_versions":["5.0.9"]}'
  End

  # The same tree, the same arguments, plus the baseline: 1.1.18 is gone, and
  # the run has to stop rather than open a PR that moved it.
  It 'fails closed on a copy dragged off another major line'
    use_fixture yarn-cross-line-collapsed
    When call adapter_jq '{ok, other_line_moves}' \
      validate --line 5 --vulnerable '< 5.0.9' --baseline "$BASELINE" \
      brace-expansion '>=5.0.9 <6'
    The status should not equal 0
    The output should equal '{"ok":false,"other_line_moves":[{"major":1,"before":["1.1.18"],"after":[],"status":"vanished","class":"fatal"}]}'
  End

  # A run that changed nothing outside its line reports `[]`, which is the
  # positive claim `null` is not allowed to impersonate.
  It 'reports an empty array when nothing outside the line moved'
    use_fixture yarn-cross-line
    When call adapter_jq '{ok, other_line_moves}' \
      validate --line 5 --vulnerable '< 5.0.5' --baseline "$BASELINE" \
      brace-expansion '>=5.0.5 <6'
    The status should be success
    The output should equal '{"ok":true,"other_line_moves":[]}'
  End

  # A major that only appears after the install is the install adding a copy,
  # not this fix moving one. Reporting it would fire on every new resolution.
  It 'ignores a major line absent from the baseline'
    use_fixture yarn-cross-line
    When call adapter_jq '.other_line_moves' \
      validate --line 5 --vulnerable '< 5.0.5' \
      --baseline '{"package":"brace-expansion","versions":[{"version":"5.0.6"}]}' \
      brace-expansion '>=5.0.5 <6'
    The status should be success
    The output should equal '[]'
  End

  It 'refuses a baseline with no line to exclude'
    use_fixture yarn-cross-line
    When run script "$ADAPTER" validate --baseline "$BASELINE" brace-expansion '>=5.0.5 <6'
    The status should not equal 0
    The stderr should include '--baseline requires --line'
  End

  # A baseline that cannot be read must not degrade into "nothing moved". Each
  # of these reaches the same clean-looking answer by checking nothing.
  Describe 'unusable baselines'
    Parameters
      not-json      'nope'
      not-an-object '["1.1.18"]'
      wrong-package '{"package":"minimatch","versions":[{"version":"3.1.5"}]}'
      no-versions   '{"package":"brace-expansion"}'
      versions-type '{"package":"brace-expansion","versions":"1.1.18"}'
      untyped-entry '{"package":"brace-expansion","versions":[{"version":118}]}'
      empty         ''
    End

    It "refuses a $1 baseline"
      use_fixture yarn-cross-line-collapsed
      When run script "$ADAPTER" validate --line 5 --vulnerable '< 5.0.9' \
        --baseline "$2" brace-expansion '>=5.0.9 <6'
      The status should not equal 0
      The stderr should include 'baseline'
    End
  End

  # Same idiom hole as --sibling-alerts, in the pre-existing capture: a
  # two-document --baseline payload must not reach --argjson downstream and
  # surface as a raw jq crash on exit 2 (ADR 001 reserves that code). The
  # slurp-and-count-one guard catches it here with the ordinary die exit code
  # and the adapter error envelope instead.
  It 'refuses a two-document --baseline payload with the adapter error envelope, not a raw jq crash'
    use_fixture yarn-cross-line-collapsed
    TWO_DOC_BASELINE='{"package":"brace-expansion","versions":[{"version":"1.1.18"}]} {"package":"brace-expansion","versions":[{"version":"1.1.18"}]}'
    When run script "$ADAPTER" validate --line 5 --vulnerable '< 5.0.9' \
      --baseline "$TWO_DOC_BASELINE" brace-expansion '>=5.0.9 <6'
    The status should equal 1
    The stderr should include 'baseline'
  End

  # `present: false` is a legitimate baseline (a package not in the tree before
  # the fix). Nothing existed to be moved, so the answer is `[]` and not a
  # refusal — and not `null` either, because the question was asked.
  It 'accepts an empty baseline as nothing to move'
    use_fixture yarn-cross-line
    When call adapter_jq '{ok, other_line_moves}' \
      validate --line 5 --vulnerable '< 5.0.5' \
      --baseline '{"package":"brace-expansion","present":false,"count":0,"versions":[]}' \
      brace-expansion '>=5.0.5 <6'
    The status should be success
    The output should equal '{"ok":true,"other_line_moves":[]}'
  End
End

# ---------------------------------------------------------------------------
# The same collapse in pnpm's syntax (issue #100). The specimen pair mirrors
# yarn-cross-line-collapsed: `pnpm-cross-line-collapsed` is the tree an
# install produces under the BARE `minimatch>brace-expansion` key the fix
# flow used to write — pnpm matches an unqualified parent half against every
# resolved copy of minimatch, so the 1.x and 2.x lines vanish —
# and `pnpm-cross-line-qualified` is the tree the version-qualified keys
# `apply_constraint` now writes produce, sibling lines intact (the shape the
# field run's five shipped PRs validated with `other_line_moves: []`).
# ---------------------------------------------------------------------------
Describe 'node.sh validate --baseline (pnpm)'
  After 'cleanup_fixture'

  PNPM_BASELINE='{"pm":"pnpm","package":"brace-expansion","present":true,"count":3,"versions":[{"version":"1.1.11","path":"brace-expansion@1.1.11"},{"version":"2.0.2","path":"brace-expansion@2.0.2"},{"version":"5.0.5","path":"brace-expansion@5.0.5"}],"lockfile_entries":14}'

  It 'fails closed on the collapse the bare parent key produces'
    use_fixture pnpm-cross-line-collapsed
    When call adapter_jq '{ok, other_line_moves}' \
      validate --line 5 --vulnerable '< 5.0.9' --baseline "$PNPM_BASELINE" \
      brace-expansion '>=5.0.9 <6'
    The status should not equal 0
    The output should equal '{"ok":false,"other_line_moves":[{"major":1,"before":["1.1.11"],"after":[],"status":"vanished","class":"fatal"},{"major":2,"before":["2.0.2"],"after":[],"status":"vanished","class":"fatal"}]}'
  End

  It 'passes the tree the version-qualified keys produce, sibling lines intact'
    use_fixture pnpm-cross-line-qualified
    When call adapter_jq '{ok, other_line_moves, resolved_versions}' \
      validate --line 5 --vulnerable '< 5.0.9' --baseline "$PNPM_BASELINE" \
      brace-expansion '>=5.0.9 <6'
    The status should be success
    The output should equal '{"ok":true,"other_line_moves":[],"resolved_versions":["1.1.11","2.0.2","5.0.9"]}'
  End
End

# ---------------------------------------------------------------------------
# --sibling-alerts: the benign within-major dedup carve-out (issue #105)
#
# The specimen is the picomatch field shape from the field-test repository,
# trimmed to public names: fixing the 4.x line, pnpm's dedup consolidated the
# UNTOUCHED 2.x line from ["2.3.1","2.3.2"] to ["2.3.2"] with zero overrides
# touching that line, and the uniform fail-close rule stopped a correct fix.
# The carve-out is the strictest policy that clears it: benign only when the
# line moved but did not vanish, exactly one version remains, that version was
# already in the baseline for its line AND is its semver max, the move's major
# is not any sibling-alert major, no version on either side matches any
# sibling vulnerable range, and the caller supplied --sibling-alerts. These
# assert the VERDICT: ok flips only for that one shape, and everything else,
# including the flag being absent, stays fatal exactly as before.
# ---------------------------------------------------------------------------
Describe 'node.sh validate --sibling-alerts'
  After 'cleanup_fixture'

  # Phase 2's `resolved_versions picomatch` in the pre-fix worktree: two 2.x
  # copies and the 4.0.1 the fix targets.
  DEDUP_BASELINE='{"pm":"pnpm","package":"picomatch","present":true,"count":3,"versions":[{"version":"2.3.1","path":"picomatch@2.3.1"},{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}'

  It 'classifies the field-case dedup as benign and passes'
    use_fixture pnpm-benign-dedup
    When call adapter_jq '{ok, other_line_moves}' \
      validate --line 4 --vulnerable '< 4.0.3' --baseline "$DEDUP_BASELINE" \
      --sibling-alerts '[]' picomatch '>=4.0.3 <5'
    The status should be success
    The output should equal '{"ok":true,"other_line_moves":[{"major":2,"before":["2.3.1","2.3.2"],"after":["2.3.2"],"status":"moved","class":"benign_dedup"}]}'
  End

  # The moved line carries an open alert of its own: the sibling 2.x group
  # owns those copies, and a move that satisfies its vulnerable range (and
  # sits on its major) must stay fatal.
  It 'stays fatal when the moved line carries a sibling alert'
    use_fixture pnpm-benign-dedup
    When call adapter_jq '{ok, classes: [.other_line_moves[].class]}' \
      validate --line 4 --vulnerable '< 4.0.3' --baseline "$DEDUP_BASELINE" \
      --sibling-alerts '[{"major":2,"vulnerable_ranges":["< 2.3.3"]}]' \
      picomatch '>=4.0.3 <5'
    The status should not equal 0
    The output should equal '{"ok":false,"classes":["fatal"]}'
  End

  # The fail-safe default: no flag means no sibling knowledge, and the exact
  # same move that [] classes benign stays fatal. This is the pre-#105
  # behavior bit for bit, except for the uniform new class field.
  It 'keeps every move fatal when the flag is absent'
    use_fixture pnpm-benign-dedup
    When call adapter_jq '{ok, other_line_moves}' \
      validate --line 4 --vulnerable '< 4.0.3' --baseline "$DEDUP_BASELINE" \
      picomatch '>=4.0.3 <5'
    The status should not equal 0
    The output should equal '{"ok":false,"other_line_moves":[{"major":2,"before":["2.3.1","2.3.2"],"after":["2.3.2"],"status":"moved","class":"fatal"}]}'
  End

  # A "none"-line sibling contributes checkable ranges but its null major
  # matches no numeric line, so it does not defeat the carve-out on its own.
  It 'treats a null-major sibling as checkable ranges, not a major match'
    use_fixture pnpm-benign-dedup
    When call adapter_jq '{ok, classes: [.other_line_moves[].class]}' \
      validate --line 4 --vulnerable '< 4.0.3' --baseline "$DEDUP_BASELINE" \
      --sibling-alerts '[{"major":null,"vulnerable_ranges":["<= 1.3.0"]}]' \
      picomatch '>=4.0.3 <5'
    The status should be success
    The output should equal '{"ok":true,"classes":["benign_dedup"]}'
  End

  # Each row breaks exactly one conjunct of the benign rule against the same
  # post-fix tree, with the flag supplied as []. The lexicographic row is the
  # semver-max trap: "2.3.2" is the string max of its line but 2.3.10 is the
  # version max, so a string comparison would wrongly class it benign.
  Describe 'baselines that keep the move fatal even with [] siblings'
    Parameters
      not-the-max     '{"pm":"pnpm","package":"picomatch","present":true,"count":3,"versions":[{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"2.3.3","path":"picomatch@2.3.3"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}'
      not-in-baseline '{"pm":"pnpm","package":"picomatch","present":true,"count":2,"versions":[{"version":"2.3.1","path":"picomatch@2.3.1"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}'
      lexicographic   '{"pm":"pnpm","package":"picomatch","present":true,"count":3,"versions":[{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"2.3.10","path":"picomatch@2.3.10"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}'
    End

    It "stays fatal when the landed version is $1"
      use_fixture pnpm-benign-dedup
      When call adapter_jq '{ok, classes: [.other_line_moves[].class]}' \
        validate --line 4 --vulnerable '< 4.0.3' --baseline "$2" \
        --sibling-alerts '[]' picomatch '>=4.0.3 <5'
      The status should not equal 0
      The output should equal '{"ok":false,"classes":["fatal"]}'
    End
  End

  # A vanished line is never a dedup: the copies stopped existing. Even a
  # caller asserting no sibling alerts exist cannot make that benign.
  It 'keeps a vanished line fatal even with [] siblings'
    use_fixture pnpm-cross-line-collapsed
    When call adapter_jq '{ok, classes: [.other_line_moves[].class]}' \
      validate --line 5 --vulnerable '< 5.0.9' \
      --baseline '{"pm":"pnpm","package":"brace-expansion","present":true,"count":3,"versions":[{"version":"1.1.11","path":"brace-expansion@1.1.11"},{"version":"2.0.2","path":"brace-expansion@2.0.2"},{"version":"5.0.5","path":"brace-expansion@5.0.5"}],"lockfile_entries":14}' \
      --sibling-alerts '[]' brace-expansion '>=5.0.9 <6'
    The status should not equal 0
    The output should equal '{"ok":false,"classes":["fatal","fatal"]}'
  End

  It 'refuses --sibling-alerts without --baseline'
    use_fixture pnpm-benign-dedup
    When run script "$ADAPTER" validate --line 4 --vulnerable '< 4.0.3' \
      --sibling-alerts '[]' picomatch '>=4.0.3 <5'
    The status should not equal 0
    The stderr should include '--sibling-alerts requires --baseline'
  End

  # A promised field arrives correctly typed or it is a hard error, exactly as
  # --baseline is treated: a garbled list must never degrade into "every move
  # fatal" or, worse, into a reclassification. `bad-major-fraction` and
  # `negative-major` pin the integer guard: `2.5` and `-1` both pass a bare
  # `type == "number"` check but never equal a real line's major, which would
  # silently stop the sibling from guarding its line rather than erroring.
  Describe 'unusable sibling-alert lists'
    Parameters
      not-json           'nope'
      not-an-array       '{"major":2,"vulnerable_ranges":[]}'
      missing-major      '[{"vulnerable_ranges":["< 2.3.3"]}]'
      mistyped-major     '[{"major":"2","vulnerable_ranges":["< 2.3.3"]}]'
      bad-major-fraction '[{"major":2.5,"vulnerable_ranges":["< 2.3.3"]}]'
      negative-major     '[{"major":-1,"vulnerable_ranges":["< 2.3.3"]}]'
      missing-ranges     '[{"major":2}]'
      mistyped-ranges    '[{"major":2,"vulnerable_ranges":"< 2.3.3"}]'
      untyped-range      '[{"major":2,"vulnerable_ranges":[233]}]'
      empty              ''
    End

    It "refuses a $1 sibling-alert list"
      use_fixture pnpm-benign-dedup
      When run script "$ADAPTER" validate --line 4 --vulnerable '< 4.0.3' \
        --baseline "$DEDUP_BASELINE" --sibling-alerts "$2" \
        picomatch '>=4.0.3 <5'
      The status should not equal 0
      The stderr should include 'sibling-alerts'
    End
  End

  # A multi-document --sibling-alerts payload (`'[] []'`) must not reach
  # `--argjson` downstream: jq's own multi-value error there is a raw stderr
  # message, exit 2, with no `{"error":...}` envelope, which violates the
  # adapter contract (ADR 001 reserves exit 2). The slurp-and-count-one guard
  # catches it here instead, with the ordinary die exit code.
  It 'refuses a multi-document --sibling-alerts payload with the adapter error envelope, not a raw jq crash'
    use_fixture pnpm-benign-dedup
    When run script "$ADAPTER" validate --line 4 --vulnerable '< 4.0.3' \
      --baseline "$DEDUP_BASELINE" --sibling-alerts '[] []' \
      picomatch '>=4.0.3 <5'
    The status should equal 1
    The stderr should include 'sibling-alerts'
  End

  # Same strict parse as --vulnerable: an unreadable sibling range answering
  # "not vulnerable" is the one direction the carve-out must never fail. But
  # unlike a structurally malformed list, an unreadable RANGE is scoped to
  # classification rather than the verb (issue #105): it forces `fatal` on
  # every move entry instead of `die`-ing outright, so a clean run with
  # nothing to move still passes.
  Describe 'unparseable sibling ranges'
    Parameters
      typo     'foo'
      wildcard '*'
      words    'all versions before 2.3.3'
    End

    It "forces every move fatal on a moved tree with sibling range $2"
      use_fixture pnpm-benign-dedup
      When call adapter_jq '{ok, classes: [.other_line_moves[].class]}' \
        validate --line 4 --vulnerable '< 4.0.3' \
        --baseline "$DEDUP_BASELINE" \
        --sibling-alerts "[{\"major\":2,\"vulnerable_ranges\":[\"$2\"]}]" \
        picomatch '>=4.0.3 <5'
      The status should not equal 0
      The output should equal '{"ok":false,"classes":["fatal"]}'
    End
  End

  # A clean tree (nothing outside the target line moved) still passes with an
  # unreadable sibling range: the flag has nothing to force fatal onto, and an
  # unreadable range must never introduce new blast radius where nothing
  # protective was even at stake.
  It 'passes a clean tree even with an unreadable sibling range'
    use_fixture pnpm-benign-dedup
    CLEAN_BASELINE='{"pm":"pnpm","package":"picomatch","present":true,"count":2,"versions":[{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}'
    When call adapter_jq '{ok, other_line_moves}' \
      validate --line 4 --vulnerable '< 4.0.3' --baseline "$CLEAN_BASELINE" \
      --sibling-alerts '[{"major":2,"vulnerable_ranges":["foo"]}]' \
      picomatch '>=4.0.3 <5'
    The status should be success
    The output should equal '{"ok":true,"other_line_moves":[]}'
  End

  # Every conjunct of the benign rule isolated against its own trigger, so a
  # future change that folds two conjuncts together (or drops one) is caught
  # by the row it would silently pass.
  Describe 'major and range conjuncts checked independently'
    Parameters
      # description                    sibling-alerts JSON
      'major hits, range misses'       '[{"major":2,"vulnerable_ranges":["< 2.0.0"]}]'
      'range hits, major differs'      '[{"major":3,"vulnerable_ranges":["< 2.3.3"]}]'
      'range hits only the before-side, vanished-in-dedup version' \
                                        '[{"major":3,"vulnerable_ranges":["<= 2.3.1"]}]'
    End

    It "stays fatal when $1"
      use_fixture pnpm-benign-dedup
      When call adapter_jq '{ok, classes: [.other_line_moves[].class]}' \
        validate --line 4 --vulnerable '< 4.0.3' --baseline "$DEDUP_BASELINE" \
        --sibling-alerts "$2" picomatch '>=4.0.3 <5'
      The status should not equal 0
      The output should equal '{"ok":false,"classes":["fatal"]}'
    End
  End

  # Two versions surviving the dedup on the untouched line breaks the
  # "exactly one version remains" conjunct even though every other conjunct
  # would otherwise hold (the survivors are both in the baseline, and jq's
  # `unique` string-sorts so "2.3.10" would pass a naive max comparison if the
  # length check were dropped).
  It 'stays fatal when two versions survive the dedup on the untouched line'
    use_fixture pnpm-benign-dedup-two-survivors
    TWO_SURVIVOR_BASELINE='{"pm":"pnpm","package":"picomatch","present":true,"count":4,"versions":[{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"2.3.9","path":"picomatch@2.3.9"},{"version":"2.3.10","path":"picomatch@2.3.10"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":6}'
    When call adapter_jq '{ok, classes: [.other_line_moves[].class]}' \
      validate --line 4 --vulnerable '< 4.0.3' --baseline "$TWO_SURVIVOR_BASELINE" \
      --sibling-alerts '[]' picomatch '>=4.0.3 <5'
    The status should not equal 0
    The output should equal '{"ok":false,"classes":["fatal"]}'
  End
End
