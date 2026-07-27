#!/bin/sh
# shellcheck shell=sh

Describe 'mutating verbs refuse a primary checkout'
  After 'cleanup_fixture'

  # Worktrees carry a .git file; the user's checkout has a .git directory. A
  # mutating verb running in the latter silently edits the user's tree
  # (observed live), so it refuses. A .git file — a real worktree — proceeds.
  It 'apply_constraint refuses when .git is a directory'
    use_fixture yarn-berry
    mkdir .git
    When run script "$ADAPTER" apply_constraint lodash '>=4.17.21 <5'
    The status should equal 1
    The stderr should include 'primary checkout'
  End

  It 'apply_constraint proceeds when .git is a worktree file'
    use_fixture yarn-berry
    printf 'gitdir: /elsewhere/.git/worktrees/fix\n' > .git
    When call adapter_jq '{package, pm}' apply_constraint lodash '>=4.17.21 <5'
    The status should be success
    The output should equal '{"package":"lodash","pm":"yarn"}'
  End
End
# node.sh apply_constraint.
#
# Every example works on a scratch copy of a fixture, because this verb writes
# package.json.

# Read a value back out of the rewritten manifest.
manifest() { jq -c "$1" package.json; }

Describe 'node.sh apply_constraint'
  After 'cleanup_fixture'

  Describe 'transitive dependencies get parent-scoped entries'
    It 'uses parent>dep for pnpm'
      use_fixture pnpm-v9
      "$ADAPTER" apply_constraint undici '>=6.19.0 <7' express koa >/dev/null
      When call manifest '[.pnpm.overrides | to_entries[] | select(.key | test("undici")) | .key] | sort'
      The output should equal '["express>undici","koa>undici"]'
    End

    It 'uses parent/dep for yarn'
      use_fixture yarn-berry
      "$ADAPTER" apply_constraint undici '>=6.19.0 <7' '@vercel/fun' >/dev/null
      When call manifest '.resolutions["@vercel/fun/undici"]'
      The output should equal '">=6.19.0 <7"'
    End

    It 'uses nested objects for npm'
      use_fixture npm-v3
      "$ADAPTER" apply_constraint undici '>=6.19.0 <7' glob rimraf >/dev/null
      When call manifest '{glob: .overrides.glob, rimraf: .overrides.rimraf}'
      The output should equal '{"glob":{"undici":">=6.19.0 <7"},"rimraf":{"undici":">=6.19.0 <7"}}'
    End
  End

  Describe 'existing entries are merged, never replaced'
    It 'preserves unrelated pnpm overrides'
      use_fixture pnpm-v9
      "$ADAPTER" apply_constraint undici '>=6.19.0 <7' express >/dev/null
      When call manifest '{lodash: .pnpm.overrides.lodash, scoped: .pnpm.overrides["express>sha.js"], versioned: .pnpm.overrides["handlebars@4"]}'
      The output should equal '{"lodash":">=4.17.21","scoped":">=2.4.11 <3","versioned":"^4.7.9"}'
    End

    It 'preserves both flat and nested npm overrides'
      use_fixture npm-v3
      "$ADAPTER" apply_constraint undici '>=6.19.0 <7' glob >/dev/null
      When call manifest '{flat: .overrides.lodash, nested: .overrides["test-exclude"]}'
      The output should equal '{"flat":"^4.17.21","nested":{"lodash":"3.10.1"}}'
    End
  End

  Describe 'direct dependencies match the manifest version style'
    # A repo that pins exactly (yarn `defaultSemverRangePrefix: ""`) should not
    # acquire a lone range entry, and a caret repo should stay caret. The major
    # bound still holds either way: an exact pin cannot cross a major, and ^ is
    # already major-bounded.
    Parameters
      yarn-berry  vitest  '"4.1.0"'   # fixture pins exactly
      pnpm-v9     vitest  '"^4.1.0"'  # fixture uses a caret
    End

    It "writes $3 into $1"
      use_fixture "$1"
      "$ADAPTER" apply_constraint "$2" '>=4.1.0 <5' >/dev/null
      When call manifest ".devDependencies[\"$2\"]"
      The output should equal "$3"
    End
  End

  It 'updates a direct runtime dependency in place'
    use_fixture npm-v3
    "$ADAPTER" apply_constraint express '>=4.19.0 <5' >/dev/null
    When call manifest '.dependencies.express'
    The output should equal '"^4.19.0"'
  End

  It 'reports the mode it took'
    use_fixture pnpm-v9
    When call adapter_jq '{mode, parents}' apply_constraint undici '>=6.19.0 <7' express
    The status should be success
    The output should equal '{"mode":"scoped","parents":["express"]}'
  End

  Describe 'observations flag pre-existing unscoped overrides'
    # Bare global overrides are usually someone reaching for the blunt tool.
    # They are reported as a lead for the pin audit (issue #7), not rewritten.

    It 'lists bare pnpm overrides and ignores scoped ones'
      use_fixture pnpm-v9
      When call adapter_jq '[.observations[].key] | sort' apply_constraint undici '>=6.19.0 <7' express
      The status should be success
      The output should equal '["handlebars@4","lodash"]'
    End

    # This is the ambiguity that breaks naive slash-splitting: for yarn,
    # `@scope/name` is a bare override while `parent/dep` is a scoped one.
    It 'treats a scoped package name as bare, not as parent/dep'
      use_fixture yarn-berry
      When call adapter_jq '[.observations[].key] | sort' apply_constraint undici '>=6.19.0 <7' express
      The status should be success
      The output should equal '["@babel/core"]'
    End

    It 'ignores npm nested overrides, whose values are objects'
      use_fixture npm-v3
      When call adapter_jq '[.observations[].key] | sort' apply_constraint undici '>=6.19.0 <7' glob
      The status should be success
      The output should equal '["lodash"]'
    End

    It 'marks an override that targets the package being fixed'
      use_fixture pnpm-v9
      When call adapter_jq '[.observations[] | select(.targets_this_package) | .key]' apply_constraint lodash '>=4.17.21 <5' express
      The status should be success
      The output should equal '["lodash"]'
    End
  End

  Describe '--tighten-bare escalation'
    # Reached for only after scoped entries alone fail validation, because a
    # bare override still governs paths the scoped entries do not cover.

    It 'raises the bare entry to satisfy the constraint'
      use_fixture pnpm-v9
      "$ADAPTER" apply_constraint --tighten-bare lodash '>=4.17.25 <5' >/dev/null
      When call manifest '.pnpm.overrides.lodash'
      The output should equal '">=4.17.25 <5"'
    End

    It 'reports the escalation as its own mode'
      use_fixture pnpm-v9
      When call adapter_jq '{mode, parents}' apply_constraint --tighten-bare lodash '>=4.17.25 <5'
      The status should be success
      The output should equal '{"mode":"tighten-bare","parents":[]}'
    End
  End

  # A direct update writes into dependencies, so it must not leave an empty
  # "resolutions": {} behind in a manifest that never had one.
  It 'does not create an empty override block for a direct update'
    use_fixture no-overrides
    "$ADAPTER" apply_constraint lodash '>=4.17.21 <5' >/dev/null
    When call manifest 'has("resolutions")'
    The output should equal 'false'
  End

  It 'still updates the direct dependency in a manifest with no override block'
    use_fixture no-overrides
    "$ADAPTER" apply_constraint lodash '>=4.17.21 <5' >/dev/null
    When call manifest '.dependencies.lodash'
    The output should equal '"^4.17.21"'
  End

  It 'creates the override block when the manifest has none'
    use_fixture yarn-berry
    "$ADAPTER" apply_constraint brand-new-pkg '>=1.0.0 <2' some-parent >/dev/null
    When call manifest '.resolutions["some-parent/brand-new-pkg"]'
    The output should equal '">=1.0.0 <2"'
  End

  It 'requires a package and a range'
    use_fixture pnpm-v9
    When run script "$ADAPTER" apply_constraint lodash
    The status should not equal 0
    The stderr should be present
  End
End
