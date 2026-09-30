// `attempt` of the node adapter (#221). The verbs reach it only with a throw
// of an `Error`. A throw of any other value must still give an envelope with
// a string `error`. ADR 001 says that a promised field is present and typed.
import { describe, expect, it } from 'vitest'

import { attempt } from '#gh-security/adapters/node/attempt.ts'

describe('attempt', () => {
  it('answers ok with the value of the computation', () => {
    expect(attempt(() => 7)).toEqual({ outcome: 'ok', value: 7 })
  })

  it('answers failed with the message of a thrown Error', () => {
    expect(
      attempt(() => {
        throw new TypeError('no such field')
      }),
    ).toEqual({ outcome: 'failed', error: 'no such field' })
  })

  it('answers failed with the text of a thrown value that is not an Error', () => {
    expect(
      attempt(() => {
        throw 'a bare string'
      }),
    ).toEqual({ outcome: 'failed', error: 'a bare string' })
  })

  it('answers failed with the tag of a thrown value that String cannot convert', () => {
    expect(
      attempt(() => {
        throw Object.create(null)
      }),
    ).toEqual({ outcome: 'failed', error: '[object Object]' })
  })
})
