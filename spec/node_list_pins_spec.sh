#!/bin/sh
# shellcheck shell=sh
# node.sh list_pins: every override/resolution entry, parsed.
#
# The pin audit reads nothing else to learn what a repository has pinned, so a
# key it splits wrongly is a pin the audit either never tests or tests as the
# wrong package. Each package manager's key syntax is ambiguous in its own way
# and every ambiguity below is a real form found in real manifests.

Describe 'node.sh list_pins'
  After 'cleanup_fixture'

  pins() { adapter_jq "$1" list_pins; }

  Describe 'scoping'
    # pnpm scopes with `>`, yarn with `/` (which also separates a scoped
    # package name), npm by nesting objects.
    Parameters
      pnpm  pnpm-v9    '[.pins[] | select(.scope == "scoped") | {key, package, parents}]' '[{"key":"express>sha.js","package":"sha.js","parents":["express"]}]'
      yarn  yarn-berry '[.pins[] | select(.scope == "scoped") | {key, package, parents}]' '[{"key":"express/sha.js","package":"sha.js","parents":["express"]}]'
      npm   npm-v3     '[.pins[] | select(.scope == "scoped") | {key, package, parents}]' '[{"key":"test-exclude","package":"lodash","parents":["test-exclude"]}]'
    End

    It "reads a scoped entry for $1"
      use_fixture "$2"
      When call pins "$3"
      The status should be success
      The output should equal "$4"
    End
  End

  Describe 'bare entries'
    # A bare entry pins the package for every consumer in the tree. It is what
    # apply_constraint already reports as an observation, and the audit is what
    # actually tests whether it is still needed.
    Parameters
      pnpm  pnpm-v9    '{bare: [.pins[] | select(.scope == "bare") | .package] | sort, n: .bare_count}' '{"bare":["handlebars","lodash"],"n":2}'
      yarn  yarn-berry '{bare: [.pins[] | select(.scope == "bare") | .package] | sort, n: .bare_count}' '{"bare":["@babel/core"],"n":1}'
      npm   npm-v3     '{bare: [.pins[] | select(.scope == "bare") | .package] | sort, n: .bare_count}' '{"bare":["lodash"],"n":1}'
    End

    It "counts bare entries for $1"
      use_fixture "$2"
      When call pins "$3"
      The status should be success
      The output should equal "$4"
    End
  End

  # For yarn, `@babel/core` is one package name and `@vercel/fun/undici` is a
  # parent and a dependency. Naive slash-splitting reads the first as a pin on
  # `core` scoped to `@babel`, which is a package that does not exist.
  Describe 'yarn keys'
    Parameters
      'scoped package name'   '"@babel/core"'         '{"package":"@babel/core","parents":[],"scope":"bare"}'
      'scoped parent'         '"@vercel/fun/undici"'  '{"package":"undici","parents":["@vercel/fun"],"scope":"scoped"}'
      'scoped dependency'     '"webpack/@types/node"' '{"package":"@types/node","parents":["webpack"],"scope":"scoped"}'
      'parent with a range'   '"lodash@^3/minimist"'  '{"package":"minimist","parents":["lodash@^3"],"scope":"scoped"}'
    End

    It "reads a $1"
      use_fixture yarn-pins
      When call pins "[.pins[] | select(.key == $2) | {package, parents, scope}]"
      The status should be success
      The output should equal "[$3]"
    End
  End

  # An alias resolution redirects to a different package entirely. Reading its
  # value as a version range would have the audit reasoning about the "range"
  # of a pin that was never about a version, and reporting the wrong package.
  Describe 'values that are not version ranges'
    Parameters
      alias      yarn-pins '"@next/env"' '{"kind":"alias","range":null,"alias_package":"@varlock/nextjs-integration","alias_range":"1.1.6"}'
      protocol   yarn-pins '"left-pad"'  '{"kind":"protocol","range":null,"alias_package":null,"alias_range":null}'
      reference  npm-pins  '"lodash"'    '{"kind":"reference","range":null,"alias_package":null,"alias_range":null}'
    End

    It "classifies a $1 value"
      use_fixture "$2"
      When call pins "[.pins[] | select(.key == $3) | {kind, range, alias_package, alias_range}] | first"
      The status should be success
      The output should equal "$4"
    End
  End

  # The version after the last `@` is optional, and its absence is not a reason
  # to read the package name as a range. Reported as `{kind:"range", range:
  # "esbuild-wasm"}`, the audit would test — and could report as removable —
  # an entry that decides which package ships.
  Describe 'an alias with no version'
    Parameters
      unscoped '"uuid"'         '{"kind":"alias","alias_package":"short-uuid","alias_range":null,"range":null}'
      scoped   '"@vercel/ncc"'  '{"kind":"alias","alias_package":"@vercel/nft","alias_range":null,"range":null}'
    End

    It "is still an alias when the target is $1"
      use_fixture yarn-pins
      When call pins "[.pins[] | select(.key == $2) | {kind, alias_package, alias_range, range}] | first"
      The status should be success
      The output should equal "$3"
    End
  End

  # A value the adapter's range parser rejects is reported as unreadable rather
  # than guessed at. The hyphen range is a legitimate npm range this evaluator
  # does not implement, and it lands here honestly instead of being scored.
  Describe 'values the range parser cannot read'
    Parameters
      'a dist-tag'      '"minimist"' '"latest"'
      'a hyphen range'  '"debug"'    '"1.2.7 - 1.3.0"'
    End

    It "reports $1 as unparseable, keeping the raw value"
      use_fixture yarn-pins
      When call pins "[.pins[] | select(.key == $2) | {kind, range, value}] | first"
      The status should be success
      The output should equal "{\"kind\":\"unparseable\",\"range\":null,\"value\":$3}"
    End
  End

  It 'names the target package of an aliased pnpm override'
    use_fixture pnpm-pins
    When call pins '[.pins[] | select(.key == "esbuild") | {kind, alias_package}]'
    The status should be success
    The output should equal '[{"kind":"alias","alias_package":"esbuild-wasm"}]'
  End

  # pnpm allows a version selector on either side of the `>`, and a scoped
  # package name begins with an `@` that is not one.
  Describe 'pnpm keys'
    Parameters
      'version selector'    pnpm-v9   '"handlebars@4"'                         '{"package":"handlebars","selector":"4","parents":[]}'
      'scoped package name' pnpm-pins '"@babel/core"'                          '{"package":"@babel/core","selector":null,"parents":[]}'
      'parent selector'     pnpm-pins '"vite@7>rollup"'                        '{"package":"rollup","selector":null,"parents":["vite@7"]}'
      'scoped parent'       pnpm-pins '"@vercel/fun>undici"'                   '{"package":"undici","selector":null,"parents":["@vercel/fun"]}'
      'nested chain'        pnpm-pins '"webpack>terser-webpack-plugin>terser"' '{"package":"terser","selector":null,"parents":["webpack","terser-webpack-plugin"]}'
    End

    It "reads a $1"
      use_fixture "$2"
      When call pins "[.pins[] | select(.key == $3) | {package, selector, parents}] | first"
      The status should be success
      The output should equal "$4"
    End
  End

  Describe 'npm nesting'
    It 'walks past the first level'
      use_fixture npm-pins
      When call pins '[.pins[] | select(.package == "brace-expansion") | {path, parents}]'
      The status should be success
      The output should equal '[{"path":["glob","minimatch","brace-expansion"],"parents":["glob","minimatch"]}]'
    End

    # `{"rimraf": {".": "^5.0.0"}}` pins rimraf itself, not a dependency of it,
    # so it is a bare pin wearing a nested shape.
    It 'reads a "." key as the parent itself, and as bare'
      use_fixture npm-pins
      When call pins '[.pins[] | select(.path[-1] == ".") | {package, parents, scope, range}]'
      The status should be success
      The output should equal '[{"package":"rimraf","parents":[],"scope":"bare","range":"^5.0.0"}]'
    End

    It 'keeps a sibling of the "." key scoped to its parent'
      use_fixture npm-pins
      When call pins '[.pins[] | select(.path == ["rimraf","glob"]) | {package, parents, scope}]'
      The status should be success
      The output should equal '[{"package":"glob","parents":["rimraf"],"scope":"scoped"}]'
    End

    It 'keeps a scoped parent name whole'
      use_fixture npm-pins
      When call pins '[.pins[] | select(.package == "semver") | .parents]'
      The status should be success
      The output should equal '[["@babel/core"]]'
    End
  End

  # A manifest with no override block is a legitimate empty answer, not a
  # parser failure: this verb reads structured JSON, so "found nothing" here
  # cannot mean what it means for the lockfile parsers. Each package manager
  # reads a different key, so each needs its own absent-block case.
  Describe 'manifests with no pins'
    Parameters
      'a yarn manifest with no resolutions'  no-overrides      '{"block_present":false,"count":0,"pins":[]}'
      'an empty yarn manifest'               empty-yarn        '{"block_present":false,"count":0,"pins":[]}'
      'an npm manifest with no overrides'    empty-npm         '{"block_present":false,"count":0,"pins":[]}'
      'a pnpm manifest with no pnpm block'   pnpm-no-overrides '{"block_present":false,"count":0,"pins":[]}'
    End

    It "reports $1 as empty rather than failing"
      use_fixture "$2"
      When call pins '{block_present, count, pins}'
      The status should be success
      The output should equal "$3"
    End
  End

  # An override block that exists but holds no entries is a third state, and
  # `block_present` is what separates it from a manifest that never had one.
  Describe 'an override block that is present and empty'
    put() { jq "$1 = $2" package.json > pkg.tmp && mv pkg.tmp package.json; }

    Parameters
      npm  npm-v3    '.overrides'      '{}'
      pnpm pnpm-v9   '.pnpm.overrides' '{}'
      yarn yarn-berry '.resolutions'   '{}'
    End

    It "reports an empty $1 block as present with no pins"
      use_fixture "$2"
      put "$3" "$4"
      When call pins '{block_present, count, bare_count}'
      The status should be success
      The output should equal '{"block_present":true,"count":0,"bare_count":0}'
    End
  End

  # The failure this guards: coercing a non-object block to {} emitted
  # `count: 0`, byte-identical to a manifest that genuinely pins nothing — and
  # the audit stops on `count: 0`. A corrupted manifest would audit clean,
  # which is the v0.1.0 "found nothing means all clear" class exactly.
  Describe 'an override block that is not an object'
    put() { jq "$1 = $2" package.json > pkg.tmp && mv pkg.tmp package.json; }

    Parameters
      'a string'  npm-v3     '.overrides'      '"oops"'
      'an array'  pnpm-v9    '.pnpm.overrides' '["oops"]'
      'a number'  yarn-berry '.resolutions'    '42'
    End

    It "fails rather than reporting no pins when the block is $1"
      use_fixture "$2"
      put "$3" "$4"
      When run script "$ADAPTER" list_pins
      The status should equal 1
      The stderr should include 'not an object of override entries'
    End
  End

  # `.pnpm.overrides` raises when `.pnpm` is a string, which would abort the
  # whole jq program rather than reach the check above.
  It 'fails when the container holding the block is not an object'
    use_fixture pnpm-v9
    jq '.pnpm = "oops"' package.json > pkg.tmp && mv pkg.tmp package.json
    When run script "$ADAPTER" list_pins
    The status should equal 1
    The stderr should include 'cannot be read'
  End

  It 'names the block it read'
    use_fixture pnpm-v9
    When call pins '{pm, override_location}'
    The status should be success
    The output should equal '{"pm":"pnpm","override_location":"pnpm.overrides"}'
  End

  It 'refuses a toolchain the adapter does not support'
    use_fixture yarn-classic
    When run script "$ADAPTER" list_pins
    The status should equal 3
    The stderr should include 'Yarn Classic'
  End

  # The whole chain the audit walks, in one example, because each half looked
  # healthy on its own: `list_pins` hands the audit the key an override for an
  # aliased dependency actually carries, and `resolved_versions` used to answer
  # `present: false` for exactly that name. agents/audit-pins.md turns that into
  # "the package left the tree entirely → removable", and the cross-check does
  # not fire, because the map has no entry under the alias key either, so both
  # sides normalize to [] and agree. Every guard passes and a pin on a real
  # package is recommended for deletion (issue #46).
  #
  # The pin carrying that shape is a **range** keyed on an alias name
  # (`"lodash-alias": ">=4.18.0"`), not `"lodash-alias": "npm:lodash@4.18.2"`.
  # The latter classifies `kind: alias`, which phase 2 files as
  # `not-a-version-pin` and never tests, so it can never reach the phase-6
  # exception it was used to illustrate; audit-pins.md pointed at that
  # unreachable specimen and no fixture carried the reachable one (issue #48).
  Describe 'an override keyed on an alias name'
    pin_then_resolve() {
      _kind=$("$ADAPTER" list_pins \
        | jq -c '[.pins[] | select(.package == "lodash-alias") | {kind, scope, range}]')
      _res=$("$ADAPTER" resolved_versions lodash-alias | jq -c '{present, versions: [.versions[].version]}')
      _map=$("$ADAPTER" resolution_map | jq -c '.resolutions["lodash-alias"] // []')
      printf 'pin=%s resolved=%s map=%s\n' "$_kind" "$_res" "$_map"
    }

    It 'is a testable range pin, resolves under that name, and has no map entry'
      use_fixture npm-alias
      When call pin_then_resolve
      The status should be success
      The output should equal 'pin=[{"kind":"range","scope":"bare","range":">=4.18.0"}] resolved={"present":true,"versions":["4.18.1"]} map=[]'
    End
  End
End

# The live pnpm override block can sit in pnpm-workspace.yaml (issue #159:
# pnpm 11 no longer reads package.json's `pnpm` field). The audit reads
# nothing but list_pins to learn what a repository has pinned, so pins read
# from the dead field would be audited — and removed — as if they were in
# effect, and pins in the workspace block would be invisible.
Describe 'node.sh list_pins workspace override file (issue #159)'
  After 'cleanup_fixture'

  It 'reads the pins from the workspace overrides block and names the file'
    use_fixture pnpm11-workspace-overrides
    When call adapter_jq '{override_file, block_present, keys: [.pins[].key] | sort}' list_pins
    The status should be success
    The output should equal '{"override_file":"pnpm-workspace.yaml","block_present":true,"keys":["form-data","js-yaml","undici","ws"]}'
  End

  # A dead entry is not a pin the repository has: pnpm does not read it, so
  # reporting it would send the audit off to test an override with no effect.
  It 'does not report package.json pnpm.overrides entries the pnpm major ignores'
    use_fixture pnpm11-workspace-overrides
    jq '.pnpm = {overrides: {"left-pad": ">=1.3.0"}}' package.json > p.json && mv p.json package.json
    When call adapter_jq '[.pins[].key] | sort' list_pins
    The status should be success
    The output should equal '["form-data","js-yaml","undici","ws"]'
  End

  It 'reports no block on a pnpm 11 repo whose workspace file has no overrides'
    use_fixture pnpm-cross-line
    jq '.packageManager = "pnpm@11.9.0"' package.json > p.json && mv p.json package.json
    When call adapter_jq '{override_file, block_present, count}' list_pins
    The status should be success
    The output should equal '{"override_file":"pnpm-workspace.yaml","block_present":false,"count":0}'
  End
End
