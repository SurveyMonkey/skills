#!/bin/sh
# shellcheck shell=sh

Describe 'mutating verbs run only in a linked worktree'
  After 'cleanup_fixture'

  # A mutating verb outside a linked worktree edits somebody's real tree
  # (observed live), so it refuses. use_fixture fakes a linked worktree; each
  # example here replaces that with the shape it is about.
  It 'apply_constraint refuses in a primary checkout'
    use_fixture yarn-berry
    fake_primary_checkout
    When run script "$ADAPTER" apply_constraint lodash '>=4.17.21 <5'
    The status should equal 1
    The stderr should include 'primary checkout'
  End

  # The old `.git` test looked only at the current directory, so any
  # subdirectory of the user's checkout passed it.
  It 'apply_constraint refuses in a subdirectory of a primary checkout'
    use_fixture yarn-berry
    fake_primary_checkout
    mkdir -p packages/app
    cp package.json yarn.lock packages/app/
    cd packages/app || return 1
    When run script "$ADAPTER" apply_constraint lodash '>=4.17.21 <5'
    The status should equal 1
    The stderr should include 'subdirectory of the primary checkout'
  End

  # A submodule's .git is a file too, which the old test accepted as a worktree.
  It 'apply_constraint refuses in a git submodule'
    use_fixture yarn-berry
    fake_linked_worktree '/parent/.git/modules/vendor'
    When run script "$ADAPTER" apply_constraint lodash '>=4.17.21 <5'
    The status should equal 1
    The stderr should include 'submodule'
  End

  # The pointer git actually writes for a submodule is relative, not the
  # absolute path the row above uses.
  It 'apply_constraint refuses in a git submodule with a relative gitdir'
    use_fixture yarn-berry
    fake_linked_worktree '../.git/modules/vendor'
    When run script "$ADAPTER" apply_constraint lodash '>=4.17.21 <5'
    The status should equal 1
    The stderr should include 'submodule'
  End

  # A submodule checked out inside the fix worktree carries both markers.
  It 'apply_constraint refuses in a submodule nested in a linked worktree'
    use_fixture yarn-berry
    fake_linked_worktree '../../main/.git/worktrees/fix/modules/vendor'
    When run script "$ADAPTER" apply_constraint lodash '>=4.17.21 <5'
    The status should equal 1
    The stderr should include 'submodule'
  End

  # A submodule whose own path begins with worktrees/ writes a gitdir like
  # .git/modules/worktrees/foo, where the last marker is `worktrees` and the
  # last-marker rule alone would misread it as a linked worktree. Only the
  # `.git/modules/` probe inside the worktrees arm catches it.
  It 'apply_constraint refuses in a submodule whose path begins with worktrees/'
    use_fixture yarn-berry
    fake_linked_worktree '../../.git/modules/worktrees/foo'
    When run script "$ADAPTER" apply_constraint lodash '>=4.17.21 <5'
    The status should equal 1
    The stderr should include 'submodule'
  End

  # A repo that lives under a directory named `modules` is an ordinary
  # monorepo, and its worktrees are ordinary worktrees. Matching `modules`
  # unanchored refused every one of them with a false diagnosis.
  It 'apply_constraint proceeds in a linked worktree of a repo under modules/'
    use_fixture yarn-berry
    fake_linked_worktree '/src/modules/app/.git/worktrees/fix'
    When call adapter_jq '{package, pm}' apply_constraint lodash '>=4.17.21 <5'
    The status should be success
    The output should equal '{"package":"lodash","pm":"yarn"}'
  End

  # The guard runs before verb_detect, so this needs no package manager on
  # PATH; deleting the one guard line from verb_install would let an install
  # regenerate the user's own lockfile, which is the live incident behind #18.
  It 'install refuses in a primary checkout'
    use_fixture yarn-berry
    fake_primary_checkout
    When run script "$ADAPTER" install
    The status should equal 1
    The stderr should include 'primary checkout'
  End

  # shim creates a directory and an executable, and absolutizes a vendored
  # runner from the cwd, so it writes into whatever tree it is pointed at.
  It 'shim refuses in a primary checkout'
    use_fixture yarn-vendored
    fake_primary_checkout
    When run script "$ADAPTER" shim shim-bin 'corepack yarn'
    The status should equal 1
    The stderr should include 'primary checkout'
    The path shim-bin should not be exist
  End

  It 'apply_constraint proceeds in a linked worktree'
    use_fixture yarn-berry
    When call adapter_jq '{package, pm}' apply_constraint lodash '>=4.17.21 <5'
    The status should be success
    The output should equal '{"package":"lodash","pm":"yarn"}'
  End

  # A monorepo package directory inside the fix worktree is a legitimate place
  # to apply a constraint.
  It 'apply_constraint proceeds in a subdirectory of a linked worktree'
    use_fixture yarn-berry
    mkdir -p packages/app
    cp package.json yarn.lock packages/app/
    cd packages/app || return 1
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

  # A bare pnpm `parent>child` key matches EVERY resolved copy of the parent,
  # so a parent in the tree at several versions — each copy resolving its own
  # major of the child — had all of its copies dragged onto the group's line:
  # on the field run behind issue #100, `ws` 7.x/8.x and `brace-expansion`
  # 1.x each collapsed the sibling lines this way and fail-closed at
  # validate. pnpm compares the parent half of `parent@<v>>child` with
  # semver.satisfies against the copy's resolved version, so the fix —
  # proven by five shipped field PRs — is one exact-version key per parent
  # version whose resolution of the child is on the target line, read from
  # the lockfile's snapshots. pnpm only: npm's nested overrides and yarn's
  # `a/b` resolutions have different narrowing semantics (a version-qualified
  # yarn key silently never matches), so neither is qualified here.
  Describe 'pnpm parent keys are version-qualified across major lines'
    It 'writes one qualified key per parent version on the target line'
      use_fixture pnpm-cross-line
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call manifest '[.pnpm.overrides | keys[]] | sort'
      The output should equal '["minimatch@10.0.3>brace-expansion","minimatch@10.2.5>brace-expansion"]'
    End

    It 'reports the qualified keys it wrote'
      use_fixture pnpm-cross-line
      When call adapter_jq '.written' apply_constraint brace-expansion '>=5.0.9 <6' minimatch
      The status should be success
      The output should equal '[{"parent":"minimatch","path":["pnpm","overrides","minimatch@10.0.3>brace-expansion"],"value":">=5.0.9 <6"},{"parent":"minimatch","path":["pnpm","overrides","minimatch@10.2.5>brace-expansion"],"value":">=5.0.9 <6"}]'
    End

    # The 1.x line has exactly one parent copy, so a fix scoped there covers
    # that copy alone and leaves the 2.x and 5.x resolutions unnamed.
    It 'covers a different target line with that line parent version only'
      use_fixture pnpm-cross-line
      "$ADAPTER" apply_constraint brace-expansion '>=1.1.12 <2' minimatch >/dev/null
      When call manifest '[.pnpm.overrides | keys[]] | sort'
      The output should equal '["minimatch@3.1.5>brace-expansion"]'
    End

    # A single-version parent keeps today's bare key: nothing else exists for
    # the key to leak onto, and qualifying it would churn every existing PR
    # shape for no safety gain.
    It 'keeps the bare key for a parent resolved at a single version'
      use_fixture pnpm-cross-line
      "$ADAPTER" apply_constraint minimatch '>=5.1.6 <6' filelist >/dev/null
      When call manifest '[.pnpm.overrides | keys[]]'
      The output should equal '["filelist>minimatch"]'
    End

    # The chain to the verdict: this override state is exactly the
    # pnpm-cross-line-qualified specimen, whose post-install lockfile keeps
    # the sibling lines and passes `validate --baseline` with
    # `other_line_moves: []`, while the bare key the verb used to write is
    # the pnpm-cross-line-collapsed specimen validate fails closed on
    # (spec/node_validate_spec.sh).
    overrides_matching_specimen() {
      _mine=$(jq -cS '.pnpm.overrides' package.json)
      _specimen=$(jq -cS '.pnpm.overrides' \
        "$FIXTURES/pnpm-cross-line-qualified/package.json")
      [ "$_mine" = "$_specimen" ] && printf '%s' "$_mine"
    }

    It 'writes the same override state the intact post-install specimen carries'
      use_fixture pnpm-cross-line
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call overrides_matching_specimen
      The status should be success
      The output should equal '{"minimatch@10.0.3>brace-expansion":">=5.0.9 <6","minimatch@10.2.5>brace-expansion":">=5.0.9 <6"}'
    End
  End

  # An aliased dependency, which `validate` now counts and which nothing could
  # previously move: `overrides.lodash` does not reach a copy the parent
  # declared as `lodash-alias`, and a bare range under the alias key names a
  # package no registry has. Both halves are needed, so both are asserted
  # (issue #46).
  #
  # **Neither fixture below has a `node_modules` directory**, and that is the
  # point. This verb runs before `install`, in a fresh worktree where
  # node_modules is gitignored and absent; Yarn PnP never has one at all. The
  # alias key used to be looked up in `node_modules/<parent>/package.json`, so
  # every parent was silently skipped and the plain package name was written,
  # which moves nothing — while `spec/fixtures/npm-alias` committed a
  # node_modules tree encoding a state that never exists here, which is why the
  # suite stayed green through it (issue #48).
  Describe 'a dependency reached through an npm: alias'
    # The chain, end to end: the key `apply_constraint` writes, and the copy
    # `validate` says is still vulnerable. A pass means the override that was
    # written names the same copy the completeness check flags — which is what
    # "the aliased copy is governed" means before an install has run.
    alias_chain() {
      _wrote=$("$ADAPTER" apply_constraint lodash '>=4.18.2 <5' "$@" \
        | jq -c '[.written[] | select(.value | startswith("npm:")) | .path]')
      _left=$("$ADAPTER" validate --line 4 --vulnerable '>= 4.18.0, < 4.18.2' \
        lodash '>=4.18.2 <5' | jq -c '[.unresolved_alerts[].path]')
      printf 'wrote=%s still_vulnerable=%s\n' "$_wrote" "$_left"
    }

    It 'writes the alias key, with the protocol, under the parent that declared it'
      use_fixture npm-alias
      "$ADAPTER" apply_constraint lodash '>=4.18.2 <5' alias-parent dupe-parent >/dev/null
      When call manifest '{aliased: .overrides["alias-parent"], plain: .overrides["dupe-parent"]}'
      The output should equal '{"aliased":{"lodash-alias":"npm:lodash@>=4.18.2 <5"},"plain":{"lodash":">=4.18.2 <5"}}'
    End

    It 'governs the aliased copy validate flags, with no node_modules to read'
      use_fixture npm-alias
      When call alias_chain alias-parent dupe-parent
      The status should be success
      The path node_modules should not be exist
      The output should equal 'wrote=[["overrides","alias-parent","lodash-alias"]] still_vulnerable=["node_modules/lodash-alias"]'
    End

    # Yarn Berry, which had no working path at all until `yarn_parents` learned
    # to read alias declarations: `why` returned no parent, so this call would
    # have received none and only the root-alias branch could fire — and the
    # root here never mentions lodash (issue #47).
    It 'does the same for a Yarn Berry parent that declares through npm:'
      use_fixture yarn-berry-alias-parent
      When call alias_chain express
      The status should be success
      The path node_modules should not be exist
      The output should equal 'wrote=[["resolutions","express/lodash-alias"]] still_vulnerable=["lodash-alias@npm:lodash@4.18.1"]'
    End

    # The result used to report `package` and `range` whatever it had written,
    # so a PR body quoting it described an edit that was not made (issue #48).
    It 'reports the key and value it actually wrote'
      use_fixture npm-alias
      When call adapter_jq '.written' apply_constraint lodash '>=4.18.2 <5' alias-parent
      The status should be success
      The output should equal '[{"parent":"alias-parent","path":["overrides","alias-parent","lodash-alias"],"value":"npm:lodash@>=4.18.2 <5"}]'
    End

    # Silently skipping a parent whose declaration cannot be read is the whole
    # failure mode above. pnpm's snapshots record what a dependency resolved to
    # rather than the key it was declared under, so this adapter has no source
    # for a pnpm alias declaration and says so rather than guessing.
    #
    # `source` is asserted alongside the list because it is what separates the
    # two readings: `unsupported` lists every parent BY DESIGN, so a definition
    # that keys the warning on a non-empty list alone raises it on 100% of pnpm
    # scoped fixes — a permanent false positive on a third of the fleet, which
    # trains the reading agent to discount the one place the npm/yarn signal
    # means something (issue #49).
    It 'names every parent whose declaration it could not read, and why'
      use_fixture pnpm-v9
      When call adapter_jq '.alias_lookup' apply_constraint lodash '>=4.17.25 <5' express koa
      The status should be success
      The output should equal '{"source":"unsupported","parents_unresolved":["express","koa"]}'
    End

    # ...and where a declaration source does exist, an empty list is the normal
    # answer, so the warning is about the parents named rather than about the
    # ecosystem.
    It 'resolves every parent where a declaration source exists'
      use_fixture npm-alias
      When call adapter_jq '.alias_lookup' apply_constraint lodash '>=4.18.2 <5' alias-parent
      The status should be success
      The output should equal '{"source":"lockfile","parents_unresolved":[]}'
    End

    definition() { grep -c "$1" "$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"; }

    It 'has a definition that treats source unsupported as a known limit, not a warning'
      When call definition 'source: "unsupported"` (pnpm)'
      The status should be success
      The output should equal '1'
    End

    It 'has a definition that keeps the warning for a lockfile-backed source'
      When call definition 'source: "lockfile"` (npm, Yarn Berry) with a non-empty'
      The status should be success
      The output should equal '1'
    End

    # Berry, through the peer-declared parent the reader could not see until
    # issue #49: `why` names it, and the scoped entry lands under it.
    It 'scopes to a Yarn Berry parent that declares the package as a peer'
      use_fixture yarn-berry-peer-parent
      When call adapter_jq '.written' apply_constraint 'sha.js' '>=2.4.12 <3' serve-static
      The status should be success
      The output should equal '[{"parent":"serve-static","path":["resolutions","serve-static/sha.js"],"value":">=2.4.12 <3"}]'
    End

    # A real package whose name is another entry's install key. The read path
    # merges the two toward `inconclusive`, which is fail-safe; the WRITE path
    # is not — retargeting the colliding declaration produces
    # `npm:underscore@^4.17.21`, a version of underscore that does not exist,
    # while the lodash copy the caller meant goes unmoved. Pre-existing and not
    # fixable in the adapter (neither sense of the name is knowable here), so
    # `written[]` has to surface it and the definition has to stop on it
    # (issue #49).
    It 'writes an npm: value naming a different package when the name collides'
      use_fixture npm-dual-name
      When call adapter_jq '[.written[] | select(.value | startswith("npm:")) | .value]' \
        apply_constraint lodash '>=4.17.21 <5'
      The status should be success
      The output should equal '["npm:underscore@^4.17.21"]'
    End

    It 'has a definition that rejects such a value rather than opening a PR on it'
      When call definition 'value that names a different package, and fail the run'
      The status should be success
      The output should equal '1'
    End

    # The root is a dependent like any other, and it declares both copies here.
    # Retargeting keeps each declaration's own form: the alias keeps its
    # protocol and the package it aliases, and a caret stays a caret.
    It 'retargets a root alias declaration without dropping the protocol'
      use_fixture npm-alias
      "$ADAPTER" apply_constraint lodash '>=4.18.2 <5' >/dev/null
      When call manifest '{plain: .dependencies.lodash, aliased: .dependencies["lodash-alias"]}'
      The output should equal '{"plain":"^4.18.2","aliased":"npm:lodash@^4.18.2"}'
    End

    # `resolved_versions` answers under the alias key too, so an agent may well
    # pass that name. It must not turn `npm:lodash@^4.18.0` into a bare range,
    # which would redirect the dependency at a package that does not exist.
    It 'keeps the protocol when the alias key itself is the named package'
      use_fixture npm-alias
      "$ADAPTER" apply_constraint lodash-alias '>=4.18.2 <5' >/dev/null
      When call manifest '.dependencies["lodash-alias"]'
      The output should equal '"npm:lodash@^4.18.2"'
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

    # An override block can carry several bare keys covering the same package
    # major line at once: a live repository pinned both `protobufjs@7` and
    # `protobufjs@8`; review of the first #104 fix added `protobufjs@^8.0.0`
    # beside `protobufjs@8`, and a plain `tar` beside `tar@6`. Any covering
    # key left untightened keeps competing with the freshly-tightened entry
    # for the same resolution, so EVERY covering key is tightened in place and
    # the whole block is read back.
    It 'tightens every qualified key on the target line, leaving other lines alone'
      use_fixture pnpm-major-qualified
      "$ADAPTER" apply_constraint --tighten-bare protobufjs '>=8.6.6 <9' >/dev/null
      When call manifest '.pnpm.overrides'
      The output should equal '{"protobufjs@7":"^7.5.5","protobufjs@8":">=8.6.6 <9","protobufjs@^8.0.0":">=8.6.6 <9","tar":"^5.0.0","tar@6":"^6.2.0"}'
    End

    It 'does not add a new plain key alongside the qualified ones'
      use_fixture pnpm-major-qualified
      "$ADAPTER" apply_constraint --tighten-bare protobufjs '>=8.6.6 <9' >/dev/null
      When call manifest '.pnpm.overrides | has("protobufjs")'
      The output should equal 'false'
    End

    It 'tightens a coexisting plain key together with its qualified sibling'
      use_fixture pnpm-major-qualified
      "$ADAPTER" apply_constraint --tighten-bare tar '>=6.2.4 <7' >/dev/null
      When call manifest '.pnpm.overrides'
      The output should equal '{"protobufjs@7":"^7.5.5","protobufjs@8":"^8.0.1","protobufjs@^8.0.0":"^8.0.0","tar":">=6.2.4 <7","tar@6":">=6.2.4 <7"}'
    End

    It 'reports every key it tightened'
      use_fixture pnpm-major-qualified
      When call adapter_jq '.written' apply_constraint --tighten-bare protobufjs '>=8.6.6 <9'
      The status should be success
      The output should equal '[{"parent":null,"path":["pnpm","overrides","protobufjs@8"],"value":">=8.6.6 <9"},{"parent":null,"path":["pnpm","overrides","protobufjs@^8.0.0"],"value":">=8.6.6 <9"}]'
    End

    # The plain-key case must stay exactly as it was: no qualified key exists
    # for lodash in pnpm-v9, so the write still lands on the plain key.
    It 'still writes the plain key when no qualified key covers the range'
      use_fixture pnpm-v9
      When call adapter_jq '.written' apply_constraint --tighten-bare lodash '>=4.17.25 <5'
      The status should be success
      The output should equal '[{"parent":null,"path":["pnpm","overrides","lodash"],"value":">=4.17.25 <5"}]'
    End

    # pnpm-v9 also carries a single major-qualified key with no sibling
    # (handlebars@4): tightening it in place must not spawn a second plain key.
    It 'tightens a lone major-qualified key (handlebars@4) in place'
      use_fixture pnpm-v9
      "$ADAPTER" apply_constraint --tighten-bare handlebars '>=4.7.10 <5' >/dev/null
      When call manifest '{qualified: .pnpm.overrides."handlebars@4", has_plain: (.pnpm.overrides | has("handlebars"))}'
      The output should equal '{"qualified":">=4.7.10 <5","has_plain":false}'
    End

    # pnpm scopes with `>`, and a `>`-bearing key pins a DIFFERENT package
    # under a parent selector: `vite@7>rollup` is rollup's pin, not vite's,
    # and `range_floor_major` still reads a floor out of the `selector>child`
    # tail (measured: `7>rollup` reads 0, `^8.0.0>lodash` reads 8). Matching
    # such keys clobbered the child's pin with the parent's range, never
    # wrote the bare key asked for, and produced a false bare-write claim
    # downstream (PR #111 review).
    Describe 'parent-scoped pnpm keys are never matched'
      It 'leaves vite@7>rollup alone and writes the plain vite key'
        use_fixture pnpm-pins
        "$ADAPTER" apply_constraint --tighten-bare vite '>=7.1.5 <8' >/dev/null
        When call manifest '.pnpm.overrides'
        The output should equal '{"@babel/core":"^7.24.0","vite@7>rollup":"^4.20.0","webpack>terser-webpack-plugin>terser":"^5.31.6","@vercel/fun>undici":">=6.19.0 <7","esbuild":"npm:esbuild-wasm@0.21.5","protobufjs@^8.0.0>lodash":"^4.17.21","vite":">=7.1.5 <8"}'
      End

      It 'reports the plain key as the only write'
        use_fixture pnpm-pins
        When call adapter_jq '.written' apply_constraint --tighten-bare vite '>=7.1.5 <8'
        The status should be success
        The output should equal '[{"parent":null,"path":["pnpm","overrides","vite"],"value":">=7.1.5 <8"}]'
      End

      It 'excludes a dotted-selector parent key (protobufjs@^8.0.0>lodash) too'
        use_fixture pnpm-pins
        "$ADAPTER" apply_constraint --tighten-bare protobufjs '>=8.6.6 <9' >/dev/null
        When call manifest '{scoped: .pnpm.overrides."protobufjs@^8.0.0>lodash", plain: .pnpm.overrides.protobufjs}'
        The output should equal '{"scoped":"^4.17.21","plain":">=8.6.6 <9"}'
      End
    End

    # Berry resolutions keys carry descriptors on bare keys too
    # (`protobufjs@^8` — PINS_JQ already strip_selectors yarn keys), and
    # scope with path segments (`lodash@^3/minimist`), so yarn takes the same
    # in-place tighten under its own bareness predicate.
    Describe 'yarn resolutions'
      It 'tightens a descriptor-qualified bare key in place'
        use_fixture yarn-major-qualified
        "$ADAPTER" apply_constraint --tighten-bare protobufjs '>=8.6.6 <9' >/dev/null
        When call manifest '.resolutions'
        The output should equal '{"protobufjs@^8":">=8.6.6 <9","protobufjs@7":"^7.5.5","lodash@^3/minimist":"^1.2.6","@grpc/grpc-js@1":"^1.8.0"}'
      End

      It 'reports the qualified key as what it wrote'
        use_fixture yarn-major-qualified
        When call adapter_jq '.written' apply_constraint --tighten-bare protobufjs '>=8.6.6 <9'
        The status should be success
        The output should equal '[{"parent":null,"path":["resolutions","protobufjs@^8"],"value":">=8.6.6 <9"}]'
      End

      It 'matches a qualified key on a scoped package name'
        use_fixture yarn-major-qualified
        "$ADAPTER" apply_constraint --tighten-bare '@grpc/grpc-js' '>=1.8.22 <2' >/dev/null
        When call manifest '{qualified: .resolutions."@grpc/grpc-js@1", has_plain: (.resolutions | has("@grpc/grpc-js"))}'
        The output should equal '{"qualified":">=1.8.22 <2","has_plain":false}'
      End

      # `lodash@^3/minimist` is minimist's pin under a path-scoped parent, so
      # a minimist tighten must not touch it.
      It 'never matches a path-scoped key, writing the plain key instead'
        use_fixture yarn-major-qualified
        "$ADAPTER" apply_constraint --tighten-bare minimist '>=1.2.8 <2' >/dev/null
        When call manifest '{scoped: .resolutions."lodash@^3/minimist", plain: .resolutions.minimist}'
        The output should equal '{"scoped":"^1.2.6","plain":">=1.2.8 <2"}'
      End

      It 'still writes the plain key when nothing covers the package'
        use_fixture yarn-major-qualified
        When call adapter_jq '.written' apply_constraint --tighten-bare left-pad '>=1.3.1 <2'
        The status should be success
        The output should equal '[{"parent":null,"path":["resolutions","left-pad"],"value":">=1.3.1 <2"}]'
      End
    End

    # npm accepts the same `pkg@selector` shape as a top-level string-valued
    # override key; nested object values stay out of reach of the match.
    Describe 'npm overrides'
      It 'tightens the qualified key on the target line only'
        use_fixture npm-major-qualified
        "$ADAPTER" apply_constraint --tighten-bare minimist '>=1.2.8 <2' >/dev/null
        When call manifest '.overrides'
        The output should equal '{"minimist@1":">=1.2.8 <2","minimist@0":"^0.2.4","glob":{"minimatch":"^9.0.5"}}'
      End

      It 'reports the qualified key as what it wrote'
        use_fixture npm-major-qualified
        When call adapter_jq '.written' apply_constraint --tighten-bare minimist '>=1.2.8 <2'
        The status should be success
        The output should equal '[{"parent":null,"path":["overrides","minimist@1"],"value":">=1.2.8 <2"}]'
      End

      It 'still writes the plain key when nothing covers the package'
        use_fixture npm-major-qualified
        "$ADAPTER" apply_constraint --tighten-bare lodash '>=4.17.21 <5' >/dev/null
        When call manifest '.overrides'
        The output should equal '{"minimist@1":"^1.2.5","minimist@0":"^0.2.4","glob":{"minimatch":"^9.0.5"},"lodash":">=4.17.21 <5"}'
      End
    End

    # The selector grammar the match must read, row by row: a floor major has
    # to be readable from the selector and equal the target's; anything else
    # falls through to the plain key. npm is the venue because its keys are
    # never `>`-scoped, so even a spaced comparator selector stays bare.
    Describe 'selector shapes'
      seed() { jq --arg k "$1" --arg v "$2" '.overrides = {($k): $v}' package.json > pkg.tmp && mv pkg.tmp package.json; }

      Parameters
        'bare major'   'protobufjs@8'      '^8.0.0' 'protobufjs'    '>=8.6.6 <9'  '{"protobufjs@8":">=8.6.6 <9"}'
        'caret'        'protobufjs@^8.0.1' '^8.0.1' 'protobufjs'    '>=8.6.6 <9'  '{"protobufjs@^8.0.1":">=8.6.6 <9"}'
        'spaced range' 'protobufjs@>=8 <9' '>=8 <9' 'protobufjs'    '>=8.6.6 <9'  '{"protobufjs@>=8 <9":">=8.6.6 <9"}'
        'dist-tag'     'protobufjs@beta'   'beta'   'protobufjs'    '>=8.6.6 <9'  '{"protobufjs@beta":"beta","protobufjs":">=8.6.6 <9"}'
        'scoped name'  '@grpc/grpc-js@1'   '^1.7.0' '@grpc/grpc-js' '>=1.8.22 <2' '{"@grpc/grpc-js@1":">=1.8.22 <2"}'
      End

      It "handles a $1 selector"
        use_fixture npm-major-qualified
        seed "$2" "$3"
        "$ADAPTER" apply_constraint --tighten-bare "$4" "$5" >/dev/null
        When call manifest '.overrides'
        The output should equal "$6"
      End
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
