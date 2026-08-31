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
  # the lockfile's snapshots. npm gets its own qualification (next block,
  # issue #132); yarn `a/b` resolutions stay bare, because a
  # version-qualified yarn key silently never matches.
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

    # The issue #160 end shape: dompurify's only parent reaches it through
    # `optionalDependencies:`, an edge the dependencies-only walk discarded,
    # so `why`/`declared_ranges` answered zero parents and the field agent
    # had to read the lockfile by hand to name jspdf. This case pins only
    # the written key's shape — the parent arrives as an argument, and a
    # single-version parent gets a bare key whether or not the optional
    # edge was read; the discriminating assertion is the qualified case
    # below (and the `why`/`declared_ranges` specs).
    It 'scopes to a parent that reaches the package only through optionalDependencies'
      use_fixture pnpm-optional-parent
      When call adapter_jq '.written' apply_constraint dompurify '>=3.4.13 <4' jspdf
      The status should be success
      The output should equal '[{"parent":"jspdf","path":["pnpm","overrides","jspdf>dompurify"],"value":">=3.4.13 <4"}]'
    End

    # The discriminating write: jspdf resolved at two majors, each copy
    # resolving its own major of dompurify, with EVERY parent->child edge
    # inside `optionalDependencies:`. Version qualification reads those
    # edges through the same walk the dependencies-only filter starved, so
    # on the unfixed code the copy rows are empty, qualification falls back
    # to the bare `jspdf>dompurify` key, and the bare key collapses the
    # 2.x sibling line onto the 3.x range — the exact issue #100 hazard the
    # qualifiers exist for. This spec fails on that code for that reason.
    It 'version-qualifies a multi-major parent whose every edge is optional'
      use_fixture pnpm-optional-qualified
      When call adapter_jq '.written' apply_constraint dompurify '>=3.4.13 <4' jspdf
      The status should be success
      The output should equal '[{"parent":"jspdf","path":["pnpm","overrides","jspdf@4.2.1>dompurify"],"value":">=3.4.13 <4"}]'
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

    # The multiplicity gate reads the snapshots edges, not the `packages:`
    # section: with `packages:` unreadable the old `pnpm_rows` gate saw zero
    # versions, skipped qualification, and failed OPEN into the bare
    # collapse-causing key. The edges already prove the parent resolves at
    # more than one version.
    It 'still writes qualified keys when the packages section is unreadable'
      use_fixture pnpm-cross-line
      awk '/^packages:/ {skip = 1; next} /^[a-zA-Z]/ {skip = 0} !skip' \
        pnpm-lock.yaml > lock.tmp && mv lock.tmp pnpm-lock.yaml
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call manifest '[.pnpm.overrides | keys[]] | sort'
      The output should equal '["minimatch@10.0.3>brace-expansion","minimatch@10.2.5>brace-expansion"]'
    End

    # Zero qualifying versions falls back to the bare key, never to writing
    # NOTHING: an unqualified entry over-covers, a missing one leaves every
    # copy vulnerable. No minimatch copy resolves a 9.x brace-expansion.
    It 'falls back to the bare key when no parent version qualifies'
      use_fixture pnpm-cross-line
      "$ADAPTER" apply_constraint brace-expansion '>=9.0.0 <10' minimatch >/dev/null
      When call manifest '[.pnpm.overrides | keys[]]'
      The output should equal '["minimatch>brace-expansion"]'
    End

    # A child resolution no major can be read from — here the codeload
    # tarball URL pnpm records for a git dependency — KEEPS its parent
    # version in the qualified set: covering a copy twice is harmless,
    # silently skipping one is not.
    It 'keeps a parent version whose child resolution has no readable major'
      use_fixture pnpm-peer-variant
      "$ADAPTER" apply_constraint minimist '>=0.0.9 <0.1' optimist >/dev/null
      When call manifest '[.pnpm.overrides | keys[]] | sort'
      The output should equal '["optimist@0.5.2>minimist","optimist@0.6.1>minimist"]'
    End
  End

  # The same collapse in npm's nested syntax (issue #132): a bare
  # `.overrides.minimatch["brace-expansion"]` applies to EVERY resolved copy
  # of minimatch, so on the field run all three brace-expansion groups
  # (1.x/2.x/5.x, majors shared under minimatch copies at two majors) failed
  # closed at validate with fatal vanished lines, and js-yaml 4.x shipped a
  # silent cross-major drag of the 3.x consumers. npm matches a
  # `parent@<sel>` key with semver.intersects against each edge's declared
  # descriptor plus semver.satisfies on the resolved copy, and hard-fails
  # the install (EOVERRIDE) on a selector that intersects a direct
  # dependency's spec without being byte-identical to it; both verified
  # empirically on npm 11.16.0. So the qualifier is the copy's exact
  # resolved version, except that copies satisfying the root manifest's own
  # declared spec share one key carrying that spec verbatim.
  Describe 'npm parent keys are version-qualified across major lines'
    It 'writes one qualified key per parent copy, root spec verbatim for the direct dependency'
      use_fixture npm-cross-line
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call manifest '[.overrides | keys[]] | sort'
      The output should equal '["minimatch@10.0.3","minimatch@^10.2.5"]'
    End

    It 'reports the qualified keys it wrote'
      use_fixture npm-cross-line
      When call adapter_jq '.written' apply_constraint brace-expansion '>=5.0.9 <6' minimatch
      The status should be success
      The output should equal '[{"parent":"minimatch","path":["overrides","minimatch@^10.2.5","brace-expansion"],"value":">=5.0.9 <6"},{"parent":"minimatch","path":["overrides","minimatch@10.0.3","brace-expansion"],"value":">=5.0.9 <6"}]'
    End

    # The 1.x line has exactly one parent copy, off the root spec, so the fix
    # scoped there is one exact-version key and the 2.x and 5.x resolutions
    # go unnamed.
    It 'covers a different target line with that line parent copy only'
      use_fixture npm-cross-line
      "$ADAPTER" apply_constraint brace-expansion '>=1.1.12 <2' minimatch >/dev/null
      When call manifest '.overrides'
      The output should equal '{"minimatch@3.1.5":{"brace-expansion":">=1.1.12 <2"}}'
    End

    # A single-version parent keeps today's bare nested key: nothing else
    # exists for the key to leak onto, and qualifying it would churn every
    # existing PR shape for no safety gain.
    It 'keeps the bare nested key for a parent resolved at a single version'
      use_fixture npm-cross-line
      "$ADAPTER" apply_constraint minimatch '>=5.1.6 <6' filelist >/dev/null
      When call manifest '.overrides'
      The output should equal '{"filelist":{"minimatch":">=5.1.6 <6"}}'
    End

    # The chain to the verdict: this override state is exactly the
    # npm-cross-line-qualified specimen, whose post-install lockfile keeps
    # the sibling lines and passes `validate --baseline` with
    # `other_line_moves: []`, while the bare key the verb used to write is
    # the npm-cross-line-collapsed specimen validate fails closed on
    # (spec/node_validate_spec.sh).
    overrides_matching_npm_specimen() {
      _mine=$(jq -cS '.overrides' package.json)
      _specimen=$(jq -cS '.overrides' \
        "$FIXTURES/npm-cross-line-qualified/package.json")
      [ "$_mine" = "$_specimen" ] && printf '%s' "$_mine"
    }

    It 'writes the same override state the intact post-install specimen carries'
      use_fixture npm-cross-line
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call overrides_matching_npm_specimen
      The status should be success
      The output should equal '{"minimatch@10.0.3":{"brace-expansion":">=5.0.9 <6"},"minimatch@^10.2.5":{"brace-expansion":">=5.0.9 <6"}}'
    End

    # Zero qualifying copies falls back to the bare key, never to writing
    # NOTHING: an unqualified entry over-covers, a missing one leaves every
    # copy vulnerable. No minimatch copy resolves a 9.x brace-expansion.
    It 'falls back to the bare nested key when no parent copy qualifies'
      use_fixture npm-cross-line
      "$ADAPTER" apply_constraint brace-expansion '>=9.0.0 <10' minimatch >/dev/null
      When call manifest '.overrides'
      The output should equal '{"minimatch":{"brace-expansion":">=9.0.0 <10"}}'
    End

    # npm has one source for the multiplicity proof, the lockfile's
    # `packages` object; without it nothing proves a second copy exists, so
    # the verb keeps the documented over-cover fallback (the bare key) and
    # `validate --baseline` stays the net that fails a collapse closed. The
    # same missing object makes the stale-entry pass report itself unable to
    # judge the lockfile rather than claiming the override effective.
    It 'falls back to the bare nested key when the lockfile has no packages object'
      use_fixture npm-cross-line
      jq 'del(.packages)' package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call manifest '.overrides'
      The output should equal '{"minimatch":{"brace-expansion":">=5.0.9 <6"}}'
    End

    # Qualified keys narrow which parent copies the override reaches, never
    # which child line it targets, so the issue #124 stale-entry pass still
    # deletes exactly the target-line copies that fail the range (here the
    # hoisted 5.0.5) and nothing on the sibling lines.
    It 'still invalidates exactly the stale target-line lockfile entries'
      use_fixture npm-cross-line
      When call adapter_jq '.lockfile_invalidated' apply_constraint brace-expansion '>=5.0.9 <6' minimatch
      The status should be success
      The output should equal '{"performed":true,"keys":["node_modules/brace-expansion"]}'
    End

    # The EOVERRIDE carve-out reads the root spec from every dependency
    # block, not just `dependencies`: a dev-declared parent is a direct
    # dependency to npm's conflict check all the same, and missing it here
    # writes an exact key the install rejects.
    It 'reads the root spec from devDependencies too'
      use_fixture npm-cross-line
      jq '.devDependencies = {minimatch: .dependencies.minimatch}
          | del(.dependencies.minimatch)' package.json > p.tmp && mv p.tmp package.json
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call manifest '[.overrides | keys[]] | sort'
      The output should equal '["minimatch@10.0.3","minimatch@^10.2.5"]'
    End

    # A root spec that ALSO admits an off-line parent copy (`>=3.0.0` admits
    # the 3.1.5 copy whose child is on the 1.x line) is the collapse shape
    # no key can express: the only key npm allows beside the direct dep is
    # the byte-identical spec, and that key drags the off-line copies. The
    # call refuses before writing anything, so the agent fails closed at
    # apply with no install burned.
    refused_shape() {
      _st=0
      _err=$("$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch \
        2>&1 >/dev/null) || _st=$?
      printf 'st=%s named=%s overrides=%s\n' "$_st" \
        "$(printf '%s' "$_err" | grep -c 'copies on other major lines')" \
        "$(jq -c '.overrides // "absent"' package.json)"
    }

    It 'refuses a root spec that also admits an off-line parent copy, writing nothing'
      use_fixture npm-cross-line
      jq '.dependencies.minimatch = ">=3.0.0"' package.json > p.tmp && mv p.tmp package.json
      When call refused_shape
      The status should be success
      The output should equal 'st=1 named=1 overrides="absent"'
    End

    # A root spec the range readers cannot judge (a dist-tag here; file:,
    # tarball and workspace: specs behave the same) must never produce exact
    # keys: npm accepts an override for such specs unconditionally at the
    # edge and then throws EOVERRIDE on the exact-version key at install
    # (reproduced on npm 11.16.0). The bare key is the EOVERRIDE-clean
    # fallback, and validate stays the net behind it.
    It 'falls back to the bare nested key when the root spec is a dist-tag'
      use_fixture npm-cross-line
      jq '.dependencies.minimatch = "latest"' package.json > p.tmp && mv p.tmp package.json
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call manifest '.overrides'
      The output should equal '{"minimatch":{"brace-expansion":">=5.0.9 <6"}}'
    End

    # A parent copy whose own lockfile version is unreadable is a copy no
    # qualifier can cover; dropping it from the set under-covers, so the
    # parent falls back to the bare key instead. The branch is shared with
    # pnpm, which gets the same fix.
    It 'falls back to the bare nested key when a parent copy has no readable version'
      use_fixture npm-cross-line
      jq 'del(.packages["node_modules/@ts-morph/common/node_modules/minimatch"].version)' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call manifest '.overrides'
      The output should equal '{"minimatch":{"brace-expansion":">=5.0.9 <6"}}'
    End

    # node-semver excludes prereleases from plain ranges where the in-repo
    # satisfies admits them; counting such a copy covered by the root spec
    # writes no key for it at all, a silent under-cover. It takes its own
    # exact key instead, which npm's prerelease rules keep off the direct
    # dep's edge.
    It 'gives a prerelease copy its own exact key rather than counting it covered'
      use_fixture npm-cross-line
      jq '.packages["node_modules/minimatch"].version = "10.3.0-beta.1"' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call manifest '[.overrides | keys[]] | sort'
      The output should equal '["minimatch@10.0.3","minimatch@10.3.0-beta.1"]'
    End

    # A lockfile version that is not plain semver cannot become a key
    # selector: semver.intersects throws on it at install time. Bare
    # fallback, same as every other unjudgeable copy.
    It 'falls back to the bare nested key when a parent copy version is not plain semver'
      use_fixture npm-cross-line
      jq '.packages["node_modules/@ts-morph/common/node_modules/minimatch"].version = "10.x-bogus"' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call manifest '.overrides'
      The output should equal '{"minimatch":{"brace-expansion":">=5.0.9 <6"}}'
    End

    # A pre-existing bare nested key for the same (parent, child) pair on
    # THIS line sits first in npm's OverrideSet and wins getEdgeRule for
    # every edge, leaving the qualified keys inert; it is superseded, the
    # removal reported. The resulting override state is byte-identical to
    # the qualified specimen.
    It 'supersedes a same-line bare nested key and reports it'
      use_fixture npm-cross-line
      jq '.overrides = {minimatch: {"brace-expansion": ">=5.0.6 <6"}}' \
        package.json > p.tmp && mv p.tmp package.json
      When call adapter_jq '{superseded: .superseded_keys, keys: [.written[].path[1]]}' \
        apply_constraint brace-expansion '>=5.0.9 <6' minimatch
      The status should be success
      The output should equal '{"superseded":[{"parent":"minimatch","path":["overrides","minimatch","brace-expansion"],"value":">=5.0.6 <6"}],"keys":["minimatch@^10.2.5","minimatch@10.0.3"]}'
    End

    It 'leaves no bare pair behind after superseding it'
      use_fixture npm-cross-line
      jq '.overrides = {minimatch: {"brace-expansion": ">=5.0.6 <6"}}' \
        package.json > p.tmp && mv p.tmp package.json
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
      When call overrides_matching_npm_specimen
      The status should be success
      The output should equal '{"minimatch@10.0.3":{"brace-expansion":">=5.0.9 <6"},"minimatch@^10.2.5":{"brace-expansion":">=5.0.9 <6"}}'
    End

    # The same bare pair pinning a DIFFERENT line is a previous fix this
    # call must not delete and cannot coexist with: refusal, nothing
    # written, human reconciliation.
    conflicting_bare() {
      _st=0
      _err=$("$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch \
        2>&1 >/dev/null) || _st=$?
      printf 'st=%s named=%s overrides=%s\n' "$_st" \
        "$(printf '%s' "$_err" | grep -c 'reconcile the existing override by hand')" \
        "$(jq -c '.overrides' package.json)"
    }

    It 'refuses to write beside a bare pair that pins a different line'
      use_fixture npm-cross-line
      jq '.overrides = {minimatch: {"brace-expansion": ">=1.1.18 <2"}}' \
        package.json > p.tmp && mv p.tmp package.json
      When call conflicting_bare
      The status should be success
      The output should equal 'st=1 named=1 overrides={"minimatch":{"brace-expansion":">=1.1.18 <2"}}'
    End

    # A scoped parent name qualifies the same way: the key is the whole
    # scoped name plus the copy's version after a second `@`.
    It 'qualifies a scoped parent resolved at several versions'
      use_fixture npm-scoped-cross-line
      When call adapter_jq '{written: [.written[].path]}' \
        apply_constraint minimatch '>=10.0.5 <11' '@npmcli/map-workspaces'
      The status should be success
      The output should equal '{"written":[["overrides","@npmcli/map-workspaces@4.0.2","minimatch"]]}'
    End
  End

  # A parent placed in the tree by a pre-existing override rule (issue #147):
  # the root manifest already carries `{"lerna": {"nx": "<range>"}}` and the
  # vulnerable package resolves under nx. npm scopes the nx node to the rule
  # that placed it — once an edge matches a rule, descendants consult only
  # that rule's children — so a sibling top-level `"nx": {...}` key never
  # matches it and the constraint silently never takes effect (field-verified
  # across three clean reinstalls). The working form, hand-built on the field
  # run and adopted here, nests inside the existing rule with the `"."` self
  # key carrying the parent's own range. The fixture is modeled structurally
  # on that field shape with public package names.
  Describe 'npm constraint nests inside a pre-existing override that places the parent'
    It 'nests inside the placing rule, "." carrying the parent range'
      use_fixture npm-override-placed-parent
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx >/dev/null
      When call manifest '.overrides.lerna.nx'
      The output should equal '{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"}'
    End

    # Placement is judged per parent copy against the lockfile's logical
    # ancestry (the placing rule's chain must actually reach the copy), and
    # here every copy is placed, so no top-level key is written — one would
    # match nothing. A parent with BOTH placed and normally-resolved copies
    # gets both shapes (see the grounding Describe below). Sibling entries
    # at every level survive the merge.
    It 'writes no top-level key for the placed parent and preserves every sibling'
      use_fixture npm-override-placed-parent
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx >/dev/null
      When call manifest '.overrides'
      The output should equal '{"lerna":{"nx":{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"},"chalk":"^6.0.0"},"glob":"^13.0.0"}'
    End

    # Both writes the manifest diff shows land in written[]: the "." coercion
    # carrying the parent's pre-existing range, and the new child key, each
    # with its real nested path. The "." entry carries `preserved: true`: it
    # quotes a value the restructure kept, not one this call chose, so the
    # agent's written[]-value checks (the npm: alias abort among them) can
    # exempt it.
    It 'reports the "." coercion, marked preserved, and the nested key it wrote'
      use_fixture npm-override-placed-parent
      When call adapter_jq '.written' apply_constraint brace-expansion '>=5.0.9 <6' nx
      The status should be success
      The output should equal '[{"parent":"nx","path":["overrides","lerna","nx","."],"value":">=22.7.7 <23","preserved":true},{"parent":"nx","path":["overrides","lerna","nx","brace-expansion"],"value":">=5.0.9 <6"}]'
    End

    # An already-object rule keeps its "." and its siblings and only gains
    # the child key; no "." coercion is reported because none was made.
    object_rule() {
      _out=$("$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx)
      printf 'rule=%s written=%s\n' \
        "$(jq -c '.overrides.lerna.nx' package.json)" \
        "$(printf '%s' "$_out" | jq -c '[.written[].path]')"
    }

    It 'adds to an already-object rule, keeping its "." and siblings'
      use_fixture npm-override-placed-parent
      jq '.overrides.lerna.nx = {".": ">=22.7.7 <23", "minimist": "^1.2.8"}' \
        package.json > p.tmp && mv p.tmp package.json
      When call object_rule
      The status should be success
      The output should equal 'rule={".":">=22.7.7 <23","minimist":"^1.2.8","brace-expansion":">=5.0.9 <6"} written=[["overrides","lerna","nx","brace-expansion"]]'
    End

    # Reader/writer round-trip: list_pins reads the written shape back — the
    # "." entry as the parent's own pin under its placing rule, and the child
    # entry with the full parent chain.
    roundtrip_pins() {
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx >/dev/null
      "$ADAPTER" list_pins | jq -c '[.pins[] | {package, parents, range}]'
    }

    It 'round-trips through list_pins with the real nested paths'
      use_fixture npm-override-placed-parent
      When call roundtrip_pins
      The status should be success
      The output should equal '[{"package":"nx","parents":["lerna"],"range":">=22.7.7 <23"},{"package":"brace-expansion","parents":["lerna","nx"],"range":">=5.0.9 <6"},{"package":"chalk","parents":["lerna"],"range":"^6.0.0"},{"package":"glob","parents":[],"range":"^13.0.0"}]'
    End

    # Nesting changes which parent copies the override reaches, never which
    # child line it targets, so the issue #124 stale-entry pass still deletes
    # exactly the target-line copy that fails the range.
    It 'still invalidates the stale target-line lockfile entry'
      use_fixture npm-override-placed-parent
      When call adapter_jq '.lockfile_invalidated' apply_constraint brace-expansion '>=5.0.9 <6' nx
      The status should be success
      The output should equal '{"performed":true,"keys":["node_modules/brace-expansion"]}'
    End

    # A parent whose only appearance is a TOP-LEVEL key is not placed: that
    # is the ordinary merge, and the depth guard keeps it on today's path.
    It 'treats a top-level rule for the parent as the ordinary merge, not placement'
      use_fixture npm-override-placed-parent
      jq '.overrides = {nx: {minimist: "^1.2.8"}}' package.json > p.tmp && mv p.tmp package.json
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx >/dev/null
      When call manifest '.overrides'
      The output should equal '{"nx":{"minimist":"^1.2.8","brace-expansion":">=5.0.9 <6"}}'
    End

    # The issue #132 interaction, grounded (#153 review): a second nx major
    # line resolving OUTSIDE the placing rule is not the placing rule's
    # problem. The placed on-line copy takes the nested write; the off-line
    # copy belongs to a sibling group and gets nothing — its qualifier is
    # dropped rather than written as a top-level key no placed copy matches,
    # and the old blanket placed-and-multi-major refusal does not fire.
    seed_second_nx_line() {
      jq '.packages["node_modules/foo"] =
            {version: "1.0.0", dependencies: {nx: "^21.0.0"}}
          | .packages["node_modules/foo/node_modules/nx"] =
            {version: "21.5.0", dependencies: {"brace-expansion": "^1.1.7"}}
          | .packages["node_modules/foo/node_modules/brace-expansion"] =
            {version: "1.1.12"}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
    }

    second_line_outside_rule() {
      _out=$("$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx)
      printf 'overrides=%s invalidated=%s\n' \
        "$(jq -c '.overrides' package.json)" \
        "$(printf '%s' "$_out" | jq -c '.lockfile_invalidated.keys')"
    }

    It 'nests without refusing when a second major line resolves outside the placing rule'
      use_fixture npm-override-placed-parent
      seed_second_nx_line
      When call second_line_outside_rule
      The status should be success
      The output should equal 'overrides={"lerna":{"nx":{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"},"chalk":"^6.0.0"},"glob":"^13.0.0"} invalidated=["node_modules/brace-expansion"]'
    End
  End

  # Placement is corroborated against the lockfile's logical ancestry, never
  # against key spelling alone (#153 review, both reproduced regressions): a
  # rule whose chain reaches no copy of the parent places nothing, and
  # treating it as placing withheld the working top-level key for an inert
  # nested one — written[] reporting success over a dead fix.
  Describe 'npm placement detection is grounded in the lockfile'
    After 'cleanup_fixture'

    set_rule() {
      jq --argjson r "$1" '.overrides = $r' package.json > p.tmp \
        && mv p.tmp package.json
    }

    ungrounded_write() {
      set_rule "$1"
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx >/dev/null
      jq -c '.overrides' package.json
    }

    Parameters
      # why the rule places nothing        the rule that spells nx as a child key
      'rule root absent from the lockfile' '{"unrelated-pkg":{"nx":"^22"}}'
      'nx never resolves under the root'   '{"chalk":{"nx":"^22"}}'
    End

    It "writes the ordinary top-level key when the rule matches no copy ($1)"
      use_fixture npm-override-placed-parent
      When call ungrounded_write "$2"
      The status should be success
      The output should equal "$(printf '%s' "$2" | jq -c '. + {nx: {"brace-expansion": ">=5.0.9 <6"}}')"
    End

    # The second reproduced regression: the same uncorroborated rule beside a
    # second nx major line. The blanket refusal killed the issue #132
    # qualified-key path that worked on base; grounded detection leaves it be.
    seed_second_nx_line() {
      jq '.packages["node_modules/foo"] =
            {version: "1.0.0", dependencies: {nx: "^21.0.0"}}
          | .packages["node_modules/foo/node_modules/nx"] =
            {version: "21.5.0", dependencies: {"brace-expansion": "^1.1.7"}}
          | .packages["node_modules/foo/node_modules/brace-expansion"] =
            {version: "1.1.12"}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
    }

    It 'keeps the qualified-key path working beside an uncorroborated rule'
      use_fixture npm-override-placed-parent
      set_rule '{"unrelated-pkg":{"nx":"^22"}}'
      seed_second_nx_line
      When call ungrounded_write '{"unrelated-pkg":{"nx":"^22"}}'
      The status should be success
      The output should equal '{"unrelated-pkg":{"nx":"^22"},"nx@22.7.9":{"brace-expansion":">=5.0.9 <6"}}'
    End

    # A parent with BOTH a placed copy and a normally-resolved on-line copy
    # gets both shapes: the nested write for the placed copy, the qualified
    # top-level key for the normal one — and the placed copy's own qualifier
    # is dropped rather than written as a key it would never match.
    both_shapes() {
      jq '.packages[""].dependencies.zed = "^1.0.0"
          | .packages["node_modules/zed"] =
            {version: "1.0.0", dependencies: {nx: "^22.0.0"}}
          | .packages["node_modules/zed/node_modules/nx"] =
            {version: "22.6.0", dependencies: {"brace-expansion": "^5.0.4"}}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      _out=$("$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx)
      printf 'paths=%s overrides=%s\n' \
        "$(printf '%s' "$_out" | jq -c '[.written[].path]')" \
        "$(jq -c '.overrides' package.json)"
    }

    It 'writes both shapes for a parent with placed and normally-resolved copies'
      use_fixture npm-override-placed-parent
      When call both_shapes
      The status should be success
      The output should equal 'paths=[["overrides","lerna","nx","."],["overrides","lerna","nx","brace-expansion"],["overrides","nx@22.6.0","brace-expansion"]] overrides={"lerna":{"nx":{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"},"chalk":"^6.0.0"},"glob":"^13.0.0","nx@22.6.0":{"brace-expansion":">=5.0.9 <6"}}'
    End
  End

  # The placement states no key shape serves refuse before anything is
  # written, each naming the rule path involved so the first error the
  # operator sees names the real mechanism (#153 review).
  Describe 'npm placement refusals'
    After 'cleanup_fixture'

    refusal() {
      _st=0
      _err=$("$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx \
        2>&1 >/dev/null) || _st=$?
      printf 'st=%s named=%s overrides=%s\n' "$_st" \
        "$(printf '%s' "$_err" | grep -c "$1")" \
        "$(jq -c '.overrides' package.json)"
    }

    # A rule placing the parent through an npm: alias child key: the copy
    # installs under the alias key with the real name in `.name`, so
    # name-matched detection cannot see it, and the pre-fix behavior fell
    # back silently to the known-ineffective top-level key. Writing through
    # an alias-keyed rule is unverified npm behavior, so the call refuses,
    # naming the alias rule.
    It 'refuses a rule that places the parent through an alias child key'
      use_fixture npm-override-placed-parent
      jq '.overrides = {"lerna": {"nx-tools": "npm:nx@>=22.7.7 <23"}, "glob": "^13.0.0"}' \
        package.json > p.tmp && mv p.tmp package.json
      jq 'del(.packages["node_modules/nx"])
          | .packages["node_modules/nx-tools"] =
            {name: "nx", version: "22.7.9",
             dependencies: {"brace-expansion": "^5.0.4"}}
          | .packages["node_modules/lerna"].dependencies =
            {"nx-tools": "npm:nx@22.7.7", chalk: "^6.0.0"}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      When call refusal 'overrides\.lerna\.nx-tools'
      The status should be success
      The output should equal 'st=1 named=1 overrides={"lerna":{"nx-tools":"npm:nx@>=22.7.7 <23"},"glob":"^13.0.0"}'
    End

    # A version-qualified child key as the placing rule: nesting a new entry
    # under a selector-carrying key is exactly the shape the code comments
    # call unverified, so it is refused rather than written silently.
    It 'refuses to nest under a version-qualified placing rule key'
      use_fixture npm-override-placed-parent
      jq '.overrides = {"lerna": {"nx@^22.0.0": ">=22.7.7 <23"}, "glob": "^13.0.0"}' \
        package.json > p.tmp && mv p.tmp package.json
      When call refusal 'overrides\.lerna\.nx@\^22\.0\.0'
      The status should be success
      The output should equal 'st=1 named=1 overrides={"lerna":{"nx@^22.0.0":">=22.7.7 <23"},"glob":"^13.0.0"}'
    End

    # A placing rule whose reach spans major lines of the child: a nested key
    # cannot be version-qualified, so nesting would drag the other line
    # across its major boundary. Refused, naming the rule and the majors.
    It 'refuses when the placing rule reaches parent copies on another child line'
      use_fixture npm-override-placed-parent
      jq '.packages["node_modules/lerna"].dependencies.baz = "^1.0.0"
          | .packages["node_modules/baz"] =
            {version: "1.0.0", dependencies: {nx: "^21.0.0"}}
          | .packages["node_modules/baz/node_modules/nx"] =
            {version: "21.5.0", dependencies: {"brace-expansion": "^1.1.7"}}
          | .packages["node_modules/baz/node_modules/brace-expansion"] =
            {version: "1.1.12"}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      When call refusal 'overrides\.lerna\.nx'
      The status should be success
      The output should equal 'st=1 named=1 overrides={"lerna":{"nx":">=22.7.7 <23","chalk":"^6.0.0"},"glob":"^13.0.0"}'
    End

    # A stale top-level pair for a FULLY placed parent on a DIFFERENT line:
    # the key matches nothing, but a different-line value is the
    # bare_conflict class and is not deleted on this call's own judgment —
    # and the message names the placement, not the qualified-key mechanism.
    It 'refuses a different-line dead top-level pair, naming the placement'
      use_fixture npm-override-placed-parent
      jq '.overrides.nx = {"brace-expansion": "^1.1.11"}' \
        package.json > p.tmp && mv p.tmp package.json
      When call refusal 'override-placed parent pins a DIFFERENT major line'
      The status should be success
      The output should equal 'st=1 named=1 overrides={"lerna":{"nx":">=22.7.7 <23","chalk":"^6.0.0"},"glob":"^13.0.0","nx":{"brace-expansion":"^1.1.11"}}'
    End

    # A pre-existing pin for the package INSIDE the placing rule, on a
    # different line: setpath would silently strip that line's protection,
    # so the call refuses instead.
    It 'refuses to overwrite a different-line pin inside the placing rule'
      use_fixture npm-override-placed-parent
      jq '.overrides.lerna.nx = {".": ">=22.7.7 <23", "brace-expansion": "^1.1.11"}' \
        package.json > p.tmp && mv p.tmp package.json
      When call refusal 'INSIDE the override rule'
      The status should be success
      The output should equal 'st=1 named=1 overrides={"lerna":{"nx":{".":">=22.7.7 <23","brace-expansion":"^1.1.11"},"chalk":"^6.0.0"},"glob":"^13.0.0"}'
    End
  End

  # Stale keys the placed shape supersedes, and states that compose without
  # refusing (#153 review).
  Describe 'npm placement supersession and composition'
    After 'cleanup_fixture'

    apply_report() {
      _out=$("$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx)
      printf 'superseded=%s overrides=%s\n' \
        "$(printf '%s' "$_out" | jq -c '.superseded_keys')" \
        "$(jq -c '.overrides' package.json)"
    }

    # A re-run on a repo where the pre-fix flow already wrote the
    # ineffective top-level pair: the corpse is deleted and reported, not
    # silently kept beside the nested write.
    It 'supersedes the dead same-line top-level pair a pre-fix run left'
      use_fixture npm-override-placed-parent
      jq '.overrides.nx = {"brace-expansion": ">=5.0.9 <6"}' \
        package.json > p.tmp && mv p.tmp package.json
      When call apply_report
      The status should be success
      The output should equal 'superseded=[{"parent":"nx","path":["overrides","nx","brace-expansion"],"value":">=5.0.9 <6"}] overrides={"lerna":{"nx":{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"},"chalk":"^6.0.0"},"glob":"^13.0.0"}'
    End

    # A same-line pin already inside the placing rule is superseded and
    # reported, never silently replaced by setpath.
    It 'supersedes a same-line pin inside the placing rule'
      use_fixture npm-override-placed-parent
      jq '.overrides.lerna.nx = {".": ">=22.7.7 <23", "brace-expansion": "^5.0.4"}' \
        package.json > p.tmp && mv p.tmp package.json
      When call apply_report
      The status should be success
      The output should equal 'superseded=[{"parent":"nx","path":["overrides","lerna","nx","brace-expansion"],"value":"^5.0.4"}] overrides={"lerna":{"nx":{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"},"chalk":"^6.0.0"},"glob":"^13.0.0"}'
    End

    # The placed + multi-major + stale-key pile-up (#153 review, R5): the
    # top-level pair protects a normally-resolved OFF-line copy, so the
    # right outcome is composition, not a refusal naming the wrong
    # mechanism — the placed copy takes the nested write and the pair stays,
    # still covering the line it pins.
    It 'nests and keeps a top-level pair that still protects a normal off-line copy'
      use_fixture npm-override-placed-parent
      jq '.overrides.nx = {"brace-expansion": "^1.1.11"}' \
        package.json > p.tmp && mv p.tmp package.json
      jq '.packages["node_modules/foo"] =
            {version: "1.0.0", dependencies: {nx: "^21.0.0"}}
          | .packages["node_modules/foo/node_modules/nx"] =
            {version: "21.5.0", dependencies: {"brace-expansion": "^1.1.7"}}
          | .packages["node_modules/foo/node_modules/brace-expansion"] =
            {version: "1.1.12"}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      When call apply_report
      The status should be success
      The output should equal 'superseded=[] overrides={"lerna":{"nx":{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"},"chalk":"^6.0.0"},"glob":"^13.0.0","nx":{"brace-expansion":"^1.1.11"}}'
    End

    # A pre-existing alias (or reference) rule value survives the "."
    # coercion verbatim and is marked preserved: without the mark, an npm:
    # value naming the parent rather than the passed package trips the
    # agent's mandatory written[]-alias abort and kills a correct fix.
    It 'marks a preserved alias value under "." rather than reporting it as a new write'
      use_fixture npm-override-placed-parent
      jq '.overrides.lerna.nx = "npm:nx@22.7.7"' package.json > p.tmp \
        && mv p.tmp package.json
      When call adapter_jq '.written' apply_constraint brace-expansion '>=5.0.9 <6' nx
      The status should be success
      The output should equal '[{"parent":"nx","path":["overrides","lerna","nx","."],"value":"npm:nx@22.7.7","preserved":true},{"parent":"nx","path":["overrides","lerna","nx","brace-expansion"],"value":">=5.0.9 <6"}]'
    End
  End

  # Rule shapes the corroboration must follow: several rules placing one
  # parent, depth beyond two, and a scoped package as the placed parent
  # (#153 review coverage asks).
  Describe 'npm placement rule shapes'
    After 'cleanup_fixture'

    shape_report() {
      _out=$("$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' "$1")
      printf 'paths=%s overrides=%s\n' \
        "$(printf '%s' "$_out" | jq -c '[.written[].path]')" \
        "$(jq -c '.overrides' package.json)"
    }

    It 'nests inside every rule when two rules place the same parent'
      use_fixture npm-override-placed-parent
      jq '.overrides = {"lerna": {nx: ">=22.7.7 <23"}, "top": {nx: ">=22.7.7 <23"}}' \
        package.json > p.tmp && mv p.tmp package.json
      jq '.packages[""].dependencies.top = "^1.0.0"
          | .packages["node_modules/top"] =
            {version: "1.0.0", dependencies: {nx: "^22.0.0"}}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      When call shape_report nx
      The status should be success
      The output should equal 'paths=[["overrides","lerna","nx","."],["overrides","lerna","nx","brace-expansion"],["overrides","top","nx","."],["overrides","top","nx","brace-expansion"]] overrides={"lerna":{"nx":{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"}},"top":{"nx":{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"}}}'
    End

    # Rule nesting is transitive, so a depth-3 rule corroborates through the
    # shared hoisted copy and the write nests at the full path.
    It 'nests at the full path of a depth-3 placing rule'
      use_fixture npm-override-placed-parent
      jq '.overrides = {"top": {"lerna": {nx: ">=22.7.7 <23"}}}' \
        package.json > p.tmp && mv p.tmp package.json
      jq '.packages[""].dependencies.top = "^1.0.0"
          | .packages["node_modules/top"] =
            {version: "1.0.0", dependencies: {lerna: "^9.0.0"}}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      When call shape_report nx
      The status should be success
      The output should equal 'paths=[["overrides","top","lerna","nx","."],["overrides","top","lerna","nx","brace-expansion"]] overrides={"top":{"lerna":{"nx":{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"}}}}'
    End

    # A scoped package as the placed parent: the key, the lockfile path
    # segment (two segments, `@scope/name`), and the selector strip must all
    # agree on the name.
    It 'places a scoped package parent'
      use_fixture npm-override-placed-parent
      jq '.overrides = {"lerna": {"@nx/devkit": ">=17.0.0 <18"}}' \
        package.json > p.tmp && mv p.tmp package.json
      jq '.packages["node_modules/lerna"].dependencies =
            {"@nx/devkit": "^17.0.0", chalk: "^6.0.0"}
          | del(.packages["node_modules/nx"])
          | .packages["node_modules/@nx/devkit"] =
            {version: "17.2.0", dependencies: {"brace-expansion": "^5.0.4"}}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      When call shape_report '@nx/devkit'
      The status should be success
      The output should equal 'paths=[["overrides","lerna","@nx/devkit","."],["overrides","lerna","@nx/devkit","brace-expansion"]] overrides={"lerna":{"@nx/devkit":{".":">=17.0.0 <18","brace-expansion":">=5.0.9 <6"}}}'
    End
  End

  # Corroboration is selector-aware on every rule segment (#153 review
  # round 2, both shapes reproduced). Selector-blind matching re-opened the
  # hijack through the version dimension: `{"lerna@^8.0.0": {"nx": ...}}`
  # with lerna resolved at 9.0.1 is a dead rule that places nothing, yet it
  # corroborated by name, the constraint nested inside it, and written[]
  # reported success while the working top-level key the base branch wrote
  # was withheld. The child key's own selector decides candidacy the same
  # way: `nx@^21.0.0` with nx resolved at 22.7.9 places nothing, and
  # treating it as a candidate raised a spurious qualified_rule refusal
  # that blocked a fix working on base. Every segment is judged with the
  # same `satisfies` the qualifier machinery uses.
  Describe 'npm placement corroboration respects rule selectors'
    After 'cleanup_fixture'

    selector_write() {
      jq --argjson r "$1" '.overrides = $r' package.json > p.tmp \
        && mv p.tmp package.json
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx >/dev/null
      jq -c '.overrides' package.json
    }

    # lerna resolves at 9.0.1 in the fixture, so ^8.0.0 cannot match the
    # installed chain: the rule is dead, does not corroborate, and the
    # ordinary top-level write serves the parent.
    It 'writes the ordinary top-level key when the root selector cannot match'
      use_fixture npm-override-placed-parent
      When call selector_write '{"lerna@^8.0.0": {"nx": ">=22.7.7 <23"}}'
      The status should be success
      The output should equal '{"lerna@^8.0.0":{"nx":">=22.7.7 <23"},"nx":{"brace-expansion":">=5.0.9 <6"}}'
    End

    # The positive direction pins the semantics: a selector that admits the
    # installed copy corroborates exactly as the bare name does.
    It 'still nests inside a rule whose root selector admits the installed copy'
      use_fixture npm-override-placed-parent
      When call selector_write '{"lerna@^9.0.0": {"nx": ">=22.7.7 <23"}}'
      The status should be success
      The output should equal '{"lerna@^9.0.0":{"nx":{".":">=22.7.7 <23","brace-expansion":">=5.0.9 <6"}}}'
    End

    # The same check on an intermediate segment of a depth-3 rule: the top
    # segment is installed and reaches lerna, but the dead middle selector
    # breaks the chain.
    seed_top_over_lerna() {
      jq '.packages[""].dependencies.top = "^1.0.0"
          | .packages["node_modules/top"] =
            {version: "1.0.0", dependencies: {lerna: "^9.0.0"}}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
    }

    It 'writes the ordinary top-level key when a depth-3 intermediate selector cannot match'
      use_fixture npm-override-placed-parent
      seed_top_over_lerna
      When call selector_write '{"top": {"lerna@^8.0.0": {"nx": ">=22.7.7 <23"}}}'
      The status should be success
      The output should equal '{"top":{"lerna@^8.0.0":{"nx":">=22.7.7 <23"}},"nx":{"brace-expansion":">=5.0.9 <6"}}'
    End

    # The child key's own selector: nx resolves at 22.7.9, so nx@^21.0.0
    # places no copy and is no candidate. No refusal, ordinary write; the
    # matching-selector refusal is pinned in the placement refusals
    # Describe above.
    It 'ignores a child rule key whose selector matches no installed copy'
      use_fixture npm-override-placed-parent
      When call selector_write '{"lerna": {"nx@^21.0.0": ">=21.7.7 <22"}}'
      The status should be success
      The output should equal '{"lerna":{"nx@^21.0.0":">=21.7.7 <22"},"nx":{"brace-expansion":">=5.0.9 <6"}}'
    End
  End

  # The corroboration walk must stay linear on a branching dependency graph
  # (#153 review round 2, reproduced). The pre-fix walk kept its visited set
  # path-local, enumerating every simple ancestor path, so a rule that
  # SPELLS the parent name without corroborating (the walk's exhaustive
  # failure case) went exponential: measured on this exact ladder shape it
  # doubled per level (2.89s at depth 18, 10.36s at 20, 40.15s at 22) and a
  # 300-package graph was killed at five minutes. The fixed walk answers
  # once per (entry, rule-suffix) pair and completes the depth-22 shape in
  # under a second. This example therefore asserts completion plus the
  # correct verdict on a size the old code demonstrably could not finish
  # quickly: a subprocess timeout guard is not portable to the stock-macOS
  # bash 3.2 environment the suite targets, so size stands in for one, and
  # a hang here is visible as the suite stalling on this example.
  Describe 'npm placement corroboration on a branching graph'
    After 'cleanup_fixture'

    # A two-wide ladder of depth 22 (47 packages, 2^22 simple ancestor
    # paths above nx): lib-a-i and lib-b-i each depend on lib-a-(i+1) and
    # lib-b-(i+1), the bottom pair depends on nx, and the rule root
    # `webpack` is absent from the tree, so the walk must exhaust the
    # graph before concluding the rule places nothing.
    branching_ladder() {
      jq '.overrides = {"webpack": {"nx": "^22"}}' package.json > p.tmp \
        && mv p.tmp package.json
      jq '.packages = ({
            "": {name: "demo", version: "1.0.0",
                 dependencies: {"lib-a-0": "^1.0.0", "lib-b-0": "^1.0.0"}},
            "node_modules/nx": {version: "22.7.9",
                                dependencies: {"brace-expansion": "^5.0.4"}},
            "node_modules/brace-expansion": {version: "5.0.5"}
          }
          + ([ range(0; 22) as $i | ["a", "b"][] as $w
               | {("node_modules/lib-\($w)-\($i)"):
                   {version: "1.0.0",
                    dependencies:
                      (if $i == 21 then {nx: "^22.0.0"}
                       else {("lib-a-\($i+1)"): "^1.0.0",
                             ("lib-b-\($i+1)"): "^1.0.0"} end)}} ]
             | add))' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx >/dev/null
      jq -c '.overrides' package.json
    }

    It 'exhausts a non-corroborating branching graph without hanging'
      use_fixture npm-override-placed-parent
      When call branching_ladder
      The status should be success
      The output should equal '{"webpack":{"nx":"^22"},"nx":{"brace-expansion":">=5.0.9 <6"}}'
    End
  End

  # `--tighten-bare` on a placed package (#153 review): a top-level bare key
  # is inert by the placement mechanism itself, so the tighten lands on the
  # placing rule's own pin — or refuses when the rule carries no pin on this
  # line — and never writes a silently-shadowed top-level key.
  Describe 'npm --tighten-bare and placed packages'
    After 'cleanup_fixture'

    It 'tightens the placing rule pin in place instead of writing a bare key'
      use_fixture npm-override-placed-parent
      "$ADAPTER" apply_constraint --tighten-bare nx '>=22.7.9 <23' >/dev/null
      When call manifest '.overrides'
      The output should equal '{"lerna":{"nx":">=22.7.9 <23","chalk":"^6.0.0"},"glob":"^13.0.0"}'
    End

    tighten_refusal() {
      _st=0
      _err=$("$ADAPTER" apply_constraint --tighten-bare nx '>=22.7.9 <23' \
        2>&1 >/dev/null) || _st=$?
      printf 'st=%s named=%s overrides=%s\n' "$_st" \
        "$(printf '%s' "$_err" | grep -c 'overrides\.lerna\.nx')" \
        "$(jq -c '.overrides' package.json)"
    }

    It 'refuses when the placing rule carries no pin on this line'
      use_fixture npm-override-placed-parent
      jq '.overrides.lerna.nx = ">=21.0.0 <22"' package.json > p.tmp \
        && mv p.tmp package.json
      When call tighten_refusal
      The status should be success
      The output should equal 'st=1 named=1 overrides={"lerna":{"nx":">=21.0.0 <22","chalk":"^6.0.0"},"glob":"^13.0.0"}'
    End

    # Placement shadows only the placed copies (#153 review round 2,
    # reproduced): with a second nx copy resolving normally under foo, the
    # rule-only tighten left that copy with no covering key at all.
    # validate does catch the gap (that net stays), but apply must not
    # create it: the placing rule's pin is tightened in place AND the
    # covering top-level key is written for the normally-resolved copy,
    # the same composition the non-tighten path uses.
    tighten_mixed() {
      jq '.packages[""].dependencies.foo = "^1.0.0"
          | .packages["node_modules/foo"] =
            {version: "1.0.0", dependencies: {nx: "^22.0.0"}}
          | .packages["node_modules/foo/node_modules/nx"] =
            {version: "22.7.5", dependencies: {"brace-expansion": "^5.0.4"}}' \
        package-lock.json > lock.tmp && mv lock.tmp package-lock.json
      _out=$("$ADAPTER" apply_constraint --tighten-bare nx '>=22.7.9 <23')
      printf 'paths=%s overrides=%s\n' \
        "$(printf '%s' "$_out" | jq -c '[.written[].path]')" \
        "$(jq -c '.overrides' package.json)"
    }

    It 'also writes the covering top-level key when normal copies exist'
      use_fixture npm-override-placed-parent
      When call tighten_mixed
      The status should be success
      The output should equal 'paths=[["overrides","lerna","nx"],["overrides","nx"]] overrides={"lerna":{"nx":">=22.7.9 <23","chalk":"^6.0.0"},"glob":"^13.0.0","nx":">=22.7.9 <23"}'
    End
  End

  # A present-but-malformed override block dies by name, before any pass
  # reads it, rather than as a downstream generic jq failure (#153 review).
  Describe 'npm malformed override block'
    After 'cleanup_fixture'

    It 'names the malformed overrides container instead of dying generically'
      use_fixture npm-override-placed-parent
      jq '.overrides = "oops"' package.json > p.tmp && mv p.tmp package.json
      When run script "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' nx
      The status should equal 1
      The stderr should include "'overrides' in package.json is a string"
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

    # The npm half of the chain runs validate BEFORE the apply: under npm the
    # apply also invalidates the stale lockfile entries on the target line
    # (issue #124). `invalidated` is the EXACT sorted key set, not an
    # intersection with the flagged set — an intersection can never fail on
    # over-deletion — so the example pins that the aliased copy validate
    # flags is deleted alongside the two plain 4.17.21 copies the range also
    # makes stale, and nothing else.
    npm_alias_chain() {
      _flagged=$("$ADAPTER" validate --line 4 --vulnerable '>= 4.18.0, < 4.18.2' \
        lodash '>=4.18.2 <5' | jq -c '[.unresolved_alerts[].path]')
      _out=$("$ADAPTER" apply_constraint lodash '>=4.18.2 <5' "$@")
      _wrote=$(printf '%s' "$_out" \
        | jq -c '[.written[] | select(.value | startswith("npm:")) | .path]')
      _inv=$(printf '%s' "$_out" | jq -c '.lockfile_invalidated.keys')
      printf 'flagged=%s wrote=%s invalidated=%s\n' "$_flagged" "$_wrote" "$_inv"
    }

    It 'writes the alias key, with the protocol, under the parent that declared it'
      use_fixture npm-alias
      "$ADAPTER" apply_constraint lodash '>=4.18.2 <5' alias-parent dupe-parent >/dev/null
      When call manifest '{aliased: .overrides["alias-parent"], plain: .overrides["dupe-parent"]}'
      The output should equal '{"aliased":{"lodash-alias":"npm:lodash@>=4.18.2 <5"},"plain":{"lodash":">=4.18.2 <5"}}'
    End

    It 'governs the aliased copy validate flags, with no node_modules to read'
      use_fixture npm-alias
      When call npm_alias_chain alias-parent dupe-parent
      The status should be success
      The path node_modules should not be exist
      The output should equal 'flagged=["node_modules/lodash-alias"] wrote=[["overrides","alias-parent","lodash-alias"]] invalidated=["node_modules/dupe-parent/node_modules/lodash","node_modules/lodash","node_modules/lodash-alias"]'
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

  # npm keeps an existing lockfile entry over a newly added override: the
  # locked copy stays at its vulnerable version and `npm ls` flags it
  # `invalid`, while npm serializes no `overrides` field into the lockfile at
  # all (verified on npm 8 through 11 against lockfile v3, and reproduced both
  # ways on the field repo behind issue #124: entry kept, override inert;
  # entry deleted, the next install dedupes the copy onto the patched
  # resolution). So the apply must invalidate the stale entries or the
  # override silently never takes effect. `spec/fixtures/npm-stale-nested` is
  # trimmed from the field shape: a nested copy locked at a vulnerable version
  # under an unscoped parent, a satisfied top-level copy, a second major line
  # under another parent, and a manifest overrides block the lockfile records
  # nowhere — npm's normal state, not drift.
  Describe 'a stale npm lockfile entry is invalidated with the override'
    It 'deletes the locked stale copy on the target line, and only it'
      use_fixture npm-stale-nested
      When call adapter_jq '.lockfile_invalidated' apply_constraint axios '>=1.18.0 <2' nx
      The status should be success
      The output should equal '{"performed":true,"keys":["node_modules/nx/node_modules/axios"]}'
    End

    # Through the consuming rule: the stale copy leaves the resolution set
    # `validate` composes on, while the satisfied 1.x copy and the 0.x line —
    # a sibling group's property, which re-resolving could move — keep their
    # entries.
    It 'removes the stale copy from resolved_versions and nothing else'
      use_fixture npm-stale-nested
      "$ADAPTER" apply_constraint axios '>=1.18.0 <2' nx >/dev/null
      When call adapter_jq '[.versions[].version] | sort' resolved_versions axios
      The status should be success
      The output should equal '["0.21.4","1.18.1"]'
    End

    # The chain to the verdict, both halves. The post-apply lockfile is the
    # state the field-verified install produced (the deleted entry stays gone
    # and the copy dedupes onto the satisfied top-level resolution), so a
    # validate that fails on the stale copy before the apply and passes after
    # it is the difference the invalidation exists to make.
    validate_line1() {
      "$ADAPTER" validate --line 1 --vulnerable '< 1.18.0' axios '>=1.18.0 <2' \
        | jq -c '{ok, unresolved: [.unresolved_alerts[].path]}'
    }

    It 'fails validate on the stale locked copy before the fix'
      use_fixture npm-stale-nested
      When call validate_line1
      The output should equal '{"ok":false,"unresolved":["node_modules/nx/node_modules/axios"]}'
    End

    It 'passes validate once the stale entry is invalidated'
      use_fixture npm-stale-nested
      "$ADAPTER" apply_constraint axios '>=1.18.0 <2' nx >/dev/null
      When call validate_line1
      The output should equal '{"ok":true,"unresolved":[]}'
    End

    # A copy already satisfying the range needs no move, so the in-sync twin
    # of the same shape reports an empty key set and an untouched lockfile —
    # which also keeps the already-fixed case's empty diff empty.
    It 'reports the pass ran and found nothing stale when the copy satisfies'
      use_fixture npm-stale-nested
      When call adapter_jq '.lockfile_invalidated' apply_constraint axios '>=1.16.0 <2' nx
      The status should be success
      The output should equal '{"performed":true,"keys":[]}'
    End

    It 'leaves the lockfile byte-identical when nothing is stale'
      use_fixture npm-stale-nested
      "$ADAPTER" apply_constraint axios '>=1.16.0 <2' nx >/dev/null
      When call cmp package-lock.json "$FIXTURES/npm-stale-nested/package-lock.json"
      The status should be success
    End

    # A direct dependency bump is a manifest range change npm reconciles on
    # its own; no override is written, so nothing is invalidated.
    It 'performs no invalidation for a direct dependency bump'
      use_fixture npm-stale-nested
      When call adapter_jq '.lockfile_invalidated' apply_constraint axios '>=1.18.0 <2'
      The status should be success
      The output should equal '{"performed":false,"keys":[]}'
    End

    It 'leaves the lockfile alone for a direct dependency bump'
      use_fixture npm-stale-nested
      "$ADAPTER" apply_constraint axios '>=1.18.0 <2' >/dev/null
      When call cmp package-lock.json "$FIXTURES/npm-stale-nested/package-lock.json"
      The status should be success
    End

    # The converse line: a 0.x fix on the same tree deletes only the 0.x
    # copy. Both 1.x copies — the satisfied top-level 1.18.1 and the stale
    # nested 1.16.0, which a 1.x fix WOULD delete — belong to a sibling
    # group's property here and survive untouched.
    It 'scopes the deletion to the range floor major: a 0.x fix touches no 1.x copy'
      use_fixture npm-stale-nested
      When call adapter_jq '.lockfile_invalidated' apply_constraint axios '>=0.21.7 <1' localtunnel
      The status should be success
      The output should equal '{"performed":true,"keys":["node_modules/localtunnel/node_modules/axios"]}'
    End

    It 'retains both 1.x resolutions after the 0.x fix'
      use_fixture npm-stale-nested
      "$ADAPTER" apply_constraint axios '>=0.21.7 <1' localtunnel >/dev/null
      When call adapter_jq '[.versions[].version] | sort' resolved_versions axios
      The status should be success
      The output should equal '["1.16.0","1.18.1"]'
    End

    # The two states where the pass cannot judge the lockfile AT ALL while an
    # override was just written — the doomed shape issue #124 is about, since
    # that override is presumed inert against any stale entry. Each reports
    # `performed: false` with a `reason` naming which, distinguishing it from
    # the benign nothing-to-do false of a direct bump, and touches nothing.
    It 'fails closed with a reason on a range whose floor it cannot read'
      use_fixture npm-stale-nested
      When call adapter_jq '.lockfile_invalidated' apply_constraint axios latest nx
      The status should be success
      The output should equal '{"performed":false,"keys":[],"reason":"unreadable_range_floor"}'
    End

    It 'leaves the lockfile byte-identical on an unreadable floor'
      use_fixture npm-stale-nested
      "$ADAPTER" apply_constraint axios latest nx >/dev/null
      When call cmp package-lock.json "$FIXTURES/npm-stale-nested/package-lock.json"
      The status should be success
    End

    It 'still writes the override the reason declares inert on an unreadable floor'
      use_fixture npm-stale-nested
      "$ADAPTER" apply_constraint axios latest nx >/dev/null
      When call manifest '.overrides.nx'
      The output should equal '{"axios":"latest"}'
    End

    # `spec/fixtures/npm-v1` is a lockfileVersion 1 file: a top-level
    # `dependencies` map and no `packages` object anywhere, the format npm 5
    # and 6 wrote. The stale-entry pass reads `.packages` keys, so v1 gives
    # it nothing to judge.
    It 'fails closed with a reason on a v1 lockfile with no packages object'
      use_fixture npm-v1
      When call adapter_jq '.lockfile_invalidated' apply_constraint axios '>=0.21.7 <1' localtunnel
      The status should be success
      The output should equal '{"performed":false,"keys":[],"reason":"no_packages_object"}'
    End

    It 'leaves the v1 lockfile byte-identical'
      use_fixture npm-v1
      "$ADAPTER" apply_constraint axios '>=0.21.7 <1' localtunnel >/dev/null
      When call cmp package-lock.json "$FIXTURES/npm-v1/package-lock.json"
      The status should be success
    End

    It 'still writes the override the reason declares inert on a v1 lockfile'
      use_fixture npm-v1
      "$ADAPTER" apply_constraint axios '>=0.21.7 <1' localtunnel >/dev/null
      When call manifest '.overrides.localtunnel'
      The output should equal '{"axios":">=0.21.7 <1"}'
    End

    # Version-less workspace `link: true` entries carry no version to judge
    # (or to hold the tree at), so the pass skips them: they never enter
    # `keys[]` and survive the deletion that removes the stale registry copy.
    It 'leaves workspace link entries in place and out of keys[]'
      use_fixture npm-workspaces
      When call adapter_jq '.lockfile_invalidated' apply_constraint lodash '>=4.18.0 <5' express
      The status should be success
      The output should equal '{"performed":true,"keys":["node_modules/lodash"]}'
    End

    It 'keeps every link entry in .packages after the deletion'
      use_fixture npm-workspaces
      "$ADAPTER" apply_constraint lodash '>=4.18.0 <5' express >/dev/null
      When call jq -c '[.packages | to_entries[] | select(.value.link == true) | .key] | sort' package-lock.json
      The status should be success
      The output should equal '["node_modules/@demo/alpha","node_modules/@demo/beta","node_modules/@demo/delta","node_modules/@demo/epsilon","node_modules/@demo/gamma","node_modules/@demo/zeta"]'
    End

    # pnpm records the active overrides in the lockfile's own `overrides:`
    # settings block and re-resolves on mismatch, and Yarn Berry re-evaluates
    # `resolutions` on every install, so neither has npm's stale-entry
    # failure. The field is still present per the contract, reporting that no
    # invalidation applies.
    Describe 'other package managers'
      Parameters
        pnpm-v9    undici '>=6.19.0 <7' express
        yarn-berry undici '>=6.19.0 <7' '@vercel/fun'
      End

      It "reports not-performed for $1"
        use_fixture "$1"
        When call adapter_jq '.lockfile_invalidated' apply_constraint "$2" "$3" "$4"
        The status should be success
        The output should equal '{"performed":false,"keys":[]}'
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

# Where the write lands (issue #159): the field repository pinned pnpm 11 and
# kept its live overrides in pnpm-workspace.yaml's top-level block; the
# adapter wrote a correctly scoped key into package.json's `pnpm.overrides`,
# which pnpm 11 does not read, so the fix was inert and validate fail-closed
# on the adapter's own write. These assert the verdict through the consuming
# surfaces — the workspace file the install reads, the manifest the PR diffs,
# and list_pins' read-back — not just apply_constraint's JSON.
Describe 'apply_constraint pnpm override file routing (issue #159)'
  After 'cleanup_fixture'

  workspace_line() { grep -c "$1" pnpm-workspace.yaml; }

  It 'writes the scoped keys into the workspace overrides block on pnpm 11'
    use_fixture pnpm11-workspace-overrides
    "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
    When call workspace_line "^  'minimatch@10\\.2\\.5>brace-expansion': '>=5\\.0\\.9 <6'$"
    The status should be success
    The output should equal 1
  End

  It 'reports the file it wrote through'
    use_fixture pnpm11-workspace-overrides
    When call adapter_jq '{override_file, keys: [.written[].path | join(".")] | sort}' apply_constraint brace-expansion '>=5.0.9 <6' minimatch
    The status should be success
    The output should equal '{"override_file":"pnpm-workspace.yaml","keys":["pnpm.overrides.minimatch@10.0.3>brace-expansion","pnpm.overrides.minimatch@10.2.5>brace-expansion"]}'
  End

  It 'preserves the pre-existing workspace entries beside the new keys'
    use_fixture pnpm11-workspace-overrides
    "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
    When call adapter_jq '[.pins[].key] | sort' list_pins
    The status should be success
    The output should equal '["form-data","js-yaml","minimatch@10.0.3>brace-expansion","minimatch@10.2.5>brace-expansion","undici","ws"]'
  End

  # The dead field is the defect: pnpm 11 ignores it and prints "The \"pnpm\"
  # field in package.json is no longer read by pnpm" on install.
  It 'leaves package.json without a pnpm field on pnpm 11'
    use_fixture pnpm11-workspace-overrides
    "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
    When call manifest '.pnpm'
    The output should equal 'null'
  End

  It 'creates pnpm-workspace.yaml with the block on a pnpm 11 repo that has none'
    use_fixture pnpm-cross-line
    jq '.packageManager = "pnpm@11.9.0"' package.json > p.json && mv p.json package.json
    "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
    When call workspace_line "^overrides:$"
    The status should be success
    The output should equal 1
  End

  # The pre-11 shape is unchanged: same fixture family, overrides still land
  # in package.json and no workspace file appears.
  It 'still writes package.json pnpm.overrides on pnpm 10 with no workspace block'
    use_fixture pnpm-cross-line
    "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch >/dev/null
    test -f pnpm-workspace.yaml && return 1
    When call manifest '[.pnpm.overrides | keys[]] | sort'
    The output should equal '["minimatch@10.0.3>brace-expansion","minimatch@10.2.5>brace-expansion"]'
  End

  # A block this script cannot round-trip is refused before anything is
  # written: a wrong write here corrupts a file pnpm reads on every install.
  It 'refuses loudly on a workspace overrides block it cannot round-trip'
    use_fixture pnpm11-workspace-overrides
    printf 'overrides:\n  jest:\n    ws: 1\n' > pnpm-workspace.yaml
    When run script "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch
    The status should equal 1
    The stderr should include 'cannot safely read the block'
  End

  It 'refuses a workspace overrides block carrying duplicate keys'
    use_fixture pnpm11-workspace-overrides
    printf 'overrides:\n  ws: 1\n  ws: 2\n' > pnpm-workspace.yaml
    When run script "$ADAPTER" apply_constraint brace-expansion '>=5.0.9 <6' minimatch
    The status should equal 1
    The stderr should include 'duplicate keys'
  End
End
