#!/bin/sh
# shellcheck shell=sh
# scripts/common/: detect-scope.sh, select-adapter.sh.

Describe 'detect-scope.sh'
  # Scope is a fact about git, never about what the directories are named
  # (issue #134). Every example therefore builds a real repository in a temp
  # directory whose name carries no convention at all, and sets `origin` to a
  # literal URL string. Nothing here reaches the network: `remote add` writes
  # config, `symbolic-ref` writes a local ref, and the `remote show` fallback
  # for default_branch is never reached while that symref exists.
  After 'cleanup_fixture'

  # `origin/HEAD` is what a clone records, so every repository that has a
  # remote here has one too — which is also what keeps the network fallback
  # out of the suite.
  make_repo() {
    TEST_DIR=$(mktemp -d)
    REPO_DIR="$TEST_DIR/plain-directory-name"
    mkdir -p "$REPO_DIR"
    git -C "$REPO_DIR" init -q
    if [ -n "${1:-}" ]; then
      git -C "$REPO_DIR" remote add origin "$1"
      git -C "$REPO_DIR" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
    fi
  }

  # A directory in no repository at all, for the not-in-a-repository answer.
  make_bare_directory() {
    TEST_DIR=$(mktemp -d)
    PLAIN_DIR="$TEST_DIR/@example-org/example-repo"
    mkdir -p "$PLAIN_DIR"
  }

  # One nwo per URL form the parser accepts, one row per branch it takes:
  # scheme form, scp form, an ssh-config alias, credentials, a port, a trailing
  # slash, and an owner and name spelled with case and dots. The parse is the
  # only source of owner and repo, so a form read wrongly is a silently wrong
  # target rather than a failure.
  Describe 'nwo from a host-bearing origin URL'
    Parameters
      'https://github.com/example-org/example-repo.git'  example-org  example-repo
      'https://github.com/example-org/example-repo'      example-org  example-repo
      'git@github.com:octo/app.git'                      octo         app
      'ssh://git@github.com/octo/app.git'                octo         app
      'ssh://git@github.com:2222/octo/app.git'           octo         app
      'https://user:pass@github.com/octo/app.git'        octo         app
      'gh-alias:octo/app.git'                            octo         app
      'https://github.com/Owner/My.Repo.git'             Owner        My.Repo
    End

    It "parses $1"
      make_repo "$1"
      expected='{"scope":"repo","owner":"'"$2"'","repo":"'"$3"'","nwo":"'"$2"'/'"$3"'"}'
      When call common_jq detect-scope.sh '{scope, owner, repo, nwo}' "$REPO_DIR"
      The status should be success
      The output should equal "$expected"
    End
  End

  # The other half, and the one that matters more. Every row here once produced
  # a plausible, wrong nwo by taking the last two path segments of whatever it
  # was handed: a sibling checkout became `src/other-repo`, a self-hosted
  # subgroup URL became `b/c`, and a relative remote became `../sibling`. With
  # the old directory-convention cross-check gone, a null nwo is the only stop
  # condition left, so a fabricated one is dispatched against.
  Describe 'a remote that names no GitHub repository'
    Parameters
      # A sibling checkout added as a local path remote.
      '/example/src/other-repo'
      'file:///example/src/other-repo'
      '../sibling'
      # Host-bearing, but three path segments: a self-hosted subgroup, not an nwo.
      'https://gitlab.example.com/a/b/c.git'
      # Host-bearing, one path segment.
      'git@github.com:owner'
    End

    It "answers repo scope with a null nwo for $1"
      make_repo "$1"
      expected='{"scope":"repo","owner":null,"repo":null,"nwo":null,"git_remote":"'"$1"'"}'
      When call common_jq detect-scope.sh '{scope, owner, repo, nwo, git_remote}' "$REPO_DIR"
      The status should be success
      The output should equal "$expected"
    End
  End

  # Two more rows in spirit, written as examples because a `Parameters` row
  # whose first token ends in `/` reads to ShellCheck as a command name ending
  # in a slash (SC2287); passing the URL as an argument is the same case
  # without the false positive, and no directive.
  It 'ignores a trailing slash on an otherwise complete URL'
    make_repo 'https://github.com/octo/app/'
    When call common_jq detect-scope.sh '.nwo' "$REPO_DIR"
    The status should be success
    The output should equal '"octo/app"'
  End

  It 'answers a null nwo for a URL with no path at all'
    make_repo 'https://github.com/'
    When call common_jq detect-scope.sh '{scope, nwo}' "$REPO_DIR"
    The status should be success
    The output should equal '{"scope":"repo","nwo":null}'
  End

  It 'reports the origin URL it parsed'
    make_repo 'git@github.com:octo/app.git'
    When call common_jq detect-scope.sh '.git_remote' "$REPO_DIR"
    The status should be success
    The output should equal '"git@github.com:octo/app.git"'
  End

  # A subdirectory of a checkout is still that checkout. The old path walk
  # answered this from the segment after the owner directory; git answers it
  # from the repository the path is in.
  It 'answers repo scope from inside a subdirectory of the checkout'
    make_repo 'https://github.com/octo/app.git'
    mkdir -p "$REPO_DIR/src/components"
    When call common_jq detect-scope.sh '{scope, nwo}' "$REPO_DIR/src/components"
    The status should be success
    The output should equal '{"scope":"repo","nwo":"octo/app"}'
  End

  # Being in a checkout is a fact about git and does not depend on the
  # checkout having a remote anyone can reach, so the scope stays `repo` and
  # only the identity is null. A caller that needs nwo stops on the null.
  It 'stays repo scope with a null nwo when the repository has no origin'
    make_repo
    When call common_jq detect-scope.sh '{scope, owner, repo, nwo, git_remote}' "$REPO_DIR"
    The status should be success
    The output should equal '{"scope":"repo","owner":null,"repo":null,"nwo":null,"git_remote":null}'
  End

  # The whole point of issue #134: an `@owner/repo` shaped path that is not a
  # repository gets no scope at all, rather than the org or repo scope the
  # directory names suggest. Exit stays 0 — this is an answer, which the audit
  # command turns into a question, and which resolve-alerts is meant to take
  # from discover-repos.sh instead (issue #188).
  Describe 'outside any repository'
    It 'returns a null scope rather than reading the directory names'
      make_bare_directory
      When call common_jq detect-scope.sh '{scope, owner, repo, nwo, default_branch}' "$PLAIN_DIR"
      The status should be success
      The output should equal '{"scope":null,"owner":null,"repo":null,"nwo":null,"default_branch":null}'
    End

    It 'echoes the path it was asked about'
      make_bare_directory
      When call common_jq detect-scope.sh '.path' "$PLAIN_DIR"
      The status should be success
      The output should equal "\"$PLAIN_DIR\""
    End

    It 'reports a null scope for a path that does not exist'
      When call common_jq detect-scope.sh '.scope' '/no/such/directory/anywhere'
      The status should be success
      The output should equal 'null'
    End
  End

  # The optional path argument is the documented test seam (detect-capacity.sh
  # cites it as precedent); every example above depends on it, and this one
  # pins that a relative argument is resolved against $PWD rather than passed
  # to git as-is.
  It 'accepts a relative path argument as the seam'
    make_repo 'https://github.com/octo/app.git'
    cd "$TEST_DIR" || return 1
    When call common_jq detect-scope.sh '.nwo' 'plain-directory-name'
    The status should be success
    The output should equal '"octo/app"'
  End

  # Resolved script-side so no agent prompt carries a shell pipeline for it.
  # The local origin/HEAD symref is how clones record the default branch, and
  # reading it needs no network.
  It 'resolves default_branch from the origin/HEAD symref'
    make_repo 'https://github.com/octo/app.git'
    When call common_jq detect-scope.sh '.default_branch' "$REPO_DIR"
    The status should be success
    The output should equal '"main"'
  End

  # A bare repository has no work tree, so `rev-parse --show-toplevel` fails
  # and the scope is null. That is the right answer rather than an oversight:
  # every downstream consumer branches, installs and validates in a tree, and
  # there is none here.
  It 'reports a null scope for a bare repository'
    TEST_DIR=$(mktemp -d)
    git init -q --bare "$TEST_DIR/origin.git"
    When call common_jq detect-scope.sh '{scope, nwo}' "$TEST_DIR/origin.git"
    The status should be success
    The output should equal '{"scope":null,"nwo":null}'
  End

  # The opposite case, and the one the fix agents live in: a linked worktree
  # resolves its own toplevel and shares the repository's origin, so it is
  # repo scope with the same nwo as the checkout it was added from.
  It 'answers repo scope from inside a linked worktree'
    make_repo 'https://github.com/octo/app.git'
    git -C "$REPO_DIR" config user.email 'spec@example.invalid'
    git -C "$REPO_DIR" config user.name 'spec'
    git -C "$REPO_DIR" commit -q --allow-empty -m init
    git -C "$REPO_DIR" worktree add -q "$TEST_DIR/linked" -b topic
    When call common_jq detect-scope.sh '{scope, nwo}' "$TEST_DIR/linked"
    The status should be success
    The output should equal '{"scope":"repo","nwo":"octo/app"}'
  End

  # The network fallback, exercised without a network: `origin` is a bare
  # repository on the same filesystem, so `remote show origin` answers locally
  # and its `HEAD branch:` line is the only source left once the symref is
  # gone. That sed branch is otherwise never executed by the suite, and it is
  # what stands between a checkout cloned before origin/HEAD was recorded and
  # a run that stops for a null default_branch.
  Describe 'default_branch when origin/HEAD was never recorded'
    make_clone() {
      TEST_DIR=$(mktemp -d)
      git init -q --bare "$TEST_DIR/origin.git"
      # Pin the bare repository's own HEAD to the branch the push below creates.
      # `git init --bare` points HEAD at the ambient init.defaultBranch, which
      # differs across machines (Apple Git compiles in main, CI runners default
      # to master); a dangling HEAD makes `remote show` answer "(unknown)".
      git -C "$TEST_DIR/origin.git" symbolic-ref HEAD refs/heads/main
      git clone -q "$TEST_DIR/origin.git" "$TEST_DIR/checkout" 2>/dev/null
      CLONE_DIR="$TEST_DIR/checkout"
      git -C "$CLONE_DIR" config user.email 'spec@example.invalid'
      git -C "$CLONE_DIR" config user.name 'spec'
      git -C "$CLONE_DIR" commit -q --allow-empty -m init
      git -C "$CLONE_DIR" push -q -u origin HEAD:main
      git -C "$CLONE_DIR" symbolic-ref -d refs/remotes/origin/HEAD 2>/dev/null || true
    }

    It 'falls back to remote show'
      make_clone
      When call common_jq detect-scope.sh '.default_branch' "$CLONE_DIR"
      The status should be success
      The output should equal '"main"'
    End

    # And when the fallback cannot answer either — here because origin points
    # at a path that is not a repository — the field is null rather than a
    # guessed branch name. Callers that need it stop on the null.
    It 'reports null when the fallback fails too'
      make_clone
      git -C "$CLONE_DIR" remote set-url origin "$TEST_DIR/absent.git"
      When call common_jq detect-scope.sh '.default_branch' "$CLONE_DIR"
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

    # Valid JSON of the wrong *shape* passes the `jq empty` guard and then
    # fails inside the annotation pipeline. Unwrapped, that left raw jq noise
    # on stderr and jq's own exit status where the adapter contract requires a
    # non-zero exit carrying `{"error": "..."}` (issue #39). This script
    # consumes discover-alerts.sh's stdout directly, so a regression in the
    # producer has to surface as a structured error, not unparseable noise.
    malformed_shape() {
      printf '%s' '{"actionable":"oops","skipped":[]}' \
        | "$COMMON/select-adapter.sh" --from-discovery
    }

    It 'reports well-formed JSON of the wrong shape through the error contract'
      When call malformed_shape
      The status should not equal 0
      The stdout should equal ''
      The stderr should include '"error":"Failed to annotate discovery JSON'
    End

    # The batch-mode pipeline rebuilds the output object from the keys it
    # knows, so a top-level key it does not know about must survive the round
    # trip rather than being silently dropped.
    discovery_with_extra_key() {
      printf '%s' '{"actionable":[{"package":"lodash","ecosystem":"npm"}],"skipped":[],"extra":[{"note":"carried by the caller"}]}'
    }
    annotate_with_extra_key() { discovery_with_extra_key | "$COMMON/select-adapter.sh" --from-discovery | jq -c "$1"; }

    It 'passes an unknown top-level key through unchanged'
      When call annotate_with_extra_key '.extra'
      The status should be success
      The output should equal '[{"note":"carried by the caller"}]'
    End
  End
End
