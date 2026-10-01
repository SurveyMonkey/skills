// Parity for the adapter registry (RFC 002, "Parity is the migration
// strategy"). It runs the single mode of `scripts/common/select-adapter.sh`
// and `selectAdapter` on the same ecosystem and manifest, and compares the
// whole answer. The `--from-discovery` batch mode of the script is the first
// step of `classify-lines`, and `parity-classify-lines.test.ts` compares it.
//
// One difference is declared. The script answers `adapter_path`, the path of
// the bash adapter. The registry answers the adapter itself, in process, and
// has no path. So `adapter_path` is dropped from the bash side, and the test
// asserts that the registry gives the node adapter in its place.
//
// A second difference is declared. The script refuses an empty `--ecosystem`
// with exit 1. The registry is a pure function, so it answers `supported:
// false` for an empty name. The caller of the registry validates its own
// input.
import { describe, expect, it } from 'vitest'

import { node } from '#gh-security/adapters/node.ts'
import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { JsonValue } from '#gh-security/lib/envelope.ts'
import { firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'

const SCRIPT = pluginFile('gh-security', 'scripts', 'common', 'select-adapter.sh')

/** The registry's answer, in the script's field names. */
const typescriptSide = (ecosystem: string, manifest: string | null): JsonValue => {
  const route = selectAdapter(ecosystem, manifest)
  return {
    ecosystem: route.ecosystem,
    supported: route.supported,
    adapter: route.name,
    manifest: route.manifest,
    skip: !route.supported,
    reason: route.supported ? null : route.reason,
  }
}

const bashSide = (ecosystem: string, manifest: string | null): JsonValue => {
  const args = ['--ecosystem', ecosystem, ...(manifest === null ? [] : ['--manifest', manifest])]
  const result = runBash({ command: SCRIPT, args })
  expect(result.status).toBe(0)
  const answer = JSON.parse(result.stdout) as { [key: string]: JsonValue }
  const { adapter_path: adapterPath, ...rest } = answer
  // The script answers a path for a supported ecosystem, and null for the rest.
  expect(adapterPath === null).toBe(rest.supported === false)
  return rest
}

describe('select-adapter parity', () => {
  it.each([
    ['npm'],
    ['pip'],
    ['rubygems'],
    ['maven'],
    ['go'],
    ['rust'],
    ['actions'],
    ['other'],
    ['NPM'],
    ['npm '],
    ['constructor'],
    ['__proto__'],
    ['toString'],
  ])('routes the ecosystem %s the same way', (ecosystem) => {
    expect(firstDifference(bashSide(ecosystem, null), typescriptSide(ecosystem, null))).toBeNull()
  })

  it.each([
    ['npm', 'packages/web/package.json'],
    ['pip', 'requirements.txt'],
  ])('carries the manifest of %s through the same way', (ecosystem, manifest) => {
    expect(
      firstDifference(bashSide(ecosystem, manifest), typescriptSide(ecosystem, manifest)),
    ).toBeNull()
  })

  it('gives the node adapter itself for npm, where the script gives a path', () => {
    const route = selectAdapter('npm')
    expect(route.adapter).toBe(node)
  })

  it('declares the empty ecosystem: the script refuses it, the registry answers unsupported', () => {
    expect(runBash({ command: SCRIPT, args: ['--ecosystem', ''] }).status).toBe(1)
    expect(selectAdapter('').supported).toBe(false)
  })
})
