// `resolved_versions` and `resolution_map` for the node adapter, ported from
// `verb_resolved_versions` and `verb_resolution_map` in node.sh (#221). The
// readers under `src/lockfiles/` parse. These verbs add the fields that
// node.sh adds around the parse: `pm`, `package`, `present`, `count` and the
// coverage counts.
//
// Each verb reads the lockfile that the detection names, with the reader of
// the manager that the detection names. Neither verb runs `detect`.
//
// A lockfile with zero entries, or one that the reader reads less than half
// of, is a `failed` outcome (ADR 001, "Empty results are never implicitly
// successful"). The reader throws for it, and `attempt` makes the throw an
// envelope.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Envelope, failed } from '../../lib/envelope.ts'
import * as npm from '../../lockfiles/npm.ts'
import * as pnpm from '../../lockfiles/pnpm.ts'
import type { ResolutionMap, ResolvedVersions } from '../../lockfiles/shared.ts'
import * as yarn from '../../lockfiles/yarn.ts'
import type { ResolutionMapAnswer, ResolvedVersionsAnswer, Tree } from '../adapter.ts'
import { attempt } from './attempt.ts'
import type { NodeDetection } from './detect.ts'

type Reader = {
  readonly resolvedVersions: (text: string, pkg: string) => ResolvedVersions
  readonly resolutionMap: (text: string) => ResolutionMap
}

const READERS: Readonly<Record<NodeDetection['pm'], Reader>> = { npm, pnpm, yarn }

/** The text of the lockfile that the detection names, and the reader for it. */
const lockfileOf = ({ root, detection }: Tree<NodeDetection>) => ({
  reader: READERS[detection.pm],
  text: readFileSync(join(root, detection.lockfile), 'utf8'),
})

/** `verb_resolved_versions`. The alias key of a copy finds it too (ADR 001). */
export const resolvedVersions = (
  tree: Tree<NodeDetection>,
  pkg: string,
): Envelope<ResolvedVersionsAnswer> => {
  if (pkg === '') return failed('resolved_versions requires a package name')
  return attempt(() => {
    const { reader, text } = lockfileOf(tree)
    const { coverage, copies } = reader.resolvedVersions(text, pkg)
    return {
      pm: tree.detection.pm,
      package: pkg,
      present: copies.length > 0,
      count: copies.length,
      versions: copies,
      lockfile_entries: coverage.entries,
    }
  })
}

/** `verb_resolution_map`. */
export const resolutionMap = (tree: Tree<NodeDetection>): Envelope<ResolutionMapAnswer> =>
  attempt(() => {
    const { reader, text } = lockfileOf(tree)
    const { coverage, resolutions } = reader.resolutionMap(text)
    return {
      pm: tree.detection.pm,
      lockfile_entries: coverage.entries,
      entries_read: coverage.read,
      entries_expected: coverage.expected,
      unreadable_entries: coverage.expected - coverage.read,
      package_count: Object.keys(resolutions).length,
      resolutions,
    }
  })
