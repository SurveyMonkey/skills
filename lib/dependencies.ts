// The dependency check for a SessionStart hook (`.claude/rules/_design-principles.md`,
// "Dependencies outside a plugin"). A plugin declares its tools as a table.
// The hook asks this file which of them are absent.
//
// This file is pure. It takes the table and the lookup as arguments, so a
// test needs no PATH, no child process and no file read.
//
// This file ships. It imports nothing.

/** One tool a plugin needs: the name the lookup takes, and the text a user reads. */
export interface Dependency {
  readonly tool: string
  readonly label: string
}

/**
 * The rows of `table` for which `present` answers false, in table order.
 * `present` takes the `tool` of one row. The hook passes a PATH lookup. A
 * test passes a function over a fixed set.
 */
export const absentDependencies = (
  table: readonly Dependency[],
  present: (tool: string) => boolean,
): readonly Dependency[] => table.filter((dependency) => !present(dependency.tool))
