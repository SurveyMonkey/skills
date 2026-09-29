// The repository paths a test needs as a file on disk rather than as an
// import: the entry point it spawns, a bash script a parity run compares
// against, the fixture root. Each one is resolved from this file's own
// location, so no test counts `../` from wherever it happens to sit.

import { join, resolve } from 'node:path'

/** The repository root. */
export const REPO_ROOT: string = resolve(import.meta.dirname, '..')

/** The gh-security plugin root, the directory `${CLAUDE_PLUGIN_ROOT}` names once installed. */
export const GH_SECURITY_ROOT: string = join(REPO_ROOT, 'plugins', 'gh-security')

/** The gh-security CLI entry point. */
export const GH_SECURITY_ENTRY: string = join(GH_SECURITY_ROOT, 'scripts', 'gh-security.ts')
