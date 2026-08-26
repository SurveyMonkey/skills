#!/bin/sh
# shellcheck shell=sh
# common/reap-agent-artifacts.sh — the orchestrator's per-agent reap of one
# finished fix agent's local leftovers (issue #131).
#
# Every example builds a real repository with a real `origin`, because the
# whole predicate is about git state: a registered worktree, a local ref, and
# a remote-tracking ref the agent's own push wrote. A faked worktree pointer
# cannot exercise `worktree remove`, and a faked ref cannot exercise the tip
# comparison that decides whether the branch is safe to delete. Nothing here
# reaches the network: `origin` is a bare repository in the same temp
# directory.

Describe 'reap-agent-artifacts.sh (issue #131)'
  BRANCH='fix/dependabot-example-pkg-6x'
  SIBLING_BRANCH='fix/dependabot-example-other-2x'

  After 'cleanup_fixture'

  make_repo() {
    TEST_DIR=$(mktemp -d)
    git init -q --bare "$TEST_DIR/origin.git" >/dev/null 2>&1
    git clone -q "$TEST_DIR/origin.git" "$TEST_DIR/repo" >/dev/null 2>&1
    REPO="$TEST_DIR/repo"
    git -C "$REPO" config user.email 'spec@example.invalid' >/dev/null 2>&1
    git -C "$REPO" config user.name 'spec' >/dev/null 2>&1
    : > "$REPO/README.md"
    git -C "$REPO" add README.md >/dev/null 2>&1
    git -C "$REPO" commit -qm init >/dev/null 2>&1
    git -C "$REPO" push -q -u origin HEAD:main >/dev/null 2>&1
    WORK="$REPO/.claude/worktrees/fix-dependabot-example-pkg-6x"
    mkdir -p "$REPO/.claude/worktrees"
  }

  # The state phase 1 of the fix agent leaves: the git worktree at `$WORK/fix`,
  # on its own branch cut from origin/<default_branch>.
  add_agent_worktree() {
    git -C "$REPO" worktree add -q "$WORK/fix" -b "$BRANCH" origin/main >/dev/null 2>&1
  }

  # And what a successful run adds: a commit pushed to origin, which is what
  # makes the local branch a duplicate of a ref that survives its deletion.
  push_fix_commit() {
    git -C "$WORK/fix" commit -q --allow-empty -m 'fix' >/dev/null 2>&1
    git -C "$WORK/fix" push -q -u origin "$BRANCH" >/dev/null 2>&1
  }

  reap() {
    common_jq reap-agent-artifacts.sh "$1" \
      --repo-root "$REPO" --branch "$BRANCH" --work "$WORK"
  }

  Describe 'a verified success, reaped whole'
    # The ordinary case the pool loop runs on every completion: the agent's own
    # Cleanup already removed the worktree in the normal path, but a crashed
    # success leaves it, and the branch is deliberately kept in some cases.
    It 'removes the worktree, the work directory, and the branch'
      make_repo
      add_agent_worktree
      push_fix_commit
      When call reap '{w: .worktree.action, d: .work_dir.action, b: .branch_ref.action, r: .branch_ref.reason, l: .left_behind, e: .errors}'
      The status should be success
      The output should equal '{"w":"removed","d":"removed","b":"deleted","r":"tip-on-origin","l":[],"e":[]}'
    End

    It 'leaves nothing on disk'
      make_repo
      add_agent_worktree
      push_fix_commit
      survey() {
        "$COMMON/reap-agent-artifacts.sh" \
          --repo-root "$REPO" --branch "$BRANCH" --work "$WORK" >/dev/null
        [ -d "$WORK" ] && printf 'work-dir-survived '
        git -C "$REPO" branch --list "$BRANCH" | tr -d ' '
        printf 'done\n'
      }
      When call survey
      The status should be success
      The output should equal 'done'
    End

    # The remote branch backs the open PR. Reaping it would close the PR's head
    # out from under a review in progress.
    It 'keeps the remote branch that backs the open pull request'
      make_repo
      add_agent_worktree
      push_fix_commit
      remote_ref() {
        "$COMMON/reap-agent-artifacts.sh" \
          --repo-root "$REPO" --branch "$BRANCH" --work "$WORK" >/dev/null
        git -C "$TEST_DIR/origin.git" for-each-ref --format='%(refname)' "refs/heads/$BRANCH"
      }
      When call remote_ref
      The status should be success
      The output should equal "refs/heads/$BRANCH"
    End
  End

  Describe 'idempotence'
    # A second reap of the same group is a no-op success, not an error: the
    # pool may retry a completion, and a well-behaved agent's own Cleanup
    # already removed most of this.
    It 'succeeds with nothing left to do on a second run'
      make_repo
      add_agent_worktree
      push_fix_commit
      "$COMMON/reap-agent-artifacts.sh" \
        --repo-root "$REPO" --branch "$BRANCH" --work "$WORK" >/dev/null
      When call reap '{w: .worktree.action, d: .work_dir.action, b: .branch_ref.action, r: .branch_ref.reason, l: .left_behind}'
      The status should be success
      The output should equal '{"w":"absent","d":"absent","b":"absent","r":"no-local-branch","l":[]}'
    End

    It 'succeeds where the agent left nothing at all'
      make_repo
      When call reap '{w: .worktree.action, d: .work_dir.action, b: .branch_ref.action, l: .left_behind, e: .errors}'
      The status should be success
      The output should equal '{"w":"absent","d":"absent","b":"absent","l":[],"e":[]}'
    End
  End

  Describe 'the branch is deleted only when its tip is on origin'
    # A commit that never reached the remote is the one artifact here that
    # cannot be recreated, so the tip is re-checked even though the caller has
    # already verified the pull request.
    It 'leaves a branch whose tip is ahead of origin, and names it'
      make_repo
      add_agent_worktree
      push_fix_commit
      git -C "$WORK/fix" commit -q --allow-empty -m 'unpushed' >/dev/null 2>&1
      When call reap '{b: .branch_ref.action, r: .branch_ref.reason, l: .left_behind, e: .errors}'
      The status should be success
      The output should equal "{\"b\":\"left\",\"r\":\"tip-not-on-origin\",\"l\":[\"$BRANCH\"],\"e\":[]}"
    End

    # No remote-tracking ref at all means nothing was ever pushed under that
    # name, which is the same hazard read from the other side.
    It 'leaves a branch with no remote-tracking ref, and names it'
      make_repo
      git -C "$REPO" branch "$BRANCH" >/dev/null 2>&1
      When call reap '{b: .branch_ref.action, r: .branch_ref.reason, l: .left_behind}'
      The status should be success
      The output should equal "{\"b\":\"left\",\"r\":\"no-remote-tracking-ref\",\"l\":[\"$BRANCH\"]}"
    End

    # A deliberate leave is a correct outcome, not a failure: the report says
    # what stayed and why, and phase 7 prints it.
    It 'exits 0 on a deliberate leave'
      make_repo
      git -C "$REPO" branch "$BRANCH" >/dev/null 2>&1
      When run script "$COMMON/reap-agent-artifacts.sh" \
        --repo-root "$REPO" --branch "$BRANCH" --work "$WORK"
      The status should be success
      The output should include 'no-remote-tracking-ref'
    End
  End

  Describe 'the work directory'
    # `$WORK` is the parent; the git worktree is at `$WORK/fix`. A run that
    # crashed between `mkdir -p` and `worktree add` leaves the parent alone,
    # and it is still this script's to remove.
    It 'removes a work directory that never held a worktree'
      make_repo
      mkdir -p "$WORK"
      : > "$WORK/why-example-pkg.json"
      When call reap '{w: .worktree.action, d: .work_dir.action, l: .left_behind}'
      The status should be success
      The output should equal '{"w":"absent","d":"removed","l":[]}'
    End

    It 'reports a leftover directory at the worktree path that git does not own'
      make_repo
      mkdir -p "$WORK/fix"
      When call reap '{w: .worktree.action, d: .work_dir.action, l: .left_behind}'
      The status should be success
      The output should equal '{"w":"not-a-worktree","d":"removed","l":[]}'
    End
  End

  Describe 'nothing repository-wide, and nothing belonging to a sibling'
    # Sibling agents are in flight by construction whenever the pool refills,
    # which is exactly when this runs. One named worktree and one named ref is
    # the whole entitlement.
    It 'leaves a sibling agent worktree and branch in place'
      make_repo
      add_agent_worktree
      push_fix_commit
      sibling_work="$REPO/.claude/worktrees/fix-dependabot-example-other-2x"
      git -C "$REPO" worktree add -q "$sibling_work/fix" -b "$SIBLING_BRANCH" origin/main >/dev/null 2>&1
      survey_sibling() {
        "$COMMON/reap-agent-artifacts.sh" \
          --repo-root "$REPO" --branch "$BRANCH" --work "$WORK" >/dev/null
        [ -e "$sibling_work/fix/.git" ] && printf 'worktree '
        git -C "$REPO" branch --list "$SIBLING_BRANCH" | tr -d ' *+'
      }
      When call survey_sibling
      The status should be success
      The output should equal "worktree $SIBLING_BRANCH"
    End

    # `git worktree prune` walks every entry in the repository, so a call timed
    # against a sibling's `worktree add` deletes a live registration and the
    # breakage surfaces in the victim (issue #35).
    prune_calls() { grep -v '^[[:space:]]*#' "$1" | grep -c 'worktree prune' || true; }
    prohibitions() { grep -c 'Never .git worktree prune' "$1" || true; }

    It 'never prunes'
      When call prune_calls "$COMMON/reap-agent-artifacts.sh"
      The status should be success
      The output should equal '0'
    End

    It 'records the prohibition rather than leaving its absence to chance'
      When call prohibitions "$COMMON/reap-agent-artifacts.sh"
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'argument validation'
    # The script runs `rm -rf` on the path it is handed, so the one shape it
    # accepts is a directory under that repository's own agent worktree root.
    It 'refuses a work path outside the repository worktree root'
      make_repo
      When run script "$COMMON/reap-agent-artifacts.sh" \
        --repo-root "$REPO" --branch "$BRANCH" --work "$TEST_DIR/elsewhere"
      The status should be failure
      The stderr should include 'is not under'
      The output should equal ''
    End

    It 'refuses the worktree root itself'
      make_repo
      When run script "$COMMON/reap-agent-artifacts.sh" \
        --repo-root "$REPO" --branch "$BRANCH" --work "$REPO/.claude/worktrees"
      The status should be failure
      The stderr should include 'is not under'
    End

    It 'refuses a repo_root that is not a git repository'
      make_repo
      When run script "$COMMON/reap-agent-artifacts.sh" \
        --repo-root "$TEST_DIR" --branch "$BRANCH" \
        --work "$TEST_DIR/.claude/worktrees/x"
      The status should be failure
      The stderr should include 'not a git repository'
    End

    It 'refuses a branch name git would reject'
      make_repo
      When run script "$COMMON/reap-agent-artifacts.sh" \
        --repo-root "$REPO" --branch 'fix/..bad' --work "$WORK"
      The status should be failure
      The stderr should include 'not a valid branch name'
    End

    It 'refuses a missing argument'
      When run script "$COMMON/reap-agent-artifacts.sh" --repo-root /tmp
      The status should be failure
      The stderr should include 'Usage:'
    End
  End
End

# The script is only half of the fix. Nothing executable decides *when* it runs
# or what happens to the artifacts it deliberately leaves: that is orchestrator
# prose in SKILL.md and agent prose in fix-dependency.md, so the sentences are
# the implementation and their absence is the whole regression (the
# spec/fix_dependency_branch_spec.sh pattern).
Describe 'the orchestrator-side reap (issue #131)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"

  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'the step in phase 6'
    It 'prescribes the reap with all three arguments'
      When call rule_in "$SKILL" 'reap-agent-artifacts.sh --repo-root <repo_root> --branch <branch_name> --work'
      The status should be success
      The output should equal '1'
    End

    # The script name appears exactly twice: the frontmatter grant and the one
    # prescribed invocation. A third is a second call site nobody decided on.
    It 'names the script only in the grant and the prescribed call'
      When call rule_in "$SKILL" 'reap-agent-artifacts.sh'
      The status should be success
      The output should equal '2'
    End

    It 'keeps the allowed-tools list accurate'
      When call rule_in "$SKILL" 'allowed-tools:.*reap-agent-artifacts.sh'
      The status should be success
      The output should equal '1'
    End

    # The verification is the gate, and it is the caller's: the script makes no
    # network call and asks gh nothing.
    It 'verifies the pull request before reaping anything'
      When call phrase_in "$SKILL" 'verified its pull request and before you refill its slot'
      The status should be success
      The output should equal '1'
    End

    It 'reaps only on an OPEN pull request'
      When call phrase_in "$SKILL" 'Only when it reads .OPEN'
      The status should be success
      The output should equal '1'
    End

    # The other half of the design: a failed or crashed agent keeps its
    # leftovers, so nothing is ever cleaned without a PR proving the tip is on
    # origin.
    It 'never reaps an agent that ended without a verified open PR'
      When call phrase_in "$SKILL" 'An agent that ended any other way is never reaped'
      The status should be success
      The output should equal '1'
    End

    # Sibling agents share the repo_root while the pool refills, which is
    # exactly when this runs.
    It 'states the local, single-artifact scope that makes it legal beside siblings'
      When call phrase_in "$SKILL" 'local scope only and reaps one named worktree and one named ref'
      The status should be success
      The output should equal '1'
    End

    It 'refills the slot even when the reap could not finish'
      When call phrase_in "$SKILL" 'A reap that could not finish must never stall the pool'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the report in phase 7'
    It 'reports the reaped count and everything left in place'
      When call phrase_in "$SKILL" 'say what phase 6.s reap removed and what it left'
      The status should be success
      The output should equal '1'
    End

    It 'says a leftover is recoverable only if the summary names it'
      When call phrase_in "$SKILL" 'but only if this summary says it is there'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the agent definition agrees with it'
    # Phase 1 still stops on a pre-existing $WORK. What changes is the
    # diagnosis it offers, now that a well-behaved success no longer leaves one.
    It 'reads a surviving work directory as a failed, crashed, or foreign run'
      When call rule_in "$AGENT" 'means a failed or crashed run, or a session that'
      The status should be success
      The output should equal '1'
    End

    It 'keeps the guard from clearing it anyway'
      When call rule_in "$AGENT" 'Neither is yours to clear from a distance'
      The status should be success
      The output should equal '1'
    End

    # Cleanup is not optional now that something else also cleans: the reap
    # covers exactly one exit path, and Cleanup covers all of them.
    It 'keeps agent Cleanup as the first line of defense'
      When call phrase_in "$AGENT" 'You are the first line of defense here, not the only one'
      The status should be success
      The output should equal '1'
    End

    It 'says the reap covers only the verified-PR exit path'
      When call phrase_in "$AGENT" 'the reap runs only on a verified open PR'
      The status should be success
      The output should equal '1'
    End
  End
End
