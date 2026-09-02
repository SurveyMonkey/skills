## Summary

- Resolves 2 Dependabot alert(s) for `lodash` in the 4.x line by adding scoped overrides
- Target version: >=4.17.21
- Resolved version: 4.17.21
- Other major lines of this package, if any, are fixed by their own PRs

## Alerts resolved

| # | CVE | Severity | EPSS | Summary |
|---|---|---|---|---|
| [#42](https://github.com/octo/app/security/dependabot/42) | CVE-2021-23337 | high | 84.2% | Command Injection in lodash |
| [#55](https://github.com/octo/app/security/dependabot/55) | GHSA-p6mc-m468-83gw | medium | 5.0% | Prototype Pollution in lodash |

## Merge risk: 🟢 Low (2/14)

- F1 version delta: minor (4.17.18 -> 4.17.21)
- F2 relationship: transitive


## Dependency chain

```
lodash@4.17.18
  express@4.18.0
    lodash "^4.17.18"
```

## Changes

```json
[
  {
    "parent": "express",
    "path": [
      "overrides",
      "express",
      "lodash"
    ],
    "value": ">=4.17.21 <5"
  }
]
```

## Verification

- [x] Lockfile validated: 1 resolved version(s) in the 4.x line satisfy
      `>=4.17.21 <5`, and no resolved copy still matches any alert's vulnerable range
- [x] No collateral: every copy of `lodash` on the other major lines resolves exactly as it did
      before this change (`other_line_moves: []`, against the baseline recorded after a no-change
      control install, so the comparison excludes stale-lockfile drift and measures only this
      change)
- CI on this PR is the verifier; coverage and CI presence are scored above

## References

- https://github.com/octo/app/security/dependabot/42
- https://github.com/octo/app/security/dependabot/55
