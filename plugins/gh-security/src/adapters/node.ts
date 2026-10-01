// The node adapter, behind the interface in `adapter.ts`, for GitHub's `npm`
// advisory ecosystem: the nine read verbs of #221 (eight from `node.sh`, and
// `parents`), and the verbs of #222. Each verb has its own file under
// `node/`.
//
// This file ships. It imports nothing outside the plugin.

import { notImplemented } from '../lib/envelope.ts'
import type { Adapter } from './adapter.ts'
import { declaredRanges } from './node/declared-ranges.ts'
import { detect, type NodeDetection } from './node/detect.ts'
import { listPins } from './node/list-pins.ts'
import { resolutionMap, resolvedVersions } from './node/lockfiles.ts'
import { parents } from './node/parents.ts'
import { compareVersions, rangeFacts } from './node/semver.ts'
import { why } from './node/why.ts'

export const node: Adapter<NodeDetection> = {
  detect,
  resolvedVersions,
  resolutionMap,
  parents,
  why,
  declaredRanges,
  listPins,
  compareVersions,
  rangeFacts,
  validate: () => notImplemented('validate'),
  install: async () => notImplemented('install'),
  shim: () => notImplemented('shim'),
  applyConstraint: () => notImplemented('apply_constraint'),
}
