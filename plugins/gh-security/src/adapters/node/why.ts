// `why` for the node adapter, ported from `verb_why` in node.sh (#221). The
// lockfile readers under `src/lockfiles/` parse. This verb adds the facts of
// the root manifest, and the `peer_only` rule of #103 for a pnpm lockfile
// at lockfileVersion 9.
//
// `raw` is the text of the package manager's own `why` command, for a
// person to read. The verb takes it from its `source` (#221, round 3 ruling
// 2). With no `raw`, it runs `why_cmd` of the detection in the tree. It uses
// the runner and the environment that it is given. That is the one process
// seam of this verb. A command that does not start is no failure. `raw` is
// then the message of the start failure, as node.sh puts the message of the
// shell in `raw`. An exit that is not zero is no failure either. The verb
// does not run `detect`.
//
// This file ships. It imports nothing outside the plugin.

import { join } from 'node:path'

import { type Envelope, failed, ok } from '../../lib/envelope.ts'
import type { Runner } from '../../lib/process.ts'
import * as pnpm from '../../lockfiles/pnpm.ts'
import type { Tree, WhyAnswer, WhySource } from '../adapter.ts'
import { attempt } from './attempt.ts'
import type { NodeDetection } from './detect.ts'
import { field, isRecord, NO_DOCUMENT, readManifest } from './manifest.ts'
import { byText, lockfileText, namesOf, readerOf } from './parents.ts'

/** jq's `(.block // {}) | has($pkg)`. It throws where jq stops. */
const declares = (manifest: unknown, block: string, pkg: string): boolean => {
  const value = field(manifest, block)
  if (value === null || value === false) return false
  if (!isRecord(value)) throw new Error(`why: ${block} in package.json is not an object`)
  return Object.hasOwn(value, pkg)
}

type PeerFacts = Pick<WhyAnswer, 'peer_only' | 'peer_parents' | 'optional_peer_parents'>

const NO_PEERS: PeerFacts = { peer_only: false, peer_parents: [], optional_peer_parents: [] }

/**
 * The `peer_only` rule of #103, for a pnpm lockfile at lockfileVersion 9
 * only. It holds when all of these are true:
 *
 * - The root does not declare the package.
 * - No importer declares it.
 * - An edge or a peer suffix reaches it.
 * - Each edge to it comes from a snapshot key whose peer suffix names it.
 *
 * A parent is an optional peer when its suffixed snapshot reaches the
 * package only through `optionalDependencies:`. `peer_parents` has the
 * required peers first, and each group is sorted.
 */
const peerFacts = (text: string, pkg: string, direct: boolean): PeerFacts => {
  if (!pnpm.isV9(text)) return NO_PEERS
  const { importers, suffixes, edges } = pnpm.scan(text, pkg)
  const suffixed = (kind: pnpm.Edge['kind']) =>
    new Set(
      edges.filter((edge) => edge.suffixed && edge.kind === kind).map(({ parent }) => parent.name),
    )
  const required = suffixed('dependencies')
  const optional = suffixed('optionalDependencies')
  // The sort key of `sort -u` in node.sh: the flag, a tab, the name.
  const peers = [...new Set(suffixes.map(({ name }) => name))]
    .map((name) => ({ name, key: `${optional.has(name) && !required.has(name) ? 1 : 0}\t${name}` }))
    .sort((a, b) => byText(a.key, b.key))
  return {
    peer_only:
      !direct &&
      importers.length === 0 &&
      (edges.length > 0 || suffixes.length > 0) &&
      edges.every((edge) => edge.suffixed),
    peer_parents: peers.map(({ name }) => name),
    optional_peer_parents: peers.filter(({ key }) => key.startsWith('1')).map(({ name }) => name),
  }
}

/** Everything that `why` reads from the tree: all of the answer but `raw`. */
const factsOf = (tree: Tree<NodeDetection>, pkg: string): Omit<WhyAnswer, 'raw'> => {
  const manifest = readManifest(join(tree.root, 'package.json'))
  if (manifest === NO_DOCUMENT) throw new Error('why: package.json holds no JSON document')
  const direct = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .map((block) => declares(manifest, block, pkg))
    .some(Boolean)
  const text = lockfileText(tree)
  const parents = namesOf(readerOf(tree).parents(text, pkg))
  return {
    pm: tree.detection.pm,
    package: pkg,
    relationship: direct ? 'direct' : 'transitive',
    dev_only:
      declares(manifest, 'devDependencies', pkg) && !declares(manifest, 'dependencies', pkg),
    parents,
    parent_count: parents.length,
    ...(tree.detection.pm === 'pnpm' ? peerFacts(text, pkg, direct) : NO_PEERS),
  }
}

/**
 * The output of `why_cmd` for `pkg`: stdout and stderr both, in the order
 * that their chunks came in. node.sh writes the two to one file
 * (`> file 2>&1`), in the order of the writes, so the mix can differ. The
 * command splits at white space, as the shell splits an unquoted word.
 */
const runWhy = async (
  { root, detection }: Tree<NodeDetection>,
  pkg: string,
  { run, env }: Extract<WhySource, { run: Runner }>,
): Promise<string> => {
  const [command, ...args] = detection.why_cmd.split(/[ \t\n]+/).filter((word) => word !== '') as [
    string,
    ...string[],
  ]
  const result = await run(command, [...args, pkg], { cwd: root, env })
  return result.startFailure === null ? result.combined : result.startFailure.message
}

/** `verb_why`. */
export const why = async (
  tree: Tree<NodeDetection>,
  pkg: string,
  source: WhySource,
): Promise<Envelope<WhyAnswer>> => {
  if (pkg === '') return failed('why requires a package name')
  const facts = attempt(() => factsOf(tree, pkg))
  if (facts.outcome !== 'ok') return facts
  const raw = source.raw === undefined ? await runWhy(tree, pkg, source) : source.raw
  // node.sh removes the newlines at the end of the output.
  return ok({ ...facts.value, raw: raw.replace(/\n+$/, '') })
}
