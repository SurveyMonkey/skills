// STUB for the parity capture. The next commit replaces it.
import type { Adapter } from './adapter.ts'
import type { NodeDetection } from './node/detect.ts'

export const UNSUPPORTED_REASON = 'ecosystem not supported yet'

export type AdapterRoute =
  | {
      readonly supported: true
      readonly ecosystem: string
      readonly name: 'node'
      readonly adapter: Adapter<NodeDetection>
      readonly manifest: string | null
    }
  | {
      readonly supported: false
      readonly ecosystem: string
      readonly name: null
      readonly adapter: null
      readonly manifest: string | null
      readonly reason: typeof UNSUPPORTED_REASON
    }

export const selectAdapter = (ecosystem: string, manifest: string | null = null): AdapterRoute => ({
  supported: false,
  ecosystem,
  name: null,
  adapter: null,
  manifest,
  reason: UNSUPPORTED_REASON,
})
