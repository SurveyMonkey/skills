// `holdSignals`. The signals of the process are a stand-in that logs each
// call, and the example sends the signals. The expected values are written by
// hand from the header of `src/signals.ts`. `classify-lines.test.ts` and
// `fix-group-cleanup.test.ts` send real signals to a real process.
import { describe, expect, it } from 'vitest'

import { holdSignals, type Signals } from '#gh-security/signals.ts'

const signalsOf = () => {
  const log: string[] = []
  const listeners = new Map<string, (signal: NodeJS.Signals) => void>()
  const signals: Signals = {
    on: (signal, listener) => {
      log.push(`on ${signal}`)
      listeners.set(signal, listener)
    },
    off: (signal, listener) => {
      log.push(`off ${signal}`)
      if (listeners.get(signal) === listener) listeners.delete(signal)
    },
    exit: (status) => {
      log.push(`exit ${status}`)
    },
  }
  const send = (signal: NodeJS.Signals): void => listeners.get(signal)?.(signal)
  return { log, listeners, signals, send }
}

describe('holdSignals', () => {
  it.each([
    ['SIGINT', ['SIGINT'], 130],
    ['SIGTERM', ['SIGTERM'], 143],
    ['the first of two signals', ['SIGINT', 'SIGTERM'], 130],
  ] as const)('finishes the body, releases with %s, then exits', async (_case, sent, status) => {
    const { log, listeners, signals, send } = signalsOf()
    const answer = await holdSignals(
      signals,
      async () => {
        for (const signal of sent) send(signal)
        log.push('body ends')
        return 'answer'
      },
      async (signal) => {
        log.push(`release ${signal}`)
      },
    )
    expect(answer).toBe('answer')
    expect(log).toEqual([
      'on SIGINT',
      'on SIGTERM',
      'body ends',
      `release ${sent[0]}`,
      'off SIGINT',
      'off SIGTERM',
      `exit ${status}`,
    ])
    expect(listeners.size).toBe(0)
  })

  it('releases with no signal, and does not exit', async () => {
    const { log, signals } = signalsOf()
    await holdSignals(
      signals,
      async () => 1,
      async (signal) => {
        log.push(`release ${signal}`)
      },
    )
    expect(log).toEqual(['on SIGINT', 'on SIGTERM', 'release null', 'off SIGINT', 'off SIGTERM'])
  })

  it('releases when the body throws, and passes the throw on', async () => {
    const { log, signals, send } = signalsOf()
    await expect(
      holdSignals(
        signals,
        async () => {
          send('SIGTERM')
          throw new Error('a defect')
        },
        async (signal) => {
          log.push(`release ${signal}`)
        },
      ),
    ).rejects.toThrow('a defect')
    expect(log).toEqual([
      'on SIGINT',
      'on SIGTERM',
      'release SIGTERM',
      'off SIGINT',
      'off SIGTERM',
      'exit 143',
    ])
  })

  it('takes the listeners off and exits when the release throws', async () => {
    const { log, listeners, signals, send } = signalsOf()
    await expect(
      holdSignals(
        signals,
        async () => send('SIGINT'),
        async () => {
          throw new Error('the release broke')
        },
      ),
    ).rejects.toThrow('the release broke')
    expect(log).toEqual(['on SIGINT', 'on SIGTERM', 'off SIGINT', 'off SIGTERM', 'exit 130'])
    expect(listeners.size).toBe(0)
  })
})
