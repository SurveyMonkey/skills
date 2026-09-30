// `detect` for the node adapter, ported from `verb_detect` and `detect_raw`
// in node.sh (#221).
//
// This file ships. It imports nothing outside the plugin.

import { type Envelope, notImplemented } from '../../lib/envelope.ts'
import type { Environment } from '../adapter.ts'

/** The fields that every node detection carries. */
type Common = {
  /** How to run the package manager: a bare name, `node <yarnPath>`, or `corepack <name>`. */
  readonly pm_exec: string
  readonly install_cmd: string
  readonly why_cmd: string
  readonly supports_scoping: true
}

/** What `detect` finds in a tree that one of the three supported managers owns. */
export type NodeDetection =
  | (Common & {
      readonly pm: 'pnpm'
      readonly lockfile: 'pnpm-lock.yaml'
      readonly override_location: 'pnpm.overrides'
      readonly override_file: 'package.json' | 'pnpm-workspace.yaml'
      /** The major that `packageManager` pins, or null when it pins no pnpm major. */
      readonly pnpm_major: number | null
      readonly override_syntax: 'parent>dep'
    })
  | (Common & {
      readonly pm: 'yarn'
      readonly lockfile: 'yarn.lock'
      readonly override_location: 'resolutions'
      readonly override_file: 'package.json'
      readonly override_syntax: 'parent/dep'
    })
  | (Common & {
      readonly pm: 'npm'
      readonly lockfile: 'package-lock.json'
      readonly override_location: 'overrides'
      readonly override_file: 'package.json'
      readonly override_syntax: 'nested'
    })

export const detect = (_root: string, _env: Environment): Envelope<NodeDetection> =>
  notImplemented('detect')
