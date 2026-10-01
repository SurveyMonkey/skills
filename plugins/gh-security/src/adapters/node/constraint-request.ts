// The request of `apply_constraint`, read as `verb_apply_constraint` reads
// its arguments (#222). node.sh refuses an empty or absent package and range
// with `${1:?}`. It joins the parents with line feeds, splits them again, and
// drops each empty one. So a parent that holds a line feed is two parents.
// `--tighten-bare` is a flag of the request, not an argument.
//
// This file ships. It imports nothing outside the plugin.

import { type Envelope, failed, ok } from '../../lib/envelope.ts'
import type { ConstraintRequest } from '../adapter.ts'

/** The request after the argument parse of node.sh, or its refusal. */
export const requestOf = (request: ConstraintRequest): Envelope<ConstraintRequest> => {
  if (request.pkg === '') return failed('apply_constraint requires a package name')
  if (request.range === '') return failed('apply_constraint requires a range')
  return ok({
    ...request,
    parents: request.parents
      .flatMap((parent) => parent.split('\n'))
      .filter((parent) => parent !== ''),
  })
}
