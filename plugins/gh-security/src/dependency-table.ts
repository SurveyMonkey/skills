// The tools that gh-security needs, in one table
// (`.claude/skills/plugin-design/dependencies.md`). The `session-start` hook
// checks it.
// `bash` and `jq` stay here because `notice-scan.sh` and `detect-capacity.sh`
// stay bash after the port. `detect-scope` runs `ssh -G` to resolve an alias
// of the ssh configuration (#305).
//
// This file ships. It imports nothing outside the plugin.

import type { Dependency } from './lib/dependencies.ts'
import { NODE_FLOOR } from './lib/node-floor.ts'

/** The `tool` of the node row. A version check answers it, not a PATH lookup. */
export const NODE_TOOL = 'node'

export const DEPENDENCIES: readonly Dependency[] = [
  { tool: NODE_TOOL, label: `node ${NODE_FLOOR} or newer` },
  { tool: 'git', label: 'git' },
  { tool: 'gh', label: 'the GitHub CLI (gh)' },
  { tool: 'ssh', label: 'ssh' },
  { tool: 'bash', label: 'bash' },
  { tool: 'jq', label: 'jq' },
]
