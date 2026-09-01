#!/bin/sh
# shellcheck shell=sh
# scripts/check.sh is the single entry point for the quality gates, so its
# refusal paths are what keep "found nothing" from reading as a pass: the
# hooks and the workflow both trust it to fail on empty discovery. Only the
# refusals and the target listing are covered here. The happy paths need the
# ShellCheck binary, the claude CLI, and the suite itself (recursion), and CI
# runs them for real via .github/workflows/gates.yml.

Describe 'scripts/check.sh'
  CHECK="$SHELLSPEC_PROJECT_ROOT/scripts/check.sh"

  # A scratch git repository: check.sh anchors itself with
  # `git rev-parse --show-toplevel` and discovers targets from the index, so
  # every example gets its own repo rather than this one.
  scratch_repo() {
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR" || return 1
    git init -q .
  }

  After cleanup_fixture

  Describe 'argument handling'
    Before scratch_repo

    It 'refuses an unknown subcommand'
      When run "$CHECK" frobnicate
      The status should eq 2
      The stderr should include 'usage:'
    End

    It 'refuses a missing subcommand'
      When run "$CHECK"
      The status should eq 2
      The stderr should include 'usage:'
    End
  End

  Describe 'targets'
    Before scratch_repo

    It 'lists tracked shell files from the index, staged included'
      mkdir -p sub
      touch tracked.sh sub/nested.sh untracked.sh
      git add tracked.sh sub/nested.sh
      When run "$CHECK" targets
      The line 1 of output should equal 'sub/nested.sh'
      The line 2 of output should equal 'tracked.sh'
      The lines of output should eq 2
    End

    It 'lists .githooks entries despite their missing .sh suffix'
      mkdir -p .githooks
      touch .githooks/pre-commit
      git add .githooks/pre-commit
      When run "$CHECK" targets
      The output should equal '.githooks/pre-commit'
    End

    It 'discovers from cwd even when the environment carries another GIT_DIR'
      # git exports GIT_DIR to hooks, and inheriting it aims every git call
      # at the hook's repository regardless of cwd; observed live when the
      # pre-push hook broke in a linked worktree (issue #56). check.sh must
      # answer for the repo it is run in, never for the environment.
      touch tracked.sh
      git add tracked.sh
      mkdir other
      git -C other init -q
      GIT_DIR="$PWD/other/.git"
      export GIT_DIR
      When run "$CHECK" targets
      The output should equal 'tracked.sh'
    End
  End

  Describe 'empty discovery refuses instead of passing'
    Before scratch_repo

    It 'fails lint when no shell files are tracked'
      When run "$CHECK" lint
      The status should eq 2
      The stderr should include 'no shell files discovered'
    End

    It 'fails validate when the marketplace manifest is absent'
      When run "$CHECK" validate
      The status should eq 2
      The stderr should include 'marketplace manifest missing'
    End

    It 'fails validate when no plugin carries a manifest'
      mkdir -p .claude-plugin plugins/empty
      printf '{}' > .claude-plugin/marketplace.json
      When run "$CHECK" validate
      The status should eq 2
      The stderr should include 'no plugin manifests found'
    End

    It 'fails spec when no spec files exist'
      When run "$CHECK" spec
      The status should eq 2
      The stderr should include 'no spec files found'
    End

    # ADR 010's gate refuses the same way the others do, and its discovery is
    # `git ls-files -- 'spec/js/*.test.mjs'` — anchored so the many
    # hand-authored package.json and node_modules trees under spec/fixtures/
    # can never be collected as this repo's own project code.
    It 'fails js when no test files are tracked under spec/js'
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'no JS test files discovered'
    End

    It 'ignores a fixture package.json when deciding whether the js gate has targets'
      mkdir -p spec/fixtures/some-repo
      printf '{"name":"fixture"}' > spec/fixtures/some-repo/package.json
      git add -A
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'no JS test files discovered'
    End

    # Discovery passing does not mean the gate can run: an untracked
    # node_modules and a missing package.json each get their own refusal
    # rather than a confusing failure from inside npm.
    It 'fails js when the project manifest is absent'
      mkdir -p spec/js
      printf 'x\n' > spec/js/x.test.mjs
      git add -A
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'package.json is missing'
    End

    It 'fails js when node_modules has not been installed'
      mkdir -p spec/js
      printf 'x\n' > spec/js/x.test.mjs
      printf '{"private":true}' > package.json
      git add -A
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'run npm ci'
    End
  End

  # The example floor is the guard against shellspec's own "0 examples, 0
  # failures, exit 0" behavior, and skips are equally green, so the floor is
  # on executed examples. Exercised with a stub shellspec on PATH printing a
  # canned summary: this tests how check.sh interprets the summary, not
  # whether shellspec passes tests, so it needs no real suite and cannot
  # recurse into this one.
  Describe 'the executed-example floor'
    stub_suite() {
      scratch_repo || return 1
      mkdir -p bin spec
      : > spec/dummy_spec.sh
      printf '#!/bin/sh\ncat summary.txt\nexit 0\n' > bin/shellspec
      chmod +x bin/shellspec
      PATH="$PWD/bin:$PATH"
      export PATH
    }
    Before stub_suite

    It 'refuses a suite that ran zero examples'
      printf '0 examples, 0 failures\n' > summary.txt
      When run "$CHECK" spec
      The status should eq 2
      The output should include '0 examples'
      The stderr should include 'zero is never a pass'
    End

    It 'refuses output carrying no summary line at all'
      printf 'something that is not a summary\n' > summary.txt
      When run "$CHECK" spec
      The status should eq 2
      The output should include 'not a summary'
      The stderr should include 'could not read an example count'
    End

    It 'refuses a suite whose every example was skipped'
      printf '5 examples, 0 failures, 5 skips\n' > summary.txt
      When run "$CHECK" spec
      The status should eq 2
      The output should include '5 skips'
      The stderr should include 'fully skipped suite is never a pass'
    End

    It 'refuses the singular form of a fully skipped suite'
      printf '1 example, 0 failures, 1 skip\n' > summary.txt
      When run "$CHECK" spec
      The status should eq 2
      The output should include '1 skip'
      The stderr should include 'fully skipped suite is never a pass'
    End

    It 'passes a suite with executed examples alongside skips'
      printf '586 examples, 0 failures, 1 skip\n' > summary.txt
      When run "$CHECK" spec
      The status should be success
      The output should include '586 examples'
    End

    It 'passes CHECK_SPEC_SHELL through as --shell'
      # The SHELLSPEC_SHELL env var is silently ignored when .shellspec sets
      # --shell, so the override travels as a CLI flag; a shell override
      # that silently does not apply is how CI ends up testing the wrong
      # shell while green (issue #57).
      cat > bin/shellspec <<'STUB'
#!/bin/sh
echo "argv: $*"
cat summary.txt
exit 0
STUB
      printf '5 examples, 0 failures\n' > summary.txt
      CHECK_SPEC_SHELL=bash
      export CHECK_SPEC_SHELL
      # SHELLSPEC_JOBS is pinned rather than inherited: the pre-push hook
      # exports it, and an example whose argv depends on the caller's
      # environment fails exactly there while passing serial CI (issue #61).
      # Pinning also covers the flag combination the hook actually produces.
      SHELLSPEC_JOBS=8
      export SHELLSPEC_JOBS
      When run "$CHECK" spec
      The status should be success
      The output should include '--jobs 8'
      The output should include '--shell bash'
    End

    It 'passes CHECK_SPEC_FORMAT through as --format'
      # Same seam as CHECK_SPEC_SHELL above, and same hazard: .shellspec sets
      # --format, so an override that did not travel as a CLI flag would be
      # silently ignored and CI would keep paying for the formatter it meant
      # to turn off (issue #149).
      cat > bin/shellspec <<'STUB'
#!/bin/sh
echo "argv: $*"
cat summary.txt
exit 0
STUB
      printf '5 examples, 0 failures\n' > summary.txt
      CHECK_SPEC_FORMAT=progress
      export CHECK_SPEC_FORMAT
      When run "$CHECK" spec
      The status should be success
      The output should include '--format progress'
    End

    It 'omits --format entirely when CHECK_SPEC_FORMAT is unset'
      # The default path must stay .shellspec's own --format documentation;
      # an empty flag value would override it with nothing and abort.
      #
      # Unset explicitly rather than trusting the ambient environment: CI sets
      # CHECK_SPEC_FORMAT at the job level, so inheriting it makes this
      # example assert the opposite of its own name and fail only there. That
      # is the same trap the SHELLSPEC_JOBS pin below documents from issue
      # #61, and it caught this example on its first CI run.
      unset CHECK_SPEC_FORMAT
      cat > bin/shellspec <<'STUB'
#!/bin/sh
echo "argv: $*"
cat summary.txt
exit 0
STUB
      printf '5 examples, 0 failures\n' > summary.txt
      When run "$CHECK" spec
      The status should be success
      The output should not include '--format'
    End

    It 'reads the summary through ANSI color codes'
      # --color via .shellspec-local prefixes the summary line with escape
      # sequences; the floor must still find the count rather than refusing
      # a passing suite.
      printf '\033[32m5 examples, 0 failures\033[0m\n' > summary.txt
      When run "$CHECK" spec
      The status should be success
      The output should include 'examples'
    End
  End
End
