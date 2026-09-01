#!/bin/sh
# shellcheck shell=sh
# fix-group.sh `setup` and `cleanup` — phase 1's worktree and branch guards,
# and the branch disposal on the way out (#84, #146, #152, #161, #171).
#
# These used to be prose in agents/fix-dependency.md, where "nothing in a
# script decides any of this" was literally true and the definition's sentences
# were the whole implementation. They are a script now, so every example here
# asserts the verdict — exit code plus the checkpoint JSON — against a real git
# repository built in a scratch directory. Nothing reaches the network: the
# "remote" is a second local repository and `origin` is a path.

Describe 'fix-group.sh setup and cleanup'
  DRIVER="$COMMON/fix-group.sh"
  After 'cleanup_fixture'

  # A bare-ish origin plus a clone of it, which is the only shape the tip
  # comparisons are meaningful in: `origin/main` and `origin/<branch>` have to
  # be real remote-tracking refs.
  make_repo() {
    TEST_DIR=$(mktemp -d)
    ORIGIN="$TEST_DIR/origin"
    REPO="$TEST_DIR/repo"
    BIN="$TEST_DIR/bin"
    mkdir -p "$ORIGIN" "$BIN"
    git -C "$ORIGIN" init -q -b main
    printf '{"name":"app","dependencies":{"lodash":"^4.17.20"}}\n' > "$ORIGIN/package.json"
    printf '{"lockfileVersion":3}\n' > "$ORIGIN/package-lock.json"
    git -C "$ORIGIN" add -A
    git -C "$ORIGIN" -c user.email=spec@example.invalid -c user.name=spec commit -qm init
    git clone -q "$ORIGIN" "$REPO"
    git -C "$REPO" config user.email spec@example.invalid
    git -C "$REPO" config user.name spec
    WORK="$REPO/.claude/worktrees/fix-dependabot-lodash-4x"
    BRANCH='fix/dependabot-lodash-4x'
    write_group lodash 4 "$BRANCH"
  }

  write_group() {
    cat > "$TEST_DIR/group.json" <<JSON
{"package": "$1", "ecosystem": "npm", "major_line": "$2",
 "highest_fixed_version": "4.17.21", "branch_name": "$3",
 "alerts": [{"number": 1, "vulnerable_range": "< 4.17.21"}],
 "sibling_alerts": []}
JSON
  }

  # The stale-branch guard's three recognized tips are all built from the same
  # two primitives: a commit on the fix branch, and where the branch points.
  commit_on_branch() {
    git -C "$REPO" switch -q -c "$BRANCH"
    printf '%s\n' "$2" > "$REPO/$1"
    git -C "$REPO" add -- "$1"
    git -C "$REPO" commit -qm "$3"
    git -C "$REPO" switch -q main
  }

  # Run the driver and reduce stdout to a compact jq projection, preserving the
  # driver's exit status (which is the verdict half of every assertion here).
  # Same shape as spec_helper.sh's `common_jq`; it is spelled out because the
  # driver takes a subcommand rather than a script name.
  drv_jq() {
    _filter=$1
    shift
    _st=0
    _out=$("$DRIVER" "$@") || _st=$?
    if [ -n "$_out" ]; then
      printf '%s' "$_out" | jq -c "$_filter"
    fi
    return "$_st"
  }

  setup_args() {
    printf '%s' "setup --group-json $TEST_DIR/group.json --repo-root $REPO --default-branch main --adapter $ADAPTER"
  }

  # An option-parsing bug that never shifts turns `while [ $# -gt 0 ]` into an
  # infinite loop, which as a plain example would hang the whole suite instead
  # of failing it. macOS ships no `timeout`, so the deadline is a watchdog.
  # The watchdog polls and exits on its own once the target is gone, rather
  # than being killed: killing it makes the shell announce the terminated job
  # on stderr, which every stderr assertion here would then have to tolerate.
  with_deadline() {
    _secs=$1
    shift
    "$@" &
    _pid=$!
    ( _n=0
      while [ "$_n" -lt "$_secs" ]; do
        kill -0 "$_pid" 2>/dev/null || exit 0
        sleep 1
        _n=$((_n + 1))
      done
      kill -9 "$_pid" 2>/dev/null ) &
    _watch=$!
    _st=0
    wait "$_pid" || _st=$?
    wait "$_watch" 2>/dev/null
    return "$_st"
  }

  run_setup() {
    drv_jq "$1" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
      --default-branch main --adapter "$ADAPTER"
  }

  Describe 'option parsing'
    # `--env-prefix "<value>"` cannot use the `${2:?...}` form the other options
    # use, because `--env-prefix ""` is legal and means "no prefix". `${2-}`
    # instead left `shift 2` to fail on a trailing `--env-prefix` — and a failed
    # shift shifts nothing, so the loop never terminated.
    It 'errors on --env-prefix with no value rather than looping forever'
      make_repo
      When call with_deadline 20 "$DRIVER" setup --group-json "$TEST_DIR/group.json" \
        --repo-root "$REPO" --default-branch main --adapter "$ADAPTER" --env-prefix
      The status should equal 1
      The output should include '"error"'
      The stderr should include 'requires a value'
    End

    It 'keeps an explicitly empty --env-prefix legal, meaning no prefix'
      make_repo
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$ADAPTER" --env-prefix '' >/dev/null
      When call jq -r '.env_prefix' "$WORK/state.json"
      The status should be success
      The output should equal ''
    End

    # Key presence is not a value. `{"package": null}` passed the old check and
    # the string `null` then flowed into the workspace path and the branch name.
    Parameters
      package               null
      package               '""'
      branch_name           null
      highest_fixed_version null
      alerts                '[]'
      major_line            null
    End

    It "refuses a group payload whose $1 is $2"
      make_repo
      jq -c ".$1 = $2" "$TEST_DIR/group.json" > "$TEST_DIR/g2.json"
      mv "$TEST_DIR/g2.json" "$TEST_DIR/group.json"
      When call drv_jq '{has_error: has("error")}' setup --group-json "$TEST_DIR/group.json" \
        --repo-root "$REPO" --default-branch main --adapter "$ADAPTER"
      The status should equal 1
      The output should equal '{"has_error":true}'
      The stderr should include "$1"
      The path "$REPO/.claude/worktrees" should not be exist
    End
  End

  Describe 'the crashed-run guard'
    # A surviving $WORK means a failed or crashed run, or a session that is not
    # this flow at all. Neither is ours to clear from a distance, so the run
    # stops rather than reusing or deleting it.
    It 'stops on an existing workspace instead of reusing or deleting it'
      make_repo
      mkdir -p "$WORK/fix"
      When call run_setup '{status, phase}'
      The status should equal 3
      The output should equal '{"status":"failure","phase":"worktree"}'
      The stderr should include 'a previous run'
      The path "$WORK/fix" should be exist
    End
  End

  Describe 'the stale-branch guard verifies rather than stops on sight'
    # Case 1: a previous run created the branch and committed nothing to it.
    It 'deletes and recreates a tip equal to origin/<default_branch>'
      make_repo
      git -C "$REPO" branch "$BRANCH"
      When call run_setup '{status, step, branch}'
      The status should be success
      The output should equal '{"status":"ok","step":"setup","branch":"fix/dependabot-lodash-4x"}'
    End

    # Case 2: a previous run pushed it and the remote still carries the same
    # commits, so the local ref is a duplicate of something that survives its
    # deletion.
    It 'deletes and recreates a tip equal to origin/<branch_name>'
      make_repo
      commit_on_branch package-lock.json '{"lockfileVersion":3,"n":1}' 'feat: someone work'
      git -C "$REPO" push -q origin "$BRANCH"
      git -C "$REPO" fetch -q origin "$BRANCH"
      When call run_setup '{status, step}'
      The status should be success
      The output should equal '{"status":"ok","step":"setup"}'
    End

    # Case 3: a single drift commit, recognized by BOTH the log-subject check
    # and the diff pathspec check, never either alone (#152).
    It 'deletes and recreates a drift-commit-only tip'
      make_repo
      commit_on_branch package-lock.json '{"lockfileVersion":3,"n":1}' \
        'chore(deps): refresh lockfile (control install, no manifest change)'
      When call run_setup '{status, step}'
      The status should be success
      The output should equal '{"status":"ok","step":"setup"}'
    End

    # The subject check alone is not enough: a commit wearing the drift
    # subject while touching package.json is a manifest edit, which is exactly
    # what the drift commit never carries.
    It 'refuses a drift-subject commit whose paths include package.json'
      make_repo
      commit_on_branch package.json '{"name":"app","edited":true}' \
        'chore(deps): refresh lockfile (control install, no manifest change)'
      When call run_setup '{status, phase}'
      The status should equal 3
      The output should equal '{"status":"failure","phase":"worktree"}'
      The stderr should include 'may hold unpushed work'
    End

    # And the paths check alone is not enough either: lockfile-only changes
    # under someone else's subject are someone else's commit.
    It 'refuses a lockfile-only commit carrying a different subject'
      make_repo
      commit_on_branch package-lock.json '{"lockfileVersion":3,"n":2}' \
        'chore: bump the lockfile by hand'
      When call run_setup '{status, phase}'
      The status should equal 3
      The output should equal '{"status":"failure","phase":"worktree"}'
      The stderr should include 'may hold unpushed work'
    End

    # Never delete that one, and never reuse it: a commit that never reached
    # the remote is the one thing here that cannot be recreated.
    It 'leaves the refused branch in place'
      make_repo
      commit_on_branch src.js 'console.log(1)' 'feat: unpushed work'
      When call run_setup '{status}'
      The status should equal 3
      The output should equal '{"status":"failure"}'
      The stderr should include 'was not deleted'
    End
  End

  Describe 'worktree creation'
    It 'creates the worktree and a state file carrying every later step needs'
      make_repo
      When call run_setup '{status, step, work, worktree, package, major_line}'
      The status should be success
      The output should equal "{\"status\":\"ok\",\"step\":\"setup\",\"work\":\"$WORK\",\"worktree\":\"$WORK/fix\",\"package\":\"lodash\",\"major_line\":\"4\"}"
      The path "$WORK/fix/package.json" should be exist
      The path "$WORK/state.json" should be exist
    End

    It 'records the adapter, branch and env_prefix the later steps read back'
      make_repo
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$ADAPTER" --env-prefix 'env FOO=1' >/dev/null
      When call jq -c '{adapter, branch_name, env_prefix, default_branch, drift_commit}' "$WORK/state.json"
      The status should be success
      The output should equal "{\"adapter\":\"$ADAPTER\",\"branch_name\":\"fix/dependabot-lodash-4x\",\"env_prefix\":\"env FOO=1\",\"default_branch\":\"main\",\"drift_commit\":false}"
    End

    # The `/` replacement is not cosmetic (#161): interpolated raw, a scoped
    # name turns into a directory separator and leaves an interposed
    # `fix-dependabot-@scope/` directory behind forever, while the reap —
    # handed the leaf — reports a clean sweep.
    It 'slugs every / in a scoped package name into the workspace path'
      make_repo
      write_group '@babel/traverse' 7 'fix/dependabot-@babel/traverse-7x'
      When call run_setup '{work}'
      The status should be success
      The output should equal "{\"work\":\"$REPO/.claude/worktrees/fix-dependabot-@babel-traverse-7x\"}"
      The path "$REPO/.claude/worktrees/fix-dependabot-@babel" should not be exist
    End
  End

  Describe 'cleanup'
    prepare() {
      make_repo
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$ADAPTER" >/dev/null
    }

    # Safe case 2: nothing was committed, so there is nothing on the branch to
    # lose.
    It 'deletes a branch whose tip still equals origin/<default_branch>'
      prepare
      When call drv_jq '{status, worktree_removed, branch_deleted}' cleanup --work "$WORK"
      The status should be success
      The output should equal '{"status":"ok","worktree_removed":true,"branch_deleted":true}'
      The path "$WORK" should not be exist
    End

    # Safe case 1: the push succeeded with that tip, so the remote carries the
    # same commits and the local ref is a duplicate.
    It 'deletes a pushed branch whose tip matches the remote'
      prepare
      printf '%s\n' 'x' > "$WORK/fix/package-lock.json"
      git -C "$WORK/fix" commit -qam 'fix(deps): resolve 1 alert'
      git -C "$WORK/fix" push -q origin "$BRANCH"
      git -C "$REPO" fetch -q origin "$BRANCH"
      When call drv_jq '{status, branch_deleted}' cleanup --work "$WORK" --pushed
      The status should be success
      The output should equal '{"status":"ok","branch_deleted":true}'
    End

    # Safe case 3: a rerun's own control install regenerates an equivalent
    # commit from the same manifests, so nothing unrecoverable is on the
    # branch. Without it every no-op against a stale lockfile leaves a branch
    # the next run's guard must read as someone's unpushed work (#146).
    It 'deletes a branch whose only commit is the drift commit'
      prepare
      printf '%s\n' '{"lockfileVersion":3,"n":9}' > "$WORK/fix/package-lock.json"
      git -C "$WORK/fix" commit -qam 'chore(deps): refresh lockfile (control install, no manifest change)'
      When call drv_jq '{status, branch_deleted}' cleanup --work "$WORK"
      The status should be success
      The output should equal '{"status":"ok","branch_deleted":true}'
    End

    # Anything else is a commit that never reached the remote, and the way out
    # of a cleanup is not the place to adjudicate it.
    It 'leaves an unpushed commit in place and reports the branch and its tip'
      prepare
      printf '%s\n' 'x' > "$WORK/fix/package-lock.json"
      git -C "$WORK/fix" commit -qam 'fix(deps): resolve 1 alert'
      When call drv_jq '{status, worktree_removed, branch_deleted, has_tip: (.branch_tip != null)}' cleanup --work "$WORK"
      The status should be success
      The output should equal '{"status":"ok","worktree_removed":true,"branch_deleted":false,"has_tip":true}'
    End

    It 'names the surviving branch in detail'
      prepare
      printf '%s\n' 'x' > "$WORK/fix/package-lock.json"
      git -C "$WORK/fix" commit -qam 'fix(deps): resolve 1 alert'
      When call drv_jq '{d: (.detail | test("branch fix/dependabot-lodash-4x left in place"))}' cleanup --work "$WORK"
      The status should be success
      The output should equal '{"d":true}'
    End

    # The drift-commit exemption is recognized by BOTH checks, here as in the
    # setup guard (#152). A commit wearing the subject while touching
    # package.json is a manifest edit, which the drift commit never carries —
    # and deleting it would destroy unpushed work.
    It 'keeps a drift-subject commit that touched package.json'
      prepare
      printf '{"name":"app","edited":true}\n' > "$WORK/fix/package.json"
      git -C "$WORK/fix" commit -qam 'chore(deps): refresh lockfile (control install, no manifest change)'
      When call drv_jq '{branch_deleted, has_tip: (.branch_tip != null)}' cleanup --work "$WORK"
      The status should be success
      The output should equal '{"branch_deleted":false,"has_tip":true}'
    End

    # `--pushed` is the caller's statement that the push succeeded. Without it
    # a tip matching the remote proves nothing about this run, so the
    # remote-duplicate route stays closed.
    It 'does not take the remote-duplicate route without --pushed'
      prepare
      printf '%s\n' 'x' > "$WORK/fix/package-lock.json"
      git -C "$WORK/fix" commit -qam 'fix(deps): resolve 1 alert'
      git -C "$WORK/fix" push -q origin "$BRANCH"
      git -C "$REPO" fetch -q origin "$BRANCH"
      When call drv_jq '{branch_deleted}' cleanup --work "$WORK"
      The status should be success
      The output should equal '{"branch_deleted":false}'
    End

    # Never silenced, and never a failure result on its own: by this point the
    # work either shipped or already failed for its own reason. The refusal is
    # injected through the env_prefix seam, which sits in front of every git
    # call the driver makes.
    It 'reports a branch -D failure in detail rather than silencing it'
      make_repo
      cat > "$BIN/prefix" <<'SH'
#!/bin/sh
_saw_branch=no
for a in "$@"; do
  [ "$a" = "branch" ] && _saw_branch=yes
  if [ "$_saw_branch" = yes ] && [ "$a" = "-D" ]; then
    printf 'error: refusing to delete (spec)\n' >&2
    exit 1
  fi
done
exec "$@"
SH
      chmod +x "$BIN/prefix"
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$ADAPTER" --env-prefix "$BIN/prefix" >/dev/null
      When call drv_jq '{branch_deleted, d: ((.detail // "") | test("branch -D"))}' cleanup --work "$WORK"
      The status should be success
      The output should equal '{"branch_deleted":false,"d":true}'
    End
  End

  Describe 'cleanup refuses to act on state it could not read'
    prepare() {
      make_repo
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$ADAPTER" >/dev/null
    }

    # A zero-byte state.json is exactly what a crashed `setup` used to leave,
    # and jq's status was discarded: every value came back empty, `[ -e "" ]`
    # was false, `removed` kept its initialized `true`, and `rm -rf "$WORK"`
    # ran anyway — deleting the worktree directory while its registration
    # under <git-common-dir>/worktrees/ survived.
    Describe 'an unreadable state file'
      Parameters
        'zero-byte'   ''
        'truncated'   '{"repo_root": "'
        'not-object'  '[]'
      End

      It "refuses a $1 state file instead of reporting a clean sweep"
        prepare
        printf '%s' "$2" > "$WORK/state.json"
        When call drv_jq '{has_error: has("error")}' cleanup --work "$WORK"
        The status should equal 1
        The output should equal '{"has_error":true}'
        The stderr should be present
        The path "$WORK/fix" should be exist
      End
    End

    # `git -C ""` is not an error and not a no-op: it operates on the CURRENT
    # directory, so an empty repo_root would put `worktree remove --force` and
    # `branch -D` in the user's own checkout (#18). An empty value is refused
    # where it is read, before any git call is composed from it.
    Describe 'an empty path value'
      Parameters
        '.repo_root'
        '.worktree'
        '.branch_name'
        '.default_branch'
      End

      It "refuses an empty $1 rather than composing a git call from it"
        prepare
        jq "$1 = \"\"" "$WORK/state.json" > "$WORK/s.tmp"
        mv "$WORK/s.tmp" "$WORK/state.json"
        When call drv_jq '{has_error: has("error")}' cleanup --work "$WORK"
        The status should equal 1
        The output should equal '{"has_error":true}'
        The stderr should include 'no usable value'
        The path "$WORK/fix" should be exist
      End
    End

    It 'leaves the branch alone when the repo_root was empty'
      prepare
      jq '.repo_root = ""' "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      "$DRIVER" cleanup --work "$WORK" >/dev/null 2>&1 || true
      When call git -C "$REPO" branch --list "$BRANCH"
      The status should be success
      The output should include "$BRANCH"
    End
  End

  Describe 'a failed worktree removal never becomes a reported success'
    # `worktree remove` is made to fail through the env_prefix seam, which is
    # in front of every git call the driver makes. What must NOT happen then is
    # `rm -rf "$WORK"`: a worktree directory that is gone while its
    # registration survives blocks both a later `worktree add` on that path and
    # any `branch -D` of its branch, and `git worktree remove` refuses to clean
    # it up afterwards (scripts/CLAUDE.md).
    prepare_failing_remove() {
      make_repo
      cat > "$BIN/prefix" <<'SH'
#!/bin/sh
for a in "$@"; do
  if [ "$a" = "remove" ]; then
    printf 'fatal: refusing (spec)\n' >&2
    exit 1
  fi
done
exec "$@"
SH
      chmod +x "$BIN/prefix"
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$ADAPTER" --env-prefix "$BIN/prefix" >/dev/null
    }

    It 'reports removal-failed rather than worktree_removed true'
      prepare_failing_remove
      When call drv_jq '{worktree_removed, worktree_removal}' cleanup --work "$WORK"
      The status should be success
      The output should equal '{"worktree_removed":false,"worktree_removal":"removal-failed"}'
    End

    It 'leaves the workspace directory on disk while the registration is still live'
      prepare_failing_remove
      "$DRIVER" cleanup --work "$WORK" >/dev/null
      When call test -d "$WORK/fix"
      The status should be success
    End

    It 'does not delete the branch while its worktree registration survives'
      prepare_failing_remove
      "$DRIVER" cleanup --work "$WORK" >/dev/null
      When call git -C "$REPO" branch --list "$BRANCH"
      The status should be success
      The output should include "$BRANCH"
    End

    # Nothing was there to remove is its own answer, and it is not "removed".
    It 'reports nothing-to-remove when the worktree directory is already gone'
      make_repo
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$ADAPTER" >/dev/null
      git -C "$REPO" worktree remove --force "$WORK/fix"
      When call drv_jq '{worktree_removed, worktree_removal}' cleanup --work "$WORK"
      The status should be success
      The output should equal '{"worktree_removed":false,"worktree_removal":"nothing-to-remove"}'
    End
  End

  Describe 'env_prefix is threaded to every git invocation, and absence means bare'
    # A shim that records its own argv and then execs what it was handed. Its
    # log is the verdict: the prefix has to reach the command, and it has to
    # compose in front of `git`, never in front of a `cd`.
    make_prefix() {
      cat > "$BIN/prefix" <<'SH'
#!/bin/sh
printf '%s\n' "$1" >> "$PREFIX_LOG"
exec "$@"
SH
      chmod +x "$BIN/prefix"
      PREFIX_LOG="$TEST_DIR/prefix.log"
      export PREFIX_LOG
      : > "$PREFIX_LOG"
    }

    It 'prepends the prefix verbatim to the git calls setup makes'
      make_repo
      make_prefix
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$ADAPTER" --env-prefix "$BIN/prefix" >/dev/null
      When call sort -u "$PREFIX_LOG"
      The status should be success
      The output should equal 'git'
    End

    It 'runs bare when no prefix was given'
      make_repo
      make_prefix
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$ADAPTER" >/dev/null
      When call cat "$PREFIX_LOG"
      The status should be success
      The output should equal ''
    End
  End
End
