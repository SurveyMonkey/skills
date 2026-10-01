// The jq rules that the discovery ports share. Each expected value is written
// by hand from jq's manual, or from a probe of jq 1.8.1 that the row names.
import { describe, expect, it } from 'vitest'

import {
  compareJq,
  fieldOf,
  majorNumber,
  majorOf,
  orElse,
  pathOf,
  sortJq,
  tostring,
  uniqueJq,
} from '#gh-security/jq.ts'

describe('compareJq', () => {
  it('orders the types as jq does: null, false, true, numbers, text, lists, objects', () => {
    // jq -n '[{}, [], "a", 1, true, false, null] | sort'
    expect(sortJq([{}, [], 'a', 1, true, false, null])).toEqual([null, false, true, 1, 'a', [], {}])
  })

  it.each([
    [1, 2, -1],
    [2, 1, 1],
    [1.5, 1.5, 0],
    [-1, 0.5, -1],
  ])('orders the number %s against %s as %s', (a, b, order) => {
    expect(compareJq(a, b)).toBe(order)
  })

  it('orders text by its bytes, so an upper case letter comes first', () => {
    expect(sortJq(['b', 'a', 'B', 'ab', ''])).toEqual(['', 'B', 'a', 'ab', 'b'])
  })

  it('orders a character above U+FFFF after U+FFFD, as code points do', () => {
    // JavaScript's own sort puts the surrogate pair first.
    expect(['\u{1F600}', '�'].sort()).toEqual(['\u{1F600}', '�'])
    expect(sortJq(['\u{1F600}', '�'])).toEqual(['�', '\u{1F600}'])
  })

  it('orders lists entry by entry, then a shorter list first', () => {
    expect(sortJq([[1, 2], [1], [0, 9], [1, 1, 5]])).toEqual([[0, 9], [1], [1, 1, 5], [1, 2]])
    expect(compareJq([1, 'a'], [1, 'a'])).toBe(0)
  })

  it('orders objects by their sorted keys first, then by the values in key order', () => {
    // jq -n '[{"b":1}, {"a":2}, {"a":1,"c":0}, {"a":1}] | sort'
    expect(sortJq([{ b: 1 }, { a: 2 }, { a: 1, c: 0 }, { a: 1 }])).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 1, c: 0 },
      { b: 1 },
    ])
    expect(compareJq({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(0)
    expect(compareJq({ a: 1, b: 2 }, { a: 1, b: 1 })).toBe(1)
  })

  it('reads the three constants as equal to themselves', () => {
    expect([compareJq(null, null), compareJq(true, true), compareJq(false, false)]).toEqual([
      0, 0, 0,
    ])
  })
})

describe('sortJq and uniqueJq', () => {
  it('keeps the order of equal entries, as jq does', () => {
    const first = { a: 1 }
    const second = { a: 1 }
    const sorted = sortJq([second, { a: 0 }, first])
    expect(sorted[1]).toBe(second)
    expect(sorted[2]).toBe(first)
  })

  it('sorts and keeps each value once', () => {
    expect(uniqueJq(['b', 'a', 'b', 1, 1, null])).toEqual([null, 1, 'a', 'b'])
    expect(uniqueJq([])).toEqual([])
  })

  it('does not change the list that it was given', () => {
    const list = ['b', 'a']
    sortJq(list)
    expect(list).toEqual(['b', 'a'])
  })
})

describe('tostring and orElse', () => {
  it.each([
    ['text', 'a b', 'a b'],
    ['a number', 7, '7'],
    ['null', null, 'null'],
    ['a list', [7], '[7]'],
    ['an object', { a: 1 }, '{"a":1}'],
  ])('gives %s as jq does', (_case, value, text) => {
    expect(tostring(value)).toBe(text)
  })

  it.each([
    [null, 'x'],
    [false, 'x'],
    [undefined, 'x'],
    [0, 0],
    ['', ''],
    [true, true],
  ])('reads %j // "x" as %j', (value, result) => {
    expect(orElse(value, 'x')).toBe(result)
  })
})

describe('fieldOf and pathOf', () => {
  it('reads a field, and null for a missing field or a null value', () => {
    expect(fieldOf({ a: 1 }, 'a')).toBe(1)
    expect(fieldOf({ a: 1 }, 'b')).toBeNull()
    expect(fieldOf(null, 'a')).toBeNull()
    expect(fieldOf(undefined, 'a')).toBeNull()
  })

  it('reads a field of Object.prototype as missing', () => {
    expect(fieldOf({}, 'constructor')).toBeNull()
  })

  it.each([['text'], [3], [true], [[1]]])('stops for the field of %j, as jq does', (value) => {
    expect(() => fieldOf(value, 'a')).toThrow(
      `cannot read the field "a" of ${JSON.stringify(value)}`,
    )
  })

  it('reads a path, and null past a missing step', () => {
    expect(pathOf({ a: { b: { c: 2 } } }, 'a', 'b', 'c')).toBe(2)
    expect(pathOf({ a: null }, 'a', 'b', 'c')).toBeNull()
    expect(() => pathOf({ a: 'x' }, 'a', 'b')).toThrow('cannot read the field "b" of "x"')
  })
})

describe('majorOf', () => {
  it.each([
    ['a plain version', '7.29.0', '7'],
    ['a v prefix', 'v7.29.0', '7'],
    ['an equals prefix', '=7.1', '7'],
    ['v and = together', 'v=v7', '7'],
    ['white space at each end', '  7.29.0 \t', '7'],
    ['a no-break space and an ideographic space', ' 7.0　', '7'],
    ['a next-line and a line separator', '\u0085 7.0', '7'],
    ['a leading zero', '07.1.0', '07'],
    ['a major with no dot', '12', '12'],
    ['a number', 7, '7'],
    ['a line break before the first dot', '7\n.1.0', '7\n'],
  ])('reads %s', (_case, version, major) => {
    expect(majorOf(version)).toBe(major)
  })

  it.each([
    ['prose', 'See vendor advisory'],
    ['empty text', ''],
    ['a leading dot', '.5'],
    ['a byte order mark, which is not white space to jq', '﻿7.0'],
    ['a line break inside the major', '7\n8.0'],
    ['a negative number', -7],
    ['a sign', '+7.0'],
    ['a digit of another script', '٣.0'],
    ['a list', [7]],
    ['null', null],
  ])('finds no major in %s', (_case, version) => {
    expect(majorOf(version)).toBeNull()
  })
})

describe('majorNumber', () => {
  it('reads the digits of a major as a number', () => {
    expect([majorNumber('7'), majorNumber('07'), majorNumber('10')]).toEqual([7, 7, 10])
  })

  it('stops for a major with a line break, as jq 1.8 does', () => {
    expect(() => majorNumber('7\n')).toThrow('"7\\n" is not a number')
  })
})
