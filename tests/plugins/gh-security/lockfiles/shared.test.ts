// The shared helpers of the lockfile readers, in the order of jq (#303).
// `uniqueCopies` is `unique_by(.version + .path)` of node.sh, and the order of
// `uniqueParents` and `groupResolutions` is the order of jq's `sort`.
//
// jq sorts text by code point. JavaScript's `<` sorts by UTF-16 unit, so a
// character above U+FFFF (a surrogate pair) lands before U+E000 to U+FFFF.
// Probe, jq 1.8.1:
//   jq -nc '["\ud83d\ude00", "\uffff", "\ue000"] | sort'
//     -> ["\ue000","\uffff","\ud83d\ude00"]
//   jq -nc '{"\ud83d\ude00-pkg":"1","\uffff-pkg":"1","a":"1"} | keys'
//     -> ["a","\uffff-pkg","\ud83d\ude00-pkg"]
//   jq -nc '[{version:"1.0.0",path:"\ud83d\ude00"},{version:"1.0.0",path:"\uffff"}] |
//           unique_by(.version + .path) | map(.path)'
//     -> ["\uffff","\ud83d\ude00"]
import { describe, expect, it } from 'vitest'

import { groupResolutions, uniqueCopies, uniqueParents } from '#gh-security/lockfiles/shared.ts'

describe('uniqueCopies', () => {
  it.fails('sorts the copies by code point of the version joined to the path', () => {
    const copies = [
      { version: '1.0.0', path: '\u{1F600}' },
      { version: '1.0.0', path: '\uffff' },
      { version: '1.0.0', path: '\u{1F600}' },
    ]
    expect(uniqueCopies(copies).map(({ path }) => path)).toEqual(['\uffff', '\u{1F600}'])
  })

  it('keeps one copy for each key, in text order', () => {
    const copies = [
      { version: '2.0.0', path: 'b' },
      { version: '1.0.0', path: 'b' },
      { version: '1.0.0', path: 'b' },
    ]
    expect(uniqueCopies(copies)).toEqual([
      { version: '1.0.0', path: 'b' },
      { version: '2.0.0', path: 'b' },
    ])
  })
})

describe('groupResolutions', () => {
  it.fails('sorts the versions of a package by code point', () => {
    const pairs = ['\u{1F600}', '\uffff', '\ue000'].map((version) => ({
      package: 'lodash',
      version,
    }))
    expect({ ...groupResolutions(pairs) }).toEqual({ lodash: ['\ue000', '\uffff', '\u{1F600}'] })
  })
})

describe('uniqueParents', () => {
  it.fails('sorts the parents by code point of the name', () => {
    const found = ['\u{1F600}', '\uffff', '\ue000'].map((name) => ({ name, version: '1.0.0' }))
    expect(uniqueParents(found).map(({ name }) => name)).toEqual(['\ue000', '\uffff', '\u{1F600}'])
  })
})
