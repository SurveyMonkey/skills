// The adapter registry: GitHub's advisory ecosystem to an adapter, in process.
// This is the port of the single mode of `select-adapter.sh`. The batch mode
// of that script, `--from-discovery`, is the first step of `classify-lines`.
//
// Routing keys on the alert's own ecosystem, never on a scan of the
// repository root. A polyglot repository has one lockfile for each toolchain,
// and only the alert knows which one it belongs to.
//
// An ecosystem with no adapter is an answer, not an error: `supported` is
// false and the caller skips it. GitHub's ecosystem names are rubygems, npm,
// pip, maven, nuget, composer, go, rust, erlang, actions, pub, swift and
// other. Only `npm` has an adapter today.
//
// The registry has no CLI entry. Its callers are `check-advisories`,
// `discover-alerts` and `classify-lines`.
//
// This file ships. It imports nothing outside the plugin.

import type { Adapter } from './adapter.ts'
import type { NodeDetection } from './node/detect.ts'
import { node } from './node.ts'

/** The reason that the script gives for an ecosystem with no adapter. */
export const UNSUPPORTED_REASON = 'ecosystem not supported yet'

/**
 * The answer for one ecosystem. A supported route holds the adapter itself.
 * The script gave a path to the bash adapter, and a path means nothing here.
 */
export type AdapterRoute =
  | {
      readonly supported: true
      readonly ecosystem: string
      /** The adapter's basename, as the script gave it. */
      readonly name: 'node'
      readonly adapter: Adapter<NodeDetection>
      /** The manifest path of the alert, or null. */
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

/**
 * The one place that routing is decided. A `Map` and not an object, because
 * an ecosystem such as `constructor` or `__proto__` would find a member of
 * `Object.prototype` in a plain object.
 */
const ROUTES: ReadonlyMap<
  string,
  { readonly name: 'node'; readonly adapter: Adapter<NodeDetection> }
> = new Map([['npm', { name: 'node', adapter: node }]])

/** Route one ecosystem. The name is matched as written, with no change of case. */
export const selectAdapter = (ecosystem: string, manifest: string | null = null): AdapterRoute => {
  const route = ROUTES.get(ecosystem)
  if (route === undefined) {
    return {
      supported: false,
      ecosystem,
      name: null,
      adapter: null,
      manifest,
      reason: UNSUPPORTED_REASON,
    }
  }
  return { supported: true, ecosystem, name: route.name, adapter: route.adapter, manifest }
}
