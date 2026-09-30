import type { Parent, ResolutionMap, ResolvedVersions } from './shared.ts'

export const resolvedVersions = (_text: string, _pkg: string): ResolvedVersions => {
  throw new Error('not implemented')
}

export const resolutionMap = (_text: string): ResolutionMap => {
  throw new Error('not implemented')
}

export const parents = (_text: string, _pkg: string): readonly Parent[] => {
  throw new Error('not implemented')
}
