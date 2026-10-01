// The jq rules for JSON values of `apply_constraint` (#222, layer 2). Each
// row is the jq 1.8 answer on the same input. Where jq stops, the function
// throws. The verb tests and the parity run hold the use of each rule.
import { describe, expect, it } from 'vitest'

import {
  addBlocks,
  compare,
  entriesOf,
  equal,
  get,
  getPath,
  has,
  indentOf,
  jqType,
  or,
  render,
  setPath,
  split,
  startsWith,
  test,
  toText,
  trimStart,
  unique,
  withKey,
  withoutKey,
} from '#gh-security/adapters/node/jq-json.ts'

describe('the jq rules for values', () => {
  it.each([
    [null, 'null'],
    [[], 'array'],
    [{}, 'object'],
    ['x', 'string'],
    [1, 'number'],
    [false, 'boolean'],
  ])('jqType names %j as %s', (value, type) => {
    expect(jqType(value)).toBe(type)
  })

  it.each([
    [null, 'x', 'x'],
    [false, 'x', 'x'],
    [0, 'x', 0],
    ['', 'x', ''],
  ])('or reads %j // %j as %j', (value, fallback, expected) => {
    expect(or(value, fallback)).toBe(expected)
  })

  it('get reads a key, null for null or an absent key, and stops on a text', () => {
    expect([get({ a: 1 }, 'a'), get({ a: 1 }, 'b'), get(null, 'a')]).toEqual([1, null, null])
    expect(() => get('x', 'a')).toThrow('cannot index a string with "a"')
    expect(() => get([], 'a')).toThrow('cannot index a array')
  })

  it('get and has see no key that an object only inherits, such as a parent named constructor', () => {
    expect([get({}, 'constructor'), get({}, 'toString')]).toEqual([null, null])
    expect([has({}, 'constructor'), has({}, 'toString')]).toEqual([false, false])
  })

  it('getPath ends at a null, and stops on a text on the way', () => {
    expect(getPath({ a: null }, ['a', 'b'])).toBeNull()
    expect(getPath({ a: { b: 2 } }, ['a', 'b'])).toBe(2)
    expect(() => getPath({ a: 'x' }, ['a', 'b'])).toThrow()
  })

  it('withKey keeps the place of a key, puts a new key last, and makes an object of null', () => {
    expect(Object.keys(withKey({ a: 1, b: 2 }, 'a', 3))).toEqual(['a', 'b'])
    expect(withKey({ a: 1 }, 'b', 2)).toEqual({ a: 1, b: 2 })
    expect(withKey(null, 'a', 1)).toEqual({ a: 1 })
    expect(Object.keys(withKey({}, '__proto__', 1))).toEqual(['__proto__'])
    expect(() => withKey('x', 'a', 1)).toThrow('cannot set "a" on a string')
  })

  it('setPath makes each object on the way, and stops on a text', () => {
    expect(setPath(null, ['a', 'b'], 1)).toEqual({ a: { b: 1 } })
    expect(setPath({ a: { c: 2 } }, ['a', 'b'], 1)).toEqual({ a: { c: 2, b: 1 } })
    expect(() => setPath({ a: 'x' }, ['a', 'b'], 1)).toThrow()
  })

  it('withoutKey keeps null, removes a key, and stops on a list', () => {
    expect([withoutKey(null, 'a'), withoutKey({ a: 1, b: 2 }, 'a')]).toEqual([null, { b: 2 }])
    expect(() => withoutKey([], 'a')).toThrow('cannot delete "a" from a array')
  })

  it('has answers for an object only', () => {
    expect([has({ a: 1 }, 'a'), has({ a: 1 }, 'b')]).toEqual([true, false])
    expect(() => has([], 'a')).toThrow('cannot check a array for "a"')
  })

  it('entriesOf reads an object, an empty list, and stops on any other value', () => {
    expect(entriesOf({ a: 1 })).toEqual([['a', 1]])
    expect(entriesOf([])).toEqual([])
    expect(() => entriesOf([1])).toThrow('cannot read the entries of a array')
    expect(() => entriesOf('x')).toThrow('cannot read the entries of a string')
  })

  it('addBlocks merges objects, joins lists, and stops on a mix', () => {
    expect(addBlocks([{ a: 1 }, { a: 2, b: 3 }])).toEqual({ a: 2, b: 3 })
    expect(addBlocks([[], []])).toEqual([])
    expect(() => addBlocks([{}, []])).toThrow('cannot add dependency blocks of different types')
  })

  it.each([
    [{ b: 1, a: { x: [1, 2] } }, { a: { x: [1, 2] }, b: 1 }, true],
    [[1, 2], [2, 1], false],
    [[1], { 0: 1 }, false],
    [{ a: 1 }, { a: 1, b: 2 }, false],
    [{ a: 1 }, { b: 1 }, false],
    [{ a: 1 }, [1], false],
    [null, false, false],
    ['1', 1, false],
  ])('equal reads %j == %j as %s', (a, b, expected) => {
    expect(equal(a, b)).toBe(expected)
  })

  it('unique sorts as jq does: null, false, true, numbers, then texts', () => {
    expect(unique([3, 'a', null, false, true, 'b', 1, 'a', 3])).toEqual([
      null,
      false,
      true,
      1,
      3,
      'a',
      'b',
    ])
    expect([compare('a', 'b'), compare('b', 'a'), compare(2, 2)]).toEqual([-1, 1, 0])
  })

  it('unique keeps one of each equal list or object, as jq does', () => {
    expect(unique([{ a: 1 }, ['x'], { a: 1 }, ['x']])).toEqual([['x'], { a: 1 }])
  })

  it.each([
    ['split', () => split(1, '.')],
    ['test', () => test(null, /x/)],
    ['startsWith', () => startsWith(5, 'v')],
    ['trimStart', () => trimStart(5, 'v')],
  ])('%s stops on a value that is not a text', (_name, call) => {
    expect(call).toThrow()
  })

  it('split gives no parts for an empty text, and trimStart drops a prefix', () => {
    expect([split('', '.'), split('a.b', '.'), trimStart('v1', 'v'), trimStart('1', 'v')]).toEqual([
      [],
      ['a', 'b'],
      '1',
      '1',
    ])
  })
})

describe('the jq text of a value', () => {
  const value = { a: [1, { b: 'é\u007f\n' }], c: {}, d: [] }

  it('writes jq -c, with U+007F escaped', () => {
    expect(render(value, null)).toBe('{"a":[1,{"b":"é\\u007f\\n"}],"c":{},"d":[]}')
  })

  it('writes jq --indent 4', () => {
    expect(render({ a: [1], b: {} }, '    ')).toBe(
      '{\n    "a": [\n        1\n    ],\n    "b": {}\n}',
    )
  })

  it('writes jq --tab', () => {
    expect(render({ a: [true, null] }, '\t')).toBe('{\n\t"a": [\n\t\ttrue,\n\t\tnull\n\t]\n}')
  })

  it.each([
    ['x', 'x'],
    [5, '5'],
    [{ a: '1' }, '{"a":"1"}'],
  ])('toText reads %j as %j', (input, text) => {
    expect(toText(input)).toBe(text)
  })

  it.each([
    ['{\n\t"a": 1\n}', '\t'],
    ['{\n    "a": 1\n}', '    '],
    ['{\n  "a": 1\n}', '  '],
    ['{"a": 1}', '  '],
    ['{\n \t"a": 1\n}', '  '],
    ['{\n\n    "a": 1\n}', '    '],
  ])('indentOf reads the indent of %j as %j', (text, unit) => {
    expect(indentOf(text)).toBe(unit)
  })
})
