// The node adapter: the verbs of `node.sh` behind the interface in
// `adapter.ts`, for GitHub's `npm` advisory ecosystem (#221).
//
// This file ships. It imports nothing outside the plugin.

import { notImplemented } from '../lib/envelope.ts'
import type { Adapter } from './adapter.ts'
import { detect, type NodeDetection } from './node/detect.ts'

export const node: Adapter<NodeDetection> = {
  detect,
  resolvedVersions: () => notImplemented('resolved_versions'),
  resolutionMap: () => notImplemented('resolution_map'),
  parents: () => notImplemented('parents'),
  why: async () => notImplemented('why'),
  declaredRanges: () => notImplemented('declared_ranges'),
  listPins: () => notImplemented('list_pins'),
  compareVersions: () => notImplemented('compare_versions'),
  rangeFacts: () => notImplemented('range_facts'),
}
