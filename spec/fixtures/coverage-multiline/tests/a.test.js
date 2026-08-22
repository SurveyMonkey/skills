// Prettier wraps a long import across lines. The specifier is on a line that
// carries no `from`, so the one-line scan never sees it and src/a.js reads as
// uncovered. Documented limit, asserted here so it stays visible.
import {
  pick,
  omit,
} from
  '../src/a';

export { pick, omit };
