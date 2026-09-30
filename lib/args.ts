// This file parses arguments. It wraps `node:util`'s `parseArgs` (#125's
// scope line names it). This file writes the wrapper once, instead of in
// each `bin`. RFC 001 decision 3 keeps `bin` a thin adapter with no
// decisions in it. A parse with a return value is also testable without a
// process.
//
// This file parses arguments. It wraps `node:util`'s `parseArgs`, so each
// entry point does not write the wrapper again. An entry point stays a thin
// adapter with no decisions in it. A parse with a return value is also
// testable without a process.
//
// **What this file adds to `parseArgs`.** node answers a bad command line
// with a thrown `TypeError`. Here, the answer comes back as an envelope, so
// a caller does not catch and translate the error. `choices` is the one
// piece of `argparse` that node has no answer for.
//
// A bad command line is exit 1 here, as `failure` from `envelope.ts`. ADR 001
// keeps exit 2 for a verb that is not implemented, so a refusal cannot use
// it. The target stack has a separate `refused` outcome. It returns when
// `envelope.ts` converges.
//
// **What `parseArguments` deliberately does not add.** It does not add
// positionals. `parseArgs` refuses them, and the refusal travels as an
// envelope. `parseCommandLine` is the widened sibling for a command that
// needs positionals. Every other caller keeps that path closed.
//
// This file also does not add support for `--help`. Help text is a
// command's own sentence about itself. A command declares a `help` boolean
// and prints its own text. That is one line there, against a text generator
// here that every command would then have to fit.
//
// This file ships. It imports only `node:util` and `./envelope.ts`. It stays
// inside the erasable subset (ADR 012).

import { parseArgs } from 'node:util'

import { type Envelope, failure, ok } from './envelope.ts'

/**
 * One option. A string option carries a default value. It never allows
 * `undefined`. Every read is then a value. No caller needs a fallback
 * branch for "the flag was not passed", so no test has to reach that
 * branch. A command that wants to know whether a flag was passed asks for
 * a boolean option beside it.
 *
 * A boolean option may name one `short` letter. This passes straight to
 * `parseArgs`. Left out, the option has no short form. `parseArgs` then
 * refuses it, the same way it refuses any flag nobody declared.
 */
export type OptionSpec =
  | { readonly type: 'boolean'; readonly short?: string }
  | { readonly type: 'string'; readonly default: string; readonly choices?: readonly string[] }

export type ArgSpec = Readonly<Record<string, OptionSpec>>

/**
 * What one option parses to. An option that declares `choices` parses to
 * those choices, not to a bare `string`. The check below refuses any other
 * value before the envelope is built. The narrower type is then a fact
 * about the value, not a hope. A command that switches on the value does
 * not have to re-prove what the parser already refused.
 */
type ValueOf<S extends OptionSpec> = S extends { type: 'boolean' }
  ? boolean
  : S extends { choices: readonly (infer C extends string)[] }
    ? C
    : string

/** The parsed command line: one property per declared option, never partial. */
export type Options<S extends ArgSpec> = { readonly [K in keyof S]: ValueOf<S[K]> }

/** What a parsed command line answers with, when it may carry positionals.
 *  This is every declared option, and the words that `parseArgs` did not
 *  read as an option or its value. */
export type CommandLine<S extends ArgSpec> = {
  readonly options: Options<S>
  readonly positionals: readonly string[]
}

/**
 * A spec, as the two exports below take it. The intersection makes
 * {@link Options}'s promise above true, not merely written down.
 *
 * `const S` at the call site fixes literal types at the argument
 * expression. An inline spec, or one declared `as const`, keeps its keys
 * and its `choices`. A spec that arrives already annotated `: ArgSpec` does
 * not keep them. `Options<S>` then silently degrades to an index
 * signature. Every value gains `| undefined`, and an option nobody
 * declared reads clean.
 *
 * `string extends keyof S` is true of exactly that degraded spec, and of
 * nothing else. Such a spec is refused at the call site, with the type of
 * the named argument. It does not surface later as a missing narrowing the
 * caller must work around.
 */
type ExactSpec<S extends ArgSpec> = S & (string extends keyof S ? never : unknown)

/**
 * The core both exports share. It builds `parseArgs`' own option table from
 * `spec`. It checks each default against its own `choices`. Then it
 * parses, and checks the parsed values against `choices` again.
 * `allowPositionals` is the one difference between {@link parseArguments}
 * and {@link parseCommandLine}. It is a parameter here, so the checks
 * around it need no second copy.
 */
// No {@link ExactSpec} here. Both callers already carry that constraint on
// their own type parameter, before they reach this function. A second,
// independent type parameter that repeats the constraint is what defeated
// `tsc`. The two conditional types normalise differently. The call site's
// already-narrowed spec then no longer satisfied the callee's version of
// the same check.
const parseCore = <S extends ArgSpec>(
  argv: readonly string[],
  spec: S,
  allowPositionals: boolean,
): Envelope<CommandLine<S>> => {
  const options: Record<
    string,
    { type: 'string' | 'boolean'; default: string | boolean; short?: string }
  > = {}
  for (const [name, option] of Object.entries(spec)) {
    if (option.type === 'boolean') {
      // `parseArgs` refuses a `short` key whose value is `undefined`. It
      // checks the key is present. It does not check that the value is a
      // string. An option with no short form must leave the key out
      // entirely. It must never set the key to `undefined`.
      options[name] =
        option.short === undefined
          ? { type: 'boolean', default: false }
          : { type: 'boolean', default: false, short: option.short }
      continue
    }
    // A default outside the option's own choices is a fault in the spec,
    // not in the command line. `parseArgs` fills in the default whenever
    // the flag is absent. Such a spec then refuses every command line, and
    // names a flag the caller never typed and cannot correct. The target
    // stack reports this as `failed` (exit 1), apart from a `refused`
    // command line (exit 2). Here both are `failure`.
    //
    // This check runs here, over the spec alone, before the command line
    // is parsed. The verdict then does not depend on argv. Asked from the
    // loop below, it would lose to whatever answer returned first. That
    // could be an unparsable command line, or an earlier option's bad
    // value. The broken spec would then stay unreported, for as long as
    // anyone typed the wrong value.
    if (option.choices !== undefined && !option.choices.includes(option.default)) {
      return failure(
        `--${name} declares a default of "${option.default}", ` +
          `which is not one of ${option.choices.join(', ')}`,
      )
    }
    options[name] = { type: 'string', default: option.default }
  }

  let parsed: { values: Record<string, unknown>; positionals: string[] }
  try {
    parsed = parseArgs({ args: [...argv], options, strict: true, allowPositionals })
  } catch (error) {
    // `parseArgs` throws only a `TypeError`, so the message is read
    // directly. An `instanceof` guard here would add a branch no input can
    // reach. The coverage rule says to restructure that branch away, not
    // to exclude it.
    return failure((error as Error).message)
  }

  for (const [name, option] of Object.entries(spec)) {
    if (option.type !== 'string' || option.choices === undefined) continue
    // Every declared option has a default, so this value is a string by
    // construction. The cast is erased, and adds no branch.
    const value = parsed.values[name] as string
    if (!option.choices.includes(value)) {
      return failure(`--${name} must be one of ${option.choices.join(', ')}, not "${value}"`)
    }
  }

  return ok({ options: parsed.values as Options<S>, positionals: parsed.positionals })
}

/**
 * Parse `process.argv.slice(2)` against `spec`. A stray positional is
 * refused here. A command that wants a positional asks for
 * {@link parseCommandLine} instead (the header above says why that is the
 * default).
 *
 * A refusal is a `failure` (exit 1). It carries node's own wording for
 * an unknown option, a missing value, or a stray positional. Its message
 * is not rewritten: node names the token that is wrong, which is what a
 * caller needs. A tidied spelling would be wording this repository then
 * owns.
 */
export const parseArguments = <const S extends ArgSpec>(
  argv: readonly string[],
  spec: ExactSpec<S>,
): Envelope<Options<S>> => {
  const parsed = parseCore(argv, spec, false)
  return parsed.outcome === 'ok' ? ok(parsed.value.options) : parsed
}

/**
 * `parseArguments`, widened to also hand back the words `parseArgs` did
 * not read as an option or its value. This is for the one command that
 * needs them.
 */
export const parseCommandLine = <const S extends ArgSpec>(
  argv: readonly string[],
  spec: ExactSpec<S>,
): Envelope<CommandLine<S>> => parseCore(argv, spec, true)
