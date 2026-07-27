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

  # Helper: write a why payload, then score against it.
  score() {
    _rel=$1; _dev=$2; _parents=$3; _before=$4; _after=$5; _f4=$6; _f5=$7; _filter=$8
    jq -n --arg rel "$_rel" --argjson dev "$_dev" --argjson parents "$_parents" \
      '{relationship: $rel, dev_only: $dev, parents: $parents, package: "lodash"}' > why.json
    _args="--package lodash --after $_after --adapter $ADAPTER --why-json why.json --f4 $_f4 --f5 $_f5"
    if [ -n "$_before" ]; then
      _args="$_args --before $_before"
    fi
    # shellcheck disable=SC2086
    "$COMMON/score-merge-risk.sh" $_args | jq -c "$_filter"
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

  Describe 'argument validation'
    It 'rejects an out-of-range factor score'
      use_fixture yarn-berry
      When run script "$COMMON/score-merge-risk.sh" --package lodash --after 1.0.0 --adapter "$ADAPTER" --why-json /dev/null --f4 5 --f5 0
      The status should not equal 0
      The stderr should include 'must be 0, 1, or 2'
    End

    It 'rejects a missing required argument'
      use_fixture yarn-berry
      When run script "$COMMON/score-merge-risk.sh" --package lodash
      The status should not equal 0
      The stderr should include 'Missing required argument'
    End
  End
End
