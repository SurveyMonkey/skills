#!/bin/sh
# shellcheck shell=sh
# node.sh detect, resolved_versions, and why.
#
# The regression that motivated this suite: v0.1.0's yarn validation used a grep
# pattern that could never match, so it returned zero lines against every
# lockfile and zero matches were read as "validated". The contract now makes
# that unrepresentable, and the "zero entries is an error" examples below are
# what hold it.

Describe 'node.sh detect'
  After 'cleanup_fixture'

  It 'identifies pnpm'
    use_fixture pnpm-v9
    When call adapter_jq '{pm, lockfile, override_location, supports_scoping}' detect
    The status should be success
    The output should equal '{"pm":"pnpm","lockfile":"pnpm-lock.yaml","override_location":"pnpm.overrides","supports_scoping":true}'
  End

  It 'identifies yarn berry by its __metadata block'
    use_fixture yarn-berry
    When call adapter_jq '{pm, override_location, override_syntax}' detect
    The status should be success
    The output should equal '{"pm":"yarn","override_location":"resolutions","override_syntax":"parent/dep"}'
  End

  It 'identifies npm'
    use_fixture npm-v3
    When call adapter_jq '{pm, override_location, override_syntax}' detect
    The status should be success
    The output should equal '{"pm":"npm","override_location":"overrides","override_syntax":"nested"}'
  End

  # Where the live pnpm override block sits (issue #159): pnpm 11 no longer
  # reads package.json's `pnpm` field, so an override written there is
  # silently inert and validate fail-closes on the adapter's own write. A
  # pre-existing workspace block wins at any major — it is where the repo
  # demonstrably keeps its live overrides — and a pnpm 11 pin routes there
  # even before the file exists. yarn and npm always answer package.json.
  Describe 'override_file'
    Parameters
      'a pnpm 11 repo with a workspace overrides block' pnpm11-workspace-overrides 'pnpm-workspace.yaml'
      'a pnpm 10 repo with no workspace file'           pnpm-cross-line            'package.json'
      'a yarn repo'                                     yarn-berry                 'package.json'
      'an npm repo'                                     npm-v3                     'package.json'
    End

    It "names the live override file for $1"
      use_fixture "$2"
      When call adapter_jq '.override_file' detect
      The status should be success
      The output should equal "\"$3\""
    End

    It 'routes a pnpm 11 repo without a workspace file to pnpm-workspace.yaml'
      use_fixture pnpm-cross-line
      jq '.packageManager = "pnpm@11.9.0"' package.json > p.json && mv p.json package.json
      When call adapter_jq '.override_file' detect
      The status should be success
      The output should equal '"pnpm-workspace.yaml"'
    End

    It 'prefers an existing workspace overrides block on pnpm 10 too'
      use_fixture pnpm11-workspace-overrides
      jq '.packageManager = "pnpm@10.2.1"' package.json > p.json && mv p.json package.json
      When call adapter_jq '.override_file' detect
      The status should be success
      The output should equal '"pnpm-workspace.yaml"'
    End

    It 'keeps package.json for a workspace file that carries no overrides block'
      use_fixture pnpm-cross-line
      printf 'packages:\n  - packages/*\n' > pnpm-workspace.yaml
      When call adapter_jq '.override_file' detect
      The status should be success
      The output should equal '"package.json"'
    End
  End

  # Whether pm_exec is a bare binary or a corepack invocation depends on the
  # machine. What must hold is that install_cmd is built from pm_exec, so the
  # emitted command is actually runnable wherever the adapter runs.
  It 'builds install_cmd from the resolved pm_exec'
    use_fixture pnpm-v9
    When call adapter_jq '.install_cmd == (.pm_exec + " install") and (.pm_exec | test("^(corepack )?pnpm$"))' detect
    The status should be success
    The output should equal 'true'
  End

  # Most Yarn Berry repos vendor the release they pin (yarnPath in
  # .yarnrc.yml). When the bare binary is absent, the vendored bundle beats
  # corepack: exact pinned version, no indirection, no cold-cache download.
  # On machines with yarn on PATH the bare binary still wins, so the
  # assertion tolerates both, like the pnpm example above.
  It 'prefers the vendored yarnPath release over corepack'
    use_fixture yarn-vendored
    When call adapter_jq '.pm_exec | test("^(yarn|node .yarn/releases/yarn-4.13.0.cjs)$")' detect
    The status should be success
    The output should equal 'true'
  End

  It 'falls through to corepack when nothing is vendored'
    use_fixture yarn-berry
    When call adapter_jq '.pm_exec | test("^(corepack )?yarn$")' detect
    The status should be success
    The output should equal 'true'
  End

  # One scripted call replaces the hand-rolled mkdir/printf/chmod sequence
  # agents otherwise improvise, each drawing its own permission review. The
  # runner override keeps the examples deterministic across machines.
  Describe 'shim'
    It 'writes an executable shim delegating to the resolved runner'
      use_fixture yarn-vendored
      When call adapter_jq '{created, pm}' shim shim-bin 'corepack yarn'
      The status should be success
      The output should equal '{"created":true,"pm":"yarn"}'
      The path shim-bin/yarn should be exist
      The contents of file shim-bin/yarn should include 'exec corepack yarn "$@"'
    End

    It 'requires a target directory'
      use_fixture yarn-vendored
      When run script "$ADAPTER" shim
      The status should not equal 0
      The stderr should be present
    End
  End

  Describe 'unsupported toolchains are reported, not crashed on'
    Parameters
      bun           3  'bun is not a supported package manager'
      yarn-classic  3  'Yarn Classic'
      no-lockfile   1  'No supported lockfile'
    End

    It "rejects $1 with exit $2"
      use_fixture "$1"
      When run script "$ADAPTER" detect
      The status should equal "$2"
      The stderr should include "$3"
    End
  End

  It 'points rejected toolchains at CONTRIBUTING.md'
    use_fixture bun
    When run script "$ADAPTER" detect
    The status should equal 3
    The stderr should include 'CONTRIBUTING.md'
  End
End

Describe 'node.sh verb dispatch'
  After 'cleanup_fixture'

  # Reserved and exiting 2 through Phases 1-3; implemented in Phase 4, whose
  # pin audit is its only consumer (issue #7). Behavior is covered in
  # spec/node_list_pins_spec.sh; this only asserts the verb is wired up.
  It 'dispatches list_pins'
    use_fixture pnpm-v9
    When call adapter_jq '{pm, count}' list_pins
    The status should be success
    The output should equal '{"pm":"pnpm","count":3}'
  End

  It 'rejects an unknown verb'
    use_fixture pnpm-v9
    When run script "$ADAPTER" no-such-verb
    The status should equal 1
    The stderr should be present
  End
End

Describe 'node.sh resolved_versions'
  After 'cleanup_fixture'

  Describe 'the empty-parse guard'
    # The specific failure mode of v0.1.0. A lockfile that yields nothing at all
    # means the parser is broken, not that the repo has no dependencies.
    Parameters
      empty-yarn
      empty-npm
    End

    It "treats a zero-entry $1 lockfile as an error, never a clean result"
      use_fixture "$1"
      When run script "$ADAPTER" resolved_versions lodash
      The status should equal 1
      The stderr should include 'Parsed 0 entries'
    End
  End

  It 'distinguishes an absent package from a broken parser'
    use_fixture yarn-berry
    When call adapter_jq '{present, count, populated: (.lockfile_entries > 0)}' resolved_versions definitely-not-installed
    The status should be success
    The output should equal '{"present":false,"count":0,"populated":true}'
  End

  Describe 'yarn berry parsing'
    Parameters
      lodash        '["4.17.21"]'  # the package the v0.1.0 grep silently missed
      '@babel/core' '["7.24.0"]'   # scoped name
      'sha.js'      '["2.4.11"]'   # a dot would match any char in a regex parser
    End

    It "resolves $1"
      use_fixture yarn-berry
      When call adapter_jq '[.versions[].version]' resolved_versions "$1"
      The status should be success
      The output should equal "$2"
    End
  End

  It 'reports every resolved version of a multiply-resolved package'
    use_fixture yarn-berry
    When call adapter_jq '[.versions[].version] | sort' resolved_versions undici
    The status should be success
    The output should equal '["5.28.4","6.19.8"]'
  End

  Describe 'pnpm parsing'
    Parameters
      lodash        '["4.17.21"]'
      '@babel/core' '["7.24.0"]'  # quoted scoped key
      'sha.js'      '["2.4.11"]'
      react-dom     '["18.2.0"]'  # peer-dependency suffix stripped
      express       '["4.18.2"]'
    End

    It "resolves $1"
      use_fixture pnpm-v9
      When call adapter_jq '[.versions[].version]' resolved_versions "$1"
      The status should be success
      The output should equal "$2"
    End
  End

  It 'does not mistake the pnpm overrides block for package entries'
    # `overrides:` sits above `packages:` and names lodash and express.
    use_fixture pnpm-v9
    When call adapter_jq '.count' resolved_versions lodash
    The status should be success
    The output should equal '1'
  End

  It 'reports npm nested paths separately from the hoisted one'
    use_fixture npm-v3
    When call adapter_jq '{versions: ([.versions[].version] | sort), nested: ([.versions[].path] | any(test("test-exclude/node_modules/lodash")))}' resolved_versions lodash
    The status should be success
    The output should equal '{"versions":["3.10.1","4.17.21"],"nested":true}'
  End

  It 'does not let a bare name match a scoped path in npm'
    # "core" must not match "node_modules/@babel/core"
    use_fixture npm-v3
    When call adapter_jq '.present' resolved_versions core
    The status should be success
    The output should equal 'false'
  End

  It 'resolves an npm scoped name exactly'
    use_fixture npm-v3
    When call adapter_jq '[.versions[].version]' resolved_versions '@babel/core'
    The status should be success
    The output should equal '["7.24.0"]'
  End

  It 'requires a package name'
    use_fixture npm-v3
    When run script "$ADAPTER" resolved_versions
    The status should not equal 0
    The stderr should include 'requires a package name'
  End

  # A package is found by the name it resolves to, never by where it sits. Both
  # cases below were invisible to this verb at a real registry version, which
  # reads as "the package left the tree" — the audit's cue for `removable`
  # (issue #44).
  Describe 'a package is identified by what it resolves to'
    It 'finds a yarn patched package at the version it patches'
      # `patch:` percent-encodes the colon of the locator it wraps, so a
      # literal `@npm:` match never sees it.
      use_fixture yarn-patch
      When call adapter_jq '{present, versions: [.versions[].version]}' resolved_versions lodash
      The status should be success
      The output should equal '{"present":true,"versions":["4.17.21"]}'
    End

    It 'finds a yarn builtin patch, whose locator carries a "#" before its metadata'
      use_fixture yarn-patch
      When call adapter_jq '[.versions[].version]' resolved_versions typescript
      The status should be success
      The output should equal '["5.4.5"]'
    End

    It 'finds an npm alias under the package it aliases'
      use_fixture npm-alias
      When call adapter_jq '[.versions[] | select(.path | endswith("lodash-alias"))]' resolved_versions lodash
      The status should be success
      The output should equal '[{"version":"4.18.1","path":"node_modules/lodash-alias"}]'
    End

    # ...and under the key it is installed as, which is the name an override
    # entry for an aliased dependency carries (`"lodash-alias":
    # "npm:lodash@4.18.2"`), so it is the name `list_pins` hands the audit.
    # Answering `present: false` there is read as "the package left the tree
    # entirely", which agents/audit-pins.md turns into `removable`: a deletion
    # recommendation for a pin on a package nothing examined (issue #46).
    It 'answers under the npm alias key as well'
      use_fixture npm-alias
      When call adapter_jq '{present, versions: [.versions[].version]}' resolved_versions lodash-alias
      The status should be success
      The output should equal '{"present":true,"versions":["4.18.1"]}'
    End

    # `yarn patch` on a package that already carries the builtin compat patch.
    # Berry escapes the wrapped locator once per nesting level, so the decode
    # has to run per unwrap: run once up front it leaves %253A intact, the
    # inner descriptor matches neither protocol, and the row is dropped —
    # `present: false` for a package sitting in the tree at a real registry
    # version (issue #46).
    It 'finds a yarn patch applied on top of another patch'
      use_fixture yarn-patch-nested
      When call adapter_jq '{present, versions: [.versions[].version]}' resolved_versions typescript
      The status should be success
      The output should equal '{"present":true,"versions":["5.1.6"]}'
    End

    # Berry writes `__archiveUrl` binding parameters for anything fetched from
    # a non-default registry. Left on the version they make it sort below the
    # clean release, which is how a vulnerable copy reads safe; see the
    # completeness example in node_validate_spec.sh.
    It 'drops the binding parameters an npm: locator carries after "::"'
      use_fixture yarn-binding-params
      When call adapter_jq '[.versions[].version]' resolved_versions privreg
      The status should be success
      The output should equal '["2.5.0"]'
    End

    Describe 'a yarn npm: alias'
      Parameters
        lodash        '["4.17.21"]' # the package it aliases
        aliased       '["4.17.21"]' # the key it is installed and pinned under
        '@scope/real' '["2.3.4"]'   # scoped, aliased
        scoped-alias  '["2.3.4"]'
      End

      It "resolves $1"
        use_fixture yarn-alias
        When call adapter_jq '[.versions[].version]' resolved_versions "$1"
        The status should be success
        The output should equal "$2"
      End
    End

    # Local code is not a registry version, so neither verb claims one for it.
    Describe 'entries that resolve to no registry version'
      Parameters
        local-tool  # portal: a linked local directory
        gen-thing   # exec:   a package generated at install time
        demo-patch  # workspace: the root itself
      End

      It "reports no registry version for the $1 entry"
        use_fixture yarn-patch
        When call adapter_jq '{present, count}' resolved_versions "$1"
        The status should be success
        The output should equal '{"present":false,"count":0}'
      End
    End
  End
End

# The whole-tree view the pin audit diffs across a removal, so a pin whose
# removal moves some OTHER package cannot come back a silent `removable`
# (issue #42).
Describe 'node.sh resolution_map'
  After 'cleanup_fixture'

  Describe 'every lockfile format yields the same shape'
    Parameters
      npm-v3     npm   6
      pnpm-v9    pnpm  5
      yarn-berry yarn  5
    End

    It "maps $1 to $3 packages"
      use_fixture "$1"
      When call adapter_jq '{pm, package_count, populated: (.lockfile_entries > 0)}' resolution_map
      The status should be success
      The output should equal "{\"pm\":\"$2\",\"package_count\":$3,\"populated\":true}"
    End
  End

  # The map is only useful for a diff if it agrees with the verb the verdict is
  # computed from. A disagreement is a parser bug, not a tie to break.
  Describe 'the map agrees with resolved_versions'
    # Printing both sides rather than a bare boolean, so a failure shows which
    # parser drifted instead of only that one did.
    #
    # `[.versions[].version] | unique` is the normalization the audit's
    # cross-check prescribes (agents/audit-pins.md, phase 4): the two
    # verbs answer different questions, so one version at two paths is a longer
    # list on one side and one entry on the other, and comparing the raw shapes
    # would report a healthy pin `inconclusive` (issue #44).
    versions_agree() {
      _map=$("$ADAPTER" resolution_map | jq -c --arg p "$1" '.resolutions[$p] // []')
      _one=$("$ADAPTER" resolved_versions "$1" | jq -c '[.versions[].version] | unique')
      if [ "$_map" = "$_one" ]; then printf 'agree %s\n' "$_map"
      else printf 'map=%s resolved_versions=%s\n' "$_map" "$_one"; fi
    }

    Parameters
      npm-v3     lodash        '["3.10.1","4.17.21"]' # two copies, one nested
      npm-v3     '@babel/core' '["7.24.0"]'           # scoped name
      pnpm-v9    react-dom     '["18.2.0"]'           # peer-dependency suffix
      pnpm-v9    'sha.js'      '["2.4.11"]'           # a dot is not a wildcard here
      yarn-berry undici        '["5.28.4","6.19.8"]'  # two majors side by side
      yarn-patch lodash        '["4.17.21"]'          # a patched package
      npm-alias  lodash        '["4.17.21","4.18.1"]' # an alias, plus one version at two paths
      yarn-patch-nested typescript '["5.1.6"]'        # a patch of a patch
      yarn-binding-params privreg  '["2.5.0"]'        # an npm: locator with :: parameters
      yarn-alias lodash        '["4.17.21"]'          # a yarn npm: alias
    End

    It "reports the same versions for $2 in $1"
      use_fixture "$1"
      When call versions_agree "$2"
      The status should be success
      The output should equal "agree $3"
    End
  End

  It 'keeps two copies of one package as one entry with two versions'
    use_fixture npm-v3
    When call adapter_jq '.resolutions.lodash' resolution_map
    The status should be success
    The output should equal '["3.10.1","4.17.21"]'
  End

  It 'excludes the yarn workspace entry, which resolves to no registry version'
    use_fixture yarn-berry
    When call adapter_jq '.resolutions | has("demo-app")' resolution_map
    The status should be success
    The output should equal 'false'
  End

  It 'excludes the npm root entry'
    use_fixture npm-v3
    When call adapter_jq '.resolutions | has("demo-npm")' resolution_map
    The status should be success
    The output should equal 'false'
  End

  It 'does not mistake the pnpm overrides or snapshots blocks for packages'
    # `overrides:` names lodash and express above `packages:`; `snapshots:`
    # repeats every key below it.
    use_fixture pnpm-v9
    When call adapter_jq '.resolutions.lodash' resolution_map
    The status should be success
    The output should equal '["4.17.21"]'
  End

  # `yarn patch` is used above all for one-off security fixes, so a patched
  # package missing from the map is missing from the baseline *and* the
  # post-removal snapshot: the collateral diff then reports `none` for a package
  # that moved (issue #44). `lockfile_entries` counts it either way, so the
  # empty-parse guard below never fires on it.
  It 'keeps a yarn patched package at the registry version it patches'
    use_fixture yarn-patch
    When call adapter_jq '{lockfile_entries, resolutions}' resolution_map
    The status should be success
    The output should equal '{"lockfile_entries":6,"resolutions":{"express":["4.21.2"],"lodash":["4.17.21"],"typescript":["5.4.5"]}}'
  End

  # portal: and exec: do NOT share the patch defect: excluding them is correct,
  # and stays correct now that patch: is unwrapped rather than string-matched.
  Describe 'entries that resolve to no registry version stay out'
    Parameters
      local-tool  # portal:, whose local package.json version would pass the digit filter
      gen-thing   # exec:, generated at install time
      demo-patch  # workspace:, the root itself
    End

    It "excludes the $1 entry"
      use_fixture yarn-patch
      When call adapter_jq ".resolutions | has(\"$1\")" resolution_map
      The status should be success
      The output should equal 'false'
    End
  End

  # npm keys an `npm:` alias by the alias and records the real name in `.name`.
  # Under the alias key the audit's collateral lookup queries a package the
  # registry does not have, which answers `no-advisories` — a lost signal that
  # never forces `still-required` the way `vulnerable` does (issue #44).
  It 'keys an npm alias under the package it aliases'
    use_fixture npm-alias
    When call adapter_jq '{lodash: .resolutions.lodash, aliased: (.resolutions | has("lodash-alias"))}' resolution_map
    The status should be success
    The output should equal '{"lodash":["4.17.21","4.18.1"],"aliased":false}'
  End

  # The shape difference the audit's cross-check has to normalize away: the same
  # version at two paths is two entries from `resolved_versions` and one from
  # the map. Compared unnormalized that reads as a disagreement, which reports a
  # healthy pin `inconclusive`; the agreement itself is asserted above.
  It 'holds one entry for a version resolved at two paths'
    use_fixture npm-alias
    When call adapter_jq '[.versions[] | select(.version == "4.17.21") | .path] | length' resolved_versions lodash
    The status should be success
    The output should equal '2'
  End

  It 'keeps a yarn patch of a patch at the version its innermost locator names'
    use_fixture yarn-patch-nested
    When call adapter_jq '{lockfile_entries, resolutions}' resolution_map
    The status should be success
    The output should equal '{"lockfile_entries":3,"resolutions":{"keep":["1.0.0"],"typescript":["5.1.6"]}}'
  End

  # Berry aliases, keyed like npm's: under the package the code actually is,
  # because the audit feeds this name into an advisory query and the alias key
  # answers `no-advisories` there — a lost signal that never forces
  # `still-required` the way `vulnerable` does.
  It 'keys a yarn npm: alias under the package it aliases'
    use_fixture yarn-alias
    When call adapter_jq '{resolutions: (.resolutions | to_entries | sort_by(.key) | from_entries), keyed_by_alias: (.resolutions | has("aliased") or has("scoped-alias"))}' resolution_map
    The status should be success
    The output should equal '{"resolutions":{"@scope/real":["2.3.4"],"lodash":["4.17.21"]},"keyed_by_alias":false}'
  End

  # The one place the two verbs answer differently about the same name, and it
  # is the identity rule rather than a parser drifting: the map holds a package
  # once, under the name a registry knows, while `resolved_versions` also
  # answers under the key an override entry names. agents/audit-pins.md says
  # what the audit does with it — report the pin `inconclusive` naming the
  # alias, never `removable`.
  It 'holds an alias only under the aliased package, though both names resolve'
    use_fixture npm-alias
    When call adapter_jq '{map: (.resolutions | has("lodash-alias")), aliased: .resolutions.lodash}' resolution_map
    The status should be success
    The output should equal '{"map":false,"aliased":["4.17.21","4.18.1"]}'
  End

  Describe 'the parse guard'
    # A whole-tree diff against an empty map reports every package unchanged,
    # which is the wrong-safe answer this plugin exists to avoid.
    Describe 'a lockfile with no entries at all'
      Parameters
        empty-yarn
        empty-npm
      End

      It "treats a zero-entry $1 lockfile as an error, never an empty tree"
        use_fixture "$1"
        When run script "$ADAPTER" resolution_map
        The status should equal 1
        The stderr should include 'Parsed 0 entries'
      End
    End

    # The guard the `entries == 0` check could not make: `grep -c 'resolution:
    # "'` counts lines the rows never had to survive, so a lockfile the parser
    # understood none of reported `{"lockfile_entries":3,"package_count":0}`
    # and exit 0. Two empty maps compare equal, so the audit's collateral check
    # degraded into a no-op that *strengthens* a removal (issue #46).
    It 'refuses a lockfile whose locators it mostly could not read'
      use_fixture yarn-unknown-protocol
      When run script "$ADAPTER" resolution_map
      The status should equal 1
      The stderr should include 'Read 1 of 4 lockfile entries'
    End

    # ...and does not mistake a repository that genuinely resolves to no
    # registry version for that failure. Every locator here is read and
    # deliberately excluded, which is why the guard counts what it could read
    # rather than what it kept.
    It 'accepts an all-local lockfile, whose package_count is legitimately zero'
      use_fixture yarn-all-local
      When call adapter_jq '{lockfile_entries, package_count, resolutions}' resolution_map
      The status should be success
      The output should equal '{"lockfile_entries":3,"package_count":0,"resolutions":{}}'
    End

    # npm writes a workspace as `"node_modules/<ws>": {"resolved":"packages/<ws>",
    # "link":true}`: the key carries `node_modules/`, so it counted in the
    # denominator, and there is no `version`, so it could never count in the
    # numerator. Six workspaces beside four dependencies read as `Read 4 of 10`
    # and hard-failed an ordinary monorepo with "the parser is broken", which
    # stops the audit and fails the fix flow's baseline outright (issue #48).
    It 'does not count npm workspace links against the parse guard'
      use_fixture npm-workspaces
      When call adapter_jq '{entries_read, entries_expected, package_count, packages: (.resolutions | keys)}' resolution_map
      The status should be success
      The output should equal '{"entries_read":4,"entries_expected":4,"package_count":4,"packages":["express","lodash","sha.js","undici"]}'
    End

    # pnpm had no "read it and deliberately excluded it" answer at all, so a
    # `link:`, a `file:` and a git dependency counted as parse failures: two
    # registry entries out of five read as `Read 2 of 5` and died. The other
    # direction was wrong too — local dependencies padded the recognized share
    # of a genuinely broken lockfile (issue #48).
    It 'classifies pnpm link:, file: and git entries as recognized, not unread'
      use_fixture pnpm-local
      When call adapter_jq '{entries_read, entries_expected, unreadable_entries, package_count}' resolution_map
      The status should be success
      The output should equal '{"entries_read":6,"entries_expected":6,"unreadable_entries":0,"package_count":2}'
    End

    # `git+ssh://git@github.com/...` carries an `@` inside the URL, so splitting
    # the locator on the LAST one read the name as `ssh-dep@git+ssh://git` and
    # the protocol test never fired: an ordinary forked dependency counted as a
    # parse failure. One of those forces `collateral_changes: null` and
    # `not-checked` for EVERY pin in the repository under the rule above, which
    # is worse than before the coverage field existed (issue #49).
    It 'reads a pnpm git+ssh locator whose URL carries an @'
      use_fixture pnpm-local
      When call adapter_jq '{unreadable_entries, kept: (.resolutions | has("ssh-dep"))}' resolution_map
      The status should be success
      The output should equal '{"unreadable_entries":0,"kept":false}'
    End

    # npm's side of the same coverage promise. The count asked
    # `.value.version != null` while the rows additionally required a leading
    # digit, so a `{"version":"v1.2.3"}` entry was dropped from the map and
    # reported as fully read: the map claiming complete coverage of a package it
    # does not contain (issue #49). Both halves are asserted — the entry is
    # still dropped, and the map now says so.
    It 'reports an npm entry it could not turn into a row, rather than claiming full coverage'
      use_fixture npm-partial-read
      When call adapter_jq '{entries_read, entries_expected, unreadable_entries, dropped: (.resolutions | has("victim"))}' resolution_map
      The status should be success
      The output should equal '{"entries_read":3,"entries_expected":4,"unreadable_entries":1,"dropped":false}'
    End

    # The guard fires only below half, so ONE unreadable locator sails through
    # it and its package is dropped from the map with nothing saying so. Absent
    # from the baseline snapshot and from the post-removal one alike, it shows
    # no change in the audit's step-6 diff, which then reports
    # `collateral_changes: []` — documented as the STRONGER claim than `null`.
    # An unaudited package becomes an affirmatively clean one and the pin stays
    # `removable`, so the map has to state its own coverage (issue #48).
    It 'reports how many locators it could not read, rather than dropping them silently'
      use_fixture yarn-partial-read
      When call adapter_jq '{entries_read, entries_expected, unreadable_entries, dropped: (.resolutions | has("victim"))}' resolution_map
      The status should be success
      The output should equal '{"entries_read":4,"entries_expected":5,"unreadable_entries":1,"dropped":false}'
    End

    # A fully-read lockfile says so in the same field, so the audit's rule is a
    # test on one number rather than an inference from an absence.
    It 'reports zero unreadable entries for a lockfile it read completely'
      use_fixture yarn-berry
      When call adapter_jq '.unreadable_entries' resolution_map
      The status should be success
      The output should equal '0'
    End
  End

  # A real package whose name equals another entry's install key. Both answer to
  # the name, one as what it resolves to and one as the key it is installed
  # under, so `resolved_versions` merges two different packages into one answer.
  # The direction is fail-safe — it over-reports toward `inconclusive` and
  # `still-required`, never toward `removable` — and disambiguating would mean
  # guessing which sense a caller's name was in, which the caller cannot say
  # either. So it is a documented limit (ADR 001) rather than a fix, and this is
  # the shape it applies to (issue #48).
  Describe 'a real package whose name is another entry install key'
    both_views() {
      _map=$("$ADAPTER" resolution_map | jq -c '.resolutions.lodash // []')
      _one=$("$ADAPTER" resolved_versions lodash | jq -c '[.versions[].version] | unique')
      printf 'map=%s resolved_versions=%s\n' "$_map" "$_one"
    }

    Parameters
      npm-dual-name
      yarn-dual-name
    End

    It "merges the two packages under one name in $1"
      use_fixture "$1"
      When call both_views
      The status should be success
      The output should equal 'map=["4.17.21"] resolved_versions=["1.13.6","4.17.21"]'
    End
  End
End

Describe 'node.sh why'
  After 'cleanup_fixture'

  # A parent that declares the package through an `npm:` alias declares it
  # under another name, and matching the declared key alone reported no parent
  # at all. `fix-dependency`'s failure ladder starts by scoping to a parent, so
  # a package with no parents and a copy no bare entry can move dead-ends the
  # flow on exactly the repositories where the copy is hardest to find
  # (issue #46).
  It 'names a parent that declares the package through an npm: alias'
    use_fixture npm-alias
    When call adapter_jq '.parents' why lodash
    The status should be success
    The output should equal '["alias-parent","dupe-parent"]'
  End

  It 'classifies a direct runtime dependency'
    use_fixture yarn-berry
    When call adapter_jq '{relationship, dev_only}' why express
    The status should be success
    The output should equal '{"relationship":"direct","dev_only":false}'
  End

  It 'flags a dev-only dependency'
    use_fixture yarn-berry
    When call adapter_jq '{relationship, dev_only}' why vitest
    The status should be success
    The output should equal '{"relationship":"direct","dev_only":true}'
  End

  # A lockfile v3 entry keeps each dependency block under its own key, so
  # `express` (which declares sha.js optionally) and `serve-static` (which
  # declares it as a peer) are both parents. Matching `.dependencies` alone
  # found neither, and a scoped override then skipped the parent that pulled
  # the vulnerable copy in.
  It 'reports the parents of a transitive dependency, optional and peer included'
    use_fixture npm-v3
    When call adapter_jq '{relationship, parents}' why 'sha.js'
    The status should be success
    The output should equal '{"relationship":"transitive","parents":["express","serve-static"]}'
  End

  # A root entry is not a registry parent an override can be scoped to.
  It 'excludes the npm root entry from parents'
    use_fixture npm-v3
    When call adapter_jq '[.parents[]] | sort' why lodash
    The status should be success
    The output should equal '["express","test-exclude"]'
  End

  # Berry's side of the same rule. `yarn_parents` matched the declared key
  # alone, so a parent reaching the package through an `npm:` alias reported no
  # parent at all — and with the root here never mentioning lodash,
  # `apply_constraint` had nothing to scope to and nothing to retarget: Yarn
  # Berry had no path from the alias identity shift to a fix (issue #47).
  It 'names a Yarn Berry parent that declares the package through an npm: alias'
    use_fixture yarn-berry-alias-parent
    When call adapter_jq '{relationship, parents}' why lodash
    The status should be success
    The output should equal '{"relationship":"transitive","parents":["express"]}'
  End

  # The declaration reader matched `/^  dependencies:/` alone while npm's
  # unioned dependencies + optional + peer, so a Berry parent that declares the
  # package as a peer — the reason the copy is in the tree at all — was
  # invisible to `why` and unreachable by `apply_constraint`, one block over
  # from issue #47 and contrary to what ADR 001 promised (issue #49).
  It 'names Yarn Berry parents that declare through peer and optional blocks'
    use_fixture yarn-berry-peer-parent
    When call adapter_jq '{relationship, parents}' why 'sha.js'
    The status should be success
    The output should equal '{"relationship":"transitive","parents":["express","serve-static"]}'
  End

  # The peerDependenciesMeta: exclusion is observable only at the reader's own
  # output: `why` collapses duplicate parents through sort -u and
  # `declared_ranges` reads no manifests on Berry (no node_modules), so both
  # pass unchanged even when the Meta block leaks junk rows (seventh review
  # pass proved this by patching the pattern). Extract the reader the way
  # audit_restore_spec.sh extracts the restore commands and assert its rows
  # exactly. An empty extraction produces zero lines, which the count catches,
  # so this cannot pass vacuously.
  yarn_reader_rows() {
    _prog=$(sed -n '/^YARN_DECLARATION_AWK=/,/^)$/p' "$ADAPTER")
    [ -n "$_prog" ] || return 1
    eval "$_prog"
    awk "$YARN_DECLARATION_AWK" yarn.lock
  }

  It 'reads exactly the declaration rows, with peerDependenciesMeta excluded'
    use_fixture yarn-berry-peer-parent
    When call yarn_reader_rows
    The status should be success
    The line 1 of output should equal "$(printf 'express\tsha.js\tnpm:^2.4.11')"
    The line 2 of output should equal "$(printf 'serve-static\tsha.js\tnpm:^2.4.0')"
    The lines of output should equal 2
  End

  It 'excludes the yarn workspace entry from parents'
    use_fixture yarn-berry
    When call adapter_jq '.parents' why lodash
    The status should be success
    The output should equal '["express"]'
  End

  It 'reads pnpm parents from the snapshots section'
    use_fixture pnpm-v9
    When call adapter_jq '.parents' why lodash
    The status should be success
    The output should equal '["express"]'
  End

  # Regression on PR #103's predecessor (issue #100): `pnpm_edge_rows`'s
  # output and every existing caller's reading of it (`parents`,
  # `relationship`) must be byte-for-byte unchanged for `dependencies:`
  # edges now that the same scan also feeds the peer_only conjuncts. lodash
  # here has an ordinary non-suffixed dependencies: edge, so it is not
  # peer-only.
  It "does not regress PR 3's dependency-edge reader (#100)"
    use_fixture pnpm-v9
    When call adapter_jq '{relationship, parents, peer_only, peer_parents, optional_peer_parents}' why lodash
    The status should be success
    The output should equal '{"relationship":"transitive","parents":["express"],"peer_only":false,"peer_parents":[],"optional_peer_parents":[]}'
  End

  # The redesigned #103 rule, on real pnpm 9/10 emission: peer auto-install
  # records the resolved peer as an edge INSIDE the consumer's suffixed
  # snapshot, so `parents` is NEVER empty for a peer-auto-installed package —
  # the old parents==[] conjunct could not fire on a real v9 lockfile. `vite`
  # here is declared by no importer, and both of its edges come from parent
  # keys that instantiate it: `@vitejs/plugin-react@4.3.4(vite@6.4.3)`
  # (required peer, dependencies:) and `@vitest/mocker@3.0.5(vite@6.4.3)`
  # (optional peer, optionalDependencies:). Required peers order first, and
  # the optional one is repeated in optional_peer_parents so remedy prose
  # never steers a human at a parent that merely tolerates the package.
  # Since issue #160 the parent walk reads optionalDependencies: edges too,
  # so @vitest/mocker's suffixed optional edge counts in `parents` exactly
  # as @vitejs/plugin-react's suffixed dependencies: edge always has.
  It 'classifies a peer-auto-installed package from its suffixed-key edges'
    use_fixture pnpm-peer-only
    When call adapter_jq '{relationship, parents, peer_only, peer_parents, optional_peer_parents}' why vite
    The status should be success
    The output should equal '{"relationship":"transitive","parents":["@vitejs/plugin-react","@vitest/mocker"],"peer_only":true,"peer_parents":["@vitejs/plugin-react","@vitest/mocker"],"optional_peer_parents":["@vitest/mocker"]}'
  End

  # Multi-peer and nested suffixes: next's key is
  # `next@15.1.6(@babel/core@7.29.7)(react-dom@19.2.8(react@19.2.8))(react@19.2.8)`,
  # so `react` is instantiated both in the trailing suffix and inside the
  # nested react-dom one, and its only edge lives in that snapshot. The
  # suffix matcher has to read past the first `(` to see any of this — the
  # shape the pre-redesign parser discarded outright.
  It 'reads a peer instantiation out of a multi-peer nested suffix'
    use_fixture pnpm-peer-only
    When call adapter_jq '{parents, peer_only, peer_parents, optional_peer_parents}' why react
    The status should be success
    The output should equal '{"parents":["next"],"peer_only":true,"peer_parents":["next"],"optional_peer_parents":[]}'
  End

  # The non-suffixed-edge conjunct, deciding (the `next > sharp` control,
  # a field-test PR): next's snapshot reaches sharp through
  # an ordinary `optionalDependencies:` edge and next's key carries no
  # `(sharp@`, so an override CAN reach the copy. One such edge defeats
  # peer_only — this subsumes the old optional-edge veto. Since issue #160
  # that reachable copy's parent is also REPORTED: `parents` names next,
  # the exact parent a scoped override key needs, where the
  # dependencies-only walk answered [] for a package it just called
  # reachable.
  It 'never classifies a package reached by a non-suffixed optionalDependencies edge'
    use_fixture pnpm-peer-only
    When call adapter_jq '{relationship, parents, peer_only, peer_parents}' why sharp
    The status should be success
    The output should equal '{"relationship":"transitive","parents":["next"],"peer_only":false,"peer_parents":[]}'
  End

  # The issue #160 specimen: dompurify's ONLY route into the tree is
  # jspdf's plain `optionalDependencies:` edge. The dependencies-only walk
  # returned zero parents for it, the risk score lost the whole parent
  # chain (`--declared-range none`), and an empty parent set with the
  # package genuinely present is the shape that steers a fix toward the
  # bare global override the scoped keys exist to avoid.
  It 'reads a parent that reaches the package only through optionalDependencies'
    use_fixture pnpm-optional-parent
    When call adapter_jq '{relationship, parents, peer_only, peer_parents, optional_peer_parents}' why dompurify
    The status should be success
    The output should equal '{"relationship":"transitive","parents":["jspdf"],"peer_only":false,"peer_parents":[],"optional_peer_parents":[]}'
  End

  # Same conjunct, scoped-name variant: `@babel/core` IS peer-instantiated by
  # next's `(@babel/core@7.29.7)` suffix, but @vitejs/plugin-react also
  # declares it as a plain dependency from a key with no `(@babel/core@`.
  # The scoped `(@scope/x@` suffix must be read, and the plain edge decides.
  It 'defeats peer_only on a plain edge even when a scoped suffix instantiates the package'
    use_fixture pnpm-peer-only
    When call adapter_jq '{parents, peer_only, peer_parents}' why @babel/core
    The status should be success
    The output should equal '{"parents":["@vitejs/plugin-react"],"peer_only":false,"peer_parents":["next"]}'
  End

  # The reachability conjunct, deciding: a package absent from the lockfile
  # is not direct, not in importers, and every edge to it is vacuously
  # suffixed — only "no edge and no instantiation reaches it" keeps it false.
  It 'never classifies a package the lockfile does not reach'
    use_fixture pnpm-peer-only
    When call adapter_jq '{parents, peer_only, peer_parents}' why left-pad
    The status should be success
    The output should equal '{"parents":[],"peer_only":false,"peer_parents":[]}'
  End

  # The near-miss: vite is a peer of one parent AND a plain dependency of
  # another (vite-node's key has no `(vite@`). peer_only is false and the
  # parent list is complete — the plain-edge parent is exactly the one an
  # override can scope to.
  It 'reports complete parents when a peer of one parent is a plain dependency of another'
    use_fixture pnpm-peer-near-miss
    When call adapter_jq '{relationship, parents, peer_only, peer_parents}' why vite
    The status should be success
    The output should equal '{"relationship":"transitive","parents":["@vitejs/plugin-react","vite-node"],"peer_only":false,"peer_parents":["@vitejs/plugin-react"]}'
  End

  # The importers conjunct, deciding (the reviewer-verified false positive):
  # vite here is declared ONLY by the workspace importer `packages/app`, so
  # it is not in the root manifest and its one snapshot edge is suffixed —
  # every other conjunct holds. Abandoning it as peer-only would walk away
  # from a dependency a one-line manifest edit moves.
  It 'never classifies a dependency declared by a workspace importer'
    use_fixture pnpm-workspace-peer
    When call adapter_jq '{relationship, parents, peer_only, peer_parents}' why vite
    The status should be success
    The output should equal '{"relationship":"transitive","parents":["@vitejs/plugin-react"],"peer_only":false,"peer_parents":["@vitejs/plugin-react"]}'
  End

  # The direct conjunct, deciding: same lockfile as pnpm-peer-only, but the
  # manifest declares vite (the stale-lockfile moment right after a human
  # adds the dependency, before the next install). Everything the lockfile
  # says still matches the peer-only shape; the declaration alone flips it.
  It 'never classifies a package the manifest declares directly'
    use_fixture pnpm-peer-direct
    When call adapter_jq '{relationship, peer_only, peer_parents, optional_peer_parents}' why vite
    The status should be success
    The output should equal '{"relationship":"direct","peer_only":false,"peer_parents":["@vitejs/plugin-react","@vitest/mocker"],"optional_peer_parents":["@vitest/mocker"]}'
  End

  # The lockfileVersion conjunct, deciding, and the v6 corruption regression
  # (#103 review): a v6 lockfile has no `snapshots:` section — edges live in
  # `packages:` under `/`-prefixed keys. Scanning them parsed garbage parents
  # like `/@vitejs/plugin-react` that flowed through parents_unreadable into
  # an unmatchable `/@vitejs/plugin-react>vite` override key written into a
  # real PR. The parser must read nothing here: parents exactly empty (no
  # `/`-prefixed entries), peer_only false — identical to the pre-#103
  # snapshot reader's answer for v6.
  It 'reads nothing from a v6 lockfile: no garbage parents, never peer_only'
    use_fixture pnpm-v6
    When call adapter_jq '{relationship, parents, peer_only, peer_parents, optional_peer_parents}' why vite
    The status should be success
    The output should equal '{"relationship":"transitive","parents":[],"peer_only":false,"peer_parents":[],"optional_peer_parents":[]}'
  End

  # npm and Yarn Berry never auto-install a peer the way pnpm does: a
  # required peer is always declared somewhere `parents` already reads
  # (issue #49), so peer_only is unconditionally false and both peer lists
  # unconditionally empty for them, regardless of relationship or parents.
  Describe 'peer_only is a pnpm-only mechanic'
    Parameters
      "npm-v3"        "lodash"
      "yarn-berry"    "lodash"
    End

    It "reports peer_only false and peer_parents empty for $1"
      use_fixture "$1"
      When call adapter_jq '{peer_only, peer_parents, optional_peer_parents}' why "$2"
      The status should be success
      The output should equal '{"peer_only":false,"peer_parents":[],"optional_peer_parents":[]}'
    End
  End

  # `verb_why` shells out to the real package manager for `raw` (`why_cmd`,
  # `verb_detect`'s `.why_cmd`), so these two examples put a fake `pnpm` ahead
  # of it on PATH rather than mocking a shell function: node.sh runs as its own
  # process, and shellspec's `Mock` only replaces functions/commands inside the
  # spec's own shell, not a subprocess a separate script execs.
  #
  # A large dependency tree can push real `pnpm why` output to megabytes, and
  # the field bug (issue #102) was `jq --arg raw "$raw"` overflowing the exec
  # argv at that size. A 5MB payload deterministically overflows the old
  # `--arg` form on both platforms this suite runs on: Linux caps a single
  # exec argument (`MAX_ARG_STRLEN`) at 128KB, and macOS caps the whole argv
  # (`ARG_MAX`) around 1MB, so 5MB clears both ceilings without depending on
  # the exact machine or CI image — see the regression example below. What
  # the first two examples pin instead is (1) that content real `why` output
  # can contain — a subshell substitution, quotes, braces, an embedded
  # newline — survives the `--rawfile` channel byte for byte, and (2) that
  # the script mechanically no longer has a path that could regress to the
  # argv-overflowing form; the grep pins stay as belt-and-suspenders even
  # though the payload example now exercises the failure directly.
  Describe 'the raw field, since #102 moved it off argv onto --rawfile'
    raw_content_via_mock() {
      mock_bin_dir=$(mktemp -d)
      cat > "$mock_bin_dir/pnpm" <<'MOCK'
#!/bin/sh
printf 'chain: %s\nsubshell $(rm -rf /tmp/x) here\nquote "value" and {brace} token\n' "$2"
MOCK
      chmod +x "$mock_bin_dir/pnpm"
      PATH="$mock_bin_dir:$PATH"
      adapter_jq '{raw}' why lodash
      _st=$?
      rm -rf "$mock_bin_dir"
      return "$_st"
    }

    It 'round-trips shell-metacharacter and newline content through --rawfile intact'
      use_fixture pnpm-v9
      expected_raw=$(printf "chain: %s\\nsubshell \$(rm -rf /tmp/x) here\\nquote \"value\" and {brace} token\\n" lodash)
      expected=$(jq -cn --arg raw "$expected_raw" '{raw:$raw}')
      When call raw_content_via_mock
      The status should be success
      The output should equal "$expected"
    End

    It 'no longer passes raw to jq via --arg'
      When call grep -c -- '--arg raw' "$ADAPTER"
      The status should equal 1
      The output should equal '0'
    End

    It 'passes raw to jq via --rawfile'
      When call grep -c -- '--rawfile raw' "$ADAPTER"
      The status should be success
      The output should equal '1'
    End

    # POSIX sh in the fake pnpm (no bash-only builtins), so the 5MB payload
    # is generated with dd + tr rather than a shell string-doubling loop.
    # 5120 * 1024 = 5242880 bytes, safely above both the Linux MAX_ARG_STRLEN
    # (128KB) and macOS ARG_MAX (~1MB) ceilings the old `--arg raw "$raw"`
    # form was subject to.
    large_raw_via_mock() {
      mock_bin_dir=$(mktemp -d)
      cat > "$mock_bin_dir/pnpm" <<'MOCK'
#!/bin/sh
dd if=/dev/zero bs=1024 count=5120 2>/dev/null | tr '\0' 'x'
printf '\n'
MOCK
      chmod +x "$mock_bin_dir/pnpm"
      PATH="$mock_bin_dir:$PATH"
      adapter_jq '{len: (.raw | length)}' why lodash
      _st=$?
      rm -rf "$mock_bin_dir"
      return "$_st"
    }

    It 'streams a 5MB why payload through --rawfile without overflowing argv'
      use_fixture pnpm-v9
      When call large_raw_via_mock
      The status should be success
      The output should equal '{"len":5242880}'
    End
  End
End
