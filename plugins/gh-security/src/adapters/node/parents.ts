// `parents` for the node adapter (#221). No verb of node.sh writes it. It
// is the answer of the parent readers inside node.sh: `npm_parents`,
// `pnpm_parents` and `yarn_parents`. The readers under `src/lockfiles/`
// parse. `why` and `declared_ranges` read the parents through this module.
//
// The verb reads the lockfile that the detection names, with the reader of
// the manager that the detection names. It does not run `detect`.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Envelope, failed } from '../../lib/envelope.ts'
import * as npm from '../../lockfiles/npm.ts'
import * as pnpm from '../../lockfiles/pnpm.ts'
import type { Copy, Parent } from '../../lockfiles/shared.ts'
import * as yarn from '../../lockfiles/yarn.ts'
import type { ParentsAnswer, Tree } from '../adapter.ts'
import { attempt } from './attempt.ts'
import type { NodeDetection } from './detect.ts'

type Reader = {
  readonly parents: (text: string, pkg: string) => readonly Parent[]
  readonly copies: (text: string, pkg: string) => readonly Copy[]
}

const READERS: Readonly<Record<NodeDetection['pm'], Reader>> = { npm, pnpm, yarn }

/** The text of the lockfile that the detection names. */
export const lockfileText = ({ root, detection }: Tree<NodeDetection>): string =>
  readFileSync(join(root, detection.lockfile), 'utf8')

/** The reader for the manager that the detection names. */
export const readerOf = ({ detection }: Tree<NodeDetection>): Reader => READERS[detection.pm]

// Code unit order. For these names, it is the order of jq's `unique` and
// `keys`, and of `sort -u` in the C locale.
export const byText = (a: string, b: string): number => Number(a > b) - Number(a < b)

/** The names of the parents, each once, sorted as text. */
export const namesOf = (found: readonly Parent[]): readonly string[] =>
  [...new Set(found.map(({ name }) => name))].sort(byText)

/** `parents`. A throw from the read or from the reader is `failed`. */
export const parents = (tree: Tree<NodeDetection>, pkg: string): Envelope<ParentsAnswer> =>
  pkg === ''
    ? failed('parents requires a package name')
    : attempt(() => ({
        pm: tree.detection.pm,
        package: pkg,
        parents: readerOf(tree).parents(lockfileText(tree), pkg),
      }))
