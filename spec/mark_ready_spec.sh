#!/bin/sh
# shellcheck shell=sh
# scripts/common/mark-ready.sh: PR inspection (status) and promotion (promote).

Describe 'mark-ready.sh'
  URL12='https://github.com/octo/app/pull/12'
  URL34='https://github.com/octo/app/pull/34'

  # The gh mock is driven by files under $MOCK_DIR so each example scripts its
  # own PR behavior, and every call is appended to $MOCK_DIR/log so examples
  # can assert what was — and was not — invoked. Stub files for update-branch
  # and ready carry the exit code on line 1 and the message on the rest.
  setup_mock() {
    MOCK_DIR="$SHELLSPEC_WORKDIR/gh-mock"
    rm -rf "$MOCK_DIR"
    mkdir -p "$MOCK_DIR"
    : > "$MOCK_DIR/log"
    export MOCK_DIR
  }

  Before 'setup_mock'

  Mock gh
    case "$1 $2" in
      'pr view')
        num="${3##*/}"
        printf 'view %s\n' "$num" >> "$MOCK_DIR/log"
        cat "$MOCK_DIR/view-$num.json"
        ;;
      'pr update-branch')
        # `exit`, not `return`: the mock body runs at the top level of the
        # generated command shim, where `return` errors and falls through.
        num="${4##*/}"
        printf 'update-branch %s\n' "$num" >> "$MOCK_DIR/log"
        if [ -f "$MOCK_DIR/update-$num" ]; then
          rc=$(sed -n 1p "$MOCK_DIR/update-$num")
          sed -n '2,$p' "$MOCK_DIR/update-$num"
          exit "$rc"
        fi
        printf 'Updated pull request branch\n'
        ;;
      'pr ready')
        num="${3##*/}"
        printf 'ready %s\n' "$num" >> "$MOCK_DIR/log"
        if [ -f "$MOCK_DIR/ready-$num" ]; then
          rc=$(sed -n 1p "$MOCK_DIR/ready-$num")
          sed -n '2,$p' "$MOCK_DIR/ready-$num"
          exit "$rc"
        fi
        ;;
      api*)
        printf 'api %s\n' "$2" >> "$MOCK_DIR/log"
        # No colon: an exported empty MOCK_ALLOW means "gh printed nothing".
        printf '%s\n' "${MOCK_ALLOW-true}"
        ;;
      *) exit 1 ;;
    esac
  End

  # Build a `gh pr view` payload. Args: rollup-json, autoMergeRequest-json,
  # mergeStateStatus (defaults to BLOCKED, the ordinary draft state).
  stub_view() {
    _num=$1
    jq -nc --arg num "$_num" --argjson roll "$2" --argjson amr "$3" \
      --arg ms "${4:-BLOCKED}" '{
      number: ($num | tonumber), state: "OPEN", isDraft: true,
      headRefName: "fix/dependabot-lodash", baseRefName: "main",
      mergeStateStatus: $ms, statusCheckRollup: $roll, autoMergeRequest: $amr
    }' > "$MOCK_DIR/view-$_num.json"
  }

  stub_update() { { printf '%s\n' "$2"; printf '%s' "$3"; } > "$MOCK_DIR/update-$1"; }
  stub_ready()  { { printf '%s\n' "$2"; printf '%s' "$3"; } > "$MOCK_DIR/ready-$1"; }

  # Reads the mock's call log after the subject ran.
  promoted_only_34() {
    if grep -q '^ready 34$' "$MOCK_DIR/log" && ! grep -q '^ready 12$' "$MOCK_DIR/log"; then
      echo ok
    else
      echo bad
    fi
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
    esac
  }

  Describe 'status'
    # The rollup mixes CheckRun nodes (status/conclusion) and legacy
    # StatusContext nodes (state only); both shapes must be read. An empty
    # rollup is "none", never "passed" (ADR 002: observe, don't assume).
    Describe 'checks derivation'
      Parameters
        empty          none
        success        passed
        failure        failed
        pending        pending
        mixed-passed   passed
        mixed-failed   failed
        status-pending pending
      End

      It "derives checks=$2 from a $1 rollup"
        stub_view 12 "$(rollup "$1")" null
        When call common_jq mark-ready.sh '.prs[0].checks' status "$URL12"
        The status should be success
        The output should equal "\"$2\""
      End
    End

    It 'counts checks and names the failing ones'
      stub_view 12 "$(rollup failure)" null
      When call common_jq mark-ready.sh '{counts: .prs[0].check_counts, failing: .prs[0].failing_checks}' status "$URL12"
      The status should be success
      The output should equal '{"counts":{"total":2,"passed":1,"failed":1,"pending":0},"failing":["lint"]}'
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
        When call common_jq mark-ready.sh '.prs[0] | {merge_state, behind, conflict}' status "$URL12"
        The status should be success
        The output should equal '{"merge_state":"'"$1"'","behind":'"$2"',"conflict":'"$3"'}'
      End
    End

    # Armed means promoting merges this PR once checks pass — a different
    # decision from handing it to a reviewer, and the caller must know which
    # one it is offering.
    Describe 'auto-merge'
      It 'distinguishes armed from merely permitted'
        stub_view 12 "$(rollup success)" '{"enabledBy":{"login":"octocat"},"mergeMethod":"SQUASH"}'
        export MOCK_ALLOW=true
        When call common_jq mark-ready.sh '.prs[0].auto_merge' status "$URL12"
        The status should be success
        The output should equal '{"permitted":true,"armed":true,"enabled_by":"octocat","method":"SQUASH"}'
      End

      It 'reports permitted-but-not-armed'
        stub_view 12 "$(rollup success)" null
        export MOCK_ALLOW=true
        When call common_jq mark-ready.sh '.prs[0].auto_merge' status "$URL12"
        The status should be success
        The output should equal '{"permitted":true,"armed":false,"enabled_by":null,"method":null}'
      End

      It 'reports not permitted'
        stub_view 12 "$(rollup success)" null
        export MOCK_ALLOW=false
        When call common_jq mark-ready.sh '.prs[0].auto_merge.permitted' status "$URL12"
        The status should be success
        The output should equal 'false'
      End

      It 'reports null when the setting is not visible to the token'
        stub_view 12 "$(rollup success)" null
        export MOCK_ALLOW=''
        When call common_jq mark-ready.sh '.prs[0].auto_merge.permitted' status "$URL12"
        The status should be success
        The output should equal 'null'
      End

      It 'looks the repository setting up once per repo, not once per PR'
        stub_view 12 "$(rollup success)" null
        stub_view 34 "$(rollup success)" null
        export MOCK_ALLOW=true
        When call common_jq mark-ready.sh '.prs | length' status "$URL12" "$URL34"
        The status should be success
        The output should equal '2'
        The value "$(grep -c '^api ' "$MOCK_DIR/log")" should equal 1
      End
    End

    It 'rejects a non-PR URL with an error entry and a non-zero exit'
      When call common_jq mark-ready.sh '.prs[0] | keys' status 'https://example.com/nope'
      The status should equal 1
      The output should equal '["error","url"]'
    End

    It 'reports a PR gh cannot view and still exits non-zero'
      # No view stub for 34: the mock's cat fails like a real gh error would.
      stub_view 12 "$(rollup success)" null
      When call common_jq mark-ready.sh '[.prs[] | has("error")]' status "$URL12" "$URL34"
      The status should equal 1
      The output should equal '[false,true]'
    End
  End

  Describe 'promote'
    It 'rebases then marks ready'
      When call common_jq mark-ready.sh '.prs[0]' promote "$URL12"
      The status should be success
      The output should equal '{"url":"'"$URL12"'","status":"rebased","ready":true,"stage":null,"detail":null}'
      The value "$(grep -c '^ready ' "$MOCK_DIR/log")" should equal 1
    End

    # gh's phrasing for "nothing to do" varies by version; every variant is
    # success and still proceeds to mark ready.
    Describe 'already up to date is success'
      Parameters
        0 'Branch is already up-to-date'
        1 'GraphQL: There are no new commits on the base branch.'
        1 'already up to date'
      End

      It "treats rc=$1 \"$2\" as already-current"
        stub_update 12 "$1" "$2"
        When call common_jq mark-ready.sh '.prs[0] | {status, ready}' promote "$URL12"
        The status should be success
        The output should equal '{"status":"already-current","ready":true}'
      End
    End

    It 'reports a conflict and never calls gh pr ready'
      stub_update 12 1 'GraphQL: merge conflict between base and head'
      When call common_jq mark-ready.sh '.prs[0] | {status, ready, stage}' promote "$URL12"
      The status should equal 1
      The output should equal '{"status":"conflict","ready":false,"stage":"rebase"}'
      The value "$(grep -c '^ready ' "$MOCK_DIR/log" || true)" should equal 0
    End

    It 'reports an unrecognized rebase failure as an error'
      stub_update 12 1 'HTTP 500: something broke'
      When call common_jq mark-ready.sh '.prs[0] | {status, stage, detail}' promote "$URL12"
      The status should equal 1
      The output should equal '{"status":"error","stage":"rebase","detail":"HTTP 500: something broke"}'
      The value "$(grep -c '^ready ' "$MOCK_DIR/log" || true)" should equal 0
    End

    It 'reports a failure at the ready stage'
      stub_ready 12 1 'HTTP 403: forbidden'
      When call common_jq mark-ready.sh '.prs[0] | {status, ready, stage}' promote "$URL12"
      The status should equal 1
      The output should equal '{"status":"error","ready":false,"stage":"ready"}'
    End

    It 'treats an already-ready PR as promoted'
      stub_ready 12 1 'Pull request #12 is not a draft'
      When call common_jq mark-ready.sh '.prs[0] | {status, ready}' promote "$URL12"
      The status should be success
      The output should equal '{"status":"rebased","ready":true}'
    End

    It 'keeps going after a conflict and reports every PR in order'
      stub_update 12 1 'merge conflict between base and head'
      When call common_jq mark-ready.sh '[.prs[] | {url, status, ready}]' promote "$URL12" "$URL34"
      The status should equal 1
      The output should equal '[{"url":"'"$URL12"'","status":"conflict","ready":false},{"url":"'"$URL34"'","status":"rebased","ready":true}]'
      The value "$(promoted_only_34)" should equal ok
    End
  End
End
