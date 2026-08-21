#!/bin/sh
# shellcheck shell=sh
# The committed hooks carry real decision logic distinct from check.sh: the
# pre-commit scope filter decides whether the gates run at all, and pre-push
# parses the pushed refs to decide whether the suite runs. A regression in
# either is a permanent, silent no-op that still exits 0, so both are pinned
# here. The gates themselves are stubbed: these examples test the hooks'
# control flow, and the stub log is the observable verdict.

Describe 'the committed git hooks'
  PRECOMMIT="$SHELLSPEC_PROJECT_ROOT/.githooks/pre-commit"
  PREPUSH="$SHELLSPEC_PROJECT_ROOT/.githooks/pre-push"

  # A scratch repo whose scripts/check.sh records every gate invocation in
  # gates.log, with stub tools on PATH so command -v always succeeds and the
  # hooks' tool-missing branches stay out of the way.
  scratch_hook_repo() {
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR" || return 1
    git init -q .
    mkdir -p scripts bin
    cat > scripts/check.sh <<'STUB'
#!/bin/sh
echo "$1" >> gates.log
exit 0
STUB
    chmod +x scripts/check.sh
    for _t in shellcheck claude shellspec; do
      printf '#!/bin/sh\nexit 0\n' > "bin/$_t"
      chmod +x "bin/$_t"
    done
    PATH="$PWD/bin:$PATH"
    export PATH
  }

  commit_seed() {
    git -c user.email=t@t -c user.name=t commit -q -m seed
  }

  Before scratch_hook_repo
  After cleanup_fixture

  Describe 'pre-commit scope filter'
    It 'skips the gates for a docs-only commit, loudly'
      printf 'x\n' > README.md
      git add README.md
      When run "$PRECOMMIT"
      The status should be success
      The stderr should include 'skipping them'
      The path gates.log should not be exist
    End

    It 'runs both fast gates when a shell file is staged'
      printf '#!/bin/sh\n' > tool.sh
      git add tool.sh
      When run "$PRECOMMIT"
      The status should be success
      The contents of file gates.log should include 'lint'
      The contents of file gates.log should include 'validate'
    End

    It 'stays in scope when the only staged change is a deletion'
      # Deleting the last plugin manifest is exactly the state the
      # empty-discovery refusal exists to catch; a diff filter that drops
      # deletions would skip the gates here (issue #56).
      mkdir -p plugins/p/.claude-plugin
      printf '{}\n' > plugins/p/.claude-plugin/plugin.json
      git add plugins/p/.claude-plugin/plugin.json
      commit_seed
      git rm -q plugins/p/.claude-plugin/plugin.json
      When run "$PRECOMMIT"
      The status should be success
      The contents of file gates.log should include 'lint'
    End

    It 'treats a root .shellcheckrc as in scope'
      # The exact file root CLAUDE.md forbids promoting; committing one must
      # not slip past the gates unexamined.
      printf 'disable=SC1000\n' > .shellcheckrc
      git add .shellcheckrc
      When run "$PRECOMMIT"
      The status should be success
      The contents of file gates.log should include 'lint'
    End

    It 'treats a workflow change as in scope'
      mkdir -p .github/workflows
      printf 'name: x\n' > .github/workflows/gates.yml
      git add .github/workflows/gates.yml
      When run "$PRECOMMIT"
      The status should be success
      The contents of file gates.log should include 'lint'
    End
  End

  Describe 'pre-push ref parsing'
    It 'skips the suite for a tag-only push, loudly'
      Data "refs/tags/v1 1111111111111111111111111111111111111111 refs/tags/v1 0000000000000000000000000000000000000000"
      When run "$PREPUSH" origin git@example.com:x/y.git
      The status should be success
      The stderr should include 'skipping the suite'
      The path gates.log should not be exist
    End

    It 'skips the suite for a delete-only push'
      Data "refs/heads/gone 0000000000000000000000000000000000000000 refs/heads/gone 1111111111111111111111111111111111111111"
      When run "$PREPUSH" origin git@example.com:x/y.git
      The status should be success
      The stderr should include 'skipping the suite'
      The path gates.log should not be exist
    End

    It 'recognizes a SHA-256 null OID as a deletion'
      Data "refs/heads/gone 0000000000000000000000000000000000000000000000000000000000000000 refs/heads/gone 1111111111111111111111111111111111111111111111111111111111111111"
      When run "$PREPUSH" origin git@example.com:x/y.git
      The status should be success
      The stderr should include 'skipping the suite'
      The path gates.log should not be exist
    End

    It 'runs the suite for a branch push'
      Data "refs/heads/topic 1111111111111111111111111111111111111111 refs/heads/topic 0000000000000000000000000000000000000000"
      When run "$PREPUSH" origin git@example.com:x/y.git
      The status should be success
      The contents of file gates.log should include 'spec'
    End

    It 'runs the suite for a mixed tag and branch push'
      Data
        #|refs/tags/v1 1111111111111111111111111111111111111111 refs/tags/v1 0000000000000000000000000000000000000000
        #|refs/heads/topic 2222222222222222222222222222222222222222 refs/heads/topic 0000000000000000000000000000000000000000
      End
      When run "$PREPUSH" origin git@example.com:x/y.git
      The status should be success
      The contents of file gates.log should include 'spec'
    End

    It 'runs the suite rather than guessing when stdin carries no refs'
      # No Data block: stdin is empty, the anomalous case the hook must not
      # read as "nothing to test".
      When run "$PREPUSH" origin git@example.com:x/y.git
      The status should be success
      The stderr should include 'no ref lines'
      The contents of file gates.log should include 'spec'
    End
  End
End
