// Tests for `lib/hook-output.ts`. The CLI shows `systemMessage` as written,
// so each case is pinned byte for byte, from a hand-written literal.
import { describe, expect, it } from 'vitest'

import { colour, emit } from '#lib/hook-output.ts'

describe('colour', () => {
  it('leaves a line without the prefix unchanged', () => {
    expect(colour('demo', 'other: text')).toBe('other: text')
    expect(colour('demo', 'demo:text')).toBe('demo:text')
    expect(colour('demo', 'not demo: text')).toBe('not demo: text')
  })

  it('makes a status line cyan, with the prefix in bold', () => {
    expect(colour('demo', 'demo: [item]')).toBe(
      '\u001b[36m\u001b[1mdemo:\u001b[22m [item]\u001b[0m',
    )
  })

  it('makes a problem line yellow, with the prefix in bold', () => {
    expect(colour('demo', 'demo: ⚠️ jq is missing')).toBe(
      '\u001b[33m\u001b[1mdemo:\u001b[22m ⚠️ jq is missing\u001b[0m',
    )
  })

  it('uses the prefix it is given', () => {
    expect(colour('other', 'demo: [item]')).toBe('demo: [item]')
  })
})

describe('emit', () => {
  it('writes one line as systemMessage after a newline, with no additionalContext', () => {
    expect(emit('demo', 'demo: [item]')).toBe(
      '{"systemMessage":"\\n\\u001b[36m\\u001b[1mdemo:\\u001b[22m [item]\\u001b[0m"}\n',
    )
  })

  it('colours each line on its own', () => {
    expect(emit('demo', 'demo: [item]\ndemo: ⚠️ jq is missing')).toBe(
      '{"systemMessage":"\\n\\u001b[36m\\u001b[1mdemo:\\u001b[22m [item]\\u001b[0m\\n' +
        '\\u001b[33m\\u001b[1mdemo:\\u001b[22m ⚠️ jq is missing\\u001b[0m"}\n',
    )
  })

  it('adds hookSpecificOutput when it gets additionalContext', () => {
    expect(emit('demo', 'demo: ⚠️ jq is missing', 'Missing: jq. The plugin cannot run.')).toBe(
      '{"systemMessage":"\\n\\u001b[33m\\u001b[1mdemo:\\u001b[22m ⚠️ jq is missing\\u001b[0m",' +
        '"hookSpecificOutput":{"hookEventName":"SessionStart",' +
        '"additionalContext":"Missing: jq. The plugin cannot run."}}\n',
    )
  })

  it('keeps an empty additionalContext in the object', () => {
    expect(emit('demo', 'demo: [item]', '')).toBe(
      '{"systemMessage":"\\n\\u001b[36m\\u001b[1mdemo:\\u001b[22m [item]\\u001b[0m",' +
        '"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}\n',
    )
  })
})
