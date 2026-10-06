// What the merge-risk scorer reads from the tree: F3 (usage surface), F4
// (test coverage of that surface) and F5 (CI presence). This is the port of
// the grep, find, awk and sed reads in `scripts/common/score-merge-risk.sh`.
// The rules and the reasons for each are in the header of that script and in
// ADR 006. `score.ts` holds the factors and the bands.
//
// Each read is a line test, as grep does it. A file is read as UTF-8: grep
// passes the bytes through, and jq writes them in the report as UTF-8. A
// module name from the walk is UTF-8 too, so it compares with the names in
// a test file.
//
// Differences from the bash, each declared with #233:
//   - Text is sorted by its bytes: the uncovered modules, and the workflow
//     files in each glob. `sort` and the glob use the collation of the
//     locale, which is the byte order in the C locale.
//   - A tree that cannot be read names the error code of node, and not the
//     exit status of grep.
//   - A target or an entry point is split on white space, as the bash split
//     it. A glob character in one is not expanded against the tree.
//   - A binary file is read as text. grep names a binary file that matches,
//     and does not print its lines.
//
// This file ships. It imports nothing outside the plugin.

import { accessSync, constants, type Dirent, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

/** The directories that no walk goes into: build outputs, and the fix worktrees (ADR 003). */
const PRUNED: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'out',
  '.yarn',
  '.git',
  'storybook-static',
  '.claude',
])

/** The file names that each walk reads. */
const SOURCE_NAME = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/

/**
 * One definition of a test path. F3 excludes these paths, and F4 reads them,
 * so a path is never in both or in neither.
 */
export const TEST_PATH =
  /(^|\/)(__tests__|__mocks__|e2e|cypress|tests?|specs?)\/|\.(test|spec|stories)\./

/** The characters of `[[:space:]]` in the C locale. */
const WS = ' \\t\\n\\v\\f\\r'

/**
 * Each source file under `root`, as `./<path>`. With `strict`, a directory
 * that cannot be read throws the error of node, as grep exits 2. Else it is
 * skipped, as `find 2>/dev/null` skips it.
 */
export const sourceFiles = (root: string, strict: boolean): string[] => {
  const found: string[] = []
  const walk = (relative: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true })
    } catch (error) {
      if (strict) throw error
      return
    }
    for (const entry of entries) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (!PRUNED.has(entry.name)) walk(path)
      } else if (entry.isFile() && SOURCE_NAME.test(entry.name)) {
        found.push(`./${path}`)
      }
    }
  }
  walk('')
  return found
}

/** A target as a literal in a regex. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * The import line of each target, as one regex: ESM, CJS, a dynamic import
 * and a subpath. Null when there is no target.
 */
export const importPattern = (targets: readonly string[]): RegExp | null => {
  if (targets.length === 0) return null
  const s = `[${WS}]`
  const alternatives = targets.map((target) => {
    const name = `['"]${literal(target)}(/[^'"]*)?['"]`
    return `(from|import)${s}*\\(?${s}*${name}|require${s}*\\(${s}*${name}`
  })
  return new RegExp(alternatives.join('|'))
}

/** True when a line of the text matches, as `grep -l` decides. */
const anyLine = (text: string, pattern: RegExp): boolean =>
  text.split('\n').some((line) => pattern.test(line))

/**
 * The files that match `pattern` on a line, as `grep -rl` lists them. A file
 * that cannot be read throws the error of node.
 */
export const matchingFiles = (root: string, files: readonly string[], pattern: RegExp): string[] =>
  files.filter((file) => anyLine(readFileSync(join(root, file), 'utf8'), pattern))

/** The text of a file, or null when it cannot be read: `2>/dev/null || true`. */
const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const IMPORT_LINE = /(^|[^A-Za-z0-9_])(from|import|require)([^A-Za-z0-9_]|$)/
const SPECIFIER = /['"][^'"]*\/[^'"]*['"]/g

/**
 * Each module basename that a test file imports by a path: the last segment
 * of a quoted specifier with a `/`, on a line that names `from`, `import` or
 * `require`, without one extension of one to five letters or digits.
 */
export const testImportBases = (root: string, testFiles: readonly string[]): Set<string> => {
  const bases = new Set<string>()
  for (const file of testFiles) {
    const text = readOrNull(join(root, file)) ?? ''
    for (const line of text.split('\n')) {
      if (!IMPORT_LINE.test(line)) continue
      for (const match of line.matchAll(SPECIFIER)) {
        const specifier = match[0].slice(1, -1)
        const last = specifier.slice(specifier.lastIndexOf('/') + 1)
        bases.add(last.replace(/\.[A-Za-z0-9]{1,5}$/, ''))
      }
    }
  }
  return bases
}

/** True when a test file imports the package by name. A file that cannot be read is skipped. */
export const packageTested = (
  root: string,
  testFiles: readonly string[],
  pattern: RegExp | null,
): boolean =>
  pattern !== null &&
  testFiles.some((file) => {
    const text = readOrNull(join(root, file))
    return text !== null && anyLine(text, pattern)
  })

/** True when the path is a regular file, through a link: `[ -f ]`. */
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The names in a directory, or none when it cannot be read: a glob that matches nothing. */
const namesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * The basename of a module without its last extension: `${base%.*}`. A
 * module is a source file, so its name always has a dot.
 */
export const moduleBase = (module: string): string => {
  const name = posix.basename(module)
  return name.slice(0, name.lastIndexOf('.'))
}

/**
 * True when a sibling test sits beside the module: `<base>.test.*`,
 * `<base>.spec.*`, or `__tests__/<base>.*`. `module` has no `./` at its start.
 */
export const siblingTested = (root: string, module: string): boolean => {
  const dir = posix.dirname(module)
  const base = moduleBase(module)
  const beside = namesIn(join(root, dir)).filter(
    (entry) => entry.startsWith(`${base}.test.`) || entry.startsWith(`${base}.spec.`),
  )
  const tests = namesIn(join(root, dir, '__tests__')).filter((entry) =>
    entry.startsWith(`${base}.`),
  )
  return (
    beside.some((entry) => isFile(join(root, dir, entry))) ||
    tests.some((entry) => isFile(join(root, dir, '__tests__', entry)))
  )
}

/** The directory of the workflows, as the bash names it. */
export const WORKFLOW_DIR = '.github/workflows'

/** True when the workflow directory is a directory that cannot be read. */
export const workflowDirUnreadable = (root: string): boolean => {
  const dir = join(root, WORKFLOW_DIR)
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  try {
    accessSync(dir, constants.R_OK)
    return false
  } catch {
    return true
  }
}

/** Text in byte order. */
export const byBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b))

/**
 * The workflow files, as `.github/workflows/*.yml` and then `*.yaml` expand:
 * no name that starts with a dot, each glob in byte order, and regular files
 * only.
 */
export const workflowFiles = (root: string): string[] => {
  const names = namesIn(join(root, WORKFLOW_DIR)).filter((name) => !name.startsWith('.'))
  const glob = (suffix: string): string[] =>
    names.filter((name) => name.endsWith(suffix)).sort(byBytes)
  return [...glob('.yml'), ...glob('.yaml')]
    .map((name) => `${WORKFLOW_DIR}/${name}`)
    .filter((path) => isFile(join(root, path)))
}

/** The lines of a text, as awk and grep read them: no empty line after the last newline. */
const linesOf = (text: string): string[] => {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

const ON_EVENT = new RegExp(
  `^["']?on["']?:[${WS}]*.*pull_request(_target)?([${WS},]|\\]|\\}|:|$)`,
  's',
)
const ON_BARE = new RegExp(`^["']?on["']?:[${WS}]*(#.*)?$`, 's')
const BLOCK_EVENT = new RegExp(`^[${WS}]{1,8}pull_request(_target)?:`)
const LEADING = new RegExp(`^[${WS}]*`)
const TRAILING = new RegExp(`[${WS}]*$`)

/**
 * The pull request trigger of a workflow, or null. The scalar, list and map
 * forms give the text after `on:`. The block form needs a bare `on:` line,
 * and gives the event name.
 */
export const prTrigger = (text: string): string | null => {
  const lines = linesOf(text)
  const inline = lines.find((line) => ON_EVENT.test(line))
  if (inline !== undefined) {
    return inline.replace(new RegExp(`^["']*on["']*:[${WS}]*`), '').replace(TRAILING, '')
  }
  if (!lines.some((line) => ON_BARE.test(line))) return null
  const block = lines.find((line) => BLOCK_EVENT.test(line))
  return block === undefined ? null : block.replace(LEADING, '').replace(/:.*$/s, '')
}

const COMMENT = new RegExp(`^[${WS}]*#`)
const NOT_BLANK = new RegExp(`[^${WS}]`)
const RUN_KEY = new RegExp(`^[${WS}]*(-[${WS}]+)?run:`)
const RUN_PREFIX = new RegExp(`^[${WS}]*(-[${WS}]+)?run:[${WS}]*`)

/**
 * The commands a workflow runs: each `run:` scalar, and each line of a
 * `run: |` or `run: >` block. The port of the awk program. A comment line is
 * never a command.
 */
export const runCommands = (text: string): string[] => {
  const commands: string[] = []
  let inBlock = false
  let blockIndent = 0
  for (const line of linesOf(text)) {
    if (COMMENT.test(line)) continue
    const indent = (LEADING.exec(line) as RegExpExecArray)[0].length
    if (inBlock && !NOT_BLANK.test(line)) continue
    if (inBlock && indent > blockIndent) {
      commands.push(line)
      continue
    }
    inBlock = false
    if (!RUN_KEY.test(line)) continue
    const rest = line.replace(RUN_PREFIX, '')
    if (/^[|>]/.test(rest)) {
      inBlock = true
      blockIndent = indent
      continue
    }
    commands.push(rest)
  }
  return commands
}

const ECHO = new RegExp(`^[${WS}]*echo([${WS}]|$)`)
const CI_STEP = new RegExp(
  `(^|[${WS}&|;(])(npm|pnpm|yarn|bun|npx|bunx)[${WS}]+(run[${WS}]+)?(test|build|typecheck|check|lint)([:-][^${WS}]*)?([${WS}]|$)` +
    `|(^|[${WS}&|;(/])(vitest|jest|playwright|cypress|tsc)([${WS}]|$)`,
)

/** The first command that would check this fix, trimmed, or null. An `echo` runs nothing. */
export const ciStep = (text: string): string | null => {
  const step = runCommands(text).find((command) => !ECHO.test(command) && CI_STEP.test(command))
  return step === undefined ? null : step.replace(LEADING, '').replace(TRAILING, '')
}
