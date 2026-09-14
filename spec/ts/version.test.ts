// `gh-security version` (#224). The seam is the exported handler, and the
// pure half takes the manifest text so that every malformed shape is a real
// verdict rather than a file this suite would have to write.
import { describe, expect, it } from 'vitest'

import { version, versionFrom } from '../../plugins/gh-security/src/commands/version.ts'

describe('versionFrom', () => {
  it('answers with the version the manifest carries', () => {
    expect(versionFrom('{"name":"gh-security","version":"1.2.3"}')).toEqual({
      outcome: 'ok',
      value: { version: '1.2.3' },
    })
  })

  it.each([
    ['not JSON at all', 'not json', 'the plugin manifest is not JSON'],
    ['a JSON string', '"gh-security"', 'the plugin manifest carries no version'],
    ['JSON null', 'null', 'the plugin manifest carries no version'],
    [
      'an object with no version',
      '{"name":"gh-security"}',
      'the plugin manifest carries no version',
    ],
    ['a non-string version', '{"version":13}', 'the plugin manifest version is not a string'],
  ])('reports %s as an error rather than an empty answer', (_case, manifest, error) => {
    expect(versionFrom(manifest)).toEqual({ outcome: 'error', error })
  })
})

describe('the version command', () => {
  it('reads the manifest this plugin ships', () => {
    // The version itself is not pinned here: it changes on every release,
    // and an example asserting it would be a second place to bump. What is
    // asserted is that the shipped manifest is found and parsed.
    const result = version()
    expect(result?.outcome).toBe('ok')
    expect(result).toEqual({ outcome: 'ok', value: { version: expect.any(String) } })
  })
})
