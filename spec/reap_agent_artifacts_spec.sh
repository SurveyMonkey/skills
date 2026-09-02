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
    # One named worktree and one named ref is the whole entitlement, and that
    # is a property of what this script may touch rather than of when it is
    # called: since issue #175 the reap runs after the dispatch workflow
    # returns, so a sibling is usually finished, and none of that licenses
    # widening the blast radius here.
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

  # Every example here asserts the VERDICT, not the parse: exit 1, a non-empty
  # errors[], and the report still on stdout. A mutant that never exits 1
  # survived the first round of this suite, because nothing asserted the status
  # on a path that had to fail.
  Describe 'a reap that could not finish reports and fails'
    # `worktree remove` refuses a pointer file naming a gitdir that is not
    # there, which is the shape a half-deleted worktree leaves.
    broken_pointer() {
      mkdir -p "$WORK/fix"
      printf 'gitdir: /nonexistent\n' > "$WORK/fix/.git"
    }

    It 'fails with the report on stdout when the worktree cannot come off'
      make_repo
      broken_pointer
      When call reap '{w: .worktree.action, d: .work_dir.action, e: (.errors | length)}'
      The status should be failure
      The output should equal '{"w":"failed","d":"skipped","e":1}'
    End

    # The directory is deliberately kept: removing it out from under a
    # registration git still holds turns a reportable leftover into a broken
    # one, so both paths are named for phase 7 instead.
    It 'keeps the work directory and names both paths'
      make_repo
      broken_pointer
      When call reap '[.left_behind[] | sub("^.*/worktrees/"; "")]'
      The status should be failure
      The output should equal '["fix-dependabot-example-pkg-6x/fix","fix-dependabot-example-pkg-6x"]'
    End

    # git refuses to delete a branch that is checked out anywhere, the primary
    # checkout included, and that refusal must reach the caller rather than
    # passing for a delete.
    It 'fails when the branch delete errors'
      make_repo
      add_agent_worktree
      push_fix_commit
      git -C "$REPO" worktree remove --force "$WORK/fix" >/dev/null 2>&1
      git -C "$REPO" checkout -q "$BRANCH" >/dev/null 2>&1
      When call reap '{b: .branch_ref.action, r: .branch_ref.reason, l: .left_behind, e: (.errors | length)}'
      The status should be failure
      The output should equal "{\"b\":\"left\",\"r\":\"delete-failed\",\"l\":[\"$BRANCH\"],\"e\":1}"
    End

    # `rev-parse --verify --quiet` answers a missing ref with an empty stdout,
    # exit 1 and NO stderr. A broken ref answers with the same empty stdout and
    # exit 1, plus `warning: ignoring broken ref`. Folding the two together
    # reported a branch that is still there as `absent`, and exited 0.
    It 'tells a ref it could not read apart from a ref that is not there'
      make_repo
      printf 'not-a-sha\n' > "$REPO/.git/refs/heads/broken-ref"
      When call common_jq reap-agent-artifacts.sh \
        '{b: .branch_ref.action, r: .branch_ref.reason, l: .left_behind, e: (.errors | length)}' \
        --repo-root "$REPO" --branch broken-ref --work "$WORK"
      The status should be failure
      The output should equal '{"b":"left","r":"tip-read-failed","l":["broken-ref"],"e":1}'
    End

    # Something at $WORK that is not a directory is nothing this flow makes.
    # Reporting `absent` there is a false claim about the user's disk.
    It 'reports a work path that is not a directory rather than claiming it is gone'
      make_repo
      : > "$WORK"
      When call reap '{d: .work_dir.action, l: [.left_behind[] | sub("^.*/worktrees/"; "")], e: (.errors | length)}'
      The status should be failure
      The output should equal '{"d":"not-a-directory","l":["fix-dependabot-example-pkg-6x"],"e":1}'
    End
  End

  # A worktree directory that is gone while its registration survives blocks the
  # next `worktree add` on that path AND every `branch -D` of its branch ("used
  # by worktree"), and `git worktree remove` refuses it outright. Pruning is
  # forbidden here, so the one entry that names this path comes off by itself.
  Describe 'a registration whose worktree directory is gone'
    stale_registration() {
      add_agent_worktree
      push_fix_commit
      rm -rf "$WORK"
    }

    It 'removes the stale entry and goes on to delete the branch'
      make_repo
      stale_registration
      When call reap '{w: .worktree.action, b: .branch_ref.action, l: .left_behind, e: .errors}'
      The status should be success
      The output should equal '{"w":"stale-registration-removed","b":"deleted","l":[],"e":[]}'
    End

    # The whole reason prune is banned: the entry that comes off is found by
    # the gitdir file naming this one path, so a sibling's live registration is
    # never a candidate.
    It 'leaves a sibling registration and its worktree alone'
      make_repo
      sibling_work="$REPO/.claude/worktrees/fix-dependabot-example-other-2x"
      git -C "$REPO" worktree add -q "$sibling_work/fix" -b "$SIBLING_BRANCH" origin/main >/dev/null 2>&1
      stale_registration
      survey_registrations() {
        "$COMMON/reap-agent-artifacts.sh" \
          --repo-root "$REPO" --branch "$BRANCH" --work "$WORK" >/dev/null
        git -C "$REPO" worktree list --porcelain \
          | sed -n 's|^worktree .*/worktrees/||p'
      }
      When call survey_registrations
      The status should be success
      The output should equal 'fix-dependabot-example-other-2x/fix'
    End

    # And the state that made this worth fixing: with the entry gone, the path
    # is reusable by the next run of this group.
    It 'leaves the path free for a later worktree add'
      make_repo
      stale_registration
      readd() {
        "$COMMON/reap-agent-artifacts.sh" \
          --repo-root "$REPO" --branch "$BRANCH" --work "$WORK" >/dev/null
        git -C "$REPO" worktree add -q "$WORK/fix" -b "$BRANCH" origin/main >/dev/null 2>&1 \
          && printf 'readded\n'
      }
      When call readd
      The status should be success
      The output should equal 'readded'
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

    It 'refuses a work path reached through a .. segment'
      make_repo
      When run script "$COMMON/reap-agent-artifacts.sh" \
        --repo-root "$REPO" --branch "$BRANCH" \
        --work "$REPO/.claude/worktrees/x/../../.."
      The status should be failure
      The stderr should include 'must not contain a .. segment'
    End

    # A relocated worktree root is refused rather than followed: the cost is a
    # leftover the user removes by hand, where following the link would put
    # `rm -rf` somewhere this script never proved it owns.
    It 'refuses a work path that is a symlink out of the repository'
      make_repo
      mkdir -p "$TEST_DIR/outside"
      ln -s "$TEST_DIR/outside" "$REPO/.claude/worktrees/relocated"
      When run script "$COMMON/reap-agent-artifacts.sh" \
        --repo-root "$REPO" --branch "$BRANCH" \
        --work "$REPO/.claude/worktrees/relocated"
      The status should be failure
      The stderr should include 'is not under'
    End

    # The same resolution, read from the other side: two spellings of one
    # repository must not read as containment escape. Without it, a caller that
    # reaches the repo through a symlink (the everyday macOS `/var` case) has
    # its own worktree refused.
    It 'accepts a repo_root and a work path spelled through different links'
      make_repo
      add_agent_worktree
      push_fix_commit
      ln -s "$REPO" "$TEST_DIR/repo-link"
      When call common_jq reap-agent-artifacts.sh \
        '{w: .worktree.action, b: .branch_ref.action}' \
        --repo-root "$TEST_DIR/repo-link" --branch "$BRANCH" --work "$WORK"
      The status should be success
      The output should equal '{"w":"removed","b":"deleted"}'
    End

    # A leading dash is a valid ref name that `git branch -D` reads as an
    # option, so it is refused by name rather than by check-ref-format.
    It 'refuses a branch name that begins with a dash'
      make_repo
      When run script "$COMMON/reap-agent-artifacts.sh" \
        --repo-root "$REPO" --branch '-D' --work "$WORK"
      The status should be failure
      The stderr should include 'must not begin with a dash'
    End

    # jq is how every exit path here reports, `die` included, so a missing jq
    # has to be caught before anything is removed rather than after.
    It 'refuses to run at all without jq'
      make_repo
      mkdir -p "$TEST_DIR/bin"
      ln -s "$(command -v bash)" "$TEST_DIR/bin/bash"
      without_jq() {
        PATH="$TEST_DIR/bin" "$COMMON/reap-agent-artifacts.sh" \
          --repo-root "$REPO" --branch "$BRANCH" --work "$WORK"
      }
      When run without_jq
      The status should be failure
      The stderr should include 'jq is required'
    End
  End

  # A scoped package name carries a `/`, and the worktree path template
  # interpolates it (issue #161). Sanitized as the template now says, with
  # every `/` in <package> replaced by `-`, the group is one flat directory
  # this script can name. Interpolated verbatim, the `/` becomes a directory
  # separator, and the field run that surfaced this reaped `left_behind: []`
  # in two repositories while leaving an empty `fix-dependabot-@scope/` behind
  # in each. Both halves are asserted below, because only the pair shows the
  # sanitization is what does the work: the script's own behavior is identical
  # and correct in both.
  Describe 'a scoped package name in the worktree path (issue #161)'
    SCOPED_BRANCH='fix/dependabot-@example-scope/example-pkg-2x'

    # The reap's own verdict, then everything the caller left under
    # `.claude/worktrees/`: the consuming rule is the orchestrator's summary,
    # which is built from `left_behind` and reports a clean sweep when it is
    # empty, so the pair of lines is the hazard itself — a clean verdict
    # printed above a residue the verdict never named. A failed reap returns
    # its own status before the survey, so `The status should be success`
    # asserts the reap, not the `printf`.
    reap_and_survey() {
      common_jq reap-agent-artifacts.sh '{l: .left_behind, e: .errors}' \
        --repo-root "$REPO" --branch "$SCOPED_BRANCH" --work "$1" || return $?
      find "$REPO/.claude/worktrees" -mindepth 1 | sed "s|^$REPO/.claude/worktrees/||" | sort
      printf 'end\n'
    }

    scoped_group() {
      make_repo
      SCOPED_WORK="$REPO/.claude/worktrees/$1"
      git -C "$REPO" worktree add -q "$SCOPED_WORK/fix" -b "$SCOPED_BRANCH" origin/main >/dev/null 2>&1
      git -C "$SCOPED_WORK/fix" commit -q --allow-empty -m 'fix' >/dev/null 2>&1
      git -C "$SCOPED_WORK/fix" push -q -u origin "$SCOPED_BRANCH" >/dev/null 2>&1
    }

    It 'reports a clean reap and leaves nothing under .claude/worktrees when the path is sanitized'
      scoped_group 'fix-dependabot-@example-scope-example-pkg-2x'
      When call reap_and_survey "$SCOPED_WORK"
      The status should be success
      The output should equal '{"l":[],"e":[]}
end'
    End

    It 'still deletes the branch, whose own slash is never sanitized'
      scoped_group 'fix-dependabot-@example-scope-example-pkg-2x'
      When call common_jq reap-agent-artifacts.sh \
        '{b: .branch_ref.action, r: .branch_ref.reason, l: .left_behind, e: .errors}' \
        --repo-root "$REPO" --branch "$SCOPED_BRANCH" --work "$SCOPED_WORK"
      The status should be success
      The output should equal '{"b":"deleted","r":"tip-on-origin","l":[],"e":[]}'
    End

    # The defect itself, reproduced against the same script: handed the
    # unsanitized path, it removes the leaf it was given, reports a clean
    # sweep, and the interposed scope directory survives unnamed. This is not
    # dead code — it is what the caller does when it forgets the replacement,
    # and the reap cannot detect it.
    It 'reports the same clean sweep over an interposed directory when the path is not sanitized'
      scoped_group 'fix-dependabot-@example-scope/example-pkg-2x'
      When call reap_and_survey "$SCOPED_WORK"
      The status should be success
      The output should equal '{"l":[],"e":[]}
fix-dependabot-@example-scope
end'
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

  # Issue #171/#173: the phase 6 reap procedure is collapsed into one
  # `post-agent.sh` call, the way `fix-group.sh` already collapsed phases 1-5
  # (scripts/CLAUDE.md, "The fix driver owns phases 1 to 5"). The path
  # template, the `<package_path>` sanitization rule, and the two-step
  # pr-status.sh/reap-agent-artifacts.sh breakdown are the script's to own
  # now (`common/post-agent.sh`'s own header, and `spec/post_agent_spec.sh`);
  # SKILL.md keeps only the orchestrator-level policy that still has to be
  # decided here — when to call it, and that its failure is never fatal.
  Describe 'the step in phase 6'
    It 'prescribes one post-agent.sh call carrying the --result and --repo-root arguments'
      When call rule_in "$SKILL" 'post-agent.sh --result <path to the saved result>'
      The status should be success
      The output should equal '1'
    End

    It 'passes package, major-line, and branch from the group'"'"'s own dispatch payload'
      When call rule_in "$SKILL" '--package <group\.package> --major-line <group\.major_line> --branch <group\.branch_name>'
      The status should be success
      The output should equal '1'
    End

    # The invocation appears exactly once, in the prescribed command block. The
    # script is also named in prose (the frontmatter grant, the env_prefix
    # seam, and phase 7's report paragraph) — legitimate references to a
    # script that does the work, not a second call site nobody decided on.
    It 'invokes the script from exactly one command block'
      When call rule_in "$SKILL" 'scripts/common/post-agent\.sh --result'
      The status should be success
      The output should equal '1'
    End

    It 'keeps the allowed-tools list accurate'
      When call rule_in "$SKILL" 'allowed-tools:.*post-agent.sh'
      The status should be success
      The output should equal '1'
    End

    # The two-step breakdown (parse the result, call pr-status.sh, then
    # reap-agent-artifacts.sh) is gone with the collapse: it is exactly the
    # prose re-derivation scripts/CLAUDE.md calls a bug once a driver script
    # exists for it.
    It 'no longer names reap-agent-artifacts.sh as a call site of its own'
      no_reap_script_mentions() { grep -c 'reap-agent-artifacts.sh' "$1" || true; }
      When call no_reap_script_mentions "$SKILL"
      The status should be success
      The output should equal '0'
    End

    It 'no longer prescribes a bare pr-status.sh call inside the reap step'
      # The window is located by its own opening sentence. A marker that stops
      # matching would silently scan nothing and pass, so an empty window is
      # reported as itself rather than as a zero.
      raw_pr_status_in_reap_step() {
        reap_step_window=$(awk '/Reap each group.s local artifacts once its result is in hand/{f=1} f{print} f && /Carry the script.s report into phase 7/{exit}' "$1")
        [ -n "$reap_step_window" ] || { echo 'reap-step window not found'; return 0; }
        printf '%s\n' "$reap_step_window" | grep -c 'scripts/common/pr-status.sh' || true
      }
      When call raw_pr_status_in_reap_step "$SKILL"
      The status should be success
      The output should equal '0'
    End

    # The AGENT workspace template is untouched: the fix agent still builds
    # its own worktree path, and that responsibility never moved.
    It 'still defines <package_path> in the agent workspace definition (untouched by the collapse)'
      When call phrase_in "$AGENT" '.<package_path>. is .<package>. with every ./. replaced by .-.'
      The status should be success
      The output should equal '1'
    End

    It 'never interpolates the raw package name into a worktree path in either document'
      raw_path_sites() {
        grep -c 'worktrees/fix-dependabot-<package>' "$SKILL" "$AGENT" | awk -F: '{ s += $NF } END { print s }'
      }
      When call raw_path_sites
      The status should be success
      The output should equal '0'
    End

    # The verification is the gate, and it is the caller's: the script makes no
    # network call and asks gh nothing. Issue #175 moved the reap out of a
    # rolling pool's refill motion (the model no longer schedules anything)
    # and onto the workflow's returned entries, so the ordering rule is now
    # stated against the summary rather than against a slot.
    It 'verifies the pull request before reaping anything'
      When call phrase_in "$SKILL" 'after the pull request is verified and before that result is folded into phase 7'
      The status should be success
      The output should equal '1'
    End

    # One call per returned entry is the whole cadence, and it is the one
    # thing #175 deliberately left outside the workflow script: a batched or
    # per-repo reap would lose the per-group `left_behind` accounting phase 7
    # reads.
    It 'makes exactly one post-agent.sh call per returned entry'
      When call phrase_in "$SKILL" 'one .post-agent.sh. call per returned entry, never one per repo and never one for the batch'
      The status should be success
      The output should equal '1'
    End

    It 'reaps only on an OPEN pull request'
      When call phrase_in "$SKILL" 'only when that PR reads .OPEN'
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

    It 'carries on to the next entry even when the reap could not finish'
      When call phrase_in "$SKILL" 'A reap that could not finish must never stall the run'
      The status should be success
      The output should equal '1'
    End

    # env_prefix's asymmetry is now the script's own contract
    # (common/post-agent.sh, "Why env_prefix stops at the PR read"); SKILL.md
    # states only that it is threaded to the PR read and not the reap, never
    # re-deriving why.
    It 'says env_prefix reaches the PR read inside the call and never the reap'
      When call phrase_in "$SKILL" 'and never to the reap that follows it'
      The status should be success
      The output should equal '1'
    End

    # The gap a reviewer found: a reap rejected before it printed anything falls
    # into neither phase 7 bucket, since this group's PR *was* verified. The
    # script now reports this itself; SKILL.md only has to say the run keeps
    # going.
    It 'never lets a reap that printed nothing stall the run either'
      When call phrase_in "$SKILL" 'and neither does one that printed nothing at all'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the report in phase 7'
    It 'reports the reaped count and everything left in place, from the script'"'"'s own reports'
      When call phrase_in "$SKILL" 'say what phase 6.s reap removed and what it left, from .post-agent.sh..s own reports'
      The status should be success
      The output should equal '1'
    End

    It 'says a leftover is recoverable only if the summary names it'
      When call phrase_in "$SKILL" 'but only if this summary says it is there'
      The status should be success
      The output should equal '1'
    End

    # Every report already carries the derived path and branch; phase 7 is
    # told not to rebuild either from a template of its own.
    It 'says nothing here recomputes a path or branch from a template'
      When call phrase_in "$SKILL" 'nothing here recomputes a path or a branch name from a template'
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

    # The agent must not read the reap as a safety net under the one judgment
    # this section refuses to make: an unpushed tip is left at both ends. The
    # reap's test is narrower than the agent's three safe cases — it re-checks
    # only origin/<branch_name> — and the agent is told so rather than told
    # the two tests are the same (#152).
    It 'tells the agent the reap re-checks only the origin tip, a narrower test'
      When call phrase_in "$AGENT" 'a narrower test than your three safe cases'
      The status should be success
      The output should equal '1'
    End

    It 'does not promise a deliberately left branch is reaped later'
      When call rule_in "$AGENT" 'is not on origin is left there too and reported'
      The status should be success
      The output should equal '1'
    End
  End
End
