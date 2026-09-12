#!/bin/sh
# shellcheck shell=sh
# scripts/common/discover-repos.sh: the repos in scope are the checkouts on disk.
#
# Scope comes from the target: inside a checkout the answer is that checkout's
# root, and otherwise it is every immediate subdirectory that is itself a
# checkout root. Nothing is ever cloned, and nothing here touches the network —
# every fixture is a real `git init` in a scratch directory.
#
# The two answers that must never be confused are "this directory holds no
# repositories" (empty list, exit 0) and "this directory could not be read"
# (error, non-zero): the second answering as the first is how an unreadable
# workspace came back as a tidy empty one. A git failure is the same confusion
# wearing git's clothes, so every shape git refuses for a reason other than
# "not a git repository" has its own example here: dubious ownership, a `.git`
# with no traverse permission, a checkout missing `HEAD`, a pointer file whose
# gitdir is gone, a git directory handed in as the path, and git missing from
# `PATH` entirely. Two more shapes wear the same words without being a git
# failure at all: a target *below* a broken checkout, and a `.git` symlink that
# dangles.
#
# The rest of the confusion comes from outside git. The environment can answer
# for the target (`GIT_DIR`, and equally `GIT_CEILING_DIRECTORIES`), the
# filesystem can spell one directory two ways (APFS is case-insensitive by
# default, so `holder` and `Holder` are one directory), a child name can carry
# a newline into a list that is one path per line, and `jq` itself can be
# missing from `PATH` — which is exit 127 and a bash error, not the error
# contract. Each has its own example below.

Describe 'discover-repos.sh'
  After 'cleanup_fixture'

  # A scratch workspace. `git init -q` is what makes a checkout, so the shapes
  # that must be skipped are built as the real thing too: a bare repository, a
  # checkout parked under a dot-directory, and a checkout two levels down.
  #
  # `Zeta` beside `alpha` is the collation pin made observable — under C they
  # sort in that order and under a case-folding UTF-8 locale they do not. That
  # is only a difference the *runner's* locale can show, and CI's is C.UTF-8,
  # so the example that actually kills the mutant everywhere runs the script
  # under an explicit `en_US.UTF-8` ('pins the collation' below). `my app` is
  # a path with a space in it.
  #
  # The links are the three link answers: an alias for a checkout already
  # listed (collapses to one entry), a link out of the workspace entirely
  # (listed where it resolves to), and a link into a checkout's subdirectory,
  # which is not a checkout root. The last one points at `elsewhere/sub`
  # rather than at a subdirectory of a checkout this workspace already lists,
  # so dropping the root-only guard is observable: without it the answer gains
  # `elsewhere`, a repository nothing here holds.
  make_workspace() {
    TEST_DIR=$(mktemp -d)
    WORK="$TEST_DIR/workspace"
    mkdir -p "$WORK/app/src" "$WORK/lib" "$WORK/scratch" "$WORK/.hidden" \
      "$WORK/nested/deep" "$WORK/bare" "$WORK/Zeta" "$WORK/alpha" \
      "$WORK/my app" "$TEST_DIR/outside" "$TEST_DIR/elsewhere/sub"
    for repo in app lib .hidden nested/deep Zeta alpha 'my app'; do
      git -C "$WORK/$repo" init -q
    done
    git -C "$TEST_DIR/outside" init -q
    git -C "$TEST_DIR/elsewhere" init -q
    git -C "$WORK/bare" init -q --bare
    ln -s app "$WORK/app-link"
    ln -s ../elsewhere/sub "$WORK/into-elsewhere"
    ln -s ../outside "$WORK/outside-link"
    : > "$WORK/notes.txt"
  }

  # git reports resolved paths, so every expectation is built from the
  # resolved form: on macOS both /tmp and /var are symlinks, and an unresolved
  # expectation disagrees with git about the very same directory.
  resolved() { (cd -P "$1" && pwd -P); }

  # The whole answer for the scratch workspace, in the order the contract
  # promises: sorted by the *resolved* path, which is why the out-of-workspace
  # link leads and the link alias for `app` contributes nothing of its own.
  all_repos() {
    printf '["%s","%s","%s","%s","%s","%s"]' \
      "$(resolved "$TEST_DIR/outside")" \
      "$(resolved "$WORK/Zeta")" \
      "$(resolved "$WORK/alpha")" \
      "$(resolved "$WORK/app")" \
      "$(resolved "$WORK/lib")" \
      "$(resolved "$WORK/my app")"
  }

  Describe 'a target inside a checkout'
    Before 'make_workspace'

    # The root and a directory below it are the same repository, and the
    # answer is the root either way — the caller never has to walk up.
    It 'answers the checkout root from the root itself'
      expected="[\"$(resolved "$WORK/app")\"]"
      When call common_jq discover-repos.sh '.repos' "$WORK/app"
      The status should be success
      The output should equal "$expected"
    End

    It 'answers the same root from a subdirectory inside it'
      mkdir -p "$WORK/app/src/deep"
      expected="[\"$(resolved "$WORK/app")\"]"
      When call common_jq discover-repos.sh '.repos' "$WORK/app/src/deep"
      The status should be success
      The output should equal "$expected"
    End

    # A space in a path survives the shell, git, and the JSON on both sides.
    It 'round-trips a path with a space in it'
      expected="[\"$(resolved "$WORK/my app")\"]"
      When call common_jq discover-repos.sh '.repos' "$WORK/my app"
      The status should be success
      The output should equal "$expected"
    End
  End

  Describe 'a target that is not a repository'
    Before 'make_workspace'

    # The whole rule in one example: every checkout root reachable as an
    # immediate child is in scope, once each, sorted by the path emitted. The
    # shapes that are out of scope get their own block below, so a leak names
    # itself on failure instead of showing up as a diff in this list.
    It 'lists every immediate checkout root, sorted, deduped, and nothing else'
      expected=$(all_repos)
      When call common_jq discover-repos.sh '.repos' "$WORK"
      The status should be success
      The output should equal "$expected"
    End

    It 'names the resolved target beside the repos'
      expected="\"$(resolved "$WORK")\""
      When call common_jq discover-repos.sh '.target' "$WORK"
      The status should be success
      The output should equal "$expected"
    End

    # Each shape that must never reach the list, named, so a leak says which
    # shape leaked. A bare repository has no toplevel (detect-scope.sh answers
    # a null scope for the same reason), a dot-directory is never matched by
    # the glob, `nested/deep` is a checkout but not an immediate one,
    # `scratch/` is a plain directory, `notes.txt` is not a directory at all,
    # `elsewhere` is the checkout `into-elsewhere` would drag in if a link
    # into a subdirectory counted as a root, and `app-link` is a second name
    # for a checkout listed once under the path it resolves to.
    #
    # Paths are relative to the resolved scratch directory, because only the
    # resolved spelling can ever appear in the answer.
    Describe 'shapes that are never listed'
      Parameters
        bare                workspace/bare
        dot-dir             workspace/.hidden
        nested              workspace/nested/deep
        plain               workspace/scratch
        file                workspace/notes.txt
        symlink-into-subdir elsewhere
        symlink-alias       workspace/app-link
      End

      It "never lists the $1"
        path="$(resolved "$TEST_DIR")/$2"
        When call common_jq discover-repos.sh "[.repos[] | select(. == \"$path\")]" "$WORK"
        The status should be success
        The output should equal '[]'
      End
    End

    # A symlinked target is the routine case on macOS, where /tmp itself is
    # one. Both halves of the answer come back resolved, because that is what
    # a caller comparing against git's own output needs.
    It 'resolves a symlinked target'
      ln -s "$WORK" "$TEST_DIR/link"
      expected="{\"target\":\"$(resolved "$WORK")\",\"repos\":$(all_repos)}"
      When call common_jq discover-repos.sh '.' "$TEST_DIR/link"
      The status should be success
      The output should equal "$expected"
    End

    # A relative path resolves against $PWD, as detect-scope.sh's does.
    It 'accepts a relative path argument'
      expected="[\"$(resolved "$WORK/app")\"]"
      cd "$WORK" || return 1
      When call common_jq discover-repos.sh '.repos' app
      The status should be success
      The output should equal "$expected"
    End

    It 'defaults to the current directory when given no argument'
      expected="{\"target\":\"$(resolved "$WORK")\",\"repos\":$(all_repos)}"
      cd "$WORK" || return 1
      When call common_jq discover-repos.sh '.'
      The status should be success
      The output should equal "$expected"
    End

    # An ambient GIT_DIR makes every git call answer one repository no matter
    # which path it was handed, so the scope would come out of the environment
    # instead of the target: this workspace would answer itself as a single
    # checkout rather than listing its children.
    repos_with_git_dir() {
      GIT_DIR="$1" "$COMMON/discover-repos.sh" "$2" | jq -c '.repos'
    }

    It 'ignores an ambient GIT_DIR'
      expected=$(all_repos)
      When call repos_with_git_dir "$WORK/app/.git" "$WORK"
      The status should be success
      The output should equal "$expected"
    End

    # `GIT_DIR` is not the only variable that answers for the target. A ceiling
    # covering the enclosing checkout stops git's upward walk before it reaches
    # `.git`, so a directory inside a checkout reports itself as being in no
    # repository at all — the scope out of the environment once more.
    repos_with_ceiling() {
      GIT_CEILING_DIRECTORIES="$1" "$COMMON/discover-repos.sh" "$2" | jq -c '.repos'
    }

    It 'ignores an ambient GIT_CEILING_DIRECTORIES'
      expected="[\"$(resolved "$WORK/app")\"]"
      When call repos_with_ceiling "$(resolved "$WORK/app")" "$WORK/app/src"
      The status should be success
      The output should equal "$expected"
    End

    # The collation pin is only observable under a locale that folds case, and
    # the runner's own locale is not that on CI (ubuntu is C.UTF-8), so the
    # `Zeta`/`alpha` ordering above passes there with or without the pin. This
    # runs the script under an explicit case-folding locale, which is what
    # makes deleting `export LC_ALL=C` fail on every runner.
    utf8_locale_missing() {
      ! locale -a 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '-' \
        | grep -qx 'en_us.utf8'
    }
    repos_under_utf8_locale() {
      LC_ALL=en_US.UTF-8 "$COMMON/discover-repos.sh" "$1" | jq -c '.repos'
    }

    It 'pins the collation under a case-folding locale'
      Skip if 'en_US.UTF-8 unavailable' utf8_locale_missing
      expected=$(all_repos)
      When call repos_under_utf8_locale "$WORK"
      The status should be success
      The output should equal "$expected"
    End
  End

  # A linked worktree is a checkout root in its own right: it has its own
  # toplevel, which is the same fact detect-scope.sh reports for one.
  Describe 'a linked worktree'
    make_worktree() {
      TEST_DIR=$(mktemp -d)
      WORK="$TEST_DIR/workspace"
      mkdir -p "$WORK" "$TEST_DIR/primary"
      git -C "$TEST_DIR/primary" init -q
      git -C "$TEST_DIR/primary" -c user.email=spec@example.com -c user.name=spec \
        commit -q --allow-empty -m init
      git -C "$TEST_DIR/primary" worktree add -q -b wktr-spec "$WORK/wt" >/dev/null 2>&1
    }
    Before 'make_worktree'

    It 'lists one held as an immediate child'
      expected="[\"$(resolved "$WORK/wt")\"]"
      When call common_jq discover-repos.sh '.repos' "$WORK"
      The status should be success
      The output should equal "$expected"
    End

    It 'answers its own root when it is the target'
      expected="[\"$(resolved "$WORK/wt")\"]"
      When call common_jq discover-repos.sh '.repos' "$WORK/wt"
      The status should be success
      The output should equal "$expected"
    End

    # The pointer-file shape the header names: a `.git` file naming a gitdir
    # under a primary checkout that is gone. git answers "not a git
    # repository" for it, exactly as it does for a plain directory, and the
    # `.git` that is present is the whole difference.
    It 'refuses one whose primary checkout was removed'
      rm -rf "$TEST_DIR/primary/.git"
      When run script "$COMMON/discover-repos.sh" "$WORK"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'git failed'
    End
  End

  # "No repositories here" is an answer, not a failure: a workspace whose
  # checkouts have all been removed is a legitimate, empty scope.
  Describe 'a directory with no repositories'
    empty_dir() {
      TEST_DIR=$(mktemp -d)
      mkdir -p "$TEST_DIR/empty"
    }
    Before 'empty_dir'

    It 'answers an empty list and succeeds'
      expected="{\"target\":\"$(resolved "$TEST_DIR/empty")\",\"repos\":[]}"
      When call common_jq discover-repos.sh '.' "$TEST_DIR/empty"
      The status should be success
      The output should equal "$expected"
    End
  End

  # A target that is not a directory is the caller's mistake, and it is
  # reported as an error rather than as an empty scope.
  Describe 'a target that is not a directory'
    not_a_directory() {
      TEST_DIR=$(mktemp -d)
      : > "$TEST_DIR/regular-file"
    }
    Before 'not_a_directory'

    Parameters
      'missing path' no-such-path-here
      'regular file' regular-file
      'quoted name'  'we"ird-name'
    End

    It "refuses a $1"
      When run script "$COMMON/discover-repos.sh" "$TEST_DIR/$2"
      The status should equal 1
      The stdout should equal ''
      The stderr should include '"error":"not a directory'
    End
  End

  # The error contract is jq-built rather than printf-interpolated precisely
  # so a double quote in the path cannot emit invalid JSON at the moment the
  # caller needs to parse the failure. `jq -r` is the assertion: it exits
  # non-zero on anything that does not parse.
  Describe 'an error message carrying a double quote'
    quoted_dir() { TEST_DIR=$(mktemp -d); }
    Before 'quoted_dir'

    error_message() {
      "$COMMON/discover-repos.sh" "$1" 2>&1 >/dev/null | jq -r '.error'
    }

    It 'stays parseable JSON'
      expected="not a directory: $TEST_DIR/we\"ird"
      When call error_message "$TEST_DIR/we\"ird"
      The status should be success
      The output should equal "$expected"
    End
  End

  # The failure this script exists to keep distinct: an unreadable directory
  # must never be reported as one holding no repositories.
  Describe 'a directory that cannot be read'
    unreadable_dir() {
      TEST_DIR=$(mktemp -d)
      mkdir -p "$TEST_DIR/locked"
      chmod 000 "$TEST_DIR/locked"
    }
    restore_and_cleanup() {
      [ -n "${TEST_DIR:-}" ] && [ -d "$TEST_DIR/locked" ] && chmod 755 "$TEST_DIR/locked"
      cleanup_fixture
    }
    Before 'unreadable_dir'
    After 'restore_and_cleanup'

    # root ignores the permission bits, so there is nothing to observe there.
    It 'reports the error instead of an empty list'
      Skip if 'running as root' [ "$(id -u)" -eq 0 ]
      When run script "$COMMON/discover-repos.sh" "$TEST_DIR/locked"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'could not read'
    End
  End

  # Same rule one level down: a child that cannot be entered is an error, not
  # a quietly shorter list. Dropping it silently is how a checkout in scope
  # goes missing from an otherwise plausible answer.
  Describe 'a child directory that cannot be read'
    locked_child() {
      TEST_DIR=$(mktemp -d)
      WORK="$TEST_DIR/workspace"
      mkdir -p "$WORK/app" "$WORK/locked"
      git -C "$WORK/app" init -q
      chmod 000 "$WORK/locked"
    }
    restore_child_and_cleanup() {
      [ -n "${WORK:-}" ] && [ -d "$WORK/locked" ] && chmod 755 "$WORK/locked"
      cleanup_fixture
    }
    Before 'locked_child'
    After 'restore_child_and_cleanup'

    # The message is the shell's own, not a diagnosis the script guessed at:
    # it used to assert "permission denied" for every `cd` that failed for any
    # reason at all.
    It 'reports the error instead of skipping the child'
      Skip if 'running as root' [ "$(id -u)" -eq 0 ]
      When run script "$COMMON/discover-repos.sh" "$WORK"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'could not enter'
      The stderr should include 'Permission denied'
    End
  End

  # git says "not a git repository" for a plain directory and for a checkout
  # whose `.git` it could not read, so the message alone cannot separate them.
  # Both of these shapes used to leave the child out of the list and exit 0.
  Describe 'a child whose git state is broken'
    broken_workspace() {
      TEST_DIR=$(mktemp -d)
      WORK="$TEST_DIR/workspace"
      mkdir -p "$WORK/ok" "$WORK/broken"
      git -C "$WORK/ok" init -q
      git -C "$WORK/broken" init -q
    }
    restore_broken_and_cleanup() {
      [ -n "${WORK:-}" ] && [ -d "$WORK/broken/.git" ] && chmod 755 "$WORK/broken/.git"
      cleanup_fixture
    }
    Before 'broken_workspace'
    After 'restore_broken_and_cleanup'

    It 'refuses a checkout missing HEAD'
      rm -f "$WORK/broken/.git/HEAD"
      When run script "$COMMON/discover-repos.sh" "$WORK"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'git failed'
    End

    It 'refuses a checkout whose .git cannot be traversed'
      Skip if 'running as root' [ "$(id -u)" -eq 0 ]
      chmod 000 "$WORK/broken/.git"
      When run script "$COMMON/discover-repos.sh" "$WORK"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'git failed'
    End

    # `-e` follows a symlink, so it answers false for a dangling one — which
    # is the check that decides whether a checkout is here at all. A link to a
    # gitdir that is gone is a broken checkout, and it was skipped in silence.
    It 'refuses a child whose .git is a dangling symlink'
      mkdir -p "$WORK/dangling"
      ln -s /no-such-git-dir "$WORK/dangling/.git"
      When run script "$COMMON/discover-repos.sh" "$WORK"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'git failed'
    End

    # A git directory and a bare repository are the same message to git, and
    # only one of them is a skippable shape: this one is the caller pointing
    # at the wrong path, and answering the `.git` directory's children would
    # be nonsense.
    It 'refuses a git directory handed in as the target'
      When run script "$COMMON/discover-repos.sh" "$WORK/ok/.git"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'git failed'
    End
  End

  # git's own absence and git's own refusals are errors too, each named for
  # what it is: a missing git is reported by the preflight rather than as a
  # generic failure, and a `safe.directory` refusal is exit 128 with a message
  # that is not "not a git repository".
  Describe 'git itself failing'
    git_fixture() {
      TEST_DIR=$(mktemp -d)
      WORK="$TEST_DIR/workspace"
      mkdir -p "$WORK/app"
      git -C "$WORK/app" init -q
      # A PATH holding only what the script needs before it looks for git:
      # /usr/bin/env resolves the shebang's interpreter through PATH, and the
      # error contract itself is built with jq.
      NO_GIT_BIN="$TEST_DIR/no-git-bin"
      mkdir -p "$NO_GIT_BIN"
      ln -s "$(command -v bash)" "$NO_GIT_BIN/bash"
      ln -s "$(command -v jq)" "$NO_GIT_BIN/jq"
      # The mirror image: git is there and jq is not, which is the one error
      # the contract cannot build with jq.
      NO_JQ_BIN="$TEST_DIR/no-jq-bin"
      mkdir -p "$NO_JQ_BIN"
      ln -s "$(command -v bash)" "$NO_JQ_BIN/bash"
      ln -s "$(command -v git)" "$NO_JQ_BIN/git"
      # A plain directory holding a plain child, for the stubs that answer for
      # every path: with no `.git` anywhere, "not a git repository" is the
      # truth and the classification is the only thing under test.
      mkdir -p "$TEST_DIR/plain/kid"
      STUB_BIN="$TEST_DIR/stub-bin"
      mkdir -p "$STUB_BIN"
      # A quoted heredoc, so the stub's own `$2` reaches the file rather than
      # being expanded here: the message is git's real one, path and all.
      cat > "$STUB_BIN/git" <<'STUB'
#!/bin/sh
printf 'fatal: detected dubious ownership in repository at %s\n' "$2" >&2
exit 128
STUB
      chmod 755 "$STUB_BIN/git"
      # git capitalized this message until 2.18, and the classification used
      # to match the lowercase spelling only: an ordinary plain directory came
      # back as a hard failure on any git old enough to say it that way.
      CAPS_BIN="$TEST_DIR/caps-bin"
      mkdir -p "$CAPS_BIN"
      cat > "$CAPS_BIN/git" <<'CAPS'
#!/bin/sh
printf 'fatal: Not a git repository (or any of the parent directories): .git\n' >&2
exit 128
CAPS
      chmod 755 "$CAPS_BIN/git"
      # git can also fail with nothing on stderr at all, which left the error
      # message trailing a bare colon and naming no cause whatsoever.
      SILENT_BIN="$TEST_DIR/silent-bin"
      mkdir -p "$SILENT_BIN"
      printf '#!/bin/sh\nexit 128\n' > "$SILENT_BIN/git"
      chmod 755 "$SILENT_BIN/git"
    }
    Before 'git_fixture'

    without_git() { PATH="$NO_GIT_BIN" "$COMMON/discover-repos.sh" "$1"; }
    without_jq() { PATH="$NO_JQ_BIN" "$COMMON/discover-repos.sh" "$1"; }
    with_stub_git() { PATH="$STUB_BIN:$PATH" "$COMMON/discover-repos.sh" "$1"; }
    with_caps_git() {
      PATH="$CAPS_BIN:$PATH" "$COMMON/discover-repos.sh" "$1" | jq -c '.repos'
    }
    with_silent_git() { PATH="$SILENT_BIN:$PATH" "$COMMON/discover-repos.sh" "$1"; }

    It 'refuses to run without git on PATH'
      When call without_git "$WORK"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'git is required'
    End

    It 'refuses a dubious-ownership failure instead of reporting no repos'
      When call with_stub_git "$WORK"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'git failed'
    End

    # Without jq there is nothing left to build the contract with, so the one
    # fixed literal in the script has to carry it: exit 127 and a bash error
    # is not a shape any caller parses.
    It 'refuses to run without jq on PATH'
      When call without_jq "$TEST_DIR/plain"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'jq is required'
    End

    It 'reads the capitalized not-a-git-repository as the ordinary answer'
      When call with_caps_git "$TEST_DIR/plain"
      The status should be success
      The output should equal '[]'
    End

    # The status is in the message because it is all there is when git says
    # nothing: `git failed in X: ` named no cause at all.
    It 'names git exit status when git fails silently'
      When call with_silent_git "$TEST_DIR/plain"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'git failed'
      The stderr should include '(exit 128)'
    End
  End

  # `safe.bareRepository=explicit` refuses a bare repository outright, with a
  # message git never says on the work-tree route the other bare example takes.
  # It is the same skippable shape, and it used to fail the whole workspace.
  Describe 'a bare child under safe.bareRepository=explicit'
    bare_holder() {
      TEST_DIR=$(mktemp -d)
      WORK="$TEST_DIR/workspace"
      mkdir -p "$WORK/app" "$WORK/bare"
      git -C "$WORK/app" init -q
      git -C "$WORK/bare" init -q --bare
    }
    Before 'bare_holder'

    # GIT_CONFIG_COUNT landed in git 2.31; older git ignores it entirely, and
    # the example would then assert nothing.
    config_env_unsupported() {
      ! GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository \
        GIT_CONFIG_VALUE_0=explicit git config --get safe.bareRepository \
        >/dev/null 2>&1
    }
    repos_bare_explicit() {
      GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository \
        GIT_CONFIG_VALUE_0=explicit "$COMMON/discover-repos.sh" "$1" | jq -c '.repos'
    }

    It 'skips it and still lists the checkout beside it'
      Skip if 'git predates GIT_CONFIG_COUNT' config_env_unsupported
      expected="[\"$(resolved "$WORK/app")\"]"
      When call repos_bare_explicit "$WORK"
      The status should be success
      The output should equal "$expected"
    End
  End

  # A case-insensitive filesystem — APFS by default — gives one directory two
  # spellings. The root-only compare was a string compare against git's own
  # toplevel, so a target typed `holder` for an on-disk `Holder` answered with
  # no repositories at all, and the `target` field echoed the typed spelling.
  Describe 'a target spelled in another case than the directory on disk'
    mixed_case_workspace() {
      TEST_DIR=$(mktemp -d)
      mkdir -p "$TEST_DIR/Holder/RepoOne"
      git -C "$TEST_DIR/Holder/RepoOne" init -q
      : > "$TEST_DIR/CaseProbe"
    }
    Before 'mixed_case_workspace'

    It 'answers the on-disk spelling for a lowercased target'
      Skip if 'case-sensitive filesystem' [ ! -e "$TEST_DIR/caseprobe" ]
      root="$(resolved "$TEST_DIR")/Holder"
      expected="{\"target\":\"$root\",\"repos\":[\"$root/RepoOne\"]}"
      When call common_jq discover-repos.sh '.' "$TEST_DIR/holder"
      The status should be success
      The output should equal "$expected"
    End
  End

  # git says "not a git repository" for a directory *below* a broken checkout
  # too, and the words are identical. Believing them without walking up
  # reported the holder of a checkout missing HEAD as an empty workspace.
  Describe 'a target below a broken checkout'
    below_broken() {
      TEST_DIR=$(mktemp -d)
      mkdir -p "$TEST_DIR/holder/nohead/src"
      git -C "$TEST_DIR/holder/nohead" init -q
      rm -f "$TEST_DIR/holder/nohead/.git/HEAD"
    }
    Before 'below_broken'

    It 'refuses instead of reporting no repositories'
      When run script "$COMMON/discover-repos.sh" "$TEST_DIR/holder/nohead/src"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'git failed'
    End
  End

  # The roots are collected one per line to be sorted, so a child whose name
  # carries a newline split into two entries, neither of which is a repository
  # and one of which was not even a path.
  Describe 'a child whose name contains a newline'
    # Both positions, because a trailing newline is the one command
    # substitution strips: checked on a resolved copy, `repo<LF>` passed the
    # test and then failed the identity compare, dropped without a word.
    Parameters
      embedded  "$(printf 'a\nb')"
      trailing  "$(printf 'repo\n-')"
    End

    newline_workspace() {
      TEST_DIR=$(mktemp -d)
      WORK="$TEST_DIR/workspace"
      name="$2"
      # The trailing case: strip the sentinel the Parameters row needed to
      # keep its own newline from being eaten, leaving `repo<LF>`.
      [ "$1" = trailing ] && name="${name%-}"
      mkdir -p "$WORK/$name"
      git -C "$WORK/$name" init -q
    }

    It "refuses a $1 newline rather than emitting garbage or skipping the checkout"
      newline_workspace "$1" "$2"
      When run script "$COMMON/discover-repos.sh" "$WORK"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'newline'
    End
  End

  # The upward `.git` walk stops at the target's own filesystem boundary, as
  # git's discovery does. Both directions matter and only a real mount shows
  # them: a healthy checkout on the far side of the mount (a versioned home
  # directory holding a mounted volume) must not be blamed, and a broken
  # checkout on the near side must still be caught rather than skipped. A
  # stub that recites git's boundary message cannot tell those apart, because
  # the walk looks at devices, not at the message. The mount is a disk image
  # attached with `hdiutil`, so these examples run on macOS and skip where no
  # unprivileged mount is available.
  Describe 'the walk stops at a filesystem boundary'
    cannot_mount() { ! command -v hdiutil >/dev/null 2>&1; }
    # `Skip if` is a directive, not a command: the body keeps running after
    # it fires, so nothing below may call `Skip` at run time. The fixture
    # therefore never fails; it leaves MNT empty and a second directive reads
    # that.
    mount_missing() { [ -z "${MNT:-}" ]; }

    mount_fixture() {
      MNT=""
      cannot_mount && return 0
      TEST_DIR=$(mktemp -d)
      HOME_DIR="$TEST_DIR/home"
      mkdir -p "$HOME_DIR/mnt"
      git -C "$HOME_DIR" init -q
      IMAGE="$TEST_DIR/vol.sparseimage"
      hdiutil create -quiet -size 16m -fs APFS -volname probe -type SPARSE "$IMAGE" >/dev/null 2>&1 || return 0
      hdiutil attach -quiet -nobrowse -mountpoint "$HOME_DIR/mnt" "$IMAGE" >/dev/null 2>&1 || return 0
      MNT="$HOME_DIR/mnt"
      # Far side of the mount: home/.git is healthy and must never be blamed.
      mkdir -p "$MNT/holder/app" "$MNT/plain"
      git -C "$MNT/holder/app" init -q
      # Near side: a checkout whose .git has no HEAD, and a directory below it.
      mkdir -p "$MNT/bad/broken/src" "$MNT/bad/ok"
      git -C "$MNT/bad/broken" init -q
      rm -f "$MNT/bad/broken/.git/HEAD"
      git -C "$MNT/bad/ok" init -q
    }
    detach_fixture() {
      if [ -n "${MNT:-}" ]; then
        hdiutil detach -quiet -force "$MNT" >/dev/null 2>&1 || true
      fi
      cleanup_fixture
    }
    After 'detach_fixture'

    names() { "$COMMON/discover-repos.sh" "$1" | jq -c '[.repos[] | split("/") | last]'; }

    It 'does not blame a healthy checkout on the far side of the mount'
      Skip if 'no unprivileged mount available' cannot_mount
      mount_fixture
      Skip if 'disk image could not be attached' mount_missing
      When call names "$MNT/holder"
      The status should be success
      The output should equal '["app"]'
    End

    It 'answers no repositories for a plain directory on the mounted volume'
      Skip if 'no unprivileged mount available' cannot_mount
      mount_fixture
      Skip if 'disk image could not be attached' mount_missing
      When call names "$MNT/plain"
      The status should be success
      The output should equal '[]'
    End

    It 'still catches a broken checkout on the near side of the mount'
      Skip if 'no unprivileged mount available' cannot_mount
      mount_fixture
      Skip if 'disk image could not be attached' mount_missing
      When run script "$COMMON/discover-repos.sh" "$MNT/bad"
      The status should equal 1
      The stdout should equal ''
      The stderr should include 'git failed in'
      The stderr should include '/bad/broken'
    End

    It 'still catches a target below a broken checkout on the mounted volume'
      Skip if 'no unprivileged mount available' cannot_mount
      mount_fixture
      Skip if 'disk image could not be attached' mount_missing
      When run script "$COMMON/discover-repos.sh" "$MNT/bad/broken/src"
      The status should equal 1
      The stdout should equal ''
      The stderr should include '/bad/broken'
    End
  End
End
