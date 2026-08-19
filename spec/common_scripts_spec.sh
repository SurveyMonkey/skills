#!/bin/sh
# shellcheck shell=sh
# scripts/common/: detect-scope.sh, select-adapter.sh, score-merge-risk.sh.

Describe 'detect-scope.sh'
  # The workspace convention is one @-prefixed directory per GitHub owner, with
  # repositories inside it. Owner directories may nest, so the *innermost*
  # @-segment is the owner and the next non-@ segment is the repository.
  Describe 'path classification'
    Parameters
      '/Code/@momentive_emu/@mntv-analysis/analysis-web'      repo mntv-analysis analysis-web
      '/Code/@SurveyMonkey/skills'                            repo SurveyMonkey  skills
      '/Code/@brianespinosa/career/src/components'            repo brianespinosa career
      '/Code/@SurveyMonkey'                                   org  SurveyMonkey  null
      '/Code/@momentive_emu/@mntv-analysis'                   org  mntv-analysis null
    End

    It "maps $1"
      expected='{"scope":"'"$2"'","owner":"'"$3"'","repo":'
      case $4 in
        null) expected="$expected"'null}' ;;
        *)    expected="$expected"'"'"$4"'"}' ;;
      esac
      When call common_jq detect-scope.sh '{scope, owner, repo}' "$1"
      The status should be success
      The output should equal "$expected"
    End
  End

  It 'builds nwo only when both owner and repo are known'
    When call common_jq detect-scope.sh '.nwo' '/Code/@SurveyMonkey/skills'
    The status should be success
    The output should equal '"SurveyMonkey/skills"'
  End

  It 'leaves nwo null at org scope'
    When call common_jq detect-scope.sh '.nwo' '/Code/@SurveyMonkey'
    The status should be success
    The output should equal 'null'
  End

  # A path with no owner directory falls back to the authenticated gh user.
  # Mocked so the spec never touches the network.
  Describe 'user scope'
    Mock gh
      case "$*" in
        'api user --jq .login') echo 'mocked-login' ;;
        *) return 1 ;;
      esac
    End

    It 'resolves the owner from the gh session'
      When call common_jq detect-scope.sh '{scope, owner}' '/Code'
      The status should be success
      The output should equal '{"scope":"user","owner":"mocked-login"}'
    End
  End

  Describe 'user scope when gh is unavailable'
    Mock gh
      return 1
    End

    It 'reports a null owner rather than failing'
      When call common_jq detect-scope.sh '{scope, owner}' '/Code'
      The status should be success
      The output should equal '{"scope":"user","owner":null}'
    End
  End

  # Resolved script-side so no agent prompt carries a shell pipeline for it.
  # The local origin/HEAD symref is how clones record the default branch, and
  # reading it needs no network.
  Describe 'default branch'
    After 'cleanup_fixture'

    make_repo() {
      TEST_DIR=$(mktemp -d)
      REPO_DIR="$TEST_DIR/@octo/app"
      mkdir -p "$REPO_DIR"
      git -C "$REPO_DIR" init -q
      git -C "$REPO_DIR" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
    }

    It 'resolves default_branch from the origin/HEAD symref'
      make_repo
      When call common_jq detect-scope.sh '.default_branch' "$REPO_DIR"
      The status should be success
      The output should equal '"main"'
    End

    It 'reports null where no repository exists'
      When call common_jq detect-scope.sh '.default_branch' '/Code/@SurveyMonkey/skills'
      The status should be success
      The output should equal 'null'
    End
  End
End

Describe 'select-adapter.sh'
  It 'routes npm to the node adapter'
    When call common_jq select-adapter.sh '{ecosystem, supported, adapter, skip}' --ecosystem npm
    The status should be success
    The output should equal '{"ecosystem":"npm","supported":true,"adapter":"node","skip":false}'
  End

  It 'resolves an adapter path that exists and is executable'
    When call common_jq select-adapter.sh '.adapter_path' --ecosystem npm
    The status should be success
    The output should not include '..'
  End

  # Unsupported ecosystems are reported, never treated as an error: exit stays 0
  # and `supported` is false, so a caller handles them alongside "no fix
  # available" through one code path.
  Describe 'unsupported ecosystems are reported, not failed'
    Parameters
      pip
      rubygems
      maven
      go
      other
    End

    It "skips $1 without erroring"
      When call common_jq select-adapter.sh '{supported, skip, reason}' --ecosystem "$1"
      The status should be success
      The output should equal '{"supported":false,"skip":true,"reason":"ecosystem not supported yet"}'
    End
  End

  It 'carries the manifest path through'
    When call common_jq select-adapter.sh '.manifest' --ecosystem npm --manifest packages/web/package.json
    The status should be success
    The output should equal '"packages/web/package.json"'
  End

  It 'requires an ecosystem or batch mode'
    When run script "$COMMON/select-adapter.sh"
    The status should not equal 0
    The stderr should be present
  End

  It 'rejects unknown arguments'
    When run script "$COMMON/select-adapter.sh" --nope
    The status should not equal 0
    The stderr should be present
  End

  Describe 'batch mode over discovery JSON'
    discovery() {
      printf '%s' '{"actionable":[{"package":"lodash","ecosystem":"npm"},{"package":"rails","ecosystem":"rubygems"},{"package":"flask","ecosystem":"pip"}],"skipped":[{"package":"old","reason":"no fix available"}]}'
    }
    annotate() { discovery | "$COMMON/select-adapter.sh" --from-discovery | jq -c "$1"; }

    It 'keeps only supported ecosystems as actionable'
      When call annotate '[.actionable[] | {package, adapter}]'
      The status should be success
      The output should equal '[{"package":"lodash","adapter":"node"}]'
    End

    # The pre-existing skipped entry must survive: a caller reads one list.
    It 'moves unsupported groups into skipped without dropping existing ones'
      When call annotate '[.skipped[] | {package, reason}]'
      The status should be success
      The output should equal '[{"package":"old","reason":"no fix available"},{"package":"rails","reason":"ecosystem not supported yet"},{"package":"flask","reason":"ecosystem not supported yet"}]'
    End

    It 'rejects non-JSON on stdin'
      When run sh -c "printf 'not json' | '$COMMON/select-adapter.sh' --from-discovery"
      The status should not equal 0
      The stderr should be present
    End
  End
End

Describe 'score-merge-risk.sh'
  After 'cleanup_fixture'

  # Helper: write a why payload, then score against it. The override scope is
  # optional here and defaults to `none` (a plain direct update), so the
  # examples that predate F6 read unchanged; scope-specific examples pass it.
  # Anything after the scope is a declared range, passed through as its own
  # --declared-range flag. Ranges reach the script as positional arguments
  # rather than a word-split string because a range may contain a space
  # (">=1 <2"), which word splitting would tear in half.
  score() {
    _rel=$1; _dev=$2; _parents=$3; _before=$4; _after=$5; _f4=$6; _f5=$7; _filter=$8
    _scope=${9:-none}
    if [ $# -gt 9 ]; then shift 9; else shift $#; fi
    : > ranges.txt
    for _range in "$@"; do printf '%s\n' "$_range" >> ranges.txt; done
    jq -n --arg rel "$_rel" --argjson dev "$_dev" --argjson parents "$_parents" \
      '{relationship: $rel, dev_only: $dev, parents: $parents, package: "lodash"}' > why.json
    set -- --package lodash --after "$_after" --adapter "$ADAPTER" \
           --why-json why.json --f4 "$_f4" --f5 "$_f5" --override-scope "$_scope"
    if [ -n "$_before" ]; then
      set -- "$@" --before "$_before"
    fi
    while IFS= read -r _range; do
      [ -n "$_range" ] || continue
      set -- "$@" --declared-range "$_range"
    done < ranges.txt
    "$COMMON/score-merge-risk.sh" "$@" | jq -c "$_filter"
  }

  Describe 'factor scoring'
    Parameters
      # rel        dev    parents        before   after    f4 f5  expected F1,F2
      direct       false  '[]'           1.0.0    2.0.0    0  0   '{"f1":2,"f2":2}'
      direct       true   '[]'           1.0.0    1.1.0    0  0   '{"f1":1,"f2":0}'
      transitive   false  '["express"]'  1.0.0    1.0.1    0  0   '{"f1":0,"f2":1}'
    End

    It "scores F1 and F2 for a $1 dependency"
      use_fixture usage-app
      When call score "$1" "$2" "$3" "$4" "$5" "$6" "$7" '{f1: .factors[0].score, f2: .factors[1].score}'
      The status should be success
      The output should equal "$8"
    End
  End

  It 'counts importing modules for a direct dependency, excluding tests'
    # src/index.js, src/util.js, and src/helper.ts import lodash or express;
    # tests/util.test.js also does but must not count.
    use_fixture usage-app
    When call score direct false '[]' 1.0.0 1.0.1 0 0 '.factors[2].evidence'
    The status should be success
    The output should include '2 module'
  End

  It 'scores usage surface as zero when nothing imports the package'
    use_fixture yarn-berry
    When call score direct false '[]' 1.0.0 1.0.1 0 0 '.factors[2].score'
    The status should be success
    The output should equal '0'
  End

  Describe 'bands'
    Parameters
      # rel       dev   before  after   f4 f5  expected band
      direct      true  1.0.0   1.0.1   0  0   Low
      direct      false 1.0.0   1.1.0   1  1   Medium
      direct      false 1.0.0   2.0.0   2  2   High
    End

    It "bands a $1 dependency as $7"
      use_fixture yarn-berry
      When call score "$1" "$2" '[]' "$3" "$4" "$5" "$6" '.band'
      The status should be success
      The output should equal "\"$7\""
    End
  End

  # A major bump of an untested, widely imported runtime dependency belongs
  # where a reviewer will look at it, regardless of the raw total.
  It 'never rates a major delta as Low'
    use_fixture yarn-berry
    When call score direct true '[]' 1.0.0 2.0.0 0 0 '{score, band, escalated}'
    The status should be success
    The output should equal '{"score":2,"band":"Medium","escalated":true}'
  End

  # F6, override blast radius (issue #20). A bare override pins the package
  # for every consumer in the tree, including copies that were never
  # vulnerable, so it must not score the same as a parent-scoped entry.
  Describe 'override blast radius'
    Parameters
      # scope           expected F6
      none              0
      scoped            0
      bare-tightened    1
      bare-added        2
    End

    It "scores $1 as $2"
      use_fixture yarn-berry
      When call score transitive false '["express"]' 1.0.0 1.0.1 0 0 '.factors[5].score' "$1"
      The status should be success
      The output should equal "$2"
    End
  End

  It 'says what an added bare override does, in the evidence'
    use_fixture yarn-berry
    When call score transitive false '["express"]' 1.0.0 1.0.1 0 0 '.factors[5].evidence' bare-added
    The status should be success
    The output should equal '"new unscoped override pins lodash for every consumer, including copies that were never vulnerable"'
  End

  # The thresholds are absolute risk points, not proportions of the maximum,
  # so neither the sixth nor the seventh factor may reband a fix that
  # introduced no override and crossed no line. Same inputs, same band as
  # before either existed.
  It 'reports the new maximum without moving the bands'
    use_fixture yarn-berry
    When call score direct false '[]' 1.0.0 1.1.0 1 1 '{score, max, band}'
    The status should be success
    The output should equal '{"score":5,"max":14,"band":"Medium"}'
  End

  # Everything else clean would total 1 and rate Low; a global pin this PR
  # created belongs where a reviewer will look at it.
  It 'never rates an added bare override as Low'
    use_fixture yarn-berry
    When call score transitive false '["express"]' 1.0.0 1.0.1 0 0 '{score, band, escalated, escalation_reason}' bare-added
    The status should be success
    The output should equal '{"score":3,"band":"Medium","escalated":true,"escalation_reason":"a newly added unscoped override never rates Low"}'
  End

  It 'names the blocker that escalated a major delta'
    use_fixture yarn-berry
    When call score direct true '[]' 1.0.0 2.0.0 0 0 '{escalation_reason, markdown: (.markdown | split("\n")[2])}'
    The status should be success
    The output should equal '{"escalation_reason":"a major version delta never rates Low","markdown":"> Escalated from Low: a major version delta never rates Low."}'
  End

  It 'scores a missing baseline as a major delta and says so'
    use_fixture yarn-berry
    When call score direct true '[]' '' 2.0.0 0 0 '{f1: .factors[0].score, evidence: .factors[0].evidence}'
    The status should be success
    The output should equal '{"f1":2,"evidence":"no pre-fix baseline available; scored as major"}'
  End

  It 'emits a markdown table for the PR body'
    use_fixture yarn-berry
    When call score direct false '[]' 1.0.0 1.1.0 1 0 '.markdown'
    The status should be success
    The output should include 'Merge risk:'
    The output should include '| Factor | Score | Evidence |'
  End

  # F7, declared-range distance (issue #21). F1 says "major" whether the fix
  # crosses one major line or three, so the distance is scored separately and
  # F1's weights stay where they were.
  Describe 'declared-range distance'
    Parameters
      # before  after   declared   expected F7
      1.0.0     2.0.0   ''         0   # one major line: the ordinary case, unchanged
      1.0.0     3.0.0   ''         1   # skips 2.x entirely
      1.0.0     4.0.0   ''         2
      1.0.0     7.0.0   ''         2   # capped at 2 like every other factor
      9.0.1     9.1.0   '^7'       1   # minor delta, but dependents never saw 8.x or 9.x
      1.0.0     1.0.1   '~1.0.0'   0   # inside the pin: nothing crossed
      1.0.0     1.1.0   '~1.0.0'   1   # crosses a tilde pin without crossing a major
      1.0.0     2.0.0   '1.0.0'    1   # crosses an exact pin
      1.0.0     3.0.0   '~1.0.0'   2   # two majors and a pin
      1.0.0     2.0.0   '>=1 <2'   1   # an explicit upper bound is a pin too
    End

    It "scores $1 -> $2 against '$3' as $4"
      use_fixture yarn-berry
      When call score direct false '[]' "$1" "$2" 0 0 '.factors[6].score' none "$3"
      The status should be success
      The output should equal "$4"
    End
  End

  # The headline complaint: with everything else held equal, a jump that skips
  # a major line must not tie a single-major bump.
  It 'ranks a two-major jump above a comparable one-major bump'
    use_fixture yarn-berry
    When call score direct false '[]' 9.0.1 10.0.0 1 1 '.score'
    The status should be success
    The output should equal '6'
  End

  It 'scores the same fix higher when it skips a major line'
    use_fixture yarn-berry
    When call score direct false '[]' 9.0.1 11.1.1 1 1 '.score'
    The status should be success
    The output should equal '7'
  End

  # Item 4 of the issue: the evidence carries the signal even before the
  # weights do. This is the string it asks for, verbatim.
  It 'names the number of majors and the ranges being left behind'
    use_fixture yarn-berry
    When call score transitive false '["express"]' 9.0.1 11.1.1 0 0 '.factors[0].evidence' scoped '^9'
    The status should be success
    The output should equal '"9.0.1 -> 11.1.1 (2 majors; parents declare ^9)"'
  End

  It 'reports a crossed pin in the evidence'
    use_fixture yarn-berry
    When call score direct false '[]' 6.14.0 7.0.0 0 0 '.factors[6].evidence' none '~6.14.0'
    The status should be success
    The output should equal '"one major line crossed; dependents declare ~6.14.0; crosses the pinned range ~6.14.0"'
  End

  It 'says so when no dependent ranges were supplied'
    use_fixture yarn-berry
    When call score direct false '[]' 1.0.0 1.0.1 0 0 '.factors[6].evidence'
    The status should be success
    The output should equal '"no major line crossed; no dependent ranges supplied"'
  End

  # Nobody has evidence the tree still works, and the fix dragged a runtime
  # dependency across two major lines. Medium reads as "skim it".
  It 'never rates an unverified multi-major runtime jump below High'
    use_fixture yarn-berry
    When call score transitive false '["express"]' 9.0.1 11.1.1 2 0 '{score, band, escalated, escalation_reason}' scoped '^9'
    The status should be success
    The output should equal '{"score":6,"band":"High","escalated":true,"escalation_reason":"a multi-major jump on a runtime dependency with no test signal never rates below High"}'
  End

  It 'leaves a dev-only multi-major jump where the total puts it'
    use_fixture yarn-berry
    When call score direct true '[]' 9.0.1 11.1.1 2 0 '{band, escalated}' scoped '^9'
    The status should be success
    The output should equal '{"band":"Medium","escalated":false}'
  End

  # The three PRs from the sweep in issue #21. F3 is 0 against this fixture,
  # and F4/F5 are set to the values that reproduce the totals the issue
  # reported, so the before column here is the score those PRs carried.
  Describe 'the sweep cases from issue #21'
    Parameters
      # case    rel        before  after   f4 f5 scope  declared  was  expected
      "bork#350"  transitive 9.0.1  11.1.1  2  1  scoped '^9'  6 '{"score":7,"band":"High"}'
      "gcal#63"   transitive 9.0.1  11.1.1  1  0  scoped '^9'  4 '{"score":5,"band":"Medium"}'
      "bork#351"  direct     2.4.2  3.0.6   1  1  none   ''    6 '{"score":6,"band":"Medium"}'
    End

    It "rescores $1 from $9"
      use_fixture yarn-berry
      When call score "$2" false '["express"]' "$3" "$4" "$5" "$6" '{score, band}' "$7" "$8"
      The status should be success
      The output should equal "${10}"
    End
  End

  Describe 'argument validation'
    It 'rejects an out-of-range factor score'
      use_fixture yarn-berry
      When run script "$COMMON/score-merge-risk.sh" --package lodash --after 1.0.0 --adapter "$ADAPTER" --why-json /dev/null --f4 5 --f5 0 --override-scope none
      The status should not equal 0
      The stderr should include 'must be 0, 1, or 2'
    End

    It 'rejects a missing required argument'
      use_fixture yarn-berry
      When run script "$COMMON/score-merge-risk.sh" --package lodash
      The status should not equal 0
      The stderr should include 'Missing required argument'
    End

    # The remediation shape is a fact the caller knows and the score depends
    # on, so there is no safe default to silently fall back to.
    It 'requires the override scope'
      use_fixture yarn-berry
      When run script "$COMMON/score-merge-risk.sh" --package lodash --after 1.0.0 --adapter "$ADAPTER" --why-json /dev/null --f4 0 --f5 0
      The status should not equal 0
      The stderr should include 'Missing required argument: --override-scope'
    End

    It 'rejects an unknown override scope'
      use_fixture yarn-berry
      When run script "$COMMON/score-merge-risk.sh" --package lodash --after 1.0.0 --adapter "$ADAPTER" --why-json /dev/null --f4 0 --f5 0 --override-scope global
      The status should not equal 0
      The stderr should include 'must be none, scoped, bare-tightened, or bare-added'
    End
  End
End
