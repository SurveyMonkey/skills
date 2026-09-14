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

    # The types gate (ADR 012, #214) discovers the same way, anchored at the
    # three paths tsconfig.json includes, so `tsc` never sees an input the
    # configuration does not claim and a shrinking input set is refused rather
    # than reported as a clean type check.
    It 'fails types when no TypeScript files are tracked under the include paths'
      When run "$CHECK" types
      The status should eq 2
      The stderr should include 'no TypeScript files discovered'
    End

    It 'ignores a .ts under spec/fixtures when deciding whether the types gate has targets'
      mkdir -p spec/fixtures/some-repo
      printf 'export const x = 1\n' > spec/fixtures/some-repo/thing.ts
      git add -A
      When run "$CHECK" types
      The status should eq 2
      The stderr should include 'no TypeScript files discovered'
    End

    # The Biome gate (#250) discovers tracked JSON, .mjs and .ts, minus the
    # three trees Biome is deliberately not pointed at, and refuses an empty
    # result for the same reason every other gate does.
    It 'fails biome when no JSON, .mjs or .ts files are tracked'
      When run "$CHECK" biome
      The status should eq 2
      The stderr should include 'no Biome targets discovered'
    End

    It 'ignores a fixture manifest when deciding whether the biome gate has targets'
      # spec/fixtures/ is excluded from Biome: a specimen is never
      # hand-edited, and a formatter edit is one. A tree of them is therefore
      # not evidence that the gate has something to check.
      mkdir -p spec/fixtures/some-repo
      printf '{"name":"fixture"}' > spec/fixtures/some-repo/package.json
      git add -A
      When run "$CHECK" biome
      The status should eq 2
      The stderr should include 'no Biome targets discovered'
    End

    It 'ignores a rulesets export when deciding whether the biome gate has targets'
      # docs/rulesets/ is excluded from Biome: it is re-exported verbatim, so
      # formatting it would make every re-export a diff.
      mkdir -p docs/rulesets
      printf '{"name":"export"}' > docs/rulesets/protect-default.json
      git add -A
      When run "$CHECK" biome
      The status should eq 2
      The stderr should include 'no Biome targets discovered'
    End

    It 'ignores a Workflow script when deciding whether the biome gate has targets'
      # plugins/gh-security/workflows/ is excluded from Biome: a Workflow
      # script's required top-level `return` is a parse error for any ES
      # module parser (ADR 010), so Biome could never pass over it.
      mkdir -p plugins/gh-security/workflows
      printf 'return {}\n' > plugins/gh-security/workflows/dispatch.mjs
      git add -A
      When run "$CHECK" biome
      The status should eq 2
      The stderr should include 'no Biome targets discovered'
    End

    It 'discovers a tracked .ts file as a Biome target'
      # The gate's claimed scope is JSON, .mjs and .ts; a .ts-only tree must
      # clear discovery, not just a JSON-only one.
      mkdir -p bin
      printf 'export const x = 1\n' > bin/thing.ts
      git add -A
      When run "$CHECK" biome
      The status should eq 2
      The stderr should include 'biome.json is missing'
    End

    # Discovery passing does not mean the gate can run: an untracked
    # node_modules and a missing package.json each get their own refusal
    # rather than a confusing failure from inside pnpm.
    It 'fails js when the project manifest is absent'
      mkdir -p spec/js
      printf 'x\n' > spec/js/x.test.mjs
      git add -A
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'package.json is missing'
    End

    It 'fails js when node_modules has not been installed'
      mkdir -p spec/js bin
      printf 'x\n' > spec/js/x.test.mjs
      printf '{"private":true}' > package.json
      git add -A
      # A minimal pnpm stub on PATH: this example is about node_modules
      # being absent, not about whether pnpm itself is installed, and the
      # real binary is not guaranteed to be on PATH here: the CI spec job
      # never installs it, only the js job does.
      printf '#!/bin/sh\nexit 0\n' > bin/pnpm
      chmod +x bin/pnpm
      PATH="$PWD/bin:$PATH"
      export PATH
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'run pnpm install'
    End
  End

  # The coverage assertions, with a stub pnpm so no suite runs: this tests how
  # check.sh reads a coverage summary, the same way the executed-example floor
  # tests how it reads a shellspec summary.
  #
  # The hazard is specific and was reproduced before these were written: point
  # vitest's `coverage.include` at a path that matches nothing and it reports
  # "Unknown%" over 0/0 files, satisfies its own 100% thresholds, and exits 0.
  # A threshold cannot see an empty file set, so the gate has to.
  Describe 'the coverage floor'
    stub_pnpm() {
      scratch_repo || return 1
      mkdir -p spec/js bin coverage node_modules
      printf 'x\n' > spec/js/x.test.mjs
      printf '{"private":true}' > package.json
      # cmd_js's own gate on lefthook.yml (#249) runs after the suite and its
      # coverage assertion, but still inside this one function, so a missing
      # lefthook.yml would fail every example below with an unrelated
      # message. Each needs one on disk regardless of what it is testing;
      # the lefthook-specific refusals get their own Describe below.
      printf 'pre-commit:\n  commands: {}\n' > lefthook.yml
      git add -A
      # cmd_js clears any stale summary before running the suite, so the
      # stub pnpm is what publishes the one each example wants — exactly where
      # the real vitest run would write it.
      # `pnpm test` publishes whatever summary the example asked for, and
      # fails if the example asked it to. Both halves matter: a stub that
      # always exits 0 never exercises the failing-suite path at all.
      # `pnpm exec lefthook validate` (cmd_js's own gate on lefthook.yml)
      # goes through this same stub, and always exits 0 here: the
      # examples in this Describe are about the coverage floor, not
      # lefthook.yml itself.
      cat > bin/pnpm <<'STUB'
#!/bin/sh
[ -f want.json ] && { mkdir -p coverage; cat want.json > coverage/coverage-summary.json; }
[ -f want-suite-failure ] && exit 1
exit 0
STUB
      chmod +x bin/pnpm
      PATH="$PWD/bin:$PATH"
      export PATH
    }
    Before stub_pnpm

    summary() { cat > want.json; }
    full() {
      printf '{"lines":{"pct":%s},"branches":{"pct":%s},"functions":{"pct":%s},"statements":{"pct":%s}}' \
        "$1" "$2" "$3" "$4"
    }

    It 'refuses a run that produced no coverage summary at all'
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'produced no coverage summary'
    End

    It 'refuses a report that names no files, however green its total'
      summary <<JSON
{"total":{"lines":{"pct":100},"branches":{"pct":100},"functions":{"pct":100},"statements":{"pct":100}}}
JSON
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'names no files'
    End

    It 'refuses a report that measured something other than the workflow projection'
      summary <<JSON
{"total":{},"/x/spec/js/harness.mjs":$(full 100 100 100 100)}
JSON
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'names no entry ending in spec/js/generated/workflow.mjs'
      The output should include 'coverage measured'
    End

    It 'accepts a report whose subject is fully covered'
      summary <<JSON
{"total":{},"/x/spec/js/generated/workflow.mjs":$(full 100 100 100 100)}
JSON
      When run "$CHECK" js
      The status should be success
      The output should include 'coverage measured'
    End

    # One column per bucket, so each example moves exactly one of them and no
    # word-splitting is needed to spread a single field across four.
    Describe 'any single bucket below 100 fails'
      Parameters
        # bucket      lines branches functions statements
        lines          99    100      100       100
        branches       100   99       100       100
        functions      100   100      99        100
        statements     100   100      100       99
      End

      It "refuses a shortfall in $1"
        summary <<JSON
{"total":{},"/x/spec/js/generated/workflow.mjs":$(full "$2" "$3" "$4" "$5")}
JSON
        When run "$CHECK" js
        The status should eq 2
        The stderr should include "$1 is 99%"
        The stderr should include 'is not 100 on all four buckets'
        The output should include 'coverage measured'
      End
    End

    # "Unknown" is what vitest prints for a bucket it could not compute, and
    # a numeric comparison against it must fail rather than pass by accident.
    # A failing vitest run must fail the gate before any coverage assertion
    # gets a chance to pass on a green report the run also happened to write.
    It 'fails when the suite itself fails, whatever the coverage report says'
      : > want-suite-failure
      summary <<JSON
{"total":{},"/x/spec/js/generated/workflow.mjs":$(full 100 100 100 100)}
JSON
      When run "$CHECK" js
      The status should not eq 0
      The status should not eq 2
    End

    # The stale-report hazard: a summary left by an earlier, greener run must
    # not satisfy the assertions for a run that produced none. cmd_js deletes
    # it before invoking the suite, so the refusal below is the deletion
    # working — without it this example would pass on last run's numbers.
    It 'refuses a stale summary left behind by an earlier run'
      mkdir -p coverage
      cat > coverage/coverage-summary.json <<JSON
{"total":{},"/x/spec/js/generated/workflow.mjs":$(full 100 100 100 100)}
JSON
      # No want.json, so the stub pnpm publishes nothing this run.
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'produced no coverage summary'
    End

    It 'refuses a report missing a bucket entirely, not just one below 100'
      summary <<JSON
{"total":{},"/x/spec/js/generated/workflow.mjs":{"lines":{"pct":100}}}
JSON
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'carries no branches bucket at all'
      The output should include 'branches ABSENT'
    End

    # One predicate for both questions. An earlier version proved presence by
    # substring and selected the entry to check by suffix, so this exact
    # report — the only file key containing the subject without ending in it,
    # every bucket at 0 — exited 0.
    It 'refuses a key that merely contains the subject without ending in it'
      summary <<JSON
{"total":{},"/x/spec/js/generated/workflow.mjs.orig":$(full 0 0 0 0)}
JSON
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'names no entry ending in'
      The output should include 'workflow.mjs.orig'
    End

    It 'refuses a bucket whose percentage is not a number'
      summary <<JSON
{"total":{},"/x/spec/js/generated/workflow.mjs":{"lines":{"pct":"Unknown"},"branches":{"pct":100},"functions":{"pct":100},"statements":{"pct":100}}}
JSON
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'pct is Unknown, not a number'
      The output should include 'coverage measured'
    End
  End

  # cmd_js's own gate on lefthook.yml (#249): a config lefthook itself would
  # reject is a local hook silently never running, the same shape every
  # empty-discovery refusal above exists to catch. This needs its own stub
  # pnpm, distinct from "the coverage floor" above, because `pnpm exec
  # lefthook validate` and `pnpm --silent test` are both invoked through it
  # and only this Describe cares about the former's exit code.
  Describe 'the lefthook check in the js gate'
    lefthook_stub_pnpm() {
      scratch_repo || return 1
      mkdir -p spec/js bin coverage node_modules
      printf 'x\n' > spec/js/x.test.mjs
      printf '{"private":true}' > package.json
      git add -A
      # `pnpm --silent test` always publishes a fully-covered summary, so
      # every example here reaches the lefthook check; `pnpm exec lefthook
      # validate` exits 1 only when want-lefthook-failure is present.
      cat > bin/pnpm <<'STUB'
#!/bin/sh
if [ "$1" = exec ]; then
  [ -f want-lefthook-failure ] && exit 1
  exit 0
fi
mkdir -p coverage
cat > coverage/coverage-summary.json <<JSON
{"total":{},"/x/spec/js/generated/workflow.mjs":{"lines":{"pct":100},"branches":{"pct":100},"functions":{"pct":100},"statements":{"pct":100}}}
JSON
exit 0
STUB
      chmod +x bin/pnpm
      PATH="$PWD/bin:$PATH"
      export PATH
    }
    Before lefthook_stub_pnpm

    It 'fails when lefthook.yml is missing'
      When run "$CHECK" js
      The status should eq 2
      The stderr should include 'lefthook.yml is missing'
      The output should include 'coverage measured'
    End

    It 'fails when lefthook rejects the config, whatever the coverage report says'
      printf 'pre-commit:\n  commands: {}\n' > lefthook.yml
      : > want-lefthook-failure
      When run "$CHECK" js
      The status should not eq 0
      The status should not eq 2
      The output should include 'coverage measured'
    End

    It 'passes when lefthook.yml is present and lefthook accepts it'
      printf 'pre-commit:\n  commands: {}\n' > lefthook.yml
      When run "$CHECK" js
      The status should be success
      The output should include 'coverage measured'
    End
  End

  # The types gate (#214, ADR 012). Stubbed node and pnpm: this covers what
  # check.sh refuses before it runs the compiler, and how it reads a node
  # version, not whether `tsc` passes. The floor assertion is the reason for
  # the node stub — a gate that only printed the running version would be
  # documenting the floor rather than enforcing it, and the machine running
  # this suite is not the one the assertion is about.
  Describe 'the types gate'
    stub_types() {
      scratch_repo || return 1
      mkdir -p spec/ts bin node_modules
      printf 'export const x = 1\n' > spec/ts/x.test.ts
      printf '{}' > tsconfig.json
      git add -A
      cat > bin/node <<'STUB'
#!/bin/sh
echo "${STUB_NODE_VERSION:-v24.18.0}"
STUB
      # `pnpm exec tsc -p tsconfig.json` goes through this; it fails only
      # when an example asks it to, so a clean run reaches the gate's own
      # verdict rather than the compiler's.
      cat > bin/pnpm <<'STUB'
#!/bin/sh
[ -f want-tsc-failure ] && exit 1
exit 0
STUB
      chmod +x bin/node bin/pnpm
      PATH="$PWD/bin:$PATH"
      export PATH
    }
    Before stub_types

    It 'fails when tsconfig.json is absent'
      rm -f tsconfig.json
      When run "$CHECK" types
      The status should eq 2
      The stderr should include 'tsconfig.json is missing'
    End

    It 'fails when node_modules has not been installed'
      rmdir node_modules
      When run "$CHECK" types
      The status should eq 2
      The stderr should include 'run pnpm install'
    End

    # ADR 012's spike table: 22.17 fails at launch, 22.18.0 is the first
    # release that runs with zero bytes on stderr. The gate names both the
    # floor and what it found, so the reader is not left to guess which half
    # to change.
    It 'refuses a node below the 22.18 floor'
      STUB_NODE_VERSION=v22.17.1
      export STUB_NODE_VERSION
      When run "$CHECK" types
      The status should eq 2
      The stderr should include '22.18.0'
      The stderr should include '22.17.1'
    End

    It 'accepts the first release that clears the floor'
      STUB_NODE_VERSION=v22.18.0
      export STUB_NODE_VERSION
      When run "$CHECK" types
      The status should be success
    End

    # A newer minor on the floor's major, distinct from the exact-boundary
    # case above and from the major-above-floor default the other examples
    # use: it is the one leg of the major/minor/patch comparison ladder nothing
    # else here exercises, so a mutant weakening that `-gt` would otherwise
    # survive.
    It 'accepts a newer minor on the floor major'
      STUB_NODE_VERSION=v22.19.0
      export STUB_NODE_VERSION
      When run "$CHECK" types
      The status should be success
    End

    It 'refuses a node whose version it cannot read'
      # An unreadable version is not evidence that the floor is met; that is
      # the found-nothing-is-a-pass shape every gate here refuses.
      STUB_NODE_VERSION=banana
      export STUB_NODE_VERSION
      When run "$CHECK" types
      The status should eq 2
      The stderr should include 'could not read a node version'
    End

    It 'fails when the compiler reports errors'
      : > want-tsc-failure
      When run "$CHECK" types
      The status should not eq 0
      The status should not eq 2
    End

    It 'passes when the compiler is clean on a supported node'
      When run "$CHECK" types
      The status should be success
    End
  End

  # The Biome gate (#250). Stubbed pnpm, like the types gate above: this
  # covers what check.sh refuses before it runs Biome, not whether Biome
  # agrees with the tree.
  Describe 'the biome gate'
    stub_biome() {
      scratch_repo || return 1
      mkdir -p bin node_modules
      printf '{}' > biome.json
      printf '{"private":true}' > package.json
      git add -A
      cat > bin/pnpm <<'STUB'
#!/bin/sh
[ -f want-biome-failure ] && exit 1
exit 0
STUB
      chmod +x bin/pnpm
      PATH="$PWD/bin:$PATH"
      export PATH
    }
    Before stub_biome

    It 'fails when biome.json is absent'
      rm -f biome.json
      When run "$CHECK" biome
      The status should eq 2
      The stderr should include 'biome.json is missing'
    End

    It 'fails when node_modules has not been installed'
      rmdir node_modules
      When run "$CHECK" biome
      The status should eq 2
      The stderr should include 'run pnpm install'
    End

    It 'fails when Biome reports findings'
      : > want-biome-failure
      When run "$CHECK" biome
      The status should not eq 0
      The status should not eq 2
    End

    It 'passes when Biome is clean'
      When run "$CHECK" biome
      The status should be success
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

    It 'passes CHECK_SPEC_ONLY through as trailing file arguments'
      # The macOS PR leg narrows to the bash 3.2 gate alone (ADR 005
      # amendment, issue #208), so this has to travel as real shellspec file
      # arguments, appended after the flags, exactly like a human typing
      # `shellspec spec/one_spec.sh spec/two_spec.sh` would.
      #
      # SHELLSPEC_JOBS, CHECK_SPEC_SHELL, and CHECK_SPEC_FORMAT are unset
      # explicitly, same trap as the SHELLSPEC_JOBS pin above (issue #61):
      # the CI spec job sets all three at the job level, so an
      # example whose argv assertion is order- and content-sensitive would
      # otherwise depend on the caller's environment. This example proved
      # it: it passed locally and failed in CI's ubuntu leg, where
      # CHECK_SPEC_SHELL=bash and CHECK_SPEC_FORMAT=progress leaked into the
      # asserted argv.
      unset SHELLSPEC_JOBS CHECK_SPEC_SHELL CHECK_SPEC_FORMAT
      cat > bin/shellspec <<'STUB'
#!/bin/sh
echo "argv: $*"
cat summary.txt
exit 0
STUB
      printf '2 examples, 0 failures\n' > summary.txt
      CHECK_SPEC_ONLY='spec/bash32_parse_spec.sh spec/other_spec.sh'
      export CHECK_SPEC_ONLY
      When run "$CHECK" spec
      The status should be success
      The output should include 'argv: spec/bash32_parse_spec.sh spec/other_spec.sh'
    End

    It 'omits file arguments entirely when CHECK_SPEC_ONLY is unset'
      # Unset explicitly for the same reason CHECK_SPEC_FORMAT is above: CI
      # sets it at the job level, and an example that inherits it asserts the
      # opposite of its own name and fails only there. SHELLSPEC_JOBS is
      # unset for the same reason as the example above.
      unset CHECK_SPEC_ONLY
      unset SHELLSPEC_JOBS CHECK_SPEC_SHELL CHECK_SPEC_FORMAT
      cat > bin/shellspec <<'STUB'
#!/bin/sh
echo "argv: [$*]"
cat summary.txt
exit 0
STUB
      printf '5 examples, 0 failures\n' > summary.txt
      When run "$CHECK" spec
      The status should be success
      The output should include 'argv: []'
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
