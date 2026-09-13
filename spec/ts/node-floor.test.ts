// The Node-floor check (ADR 012, issue #214's ruling comment). The seam is
// the exported function: `assertNodeFloor` takes a version string rather than
// reading `process.version`, so every row below is a real verdict rather than
// a fact about the machine running the suite. `bin/gh-security.ts` passes
// `process.version` to it when that entry point lands (#224).
//
// Every expected value here is hand-written from ADR 012's spike table
// (docs/adr/012-typescript-on-node-22-18.md): 22.16 and 22.17 fail at launch,
// 22.18.0 is the first release that runs with zero bytes on stderr, and
// 22.22.2, 24.15.0 and 24.18.0 run. None of it is recomputed the way the
// module computes it.
import { describe, expect, it } from 'vitest'

import {
  assertNodeFloor,
  NODE_FLOOR,
  NodeFloorError,
} from '../../plugins/gh-security/src/lib/node-floor.ts'

describe('assertNodeFloor', () => {
  it('states the floor ADR 012 decided', () => {
    expect(NODE_FLOOR).toBe('22.18.0')
  })

  // `v`-prefixed because that is the shape `process.version` has; the bare
  // spelling is here because a version read from anywhere else does not carry
  // the prefix, and one spelling passing while the other throws would be a
  // launch-time failure on a supported runtime.
  it.each([
    ['v22.18.0'],
    ['22.18.0'],
    ['v22.22.2'],
    ['v24.15.0'],
    ['v24.18.0'],
    ['v26.0.0'],
  ])('accepts %s, at or above the floor', (version) => {
    expect(() => {
      assertNodeFloor(version)
    }).not.toThrow()
  })

  it.each([
    ['v22.17.1'],
    ['v22.17.0'],
    ['v22.16.0'],
    ['v20.19.0'],
    ['v18.20.8'],
  ])('refuses %s, below the floor', (version) => {
    expect(() => {
      assertNodeFloor(version)
    }).toThrow(NodeFloorError)
  })

  it('names both the required and the running version', () => {
    let thrown: unknown
    try {
      assertNodeFloor('v22.17.1')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(NodeFloorError)
    // The message is what a user sees at launch instead of a working plugin
    // (ADR 012, Consequences), so it has to say what is required and what
    // they are actually running. A message naming only one of the two leaves
    // them guessing which half to change.
    const message = (thrown as NodeFloorError).message
    expect(message).toContain('22.18.0')
    expect(message).toContain('22.17.1')
    expect((thrown as NodeFloorError).name).toBe('NodeFloorError')
  })

  // A version string the check cannot read is not evidence that the floor is
  // met. Passing an unparsable value is the found-nothing-is-a-pass shape
  // every gate in this repository refuses, arriving inside the runtime check.
  it.each([['banana'], [''], ['v22'], ['22.18'], ['v22.18.x']])(
    'refuses %s, which it cannot read as a version',
    (version) => {
      expect(() => {
        assertNodeFloor(version)
      }).toThrow(NodeFloorError)
    },
  )

  it('quotes the unreadable version in the message', () => {
    expect(() => {
      assertNodeFloor('banana')
    }).toThrow(/banana/)
  })
})
