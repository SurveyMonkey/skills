// The verb table of the node adapter (#222). Each verb has its own tests
// under `node/`. This file holds the entry of the last verb that #222 ports.
import { describe, expect, it } from 'vitest'

import { applyConstraint } from '#gh-security/adapters/node/apply-constraint.ts'
import { node } from '#gh-security/adapters/node.ts'

describe('the node adapter', () => {
  it('answers apply_constraint with the port of layer 2 of #222', () => {
    expect(node.applyConstraint).toBe(applyConstraint)
  })
})
