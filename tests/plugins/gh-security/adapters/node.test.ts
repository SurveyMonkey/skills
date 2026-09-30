// The node adapter as a whole (#221). The verbs that this layer ports have
// their own files under `node/`. This file holds the four verbs that the
// second layer of #221 ports: until then, each answers `not-implemented`
// (ADR 001, exit 2), which a caller must not read as a failure.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { node } from '#gh-security/adapters/node.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'

const root = join(FIXTURES_ROOT, 'npm-v3')

const treeOf = () => {
  const detection = node.detect(root, { PATH: '' })
  if (detection.outcome !== 'ok') throw new Error(`detect refused ${root}: ${detection.error}`)
  return { root, detection: detection.value }
}

describe('the verbs that are not built yet', () => {
  it('answers not-implemented for each, with its verb named', async () => {
    const tree = treeOf()
    expect([
      await node.why(tree, 'lodash', { raw: '' }),
      node.declaredRanges(tree, 'lodash', null),
      node.listPins(tree),
    ]).toEqual([
      { outcome: 'not-implemented', error: 'why is not implemented' },
      { outcome: 'not-implemented', error: 'declared_ranges is not implemented' },
      { outcome: 'not-implemented', error: 'list_pins is not implemented' },
    ])
  })
})
