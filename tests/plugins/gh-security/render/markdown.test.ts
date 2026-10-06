// The text rules of the PR renderer (#233). Each expected value is written by
// hand from the rule, and the EPSS values are the answers of `awk` in the
// capture of `render-pr.sh` (`spec/fixtures/render-pr/capture.json`).
import { describe, expect, it } from 'vitest'

import {
  cell,
  DASH,
  fence,
  inline,
  percent,
  shown,
  withoutFinalNewlines,
} from '#gh-security/render/markdown.ts'

describe('withoutFinalNewlines', () => {
  it.each([
    ['one', 'a\n', 'a'],
    ['many', 'a\n\n\n', 'a'],
    ['none', 'a', 'a'],
    ['an inner one', 'a\nb\n', 'a\nb'],
    ['only line feeds', '\n\n', ''],
    ['a carriage return, which stays', 'a\r\n', 'a\r'],
  ])('drops the final line feeds of %s', (_name, text, expected) => {
    expect(withoutFinalNewlines(text)).toBe(expected)
  })
})

describe('inline', () => {
  it.each([
    ['CRLF', 'a\r\nb', 'a b'],
    ['a lone CR', 'a\rb', 'a b'],
    ['LF', 'a\nb', 'a b'],
    ['each break of three', 'a\n\r\nb', 'a  b'],
    ['no break', 'a b', 'a b'],
    ['a tab, which stays', 'a\tb', 'a\tb'],
  ])('puts one space for each line break of %s', (_name, text, expected) => {
    expect(inline(text)).toBe(expected)
  })
})

describe('shown', () => {
  it('drops the final line feeds, and then puts one space for each other break', () => {
    expect(shown('lo\ndash\n\n')).toBe('lo dash')
  })
})

describe('cell', () => {
  it.each([
    ['a pipe', 'a|b', 'a\\|b'],
    ['a backslash', 'a\\b', 'a\\\\b'],
    ['a backslash and then a pipe', 'a\\|b', 'a\\\\\\|b'],
    ['a line break', 'a\r\nb', 'a b'],
    ['plain text', 'plain', 'plain'],
    ['non-ASCII text', 'ünï 日本', 'ünï 日本'],
  ])('escapes %s', (_name, text, expected) => {
    expect(cell(text)).toBe(expected)
  })
})

describe('fence', () => {
  it.each([
    ['text with no backtick', 'a b', '```'],
    ['a run of one', 'a`b', '```'],
    ['a run of two', 'a``b', '```'],
    ['a run of three', 'a```b', '````'],
    ['a run of four after a run of three', '```\n````', '`````'],
    ['a run of three after a run of four', '````\n```', '`````'],
    ['nothing', '', '```'],
  ])('is the shortest fence that %s cannot end', (_name, block, expected) => {
    expect(fence(block)).toBe(expected)
  })
})

describe('percent', () => {
  it.each([
    [0, '0.0'],
    [1, '100.0'],
    [0.842, '84.2'],
    [0.05, '5.0'],
    [0.123456, '12.3'],
    [0.999, '99.9'],
    [0.00049, '0.0'],
    // Above the half: the exact double of 0.0005 times 100 is above 0.05.
    [0.0005, '0.1'],
    [0.005, '0.5'],
  ])('prints %s as %s', (fraction, expected) => {
    expect(percent(fraction)).toBe(expected)
  })

  // 0.0125 times 100 is exactly 1.25, a tie. `awk` rounds a tie to the even
  // digit. `toFixed` sends it up.
  it.each([
    [0.0125, '1.2'],
    [0.0375, '3.8'],
    [0.0625, '6.2'],
    [0.0875, '8.8'],
  ])('rounds the tie %s to the even digit, %s', (fraction, expected) => {
    expect(percent(fraction)).toBe(expected)
  })
})

describe('DASH', () => {
  it('is U+2014, the dash of three sentences of the script', () => {
    expect(DASH.codePointAt(0)).toBe(0x2014)
    expect(DASH).toHaveLength(1)
  })
})
