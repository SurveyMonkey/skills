// The causes of a registry preflight that excluded a repository: a probe
// that failed twice, or a `detect` that failed. `preflight-repo` gives one
// in its answer, and `summarize-run` reads one from that answer. The answer
// type of `preflight-repo` and the text of each cause in `run-summary` use
// the type, and `run-inputs` reads a cause with the list. So
// `preflight-repo` cannot give a cause that `summarize-run` refuses, and
// `run-summary` has a text for each cause. This file has no import of the
// node adapter on purpose: a `summarize-run` that imported `preflight-repo`
// would load that adapter.
//
//   auth        HTTP 401 or 403. The registry token is dead.
//   not-found   HTTP 404. The registry has no such package.
//   network     anything else, such as a time limit, DNS or a reset.
//   start       the package manager did not start.
//   detect      the adapter could not detect the package manager.
//
// This file ships. It imports nothing outside the plugin.

export const CAUSES = ['auth', 'not-found', 'network', 'start', 'detect'] as const

export type Cause = (typeof CAUSES)[number]
