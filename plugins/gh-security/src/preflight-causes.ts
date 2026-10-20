// The causes of a registry preflight that failed twice. `preflight-repo`
// gives one in its answer, and `summarize-run` reads one from that answer.
// Both import this list and its type, so a cause cannot be in one and not
// in the other. This file has no import of the node adapter on purpose: a
// `summarize-run` that imported `preflight-repo` would load that adapter.
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
