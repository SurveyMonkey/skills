// `probeRegistry` for the node adapter (#228, round 6 ruling 8). node.sh has
// no such verb. The specification is phase 5 of `resolve-alerts` SKILL.md and
// the contract comment on #228.
//
// The verb runs one read-only probe of the registry of the tree. A dead
// registry token then stops one repository before its agents start, and not
// each agent at its install. The caller makes the retry and the cause.
//
// The package. A scoped dependency of the root `package.json`, in
// `dependencies`, then `devDependencies`, then `optionalDependencies`.
// Private registries hold scoped packages. A scope that the repository maps to
// a registry comes first (#324): a `@<scope>:registry=` line of `.npmrc`, or a
// key of `npmScopes` in `.yarnrc.yml`. Both files are read by line, with no
// parser, and a file that cannot be read maps nothing. The `.npmrc` of the
// user is not read, so the answer depends on the repository only. Without a
// mapped scope, the first scoped dependency applies. Only a spec with no `:` and no `/`
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
// stdout. The verb reads the status from the full text, and then cuts
// `output` to its first 4 KiB and its last 4 KiB (#324). One marker line
// between them names the bytes cut. The tail keeps the error of Yarn Berry,
// which comes after a stderr of about 61 KB of minified source.
//
// A non-zero exit is not a failure of the verb. Then `ok` is false, and the
// caller reads it. Exit 0 with no text on stdout, or with a failed pipe, is
// also not `ok`: a probe that answered nothing proved nothing.
//
// This file ships. It imports nothing outside the plugin.

import { join } from 'node:path'

import { type Envelope, failed, ok } from '../../lib/envelope.ts'
import type { ProbeSource, RegistryProbeAnswer, Tree } from '../adapter.ts'
import { linesOf, type NodeDetection } from './detect.ts'
import { isRecord, readManifest } from './manifest.ts'

/** The time limit of one probe. The read-only steps of a fix agent have two minutes for two tries. */
export const PROBE_TIMEOUT_MS = 60_000

/** The manifest fields that the verb reads, in order. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/** `@scope/name`. */
const SCOPED = /^@[^/]+\/[^/]+$/

/** A range or a tag. Every other spec has a `:` or a `/`. */
const REGISTRY_SPEC = /^[^:/]*$/

/** The bytes that `output` keeps at each end. A longer text is cut in the middle. */
export const OUTPUT_KEEP_BYTES = 4096

/**
 * `text` with the middle cut when it is longer than two ends of
 * {@link OUTPUT_KEEP_BYTES}. One marker line names the bytes cut. The ends are
 * bytes, so a multi-byte character at a cut can become U+FFFD.
 */
const bounded = (text: string): string => {
  const bytes = Buffer.from(text, 'utf8')
  const cut = bytes.length - 2 * OUTPUT_KEEP_BYTES
  if (cut <= 0) return text
  const head = bytes.subarray(0, OUTPUT_KEEP_BYTES).toString('utf8')
  const tail = bytes.subarray(bytes.length - OUTPUT_KEEP_BYTES).toString('utf8')
  return `${head}\n[the probe output is cut here: ${cut} bytes]\n${tail}`
}

/** The HTTP statuses that the probe output can name, with the words that name each. */
const STATUS_WORDS: readonly (readonly [401 | 403 | 404, RegExp])[] = [
  [401, /\bE401\b|\bYN0041:/],
  [403, /\bE403\b|Response Code: 403\b/],
  [404, /\bE404\b|Response Code: 404\b/],
]

/** `@<scope>:registry=<value>` of `.npmrc`. A comment line starts with `;` or `#`. */
const NPMRC_SCOPE = /^[ \t]*@([^/:\s]+):registry[ \t]*=[ \t]*\S/

/** A scope key of `npmScopes`, as a line: `scope:` or a quoted one, with nothing after it. */
const YARN_SCOPE_KEY = /^ +["']?([^\s"':]+)["']?:[ \t\r]*$/

/** The scope names, with no `@`, that the repository maps to a registry. */
const mappedScopes = (root: string): ReadonlySet<string> => {
  const scopes = new Set<string>()
  for (const line of linesOf(join(root, '.npmrc'))) {
    const match = NPMRC_SCOPE.exec(line)
    if (match !== null) scopes.add(match[1] as string)
  }
  const yarnrc = linesOf(join(root, '.yarnrc.yml'))
  const start = yarnrc.findIndex((line) => /^npmScopes:[ \t\r]*$/.test(line))
  // The keys of the block are the lines at its first indent. A line with no
  // indent ends the block. A blank line, or a comment, does not.
  let indent: number | null = null
  for (const line of start === -1 ? [] : yarnrc.slice(start + 1)) {
    if (/^[ \t\r]*(#.*)?$/.test(line)) continue
    const width = line.length - line.trimStart().length
    if (width === 0) break
    indent ??= width
    const match = width === indent ? YARN_SCOPE_KEY.exec(line) : null
    if (match !== null) scopes.add(match[1] as string)
  }
  return scopes
}

/** The scoped registry dependency of the manifest at `root` to probe, null, or why it cannot say. */
const scopedDependency = (root: string): Envelope<string | null> => {
  const path = join(root, 'package.json')
  let manifest: unknown
  try {
    manifest = readManifest(path)
  } catch (error) {
    return failed(`probeRegistry: cannot read ${path}: ${(error as Error).message}`)
  }
  if (!isRecord(manifest)) return failed(`probeRegistry: ${path} is not a JSON object`)
  const scopes = mappedScopes(root)
  let first: string | null = null
  for (const name of DEPENDENCY_FIELDS) {
    const block = manifest[name]
    if (block === undefined) continue
    if (!isRecord(block)) {
      // The first candidate was found before this field: it is not read.
      if (first !== null) continue
      return failed(`probeRegistry: ${name} in ${path} is not an object`)
    }
    for (const [pkg, spec] of Object.entries(block)) {
      if (!SCOPED.test(pkg) || typeof spec !== 'string' || !REGISTRY_SPEC.test(spec)) continue
      if (scopes.has(pkg.slice(1, pkg.indexOf('/')))) return ok(pkg)
      first ??= pkg
    }
    // With no mapped scope, the first candidate ends the search, as before.
    if (first !== null && scopes.size === 0) return ok(first)
  }
  return ok(first)
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
  const [program, ...args] = [...detection.pm_exec.split(/[ \t\n]+/), ...tail] as [
    string,
    ...string[],
  ]
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
  const full = [
    ...limit,
    ...pipes,
    result.startFailure === null ? `${result.stderr}${result.stdout}` : result.startFailure.message,
  ].join('')
  return ok({
    package: pkg,
    command: [program, ...args].join(' '),
    ok: result.status === 0 && pipes.length === 0 && result.stdout.trim() !== '',
    started: result.startFailure === null,
    http_status: STATUS_WORDS.find(([, words]) => words.test(full))?.[0] ?? null,
    output: bounded(full),
  })
}
