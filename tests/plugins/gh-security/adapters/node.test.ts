// The verb table of the node adapter (#222). Each verb has its own tests
// under `node/`. This file holds the verb that is not built yet.
import { describe, expect, it } from 'vitest'

import { node } from '#gh-security/adapters/node.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'

describe('the node adapter', () => {
  it('answers not-implemented for apply_constraint until layer 2 of #222 ports it', () => {
    const root = `${FIXTURES_ROOT}/npm-v3`
    const detection = node.detect(root, {})
    if (detection.outcome !== 'ok') throw new Error(detection.error)
    expect(
      node.applyConstraint(
        { root, detection: detection.value },
        { pkg: 'lodash', range: '>=4.17.21 <5', parents: [], tightenBare: false },
      ),
    ).toEqual({ outcome: 'not-implemented', error: 'apply_constraint is not implemented' })
  })
})
