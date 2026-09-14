import type { Envelope, JsonObject, JsonValue } from './envelope.ts'

export interface StateFile {
  readonly path: string
  readonly data: JsonObject
}

export const stateFileName = 'state.json'

export const statePath = (workDir: string): string => `${workDir}/${stateFileName}`

export const loadState = (_workDir: string): Envelope<StateFile> => {
  throw new Error('loadState is not implemented yet')
}

export const readValue = (_state: StateFile, _path: string): Envelope<JsonValue> => {
  throw new Error('readValue is not implemented yet')
}
