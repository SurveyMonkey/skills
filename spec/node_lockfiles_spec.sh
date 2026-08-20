#!/bin/sh
# shellcheck shell=sh
# node.sh detect, resolved_versions, why, and verification_commands.
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

  Describe 'the empty-parse guard'
    # A whole-tree diff against an empty map reports every package unchanged,
    # which is the wrong-safe answer this plugin exists to avoid.
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
End

Describe 'node.sh why'
  After 'cleanup_fixture'

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
End

Describe 'node.sh verification_commands'
  After 'cleanup_fixture'

  It 'prefixes each script with the runnable pm_exec'
    use_fixture npm-v3
    When call adapter_jq '.commands | sort' verification_commands
    The status should be success
    The output should equal '["npm build","npm test"]'
  End

  It 'skips long-running servers'
    use_fixture npm-v3
    When call adapter_jq '.skipped' verification_commands
    The status should be success
    The output should equal '["start"]'
  End

  # Matching only the whole name would run test:watch forever; matching any
  # segment would drop storybook:build, which is a real check.
  It 'skips test:watch but keeps storybook:build'
    use_fixture yarn-berry
    When call adapter_jq '{skipped: (.skipped | sort), keeps_build: (.commands | any(test("storybook:build")))}' verification_commands
    The status should be success
    The output should equal '{"skipped":["dev","storybook","test:watch"],"keeps_build":true}'
  End
End
