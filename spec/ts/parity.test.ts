// The parity runner's own examples. The subject here is deliberately not the
// adapter: what is under test is the comparison and the report it produces,
// so the bash side is a command that prints exactly what each example needs,
// run as a real process through the same path a port issue's subject takes.
//
// `spec/ts/parity-semver.test.ts` is the runner used for what it exists for.
import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../../plugins/gh-security/src/lib/envelope.ts'
import { checkParity, firstDifference, type ParitySubject } from './support/parity.ts'

/** A bash side that prints one fixed string, and a TypeScript side to match. */
const printing = (text: string, typescript: JsonValue): ParitySubject<null> => ({
  bash: () => ({ command: 'printf', args: ['%s', text] }),
  typescript: () => typescript,
})

describe('firstDifference', () => {
  it.each([
    [1, 1],
    ['a', 'a'],
    [null, null],
    [true, true],
    [
      { a: 1, b: [1, 2] },
      { a: 1, b: [1, 2] },
    ],
    // Key order is not a difference: two implementations building the same
    // object in different orders agree.
    [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ],
  ])('reports nothing for %j against %j', (bash: JsonValue, typescript: JsonValue) => {
    expect(firstDifference(bash, typescript)).toBe(null)
  })

  // Each row names the path a reader has to open, and both values, because
  // "the two disagree" is a verdict nobody can act on. The expected strings
  // are written by hand from the notation this module documents.
  it.each([
    [1, 2, '$: bash 1, TypeScript 2'],
    // The type difference a JSON boundary produces: a number that survived a
    // shell as a string.
    [1, '1', '$: bash 1, TypeScript "1"'],
    [{ delta: 'minor' }, { delta: 'patch' }, '$.delta: bash "minor", TypeScript "patch"'],
    [{ a: { b: 1 } }, { a: { b: 2 } }, '$.a.b: bash 1, TypeScript 2'],
    [[1, 2, 3], [1, 9, 3], '$[1]: bash 2, TypeScript 9'],
    // A length difference is reported as one. Comparing entry 2 against
    // nothing would name a path that is not where the fault is.
    [[1, 2, 3], [1, 2], '$: bash has 3 entries, TypeScript has 2'],
    [{ a: 1 }, {}, '$: bash carries a key TypeScript does not: a'],
    [{}, { a: 1 }, '$: TypeScript carries a key bash does not: a'],
    // A shape difference between the two kinds of container, and between a
    // container and a leaf.
    [{ a: 1 }, [1], '$: bash {"a":1}, TypeScript [1]'],
    [[1], null, '$: bash [1], TypeScript null'],
  ])('reports %j against %j as %s', (bash: JsonValue, typescript: JsonValue, expected) => {
    expect(firstDifference(bash, typescript)).toBe(expected)
  })

  // Depth first, left to right: the path named is the first one a reader
  // scanning the JSON reaches, not whichever key the walk happened to visit.
  it('names the first differing path when several differ', () => {
    expect(firstDifference({ a: 1, b: 1 }, { a: 2, b: 2 })).toBe('$.a: bash 1, TypeScript 2')
  })
})

describe('checkParity', () => {
  it('matches when both sides answer the same JSON', () => {
    expect(checkParity(printing('{"result":-1}', { result: -1 }), null)).toEqual({ matched: true })
  })

  it('reports the differing path when they disagree', () => {
    expect(checkParity(printing('{"result":-1}', { result: 1 }), null)).toEqual({
      matched: false,
      report: 'they differ at $.result: bash -1, TypeScript 1',
    })
  })

  // A bash side that never answered is reported as itself. Reading a failed
  // run as a difference would send a reader looking for a defect in the
  // TypeScript, and reading it as a match would be a parity claim backed by
  // nothing at all.
  it('reports a bash side that failed rather than comparing its output', () => {
    const subject: ParitySubject<null> = {
      bash: () => ({ command: 'false', args: [] }),
      typescript: () => null,
    }
    expect(checkParity(subject, null)).toEqual({
      matched: false,
      report: 'bash did not answer: false failed (exit 1): no output',
    })
  })

  it('reports a bash side whose output is not JSON', () => {
    expect(checkParity(printing('not json', null), null)).toEqual({
      matched: false,
      report: 'the bash answer is not JSON: not json',
    })
  })

  it('says so when the bash side answered nothing at all', () => {
    expect(checkParity(printing('', null), null)).toEqual({
      matched: false,
      report: 'the bash answer is not JSON: (no output)',
    })
  })
})
