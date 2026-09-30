// Paths into the plugins, for a test that runs a plugin's script or hook as
// its own process. The tests live under `tests/`, outside every plugin
// (`.claude/rules/path-plugins.md`), so a test reaches a plugin file through
// this module and not through `..` steps from its own directory. An import
// goes through the `#<plugin>/*` aliases in the root `package.json` instead.
import path from 'node:path'

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, '..')

/** A file inside `plugins/<plugin>/`, such as `scripts/gh-security.ts`. */
export const pluginFile = (plugin: string, ...parts: string[]): string =>
  path.join(ROOT, 'plugins', plugin, ...parts)

/** The placeholder Claude Code expands to the plugin root, in hooks.json and SKILL.md. */
export const PLUGIN_ROOT_PLACEHOLDER = ['$', '{CLAUDE_PLUGIN_ROOT}'].join('')
