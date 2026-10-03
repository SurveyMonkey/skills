// `fix-group classify`: phase 2, the port of `cmd_classify` in
// `scripts/common/fix-group.sh`. It runs on the tree before any install:
// `why` and `declared_ranges` read the lockfile, so a dead end that this
// phase can name costs no install (#103). The contract is in the header of
// `fix-group.ts`.
//
// This file ships. It imports nothing outside the plugin.

import type { CommandResult } from '../cli/command.ts'
import { orElse, tostring, uniqueJq } from '../jq.ts'
import { failed, type JsonObject, type JsonValue, ok } from '../lib/envelope.ts'
import { writeKey } from '../state.ts'
import { failPhase, type Loaded, promisedField } from './fix-group-common.ts'

/** A parent name without the version that a per-copy entry carries (#85). */
const bareName = (key: string): string => {
  const at = key.lastIndexOf('@')
  return at <= 0 ? key : key.slice(0, at)
}

/** A list that the answer carries, or the empty list, as jq's `// []` reads it. */
const listOf = (answer: Record<string, unknown>, key: string): JsonValue =>
  orElse(answer[key], []) as JsonValue

/** The classify phase, on a loaded state. */
export const classify = async (loaded: Loaded): Promise<CommandResult> => {
  const { driver, adapter } = loaded
  const pkg = driver.package
  const whySource = `adapter why ${pkg}`

  const tree = loaded.tree()
  const whyAnswer =
    tree.outcome === 'ok'
      ? await adapter.why(tree.value, pkg, { run: loaded.pm, env: loaded.env })
      : tree
  if (whyAnswer.outcome !== 'ok') {
    return failPhase('classify', `${whySource} failed: ${whyAnswer.error}`)
  }
  const why = whyAnswer.value as unknown as JsonObject

  // A package that only peer resolutions reach is a dead end: no override
  // key can move it. A field run spent four installs to prove what `why`
  // says before any install (#103).
  const peerOnly = promisedField('classify', why, whySource, 'peer_only')
  if ('outcome' in peerOnly) return peerOnly
  if (tostring(peerOnly.value) === 'true') {
    const peers = JSON.stringify(why.peer_parents ?? null)
    const optional = JSON.stringify(why.optional_peer_parents ?? null)
    return failPhase(
      'classify',
      `peer_only_dependency: ${pkg} is reached only through peer resolutions, so no override ` +
        `key can move it. peer_parents=${peers} optional_peer_parents=${optional}. The remedy is ` +
        'human work no override can substitute for: a major bump of one of the REQUIRED peer ' +
        'parents wide enough to require a patched range, or a real dependency declaration that ' +
        'gives the package an edge an override can reach. Bumping a parent that merely tolerates ' +
        'the package cannot force a patched range.',
    )
  }

  const line = driver.majorLine
  const rangesTree = loaded.tree()
  const declaredAnswer =
    rangesTree.outcome === 'ok'
      ? adapter.declaredRanges(rangesTree.value, pkg, Number(line))
      : rangesTree
  if (declaredAnswer.outcome !== 'ok') {
    return failPhase(
      'classify',
      `adapter declared_ranges --line ${line} ${pkg} failed: ${declaredAnswer.error}`,
    )
  }
  const declared: unknown = declaredAnswer.value
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    return failPhase('classify', 'adapter declared_ranges did not return a JSON object')
  }
  const ranges = declared as Record<string, unknown>

  // The eligible parents: read, unreadable and without a range. Only
  // `parents_other_lines` is out, because a sibling agent owns that line
  // (#83). A line that cannot be read is no proof of another line, so an
  // unreadable parent stays (#76). The scope is the parent's name (#85).
  const lists = ['parents_read', 'parents_unreadable', 'parents_without_range'].map((key) =>
    listOf(ranges, key),
  )
  if (
    !lists.every((list) => Array.isArray(list) && list.every((name) => typeof name === 'string'))
  ) {
    return failPhase(
      'classify',
      'adapter declared_ranges answered a parents_read, parents_unreadable or ' +
        'parents_without_range that is not a list of names, so no eligible parent can be read.',
    )
  }
  const eligible = uniqueJq((lists as string[][]).flat().map(bareName))

  // An absent `relationship` must not become the text "null" in the state:
  // `apply` reads it, and a value that is neither `direct` nor `transitive`
  // sends a direct dependency down the path for parents.
  const relationshipField = promisedField('classify', why, whySource, 'relationship')
  if ('outcome' in relationshipField) return relationshipField
  const relationship = tostring(relationshipField.value)
  if (relationship !== 'direct' && relationship !== 'transitive') {
    return failPhase(
      'classify',
      `${whySource} answered relationship '${relationship}', which is not in the contract enum ` +
        'direct|transitive (docs/adr/001-ecosystem-adapter-contract.md). Anything else routes the ' +
        "parent list by falling off the 'direct' branch, so a direct dependency would be pinned " +
        'through parents it has none of.',
    )
  }

  let state = driver.state
  for (const [key, value] of [
    ['why', why],
    ['declared', ranges as JsonObject],
    ['eligible_parents', eligible],
    ['relationship', relationship],
  ] as const) {
    const written = writeKey(state, key, value)
    if (written.outcome !== 'ok') return failed(written.error)
    state = written.value
  }

  return ok({
    status: 'ok',
    step: 'classify',
    relationship: why.relationship as JsonValue,
    eligible_parents: eligible,
    parents_read: listOf(ranges, 'parents_read'),
    parents_without_range: listOf(ranges, 'parents_without_range'),
    parents_unreadable: listOf(ranges, 'parents_unreadable'),
    parents_malformed: listOf(ranges, 'parents_malformed'),
    parents_other_lines: listOf(ranges, 'parents_other_lines'),
    ranges: listOf(ranges, 'ranges'),
  })
}
