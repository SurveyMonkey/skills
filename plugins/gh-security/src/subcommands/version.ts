// `gh-security version`: the installed plugin version, read from the
// manifest that is the single place it lives (root CLAUDE.md: a plugin's
// version is in its own plugin.json and nowhere else).
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `fs`.

import { readFileSync } from 'node:fs'

import type { CommandResult } from '../cli/command.ts'
import { type Envelope, failure, type JsonValue, ok } from '../lib/envelope.ts'

/** The plugin manifest, relative to this file rather than to a caller's cwd. */
export const MANIFEST = new URL('../../.claude-plugin/plugin.json', import.meta.url)

/**
 * The version carried by a manifest's text. A manifest that does not parse,
 * or that carries no `version` string, is a hard error rather than an empty
 * answer: this is a file the plugin ships, so its absence or its wrong shape
 * is a packaging fault worth reporting (ADR 001, empty results are never
 * implicitly successful).
 */
export const versionFrom = (manifest: string): Envelope<JsonValue> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest)
  } catch {
    return failure('the plugin manifest is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
    return failure('the plugin manifest carries no version')
  }
  const { version } = parsed
  if (typeof version !== 'string') return failure('the plugin manifest version is not a string')
  return ok({ version })
}

export const version = (): CommandResult => versionFrom(readFileSync(MANIFEST, 'utf8'))
