export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type Envelope<T> = { readonly outcome: 'ok'; readonly value: T }

export const ok = <T>(value: T): Envelope<T> => ({ outcome: 'ok', value })

export const renderEnvelope = (
  _envelope: Envelope<JsonValue>,
): { stdout: string; stderr: string; exitCode: number } => {
  throw new Error('renderEnvelope is not implemented yet')
}
