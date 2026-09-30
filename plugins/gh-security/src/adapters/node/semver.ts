// `compare_versions` and `range_facts` for the node adapter, ported from
// `verb_compare_versions` and `verb_range_facts` in node.sh (#221). The
// semver module under `src/semver/` holds the rules. These verbs add the
// usage refusals of node.sh, and `compare_versions` adds the echo of its
// two arguments.
//
// This file ships. It imports nothing outside the plugin.

import { type Envelope, failed } from '../../lib/envelope.ts'
import { rangeFacts as factsOf } from '../../semver/ranges.ts'
import { versionFacts } from '../../semver/versions.ts'
import type { CompareVersionsAnswer, RangeFactsAnswer } from '../adapter.ts'
import { attempt } from './attempt.ts'

/** `verb_compare_versions`. An empty argument is a usage refusal, as `${1:?}` makes it. */
export const compareVersions = (a: string, b: string): Envelope<CompareVersionsAnswer> =>
  a === '' || b === ''
    ? failed('compare_versions requires two versions')
    : attempt(() => ({ a, b, ...versionFacts(a, b) }))

/** `verb_range_facts`. An empty argument is a usage refusal, as `${1:?}` makes it. */
export const rangeFacts = (range: string, version: string): Envelope<RangeFactsAnswer> =>
  range === '' || version === ''
    ? failed('range_facts requires a range and a version')
    : attempt(() => factsOf(range, version))
