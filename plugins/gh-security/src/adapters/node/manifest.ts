// How the tree verbs of the node adapter read a `package.json`: as jq reads
// it, because jq reads it in node.sh (#221).
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'

// jq reads a byte order mark at the start of the file. `JSON.parse` does not.
const BYTE_ORDER_MARK = /^﻿/

// jq reads a file of only JSON white space as no document, and writes nothing.
const WHITE_SPACE = /^[ \t\n\r]*$/

/** What {@link readManifest} answers for a file that holds no document. */
export const NO_DOCUMENT: unique symbol = Symbol('no document')

/**
 * The JSON document in the file at `path`, or {@link NO_DOCUMENT}. It throws
 * for a file that it cannot read, and for text that is not JSON.
 */
export const readManifest = (path: string): unknown => {
  const text = readFileSync(path, 'utf8').replace(BYTE_ORDER_MARK, '')
  return WHITE_SPACE.test(text) ? NO_DOCUMENT : JSON.parse(text)
}

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * jq's `.key`: null for null or for an absent key. It throws where jq stops,
 * for a value that is not an object or null.
 */
export const field = (value: unknown, key: string): unknown => {
  if (value === null) return null
  if (!isRecord(value)) throw new Error(`cannot index a value that is not an object with "${key}"`)
  return Object.hasOwn(value, key) ? value[key] : null
}
