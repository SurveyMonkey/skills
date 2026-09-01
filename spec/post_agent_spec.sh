#!/bin/sh
# shellcheck shell=sh
# common/post-agent.sh — the one call phase 6 makes per completed fix agent:
# verify its pull request, reap when that verification allows it, and report
# the outcome for phase 7.
#
# post-agent.sh always resolves its two collaborators as siblings of its own
# path (`$SELF_DIR/pr-status.sh`, `$SELF_DIR/reap-agent-artifacts.sh`), so a
# PATH shim cannot intercept them. Every example instead runs a scratch copy
# of the real script sitting next to mock collaborators built for this suite
# — the "scratch-dir wrapper" the plugin's own CLAUDE.md calls for. Nothing
# here reaches gh, git, or the network: the mocks are driven entirely by
# control files under $MOCK_DIR.

Describe 'post-agent.sh'
  URL='https://github.com/octo/app/pull/12'

  setup_scratch() {
    SCRATCH=$(mktemp -d)
    mkdir -p "$SCRATCH/scripts"
    cp "$COMMON/post-agent.sh" "$SCRATCH/scripts/post-agent.sh"
    chmod +x "$SCRATCH/scripts/post-agent.sh"
    POST_AGENT="$SCRATCH/scripts/post-agent.sh"

    MOCK_DIR="$SCRATCH/mock"
    mkdir -p "$MOCK_DIR"
    : > "$MOCK_DIR/pr-status-args"
    : > "$MOCK_DIR/reap-args"
    : > "$MOCK_DIR/prefix-log"
    printf 'OPEN\n' > "$MOCK_DIR/pr-mode"
    printf 'clean\n' > "$MOCK_DIR/reap-mode"

    REPO_ROOT="$SCRATCH/repo"
    mkdir -p "$REPO_ROOT"

    # Driven by $MOCK_DIR/pr-mode: OPEN | MERGED | ERROR | CRASH. Every call
    # is logged, prefix included, so a test can assert env_prefix reached
    # this script and reap-agent-artifacts.sh's mock below.
    cat > "$SCRATCH/scripts/pr-status.sh" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_DIR/pr-status-args"
url="$1"
mode=$(cat "$MOCK_DIR/pr-mode" 2>/dev/null || printf 'OPEN')
case "$mode" in
  OPEN)   printf '{"prs":[{"url":"%s","state":"OPEN"}]}\n' "$url"; exit 0 ;;
  MERGED) printf '{"prs":[{"url":"%s","state":"MERGED"}]}\n' "$url"; exit 0 ;;
  ERROR)  printf '{"prs":[{"url":"%s","error":"gh pr view failed: 404"}]}\n' "$url"; exit 1 ;;
  CRASH)  exit 1 ;;
esac
SCRIPT
    chmod +x "$SCRATCH/scripts/pr-status.sh"

    # Driven by $MOCK_DIR/reap-mode: clean | dirty | silent.
    cat > "$SCRATCH/scripts/reap-agent-artifacts.sh" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_DIR/reap-args"
branch=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch) branch=$2; shift 2 ;;
    *)        shift ;;
  esac
done
mode=$(cat "$MOCK_DIR/reap-mode" 2>/dev/null || printf 'clean')
case "$mode" in
  clean)
    printf '{"repo_root":"x","branch":"%s","left_behind":[],"errors":[]}\n' "$branch"
    exit 0
    ;;
  dirty)
    printf '{"repo_root":"x","branch":"%s","left_behind":["stale-thing"],"errors":["worktree remove failed: boom"]}\n' "$branch"
    exit 1
    ;;
  silent)
    printf '{"error":"branch name must not begin with a dash"}\n' >&2
    exit 1
    ;;
esac
SCRIPT
    chmod +x "$SCRATCH/scripts/reap-agent-artifacts.sh"

    # A prefix a repo's environment would require for its own gh/git calls.
    # Logging its own invocation is what lets a test tell whether it wrapped
    # pr-status.sh, reap-agent-artifacts.sh, both, or neither.
    cat > "$SCRATCH/scripts/env-prefix" <<'SCRIPT'
#!/usr/bin/env bash
printf 'prefix-called:%s\n' "$*" >> "$MOCK_DIR/prefix-log"
exec "$@"
SCRIPT
    chmod +x "$SCRATCH/scripts/env-prefix"

    export MOCK_DIR
  }

  cleanup_scratch() {
    [ -n "${SCRATCH:-}" ] && [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
  }

  Before 'setup_scratch'
  After 'cleanup_scratch'

  # Same shape as spec_helper's common_jq/adapter_jq: run the script, print a
  # compact jq projection of its stdout, and preserve its own exit status.
  post_agent_jq() {
    _filter=$1
    shift
    _st=0
    _out=$("$POST_AGENT" "$@") || _st=$?
    if [ -n "$_out" ]; then
      printf '%s' "$_out" | jq -c "$_filter"
    fi
    return "$_st"
  }

  write_result() {
    printf '%s' "$1" > "$SCRATCH/result.json"
  }

  success_result() {
    jq -nc --arg branch "$1" --arg pr_url "$2" --arg pkg "${3:-example-pkg}" \
      --arg major "${4:-1}" \
      '{status: "success", package: $pkg, major_line: $major, repo: "octo/app",
        branch: $branch, pr_url: $pr_url, action: "direct-update",
        resolved_version: "1.2.3", risk: {band: "Low", score: 1, f4: 0, f5: 0},
        observations: [], requires_major_bump: [], bare_override: "none",
        no_op: null, failure: null}'
  }

  Describe 'a success whose pull request reads OPEN'
    It 'reaps and reports a clean sweep'
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      When call post_agent_jq \
        '{status: .result_status, pr: .pr_state, reaped: .reaped, reason: .reason, l: .left_behind, e: .errors}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"status":"success","pr":"OPEN","reaped":true,"reason":null,"l":[],"e":[]}'
    End

    It 'builds the worktree path from the repo root, package, and major line'
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      When call post_agent_jq '.worktree_path' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal "\"$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x\""
    End

    It 'reports exactly the documented entry shape'
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      When call post_agent_jq 'keys' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '["branch","errors","left_behind","major_line","package","pr_state","pr_url","reaped","reason","result_status","worktree_path"]'
    End

    It 'calls the reap with the repo root, branch, and derived worktree path'
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      "$POST_AGENT" --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT" >/dev/null
      When call cat "$MOCK_DIR/reap-args"
      The status should be success
      The output should equal "--repo-root $REPO_ROOT --branch fix-dependabot-example-pkg-1x --work $REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x"
    End
  End

  Describe 'a success whose pull request is not open'
    It 'is not reaped, and names the state in the reason'
      printf 'MERGED\n' > "$MOCK_DIR/pr-mode"
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      When call post_agent_jq \
        '{reaped: .reaped, pr: .pr_state, reason: .reason}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"reaped":false,"pr":"MERGED","reason":"pull request is not open (state=MERGED)"}'
    End

    It 'reports the worktree path and branch as left behind, and never calls the reap'
      printf 'MERGED\n' > "$MOCK_DIR/pr-mode"
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      "$POST_AGENT" --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT" >/dev/null
      When call post_agent_jq '.left_behind' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal "[\"$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x\",\"fix-dependabot-example-pkg-1x\"]"
      The value "$(cat "$MOCK_DIR/reap-args")" should equal ''
    End
  End

  Describe 'a no-op'
    no_op_result() {
      jq -nc --arg branch "$1" \
        '{status: "no-op", package: "example-pkg", major_line: "1", repo: "octo/app",
          branch: $branch, pr_url: null, action: null, resolved_version: "1.2.3",
          risk: null, observations: [], requires_major_bump: [], bare_override: "none",
          no_op: {reason: "already fixed on main", evidence: {}}, failure: null}'
    }

    It 'is never checked against a pull request and is never reaped'
      write_result "$(no_op_result 'fix-dependabot-example-pkg-1x')"
      "$POST_AGENT" --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT" >/dev/null
      When call post_agent_jq \
        '{status: .result_status, reaped: .reaped, reason: .reason, pr: .pr_url}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"status":"no-op","reaped":false,"reason":"no-op: the agent made no fix, so there is nothing to verify or reap","pr":null}'
      The value "$(cat "$MOCK_DIR/pr-status-args")" should equal ''
      The value "$(cat "$MOCK_DIR/reap-args")" should equal ''
    End
  End

  Describe 'a failure'
    failure_result() {
      jq -nc --arg branch "$1" \
        '{status: "failure", package: "example-pkg", major_line: "1", repo: "octo/app",
          branch: $branch, pr_url: null, action: null, resolved_version: null,
          risk: null, observations: [], requires_major_bump: [], bare_override: "none",
          no_op: null, failure: {phase: "validate", detail: "other_line_moves fatal"}}'
    }

    It 'is never reaped, and the reason names the failure'
      write_result "$(failure_result 'fix-dependabot-example-pkg-1x')"
      When call post_agent_jq \
        '{status: .result_status, reaped: .reaped, reason: .reason}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"status":"failure","reaped":false,"reason":"failure: the agent'"'"'s result was a failure"}'
      The value "$(cat "$MOCK_DIR/reap-args")" should equal ''
    End
  End

  Describe 'an unparseable result block, with the dispatch-payload fallback'
    It 'falls back to --package/--major-line/--branch and reports unparsable'
      write_result 'this is not json'
      When call post_agent_jq \
        '{status: .result_status, reaped: .reaped, worktree: .worktree_path, branch: .branch}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT" \
        --package example-pkg --major-line 3 --branch fix-dependabot-example-pkg-3x
      The status should be success
      The output should equal "{\"status\":\"unparsable\",\"reaped\":false,\"worktree\":\"$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-3x\",\"branch\":\"fix-dependabot-example-pkg-3x\"}"
      The value "$(cat "$MOCK_DIR/pr-status-args")" should equal ''
    End

    # A malformed success block — missing the pr_url the contract promises —
    # is exactly as unusable as one that never parsed at all, never read as
    # a no-op or a success with a null PR.
    It 'treats a success block missing its promised pr_url as unparseable too'
      jq -nc '{status: "success", package: "example-pkg", major_line: "1",
               branch: "fix-dependabot-example-pkg-1x"}' > "$SCRATCH/result.json"
      When call post_agent_jq '.result_status' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT" \
        --package example-pkg --major-line 1 --branch fix-dependabot-example-pkg-1x
      The status should be success
      The output should equal '"unparsable"'
    End

    It 'extracts the last fenced ```json block from a full agent transcript'
      {
        printf 'Some closing prose from the agent.\n\n```json\n'
        success_result 'fix-dependabot-example-pkg-1x' "$URL"
        printf '\n```\n'
      } > "$SCRATCH/result.json"
      When call post_agent_jq '.result_status' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '"success"'
    End
  End

  Describe 'a missing result block, with the dispatch-payload fallback'
    It 'reports missing and still derives the worktree path and branch'
      : > "$SCRATCH/result.json"
      When call post_agent_jq \
        '{status: .result_status, worktree: .worktree_path, l: .left_behind}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT" \
        --package example-pkg --major-line 2 --branch fix-dependabot-example-pkg-2x
      The status should be success
      The output should equal "{\"status\":\"missing\",\"worktree\":\"$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-2x\",\"l\":[\"$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-2x\",\"fix-dependabot-example-pkg-2x\"]}"
    End

    It 'refuses to run at all when no fallback is given either'
      When run script "$POST_AGENT" --result "$SCRATCH/no-such-file.json" --repo-root "$REPO_ROOT"
      The status should be failure
      The stderr should include 'no package name available'
      The output should include '"error"'
    End
  End

  # Issue #161's shape, applied here: <package_path> is <package> with every
  # `/` replaced by `-`, computed once by this script and never left to a
  # copy-pasted template. A path handed the raw scoped name would split into
  # a `@example-scope/` directory the fix agent never created.
  Describe 'a scoped package name'
    It 'flattens the worktree path to one segment, never a nested one'
      write_result "$(success_result 'fix/dependabot-@example-scope/example-pkg-2x' "$URL" '@example-scope/example-pkg' '2')"
      When call post_agent_jq '.worktree_path' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal "\"$REPO_ROOT/.claude/worktrees/fix-dependabot-@example-scope-example-pkg-2x\""
    End

    It 'leaves the branch name'"'"'s own slash untouched'
      write_result "$(success_result 'fix/dependabot-@example-scope/example-pkg-2x' "$URL" '@example-scope/example-pkg' '2')"
      When call post_agent_jq '.branch' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '"fix/dependabot-@example-scope/example-pkg-2x"'
    End
  End

  Describe 'a reap that exits without printing a report at all'
    It 'is not reaped, and the worktree path and branch are derived rather than claimed clean'
      printf 'silent\n' > "$MOCK_DIR/reap-mode"
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      When call post_agent_jq \
        '{reaped: .reaped, l: .left_behind, has_errors: (.errors | length > 0)}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal "{\"reaped\":false,\"l\":[\"$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x\",\"fix-dependabot-example-pkg-1x\"],\"has_errors\":true}"
    End
  End

  Describe 'a reap that reports a non-empty left_behind'
    It 'still counts as reaped, and passes the reap'"'"'s own left_behind and errors through'
      printf 'dirty\n' > "$MOCK_DIR/reap-mode"
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      When call post_agent_jq \
        '{reaped: .reaped, l: .left_behind, e: .errors}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"reaped":true,"l":["stale-thing"],"e":["worktree remove failed: boom"]}'
    End
  End

  Describe 'pr-status.sh itself failing'
    It 'is not reaped when the pull request could not be read'
      printf 'ERROR\n' > "$MOCK_DIR/pr-mode"
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      When call post_agent_jq \
        '{reaped: .reaped, reason: .reason}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"reaped":false,"reason":"pr-status.sh could not read the pull request: gh pr view failed: 404"}'
      The value "$(cat "$MOCK_DIR/reap-args")" should equal ''
    End

    It 'is not reaped when pr-status.sh crashes with no output at all'
      printf 'CRASH\n' > "$MOCK_DIR/pr-mode"
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      When call post_agent_jq '.reaped' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal 'false'
    End
  End

  Describe 'argument validation'
    It 'refuses an empty --repo-root rather than letting it fall through to git'
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      When run script "$POST_AGENT" --result "$SCRATCH/result.json" --repo-root ''
      The status should be failure
      The stderr should include 'must not be empty'
      The output should include '"error"'
    End
  End

  # env_prefix is threaded to the pull-request read, which needs the repo's
  # identity, and never to the reap, which touches only a local directory and
  # a local ref (scripts/CLAUDE.md, "env_prefix is an opaque, optional seam").
  Describe 'env_prefix'
    It 'wraps the pr-status.sh call and never the reap'
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL")"
      "$POST_AGENT" --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT" \
        --env-prefix "$SCRATCH/scripts/env-prefix" >/dev/null
      When call cat "$MOCK_DIR/prefix-log"
      The status should be success
      The output should include 'pr-status.sh'
      The output should not include 'reap-agent-artifacts.sh'
    End
  End
End
