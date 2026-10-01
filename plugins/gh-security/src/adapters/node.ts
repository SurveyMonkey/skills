// The node adapter for GitHub's `npm` advisory ecosystem, behind the
// interface in `adapter.ts`. It has the nine read verbs of #221 (eight from
// `node.sh`, and `parents`), and the verbs of #222. Each verb, or group of
// verbs, has its own file under `node/`.
//
// This file ships. It imports nothing outside the plugin.

import type { Adapter } from './adapter.ts'
import { applyConstraint } from './node/apply-constraint.ts'
import { declaredRanges } from './node/declared-ranges.ts'
import { detect, type NodeDetection } from './node/detect.ts'
import { install } from './node/install.ts'
import { listPins } from './node/list-pins.ts'
import { resolutionMap, resolvedVersions } from './node/lockfiles.ts'
import { parents } from './node/parents.ts'
import { compareVersions, rangeFacts } from './node/semver.ts'
import { shim } from './node/shim.ts'
import { validate } from './node/validate.ts'
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
  validate,
  install,
  shim,
  applyConstraint,
}
