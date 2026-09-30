// The node adapter: the nine read verbs of #221 (eight from `node.sh`, and
// `parents`), behind the interface in `adapter.ts`, for GitHub's `npm`
// advisory ecosystem.
//
// `parents`, `why`, `declared_ranges` and `list_pins` answer
// `not-implemented` (ADR 001, exit 2). The second layer of #221 ports them.
//
// This file ships. It imports nothing outside the plugin.

import { notImplemented } from '../lib/envelope.ts'
import type { Adapter } from './adapter.ts'
import { detect, type NodeDetection } from './node/detect.ts'
import { resolutionMap, resolvedVersions } from './node/lockfiles.ts'
import { compareVersions, rangeFacts } from './node/semver.ts'

export const node: Adapter<NodeDetection> = {
  detect,
  resolvedVersions,
  resolutionMap,
  parents: () => notImplemented('parents'),
  why: async () => notImplemented('why'),
  declaredRanges: () => notImplemented('declared_ranges'),
  listPins: () => notImplemented('list_pins'),
  compareVersions,
  rangeFacts,
}
