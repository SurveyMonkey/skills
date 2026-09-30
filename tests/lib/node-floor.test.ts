// This tests the node floor check (ADR 012). The seam is the exported
// function. It takes a version string, rather than read `process.version`
// itself. So every row below is a real verdict, not a fact about the
// machine that runs the suite.
//
// Every expected value here is written by hand. Some values come from ADR
// 012's account of the spike. 22.16 and 22.17 fail at launch. 22.18.0 is
// the first release that runs with zero bytes on stderr, and 22.22.2,
// 24.15.0, and 24.18.0 also run.
//
// Other values are a hand-written extrapolation from that account, such as
// older majors and an unreadable string. None of it is recomputed the way
// the module computes it.
import { describe, expect, it } from 'vitest'

import {
  assertNodeFloor,
  belowFloorMessage,
  meetsNodeFloor,
  NODE_FLOOR,
  NodeFloorError,
} from '#lib/node-floor.ts'

// The `v` prefix is here because that is the shape `process.version` has.
// The bare spelling is here too, because a version read from anywhere else
// does not carry the prefix. If one spelling passed and the other were
// refused, that would be a launch-time failure on a supported runtime.
const AT_OR_ABOVE = [
  'v22.18.0',
  '22.18.0',
  'v22.18.1',
  'v22.22.2',
  'v24.15.0',
  'v24.18.0',
  'v26.0.0',
]
const BELOW = ['v22.17.1', 'v22.17.0', 'v22.16.0', 'v20.19.0', 'v18.20.8', 'v21.7.3']
// A version string the check cannot read is not proof that the floor is
// met. An unparsable value is the "found nothing counts as a pass" shape
// every gate in this repository refuses. Here it arrives inside the
// runtime check.
const UNREADABLE = [
  'banana',
  '',
  'v22',
  '22.18',
  'v22.18.x',
  'v22.18.0.1',
  'xv22.18.0',
  ' v22.18.0',
  'vv22.18.0',
]

it('states the floor ADR 012 decided', () => {
  expect(NODE_FLOOR).toBe('22.18.0')
})

describe('meetsNodeFloor', () => {
  it.each(AT_OR_ABOVE)('answers true for %s, at or above the floor', (version) => {
    expect(meetsNodeFloor(version)).toBe(true)
  })

  it.each(BELOW)('answers false for %s, below the floor', (version) => {
    expect(meetsNodeFloor(version)).toBe(false)
  })

  it.each(UNREADABLE)('answers false for %s, which it cannot read', (version) => {
    expect(meetsNodeFloor(version)).toBe(false)
  })

  it('answers the same on a second reading of the same string', () => {
    // The regular expression is shared between calls. A global one would
    // carry `lastIndex` forward, and answer false the second time. In a
    // hook, that means it passes on the first tool call of a session, then
    // refuses on the next.
    expect(meetsNodeFloor('v22.18.0')).toBe(true)
    expect(meetsNodeFloor('v22.18.0')).toBe(true)
  })

  // Each part is compared as its own subtraction. So one part may exceed
  // 999 and never carry into the part above it. node has never shipped
  // such a release. But the floor check is the first thing that runs on
  // every machine, so this property is asserted, not assumed.
  it('compares each component on its own', () => {
    expect(meetsNodeFloor('v22.18.1000')).toBe(true)
    expect(meetsNodeFloor('v22.17.1000')).toBe(false)
  })

  it('ignores a prerelease or build suffix', () => {
    expect(meetsNodeFloor('v22.18.0-nightly20260101')).toBe(true)
    expect(meetsNodeFloor('v22.18.0+build.7')).toBe(true)
  })
})

describe('assertNodeFloor', () => {
  it.each(AT_OR_ABOVE)('accepts %s', (version) => {
    expect(() => {
      assertNodeFloor(version)
    }).not.toThrow()
  })

  it.each([...BELOW, ...UNREADABLE])('refuses %s', (version) => {
    expect(() => {
      assertNodeFloor(version)
    }).toThrow(NodeFloorError)
  })

  it('names both the required and the running version', () => {
    // A user reads this message at launch, instead of a plugin that works
    // (ADR 012, Consequences). So it must say what version is required and
    // what version they actually run. A message that names
    // only one of the two would leave them unsure which one to change.
    let thrown: unknown
    try {
      assertNodeFloor('v22.17.1')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(NodeFloorError)
    const error = thrown as NodeFloorError
    expect(error.message).toContain('22.18.0')
    expect(error.message).toContain('22.17.1')
    // The message must also say what to do about it. A message that names
    // only the two versions leaves a user with no idea what to change.
    expect(error.message).toContain('Upgrade node')
    // This name is set explicitly, not inherited. A refusal reported as a
    // plain `Error` would tell a reader nothing about which guard refused.
    expect(error.name).toBe('NodeFloorError')
  })

  it('quotes the unreadable version in the message', () => {
    expect(() => {
      assertNodeFloor('banana')
    }).toThrow(/"banana"/)
  })
})

describe('belowFloorMessage', () => {
  // This is the shape a `SessionStart` hook needs: a line for
  // `systemMessage`. It names the running version and the floor it must
  // meet. Unlike `assertNodeFloor`, this never throws: the hook does not
  // read the below-floor case as an exception to catch.
  it('names the running version and the floor, both quoted the same way', () => {
    expect(belowFloorMessage('v22.17.1')).toBe(
      'node "v22.17.1" is below the floor: 22.18.0 or newer.',
    )
  })

  it('quotes an unreadable version the same way, with the floor', () => {
    expect(belowFloorMessage('banana')).toBe('node "banana" is below the floor: 22.18.0 or newer.')
  })
})
