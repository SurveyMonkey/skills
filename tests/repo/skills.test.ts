// The rules of .claude/rules/file-skill-md.md: every plugin skill has a flow
// directory, and no SKILL.md holds a command in a shell variable. Each check
// is proven red on a scratch tree, then held green on this repository.
import { describe, expect, it } from 'vitest'

import { PLUGIN_ROOT_PLACEHOLDER as PLUGIN_ROOT, REPO_ROOT } from '#harness/paths.ts'
import {
  commandVariables,
  missingFlows,
  pluginSkills,
  scratchTree,
  trackedFiles,
} from '#harness/repo-layout.ts'

const repo = trackedFiles(REPO_ROOT)

// The floor under both repository examples below: a discovery that stopped
// matching would make them pass while checking nothing.
it("discovers this repository's plugin skills", () => {
  expect(pluginSkills(repo)).toEqual([
    'plugins/gh-security/skills/audit-pins/SKILL.md',
    'plugins/gh-security/skills/resolve-alerts/SKILL.md',
  ])
})

describe('every plugin skill has a flow directory', () => {
  it('names the flow a skill is missing, and not one that exists', () => {
    const root = scratchTree({
      'plugins/p/skills/a/SKILL.md': '',
      'plugins/p/skills/b/SKILL.md': '',
      'docs/flows/p/b/_skill-flow.md': '',
    })
    expect(missingFlows(trackedFiles(root))).toEqual(['docs/flows/p/a/_skill-flow.md'])
  })

  it('holds for this repository', () => {
    expect(missingFlows(repo)).toEqual([])
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

  it.each([
    ['an exported assignment', `export S="node ${PLUGIN_ROOT}/scripts/p.ts"\n$S sync`],
    ['a local assignment', `local S="node ${PLUGIN_ROOT}/scripts/p.ts"\n"$S" sync`],
    ['an array', `S=(node ${PLUGIN_ROOT}/scripts/p.ts)\n"\${S[@]}" sync`],
    ['the script path alone', `S="${PLUGIN_ROOT}/scripts/p.ts"\nnode "$S" sync`],
  ])('names %s', (_case, body) => {
    const root = scratchTree({ 'plugins/p/skills/a/SKILL.md': `\`\`\`bash\n${body}\n\`\`\`\n` })
    expect(commandVariables(root, trackedFiles(root))).toEqual(['plugins/p/skills/a/SKILL.md: $S'])
  })

  it('does not name an assignment that is never expanded', () => {
    const root = scratchTree({
      'plugins/p/skills/a/SKILL.md': `\`\`\`bash\nS="node ${PLUGIN_ROOT}/scripts/p.ts"\n\`\`\`\n`,
    })
    expect(commandVariables(root, trackedFiles(root))).toEqual([])
  })

  it('holds for this repository', () => {
    expect(commandVariables(REPO_ROOT, repo)).toEqual([])
  })
})
