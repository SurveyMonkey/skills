// The rules of .claude/rules/file-skill-md.md: every plugin skill has a flow
// directory, and no SKILL.md holds a command in a shell variable. Each check
// is proven red on a scratch tree, then held green on this repository.
import { describe, expect, it } from 'vitest'

import { REPO_ROOT } from '#harness/paths.ts'
import { commandVariables, missingFlows, scratchTree, trackedFiles } from '#harness/repo-layout.ts'

const repo = trackedFiles(REPO_ROOT)

// The placeholder Claude Code expands in a SKILL.md, spelled so it is not read
// as a template literal that lost its backticks.
const PLUGIN_ROOT = `$${'{'}CLAUDE_PLUGIN_ROOT}`

describe('every plugin skill has a flow directory', () => {
  it('names the flow a skill is missing, and not one that exists', () => {
    const root = scratchTree({
      'plugins/p/skills/a/SKILL.md': '',
      'plugins/p/skills/b/SKILL.md': '',
      'docs/flows/p/b/_skill-flow.md': '',
    })
    expect(missingFlows(root, trackedFiles(root))).toEqual(['docs/flows/p/a/_skill-flow.md'])
  })

  it('holds for this repository', () => {
    expect(missingFlows(REPO_ROOT, repo)).toEqual([])
  })
})

describe('no command held in a shell variable in a SKILL.md', () => {
  it('names a variable that holds a node command and is expanded', () => {
    const root = scratchTree({
      'plugins/p/skills/a/SKILL.md': `\`\`\`bash\nS="node ${PLUGIN_ROOT}/scripts/p.ts"\n$S sync\n\`\`\`\n`,
      'plugins/p/skills/b/SKILL.md': `\`\`\`bash\nnode "${PLUGIN_ROOT}/scripts/p.ts" sync\n\`\`\`\n`,
    })
    expect(commandVariables(root, trackedFiles(root))).toEqual(['plugins/p/skills/a/SKILL.md: $S'])
  })

  it('holds for this repository', () => {
    expect(commandVariables(REPO_ROOT, repo)).toEqual([])
  })
})
