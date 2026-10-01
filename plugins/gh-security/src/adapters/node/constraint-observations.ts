// The observations of `apply_constraint` (#222): override entries that the
// call saw and did not change. Each one is a lead for the pin audit (#7),
// not a defect.
//
//   - `unscoped_override`: a bare entry of the block. "Bare" is per syntax.
//     pnpm scopes with `>`, so a key with no `>` is bare. Yarn scopes with
//     `/`, which a scoped name holds too: `@scope/name` is bare, and
//     `@scope/name/dep` and `parent/dep` are not. Each npm key is bare.
//   - `manifest_pnpm_overrides_ignored`: the live block is in
//     pnpm-workspace.yaml, and package.json still has `pnpm.overrides`
//     entries (#159).
//   - `pnpm_major_unknown`: the block is in package.json only because
//     `packageManager` pins no pnpm major (#159).
//
// This file ships. It imports nothing outside the plugin.

import type { ApplyConstraintAnswer } from '../adapter.ts'
import type { NodeDetection } from './detect.ts'
import { entriesOf, get, or, split } from './jq-json.ts'
import { isRecord } from './manifest.ts'
import { byText } from './parents.ts'

type Observation = ApplyConstraintAnswer['observations'][number]

/** `is_bare`, for the syntax of the location. */
const isBare = (location: NodeDetection['override_location'], key: string): boolean => {
  if (location === 'pnpm.overrides') return !key.includes('>')
  if (location === 'resolutions')
    return split(key, '/').slice(key.startsWith('@') ? 2 : 1).length === 0
  return true
}

/** The bare entries of the block that hold a text, in block order. */
export const unscopedOverrides = (
  location: NodeDetection['override_location'],
  block: unknown,
  pkg: string,
): Observation[] =>
  entriesOf(or(block, {})).flatMap(([key, value]): Observation[] =>
    typeof value === 'string' && isBare(location, key)
      ? [
          {
            type: 'unscoped_override',
            key,
            range: value,
            targets_this_package: key === pkg || key.startsWith(`${pkg}@`),
          },
        ]
      : [],
  )

/**
 * `(.pnpm.overrides // {}) | keys` of package.json, sorted. It throws where
 * jq stops. For a list, jq answers its indexes. The port refuses a list, as
 * `list_pins` does: a declared divergence.
 */
const manifestOverrideKeys = (manifest: unknown): readonly string[] => {
  const overrides = or(get(get(manifest, 'pnpm'), 'overrides'), {})
  if (!isRecord(overrides)) throw new Error('pnpm.overrides of package.json is not an object')
  return Object.keys(overrides).sort(byText)
}

/** The two observations of pnpm, after the unscoped ones. */
export const pnpmObservations = (
  detection: Extract<NodeDetection, { pm: 'pnpm' }>,
  manifest: unknown,
): Observation[] => {
  const keys = manifestOverrideKeys(manifest)
  const { override_file: file, pnpm_major: major } = detection
  return [
    ...(file === 'pnpm-workspace.yaml' && keys.length > 0
      ? [{ type: 'manifest_pnpm_overrides_ignored' as const, keys, pnpm_major: major }]
      : []),
    ...(file === 'package.json' && major === null ? [{ type: 'pnpm_major_unknown' as const }] : []),
  ]
}
