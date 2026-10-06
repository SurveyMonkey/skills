// `probeRegistry` for the node adapter (#228, round 6 ruling 8). node.sh has
// no such verb. The specification is phase 5 of `resolve-alerts` SKILL.md and
// the contract comment on #228.
//
// The verb runs one read-only probe of the registry of the tree. A dead
// registry token then stops one repository before its agents start, and not
// each agent at its install. The caller makes the retry and the cause.
//
// The package. The first scoped dependency of the root `package.json`, in
// `dependencies`, then `devDependencies`, then `optionalDependencies`.
// Private registries hold scoped packages. Only a spec with no `:` and no `/`
// counts, because the registry resolves only a range or a tag. A
// `workspace:`, `file:`, `link:`, `npm:` or git spec is not in the registry,
// and a probe of it reads as a 404. With no such dependency, the verb uses
// the fallback of the caller. With no fallback either, the verb fails.
//
// The command. `<pm_exec> view <package> version` for pnpm and npm, and
// `<pm_exec> npm info <package> --fields version` for Yarn Berry. It runs in
// the root of the tree, because the package manager reads `.npmrc` or
// `.yarnrc.yml` from there. Without that directory, a dead private token can
// probe green against the public registry. Yarn Berry also stops outside a
// project. The caller wraps the runner in the `env_prefix`, so the prefix
// comes after the directory. The command splits at white space, as `install`
// splits `install_cmd`.
//
// The status. The verb reads the HTTP status from the words of the package
// manager. Each pattern is in a specimen from a real run, in
// `spec/fixtures/registry-probe/`:
//   E401, E403, E404               npm, and pnpm 10, which runs `npm view`
//   YN0041                         Yarn Berry, for a 401
//   Response Code: 403, 404        Yarn Berry
// Yarn Berry writes its errors to stdout. So `output` holds stderr and then
// stdout.
//
// A non-zero exit is not a failure of the verb. Then `ok` is false, and the
// caller reads it. Exit 0 with no text on stdout, or with a failed pipe, is
// also not `ok`: a probe that answered nothing proved nothing.
//
// This file ships. It imports nothing outside the plugin.

import { join } from 'node:path'

import { type Envelope, failed, ok } from '../../lib/envelope.ts'
import type { ProbeSource, RegistryProbeAnswer, Tree } from '../adapter.ts'
import type { NodeDetection } from './detect.ts'
import { isRecord, readManifest } from './manifest.ts'

/** The time limit of one probe. The read-only steps of a fix agent have two minutes for two tries. */
export const PROBE_TIMEOUT_MS = 60_000

/** The manifest fields that the verb reads, in order. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/** `@scope/name`. */
const SCOPED = /^@[^/]+\/[^/]+$/

/** A range or a tag. Every other spec has a `:` or a `/`. */
const REGISTRY_SPEC = /^[^:/]*$/

/** The HTTP statuses that the probe output can name, with the words that name each. */
const STATUS_WORDS: readonly (readonly [401 | 403 | 404, RegExp])[] = [
  [401, /\bE401\b|\bYN0041:|Response Code: 401\b/],
  [403, /\bE403\b|Response Code: 403\b/],
  [404, /\bE404\b|Response Code: 404\b/],
]

/** The first scoped registry dependency of the manifest at `root`, null, or why it cannot say. */
const scopedDependency = (root: string): Envelope<string | null> => {
  const path = join(root, 'package.json')
  let manifest: unknown
  try {
    manifest = readManifest(path)
  } catch (error) {
    return failed(`probeRegistry: cannot read ${path}: ${(error as Error).message}`)
  }
  if (!isRecord(manifest)) return failed(`probeRegistry: ${path} is not a JSON object`)
  for (const name of DEPENDENCY_FIELDS) {
    const block = manifest[name]
    if (block === undefined) continue
    if (!isRecord(block)) return failed(`probeRegistry: ${name} in ${path} is not an object`)
    const found = Object.entries(block).find(
      ([pkg, spec]) => SCOPED.test(pkg) && typeof spec === 'string' && REGISTRY_SPEC.test(spec),
    )
    if (found !== undefined) return ok(found[0])
  }
  return ok(null)
}

/** `probeRegistry`. */
export const probeRegistry = async (
  { root, detection }: Tree<NodeDetection>,
  fallback: string | null,
  { run, env }: ProbeSource,
): Promise<Envelope<RegistryProbeAnswer>> => {
  const scoped = scopedDependency(root)
  if (scoped.outcome !== 'ok') return scoped
  const pkg = scoped.value ?? fallback
  if (pkg === null) {
    return failed(
      'probeRegistry: package.json has no scoped registry dependency, and the caller gave no fallback package',
    )
  }
  const tail =
    detection.pm === 'yarn' ? ['npm', 'info', pkg, '--fields', 'version'] : ['view', pkg, 'version']
  const [program, ...args] = [
    ...detection.pm_exec.split(/[ \t\n]+/).filter((word) => word !== ''),
    ...tail,
  ] as [string, ...string[]]
  const result = await run(program, args, {
    cwd: root,
    env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  const pipes = result.streamErrors.map(
    (broke) => `a pipe failed: ${broke.code}, ${broke.message}\n`,
  )
  const limit = result.timedOut
    ? [`the probe stopped at its limit of ${PROBE_TIMEOUT_MS} ms\n`]
    : []
  const output = [
    ...limit,
    ...pipes,
    result.startFailure === null ? `${result.stderr}${result.stdout}` : result.startFailure.message,
  ].join('')
  return ok({
    package: pkg,
    command: [program, ...args].join(' '),
    ok: result.status === 0 && pipes.length === 0 && result.stdout.trim() !== '',
    started: result.startFailure === null,
    http_status: STATUS_WORDS.find(([, words]) => words.test(output))?.[0] ?? null,
    output,
  })
}
