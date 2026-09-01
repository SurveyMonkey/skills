#!/bin/sh
# shellcheck shell=sh
# common/post-agent.sh — the one call phase 6 makes per completed fix agent:
# verify its pull request, reap when that verification allows it, and report
# the outcome for phase 7.
#
# post-agent.sh always resolves its two collaborators as siblings of its own
# path (`$SELF_DIR/pr-status.sh`, `$SELF_DIR/reap-agent-artifacts.sh`), so a
# PATH shim cannot intercept them, and every example instead runs a scratch
# copy of the real post-agent.sh next to *the real* pr-status.sh and
# reap-agent-artifacts.sh, copied verbatim from common/ — the "scratch-dir
# wrapper" the plugin's own CLAUDE.md calls for. pr-status.sh's own `gh` is
# driven by a PATH shim exactly the way spec/pr_status_spec.sh's `Mock gh`
# drives it, just as a real executable rather than a shellspec mock, because
# pr-status.sh runs here as a genuine subprocess of post-agent.sh, one level
# deeper than shellspec's own interception reaches. reap-agent-artifacts.sh
# is driven against real throwaway git repositories, the same fixtures
# spec/reap_agent_artifacts_spec.sh builds. Per the root CLAUDE.md rule that a
# shape found in the wild is the specimen, this is what makes the "well-shaped
# JSON that is not the promised report" and "the real script's exit status
# always agrees with its own errors[]" assertions meaningful: a hand-authored
# mock cannot fail to reproduce a defect it was never taught to have.
#
# Two collaborator behaviors cannot be produced by the real scripts, because
# each of those two always reports-and-fails rather than crashing silently or
# disagreeing with itself: pr-status.sh producing no output at all, and
# reap-agent-artifacts.sh printing a well-shaped report whose errors[] and
# exit status disagree. Both are exercised with a small synthetic
# replacement script instead, named as such at the point of use — this is
# testing post-agent.sh's own defense against a broken collaborator, not
# reproducing a shape either real script emits.
#
# Nothing here reaches the network: `origin` is a bare repository in the same
# scratch directory, and `gh` is the PATH shim above.

Describe 'post-agent.sh'
  URL12='https://github.com/octo/app/pull/12'
  URL34='https://github.com/octo/app/pull/34'
  URL56='https://github.com/octo/app/pull/56'

  setup_scratch() {
    SCRATCH=$(mktemp -d)
    mkdir -p "$SCRATCH/scripts" "$SCRATCH/bin"
    cp "$COMMON/post-agent.sh" "$SCRATCH/scripts/post-agent.sh"
    cp "$COMMON/pr-status.sh" "$SCRATCH/scripts/pr-status.sh"
    cp "$COMMON/reap-agent-artifacts.sh" "$SCRATCH/scripts/reap-agent-artifacts.sh"
    chmod +x "$SCRATCH"/scripts/*.sh
    POST_AGENT="$SCRATCH/scripts/post-agent.sh"

    MOCK_DIR="$SCRATCH/mock"
    mkdir -p "$MOCK_DIR"
    : > "$MOCK_DIR/gh-log"
    : > "$MOCK_DIR/prefix-log"

    # The real pr-status.sh calls `gh pr view <url> --json ...` unqualified,
    # so a PATH shim ahead of the real `gh` drives it against canned pull
    # request states without touching the network. A PR number with no
    # `view-N.json` stub reproduces gh's real "not found" shape, which is
    # what backs the "pr-status.sh could not read the pull request" example
    # below — a genuine gh failure text, not an invented one.
    cat > "$SCRATCH/bin/gh" <<'SCRIPT'
#!/usr/bin/env bash
case "$1 $2" in
  'pr view')
    num="${3##*/}"
    printf 'pr view %s\n' "$num" >> "$MOCK_DIR/gh-log"
    if [ -f "$MOCK_DIR/view-$num.json" ]; then
      cat "$MOCK_DIR/view-$num.json"
      exit 0
    fi
    printf 'gh: no pull requests found for pull request #%s\n' "$num" >&2
    exit 1
    ;;
  *)
    printf 'other %s %s\n' "$1" "$2" >> "$MOCK_DIR/gh-log"
    exit 1
    ;;
esac
SCRIPT
    chmod +x "$SCRATCH/bin/gh"

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
    PATH="$SCRATCH/bin:$PATH"
    export PATH
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

  # A real gh `pr view --json number,state,isDraft,headRefName,
  # baseRefName,mergeStateStatus,statusCheckRollup` payload, minimal but
  # complete: exactly the fields pr-status.sh reads.
  stub_view() {
    jq -nc --arg num "$1" --arg state "$2" '{
      number: ($num | tonumber), state: $state, isDraft: false,
      headRefName: "irrelevant", baseRefName: "main",
      mergeStateStatus: "UNKNOWN", statusCheckRollup: []
    }' > "$MOCK_DIR/view-$1.json"
  }

  # A real throwaway repository with a real `origin`, the same fixture
  # spec/reap_agent_artifacts_spec.sh builds — the whole predicate
  # reap-agent-artifacts.sh implements is about git state, so nothing short
  # of real git state can exercise it honestly.
  make_repo() {
    git init -q --bare "$SCRATCH/origin.git" >/dev/null 2>&1
    git clone -q "$SCRATCH/origin.git" "$SCRATCH/repo" >/dev/null 2>&1
    REPO_ROOT="$SCRATCH/repo"
    git -C "$REPO_ROOT" config user.email 'spec@example.invalid' >/dev/null 2>&1
    git -C "$REPO_ROOT" config user.name 'spec' >/dev/null 2>&1
    : > "$REPO_ROOT/README.md"
    git -C "$REPO_ROOT" add README.md >/dev/null 2>&1
    git -C "$REPO_ROOT" commit -qm init >/dev/null 2>&1
    git -C "$REPO_ROOT" push -q -u origin HEAD:main >/dev/null 2>&1
    mkdir -p "$REPO_ROOT/.claude/worktrees"
  }

  # The state phase 1 of the fix agent leaves for a given group: the git
  # worktree at `<work>/fix`, on its own branch cut from origin/main, with
  # the agent's own push already landed — exactly what makes the branch
  # delete provably safe.
  add_agent_worktree() {
    git -C "$REPO_ROOT" worktree add -q "$1/fix" -b "$2" origin/main >/dev/null 2>&1
  }
  push_fix_commit() {
    git -C "$1/fix" commit -q --allow-empty -m fix >/dev/null 2>&1
    git -C "$1/fix" push -q -u origin "$2" >/dev/null 2>&1
  }

  Describe 'a success whose pull request reads OPEN'
    It 'reaps and reports a clean sweep'
      make_repo
      WORK="$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x"
      add_agent_worktree "$WORK" fix-dependabot-example-pkg-1x
      push_fix_commit "$WORK" fix-dependabot-example-pkg-1x
      stub_view 12 OPEN
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When call post_agent_jq \
        '{status: .result_status, pr: .pr_state, reaped: .reaped, reason: .reason, l: .left_behind, e: .errors}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"status":"success","pr":"OPEN","reaped":true,"reason":null,"l":[],"e":[]}'
    End

    It 'leaves nothing on disk'
      make_repo
      WORK="$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x"
      add_agent_worktree "$WORK" fix-dependabot-example-pkg-1x
      push_fix_commit "$WORK" fix-dependabot-example-pkg-1x
      stub_view 12 OPEN
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      survey() {
        "$POST_AGENT" --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT" >/dev/null
        [ -d "$WORK" ] && printf 'work-dir-survived '
        git -C "$REPO_ROOT" branch --list fix-dependabot-example-pkg-1x | tr -d ' '
        printf 'done\n'
      }
      When call survey
      The status should be success
      The output should equal 'done'
    End

    It 'builds the worktree path from the repo root, package, and major line'
      make_repo
      stub_view 12 OPEN
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When call post_agent_jq '.worktree_path' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal "\"$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x\""
    End

    It 'reports exactly the documented entry shape'
      make_repo
      stub_view 12 OPEN
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When call post_agent_jq 'keys' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '["branch","errors","left_behind","major_line","package","pr_state","pr_url","reaped","reason","result_status","worktree_path"]'
    End
  End

  Describe 'a success whose pull request is not open'
    It 'is not reaped, and names the state in the reason'
      make_repo
      stub_view 34 MERGED
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL34")"
      When call post_agent_jq \
        '{reaped: .reaped, pr: .pr_state, reason: .reason}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"reaped":false,"pr":"MERGED","reason":"pull request is not open (state=MERGED)"}'
    End

    It 'reports the worktree path and branch as left behind, and never calls the reap'
      make_repo
      stub_view 34 MERGED
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL34")"
      When call post_agent_jq '.left_behind' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal "[\"$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x\",\"fix-dependabot-example-pkg-1x\"]"
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
      When call post_agent_jq \
        '{status: .result_status, reaped: .reaped, reason: .reason, pr: .pr_url}' \
        --result "$SCRATCH/result.json" --repo-root "$SCRATCH/repo"
      The status should be success
      The output should equal '{"status":"no-op","reaped":false,"reason":"no-op: the agent made no fix, so there is nothing to verify or reap","pr":null}'
      The value "$(cat "$MOCK_DIR/gh-log")" should equal ''
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
        --result "$SCRATCH/result.json" --repo-root "$SCRATCH/repo"
      The status should be success
      The output should equal '{"status":"failure","reaped":false,"reason":"failure: the agent'"'"'s result was a failure"}'
      The value "$(cat "$MOCK_DIR/gh-log")" should equal ''
    End
  End

  Describe 'an unparseable result block, with the dispatch-payload fallback'
    It 'falls back to --package/--major-line/--branch and reports unparsable'
      write_result 'this is not json'
      When call post_agent_jq \
        '{status: .result_status, reaped: .reaped, worktree: .worktree_path, branch: .branch}' \
        --result "$SCRATCH/result.json" --repo-root "$SCRATCH/repo" \
        --package example-pkg --major-line 3 --branch fix-dependabot-example-pkg-3x
      The status should be success
      The output should equal "{\"status\":\"unparsable\",\"reaped\":false,\"worktree\":\"$SCRATCH/repo/.claude/worktrees/fix-dependabot-example-pkg-3x\",\"branch\":\"fix-dependabot-example-pkg-3x\"}"
      The value "$(cat "$MOCK_DIR/gh-log")" should equal ''
    End

    # A malformed success block — missing the pr_url the contract promises —
    # is exactly as unusable as one that never parsed at all, never read as
    # a no-op or a success with a null PR.
    It 'treats a success block missing its promised pr_url as unparseable too'
      jq -nc '{status: "success", package: "example-pkg", major_line: "1",
               branch: "fix-dependabot-example-pkg-1x"}' > "$SCRATCH/result.json"
      When call post_agent_jq '.result_status' \
        --result "$SCRATCH/result.json" --repo-root "$SCRATCH/repo" \
        --package example-pkg --major-line 1 --branch fix-dependabot-example-pkg-1x
      The status should be success
      The output should equal '"unparsable"'
    End

    # The field-mixing hazard (correctness review, PR #179): a success block
    # missing `package` used to keep its own (validated) `branch` while
    # taking `package` from the dispatch-payload fallback, assembling a
    # worktree path for one group out of another group's identity. The whole
    # block is unparsable now, so `worktree` and `branch` both come from the
    # SAME source — the fallback — never a mix of the two.
    It 'never mixes a validated branch from the block with a package from the fallback'
      jq -nc '{status: "success", major_line: "1", branch: "real-branch",
               pr_url: "https://github.com/octo/app/pull/1"}' > "$SCRATCH/result.json"
      When call post_agent_jq '{status: .result_status, worktree: .worktree_path, branch: .branch}' \
        --result "$SCRATCH/result.json" --repo-root "$SCRATCH/repo" \
        --package fallback-pkg --major-line 9 --branch fallback-branch
      The status should be success
      The output should equal "{\"status\":\"unparsable\",\"worktree\":\"$SCRATCH/repo/.claude/worktrees/fix-dependabot-fallback-pkg-9x\",\"branch\":\"fallback-branch\"}"
    End

    # And the type half of the same gate: a `package`/`major_line` that is
    # present but not a string renders into the path via `jq -r` as literal
    # object/array text otherwise — a multi-line path a deleting script would
    # still accept.
    It 'rejects a non-string package and major_line rather than rendering them into the path'
      jq -nc '{status: "success", package: 5, major_line: {"a":1},
               branch: "real-branch", pr_url: "https://github.com/octo/app/pull/1"}' \
        > "$SCRATCH/result.json"
      When call post_agent_jq '.result_status' \
        --result "$SCRATCH/result.json" --repo-root "$SCRATCH/repo" \
        --package fallback-pkg --major-line 1 --branch fallback-branch
      The status should be success
      The output should equal '"unparsable"'
    End

    It 'extracts the last fenced ```json block from a full agent transcript'
      make_repo
      stub_view 12 MERGED
      {
        printf 'Some closing prose from the agent.\n\n```json\n'
        success_result 'fix-dependabot-example-pkg-1x' "$URL12"
        printf '\n```\n'
      } > "$SCRATCH/result.json"
      When call post_agent_jq '.result_status' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '"success"'
    End

    # Correctness review, PR #179: recording the fenced block only at its
    # closing ``` meant a cut-off final block silently fell back to whatever
    # CLOSED block came earlier — including a quoted copy of the Result
    # *template*, placeholders and all, which passes every has()/type check.
    It 'refuses a truncated final fence rather than promoting an earlier closed one'
      {
        printf 'Here is the schema for reference:\n\n```json\n'
        printf '{"status": "success", "package": "<package>", "major_line": "<major_line>", "branch": "<branch_name>", "pr_url": "https://github.com/<nwo>/pull/<n>"}\n'
        printf '```\n\n'
        printf 'Now my actual result:\n\n```json\n'
        printf '{"status": "success", "package": "real-pkg", "major_line": "3", "branch": "real-branch", "pr_url": "https://github.com/octo/app/pull/9"\n'
        # deliberately no closing fence: the message was cut off here
      } > "$SCRATCH/result.json"
      When call post_agent_jq '{status: .result_status, worktree: .worktree_path, branch: .branch}' \
        --result "$SCRATCH/result.json" --repo-root "$SCRATCH/repo" \
        --package fallback-pkg --major-line 7 --branch fallback-branch
      The status should be success
      The output should equal "{\"status\":\"unparsable\",\"worktree\":\"$SCRATCH/repo/.claude/worktrees/fix-dependabot-fallback-pkg-7x\",\"branch\":\"fallback-branch\"}"
    End
  End

  # A result block that parsed cleanly can still disagree with the
  # dispatch-payload fallback the caller supplied for the same group
  # (correctness review, PR #179). The result's own value is still what
  # drives the reap — it passed the has()/type/non-empty gate — but the
  # mismatch is reported rather than silently swallowed.
  Describe 'a result/fallback disagreement'
    It 'reports the mismatch and still reaps using the result'"'"'s own package'
      make_repo
      WORK="$REPO_ROOT/.claude/worktrees/fix-dependabot-real-pkg-1x"
      add_agent_worktree "$WORK" fix-dependabot-real-pkg-1x
      push_fix_commit "$WORK" fix-dependabot-real-pkg-1x
      stub_view 12 OPEN
      jq -nc --arg pr_url "$URL12" '{status: "success", package: "real-pkg",
        major_line: "1", branch: "fix-dependabot-real-pkg-1x", pr_url: $pr_url}' \
        > "$SCRATCH/result.json"
      When call post_agent_jq '{errors: .errors, worktree: .worktree_path, reaped: .reaped}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT" --package other-pkg
      The status should be success
      The output should equal "{\"errors\":[\"the result block's package ('real-pkg') disagrees with the --package fallback ('other-pkg')\"],\"worktree\":\"$REPO_ROOT/.claude/worktrees/fix-dependabot-real-pkg-1x\",\"reaped\":true}"
    End
  End

  # Issue #161's shape, applied here: <package_path> is <package> with every
  # `/` replaced by `-`, computed once by this script and never left to a
  # copy-pasted template. A path handed the raw scoped name would split into
  # a `@example-scope/` directory the fix agent never created.
  Describe 'a scoped package name'
    It 'flattens the worktree path to one segment, never a nested one'
      make_repo
      stub_view 12 MERGED
      write_result "$(success_result 'fix/dependabot-@example-scope/example-pkg-2x' "$URL12" '@example-scope/example-pkg' '2')"
      When call post_agent_jq '.worktree_path' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal "\"$REPO_ROOT/.claude/worktrees/fix-dependabot-@example-scope-example-pkg-2x\""
    End

    It 'leaves the branch name'"'"'s own slash untouched'
      make_repo
      stub_view 12 MERGED
      write_result "$(success_result 'fix/dependabot-@example-scope/example-pkg-2x' "$URL12" '@example-scope/example-pkg' '2')"
      When call post_agent_jq '.branch' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '"fix/dependabot-@example-scope/example-pkg-2x"'
    End
  End

  Describe 'a reap that exits without printing a report at all'
    # A real specimen (not a mock told to behave this way): the real
    # reap-agent-artifacts.sh refuses a branch name that begins with a dash
    # before it prints anything, exactly the "rejected argument" case the
    # header describes.
    It 'is not reaped, and the worktree path and branch are derived rather than claimed clean'
      make_repo
      stub_view 12 OPEN
      write_result "$(success_result '-D' "$URL12")"
      When call post_agent_jq \
        '{reaped: .reaped, l: .left_behind, has_errors: (.errors | length > 0)}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal "{\"reaped\":false,\"l\":[\"$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x\",\"-D\"],\"has_errors\":true}"
    End
  End

  Describe 'a reap that reports a non-empty left_behind'
    # A real specimen of the "worktree cannot come off" shape
    # spec/reap_agent_artifacts_spec.sh calls `broken_pointer`: a `.git`
    # pointer file naming a gitdir that does not exist. `worktree remove`
    # refuses it for real, so `errors` is genuinely non-empty and the
    # process genuinely exits 1 — the case REAP_AGREES is built to accept.
    It 'still counts as reaped, and passes the reap'"'"'s own left_behind and errors through'
      make_repo
      WORK="$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x"
      mkdir -p "$WORK/fix"
      printf 'gitdir: /nonexistent\n' > "$WORK/fix/.git"
      stub_view 12 OPEN
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When call post_agent_jq \
        '{reaped: .reaped, l: (.left_behind | length), e: (.errors | length > 0)}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"reaped":true,"l":2,"e":true}'
    End
  End

  # These two shapes cannot come from the real reap-agent-artifacts.sh — its
  # own invariant (`[ -z "$errors" ] || exit 1`) means its exit status and its
  # own errors[] always agree, and it never prints an object missing the keys
  # its header promises. Both are exercised with a small synthetic
  # replacement, named as such, to prove post-agent.sh's own defense rather
  # than to reproduce something the real script does.
  Describe 'a reap report of the wrong shape (synthetic: unreachable via the real script)'
    fake_reap() {
      cat > "$SCRATCH/scripts/reap-agent-artifacts.sh" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' '$1'
exit $2
SCRIPT
      chmod +x "$SCRATCH/scripts/reap-agent-artifacts.sh"
    }

    It 'is not reaped when the reap prints an empty object'
      make_repo
      stub_view 12 OPEN
      fake_reap '{}' 1
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When call post_agent_jq '{reaped: .reaped, has_errors: (.errors | length > 0)}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"reaped":false,"has_errors":true}'
    End

    It 'is not reaped when the reap prints an error-only object with none of the promised keys'
      make_repo
      stub_view 12 OPEN
      fake_reap '{"error": "work path is not..."}' 1
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When call post_agent_jq '{reaped: .reaped, has_errors: (.errors | length > 0)}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"reaped":false,"has_errors":true}'
    End

    It 'is not reaped when a well-shaped report'"'"'s errors[] disagrees with a zero exit'
      make_repo
      stub_view 12 OPEN
      fake_reap '{"worktree":{"path":"p","action":"removed"},"work_dir":{"path":"p","action":"removed"},"branch_ref":{"action":"deleted","reason":"tip-on-origin"},"left_behind":[],"errors":["boom"]}' 0
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When call post_agent_jq '{reaped: .reaped, reason: .reason}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"reaped":false,"reason":"reap-agent-artifacts.sh'"'"'s exit status (0) disagrees with its own errors array (count=1); the report cannot be trusted"}'
    End

    It 'is not reaped when a well-shaped report claims empty errors[] but exited non-zero'
      make_repo
      stub_view 12 OPEN
      fake_reap '{"worktree":{"path":"p","action":"failed"},"work_dir":{"path":"p","action":"skipped"},"branch_ref":{"action":"left","reason":"tip-not-on-origin"},"left_behind":[],"errors":[]}' 1
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When call post_agent_jq '{reaped: .reaped, reason: .reason}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"reaped":false,"reason":"reap-agent-artifacts.sh'"'"'s exit status (1) disagrees with its own errors array (count=0); the report cannot be trusted"}'
    End
  End

  Describe 'pr-status.sh itself failing'
    It 'is not reaped when the pull request could not be read'
      make_repo
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL56")"
      When call post_agent_jq \
        '{reaped: .reaped, reason: .reason}' \
        --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT"
      The status should be success
      The output should equal '{"reaped":false,"reason":"pr-status.sh could not read the pull request: gh: no pull requests found for pull request #56"}'
    End

    # Real pr-status.sh always reports-and-fails; it never exits with empty
    # stdout. This exercises post-agent.sh's own defense against a
    # collaborator that crashes outright, with a minimal synthetic stand-in.
    It 'is not reaped when pr-status.sh crashes with no output at all (synthetic: unreachable via the real script)'
      cat > "$SCRATCH/scripts/pr-status.sh" <<'SCRIPT'
#!/usr/bin/env bash
exit 1
SCRIPT
      chmod +x "$SCRATCH/scripts/pr-status.sh"
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When call post_agent_jq '.reaped' \
        --result "$SCRATCH/result.json" --repo-root "$SCRATCH/repo"
      The status should be success
      The output should equal 'false'
    End
  End

  Describe 'argument validation'
    It 'refuses an empty --repo-root rather than letting it fall through to git'
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When run script "$POST_AGENT" --result "$SCRATCH/result.json" --repo-root ''
      The status should be failure
      The stderr should include 'must not be empty'
      The output should include '"error"'
    End

    # jq is this script's one hard dependency and `die` is built out of it
    # (mirrors reap-agent-artifacts.sh's own "refuses to run at all without
    # jq" example).
    It 'refuses to run at all without jq'
      mkdir -p "$SCRATCH/nobin"
      for c in bash dirname cat printf mktemp rm; do
        p=$(command -v "$c" 2>/dev/null) && ln -sf "$p" "$SCRATCH/nobin/$c"
      done
      without_jq() {
        PATH="$SCRATCH/nobin" "$POST_AGENT" --result "$SCRATCH/result.json" --repo-root "$SCRATCH/repo"
      }
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      When run without_jq
      The status should be failure
      The stderr should include 'jq is required'
    End
  End

  # env_prefix is threaded to the pull-request read, which needs the repo's
  # identity, and never to the reap, which touches only a local directory and
  # a local ref (scripts/CLAUDE.md, "env_prefix is an opaque, optional seam").
  Describe 'env_prefix'
    It 'wraps the pr-status.sh call and never the reap'
      make_repo
      WORK="$REPO_ROOT/.claude/worktrees/fix-dependabot-example-pkg-1x"
      add_agent_worktree "$WORK" fix-dependabot-example-pkg-1x
      push_fix_commit "$WORK" fix-dependabot-example-pkg-1x
      stub_view 12 OPEN
      write_result "$(success_result 'fix-dependabot-example-pkg-1x' "$URL12")"
      "$POST_AGENT" --result "$SCRATCH/result.json" --repo-root "$REPO_ROOT" \
        --env-prefix "$SCRATCH/scripts/env-prefix" >/dev/null
      When call cat "$MOCK_DIR/prefix-log"
      The status should be success
      The output should include 'pr-status.sh'
      The output should not include 'reap-agent-artifacts.sh'
    End
  End
End
