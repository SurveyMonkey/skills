#!/bin/sh
# shellcheck shell=sh
# scripts/common/pr-status.sh: read-only inspection of the PRs this flow opens.

Describe 'pr-status.sh'
  URL12='https://github.com/octo/app/pull/12'
  URL34='https://github.com/octo/app/pull/34'

  setup_mock() {
    mock_gh_reset
  }

  Before 'setup_mock'
  After 'mock_gh_cleanup'

  # Only `pr view` calls stubbed by stub_view get a reply. That is the point:
  # every other gh subcommand — `pr ready`, `pr update-branch`, `pr merge`,
  # `pr edit`, `api` — and any `pr view` for a PR this file never stubbed is
  # unhandled and fails outright, so an unguarded mutating call fails the
  # suite. A guarded one (`|| printf ''`) would not; mutating_calls reads the
  # request log instead, which holds under any error suppression and depends
  # on the dispatcher logging every call, handled or not, before it decides.
  # This script is read-only (ADR 008) and the mock is what holds it to that.
  Mock gh
    "$GH_MOCK_DISPATCH" "$@"
  End

  # Build a `gh pr view` payload. Args: rollup-json, autoMergeRequest-json,
  # mergeStateStatus (defaults to UNKNOWN, which is what a PR reads moments
  # after it is created — when the final report is the one thing that calls
  # this script), and isDraft, defaulting to false because PRs open ready for
  # review (ADR 008). isDraft is a parameter rather than a constant so the
  # `true` case is reachable: that is the one value the field exists to
  # surface, and a fixture that can only say false let a hardcoded
  # `is_draft: false` pass the whole suite (#87).
  stub_view() {
    _num=$1
    jq -nc --arg num "$_num" --argjson roll "$2" --argjson amr "$3" \
      --arg ms "${4:-UNKNOWN}" --argjson draft "${5:-false}" '{
      number: ($num | tonumber), state: "OPEN", isDraft: $draft,
      headRefName: "fix/dependabot-lodash", baseRefName: "main",
      mergeStateStatus: $ms, statusCheckRollup: $roll, autoMergeRequest: $amr
    }' > "$GH_MOCK_DIR/view-$_num.json"
    mock_gh_reply "pr view https://github.com/octo/app/pull/$_num" "$GH_MOCK_DIR/view-$_num.json"
  }

  # Every gh call the mock saw, minus the one read-only one. Reading the
  # request log holds under any error suppression (`gh pr merge --auto ||
  # true` slips past a bare `exit 1` in a case arm, proven by a mutation run
  # that added exactly that and stayed green — #87), and depends on the
  # dispatcher logging every call before it decides whether to answer it.
  # `api` counts as mutating here too: pr-status.sh has no legitimate reason
  # to call it (#91), so a re-added call must show up as one.
  mutating_calls() { mock_gh_requests | grep -vc '^pr view ' || true; }

  # Trimmed from a live `gh pr view` run: the notice gh 2.98.0 prints to stderr
  # on every command once a newer release exists. It arrives WITH a zero exit,
  # which is what made capturing it into the payload fatal. Re-registers the
  # same endpoint stub_view already registered, this time with the stderr
  # file attached — the later registration wins.
  stub_stderr() {
    _num=$1
    printf 'A new release of gh is available: 2.98.0 -> 2.99.0\nTo upgrade, run: brew upgrade gh\nhttps://github.com/cli/cli/releases/tag/v2.99.0\n' \
      > "$GH_MOCK_DIR/stderr-$_num"
    mock_gh_reply "pr view https://github.com/octo/app/pull/$_num" \
      "$GH_MOCK_DIR/view-$_num.json" "$GH_MOCK_DIR/stderr-$_num"
  }

  rollup() {
    case "$1" in
      empty)          printf '[]' ;;
      success)        printf '[{"status":"COMPLETED","conclusion":"SUCCESS","name":"test"}]' ;;
      failure)        printf '[{"status":"COMPLETED","conclusion":"SUCCESS","name":"test"},{"status":"COMPLETED","conclusion":"FAILURE","name":"lint"}]' ;;
      pending)        printf '[{"status":"IN_PROGRESS","conclusion":null,"name":"e2e"}]' ;;
      mixed-passed)   printf '[{"status":"COMPLETED","conclusion":"SUCCESS","name":"test"},{"state":"SUCCESS","context":"ci/legacy"}]' ;;
      mixed-failed)   printf '[{"status":"COMPLETED","conclusion":"SUCCESS","name":"test"},{"state":"FAILURE","context":"ci/legacy"}]' ;;
      status-pending) printf '[{"state":"PENDING","context":"ci/legacy"}]' ;;
      neutral)        printf '[{"status":"COMPLETED","conclusion":"NEUTRAL","name":"advisory"}]' ;;
      skipped)        printf '[{"status":"COMPLETED","conclusion":"SKIPPED","name":"e2e"}]' ;;
      status-expected) printf '[{"state":"EXPECTED","context":"ci/legacy"}]' ;;
    esac
  }

  # The rollup mixes CheckRun nodes (status/conclusion) and legacy
  # StatusContext nodes (state only); both shapes must be read. An empty
  # rollup is "none", never "passed" (ADR 008: observe, don't assume).
  Describe 'checks derivation'
    Parameters
      empty          none
      success        passed
      failure        failed
      pending        pending
      mixed-passed   passed
      mixed-failed   failed
      status-pending pending
      neutral        passed
      skipped        passed
      status-expected pending
    End

    It "derives checks=$2 from a $1 rollup"
      stub_view 12 "$(rollup "$1")" null
      When call common_jq pr-status.sh '.prs[0].checks' "$URL12"
      The status should be success
      The output should equal "\"$2\""
    End
  End

  It 'counts checks and names the failing ones'
    stub_view 12 "$(rollup failure)" null
    When call common_jq pr-status.sh '{counts: .prs[0].check_counts, failing: .prs[0].failing_checks}' "$URL12"
    The status should be success
    The output should equal '{"counts":{"total":2,"passed":1,"failed":1,"pending":0},"failing":["lint"]}'
  End

  # Nothing in this plugin converts a PR to a draft, so `is_draft: true` in a
  # report means a human did it, and SKILL.md's closing report tells the reader
  # exactly that. Both values are exercised: the field has to be an observation
  # of the PR, never a constant, or the one state worth surfacing is the one it
  # cannot express.
  Describe 'draft state'
    Parameters
      false false
      true  true
    End

    It "reports isDraft=$1 as it finds it"
      stub_view 12 "$(rollup success)" null UNKNOWN "$1"
      When call common_jq pr-status.sh '.prs[0] | {state, is_draft}' "$URL12"
      The status should be success
      The output should equal '{"state":"OPEN","is_draft":'"$2"'}'
    End
  End

  # The read-only guarantee, asserted as a verdict rather than as a comment.
  # Both PRs are on the same repo (octo/app): this is the shape that used to
  # exercise the per-repo `gh api repos/<nwo>` memo, so a re-added memoized
  # call would fire only once, on the first PR — the log assertion catches
  # even that single call.
  It 'calls nothing but gh pr view'
    stub_view 12 "$(rollup success)" '{"enabledBy":{"login":"octocat"},"mergeMethod":"SQUASH"}'
    stub_view 34 "$(rollup failure)" null BEHIND
    When call common_jq pr-status.sh '.prs | length' "$URL12" "$URL34"
    The status should be success
    The output should equal '2'
    The value "$(mutating_calls)" should equal 0
  End

  # #91: pr-status.sh no longer reads or reports auto-merge state. A non-null
  # autoMergeRequest in the gh pr view payload must not surface as an
  # auto_merge key at all, and no gh api call is made to learn the repo's
  # allow_auto_merge setting.
  It 'reports no auto_merge key even when autoMergeRequest is present'
    stub_view 12 "$(rollup success)" \
      '{"enabledBy":{"login":"octocat"},"mergeMethod":"SQUASH"}'
    When call common_jq pr-status.sh '.prs[0] | has("auto_merge")' "$URL12"
    The status should be success
    The output should equal 'false'
  End

  It 'makes no gh api call to learn the repository auto-merge setting'
    stub_view 12 "$(rollup success)" \
      '{"enabledBy":{"login":"octocat"},"mergeMethod":"SQUASH"}'
    When call common_jq pr-status.sh '.prs[0].number' "$URL12"
    The status should be success
    The output should equal '12'
    The value "$(mock_gh_requests | grep -c '^api ' || true)" should equal 0
  End

  It 'does not request autoMergeRequest in the --json field list'
    stub_view 12 "$(rollup success)" null
    When call common_jq pr-status.sh '.prs[0].number' "$URL12"
    The status should be success
    The output should equal '12'
    The value "$(mock_gh_requests | grep '^pr view ')" should not include 'autoMergeRequest'
  End

  # Any re-added field, however named, fails this exact-key-set assertion:
  # it does not need to know the field's name to catch it, only that the
  # entry grew one. Sorted, matching what jq's `keys` emits.
  It 'has exactly the entry shape documented in the header contract'
    stub_view 12 "$(rollup success)" \
      '{"enabledBy":{"login":"octocat"},"mergeMethod":"SQUASH"}'
    When call common_jq pr-status.sh '.prs[0] | keys' "$URL12"
    The status should be success
    The output should equal '["base","behind","check_counts","checks","conflict","failing_checks","head","is_draft","merge_state","number","repo","state","url"]'
  End

  # UNKNOWN is a real transient right after a push: not clean, not behind.
  # The raw value passes through so the caller can say so honestly.
  Describe 'merge state'
    Parameters
      BEHIND  true  false
      DIRTY   false true
      UNKNOWN false false
      CLEAN   false false
    End

    It "maps $1 to behind=$2 conflict=$3"
      stub_view 12 "$(rollup success)" null "$1"
      When call common_jq pr-status.sh '.prs[0] | {merge_state, behind, conflict}' "$URL12"
      The status should be success
      The output should equal '{"merge_state":"'"$1"'","behind":'"$2"',"conflict":'"$3"'}'
    End
  End

  # gh chatters on stderr and exits 0; the payload must survive it. Merging
  # stderr into the capture made jq parse the notice, which aborted the whole
  # run under set -e: no report, no error key, exit 5 (#87).
  It 'ignores gh chatter on stderr when the command succeeded'
    stub_view 12 "$(rollup success)" null
    stub_stderr 12
    When call common_jq pr-status.sh '.prs[0] | {number, checks}' "$URL12"
    The status should be success
    The output should equal '{"number":12,"checks":"passed"}'
  End

  # The same hazard's blast radius: one bad entry must never cost the others
  # theirs. A parse failure on the LAST url used to discard every entry before
  # it, because entries print only after the loop.
  It 'keeps every other entry when one PR''s output cannot be parsed'
    stub_view 12 "$(rollup success)" null
    # Registers a reply for 34, then overwrites its content: mock_gh_reply
    # reads the file at call time, so this lands as a real gh success whose
    # body is unparseable, not an unhandled call.
    mock_gh_reply "pr view $URL34" "$GH_MOCK_DIR/view-34.json"
    printf 'not json at all\n' > "$GH_MOCK_DIR/view-34.json"
    When call common_jq pr-status.sh '[.prs[] | .number // .error[0:37]]' "$URL12" "$URL34"
    The status should equal 1
    The output should equal '[12,"gh pr view output could not be parsed"]'
    The value "$(mutating_calls)" should equal 0
  End

  It 'rejects a non-PR URL with an error entry and a non-zero exit'
    When call common_jq pr-status.sh '.prs[0] | keys' 'https://example.com/nope'
    The status should equal 1
    The output should equal '["error","url"]'
    The value "$(mutating_calls)" should equal 0
  End

  It 'reports a PR gh cannot view and still exits non-zero'
    # No view stub for 34: the mock's cat fails like a real gh error would.
    stub_view 12 "$(rollup success)" null
    When call common_jq pr-status.sh '[.prs[] | has("error")]' "$URL12" "$URL34"
    The status should equal 1
    The output should equal '[false,true]'
  End

  # The old `status`/`promote` verb pair is gone with the promotion phases.
  # A caller still passing `status` would otherwise have it silently read as a
  # URL and reported as an error entry among the real PRs.
  It 'takes URLs directly, with no verb'
    stub_view 12 "$(rollup success)" null
    When call common_jq pr-status.sh '.prs[0].error' status "$URL12"
    The status should equal 1
    The output should equal '"not a GitHub pull request URL"'
  End

  It 'refuses an empty argument list'
    When run script "$COMMON/pr-status.sh"
    The status should equal 1
    The stderr should include 'Usage: pr-status.sh'
  End
End
