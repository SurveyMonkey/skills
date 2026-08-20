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
  # cannot mean what it means for the lockfile parsers.
  Describe 'manifests with no pins'
    Parameters
      'no override block' no-overrides '{"block_present":false,"count":0,"pins":[]}'
      'empty manifest'    empty-yarn   '{"block_present":false,"count":0,"pins":[]}'
    End

    It "reports $1 as empty rather than failing"
      use_fixture "$2"
      When call pins '{block_present, count, pins}'
      The status should be success
      The output should equal "$3"
    End
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
End
