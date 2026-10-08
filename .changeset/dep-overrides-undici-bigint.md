---
'cypher-brain': patch
---

Pin `undici` to 6.29.0 and `bigint-buffer` to the maintained
`@trufflesuite/bigint-buffer` 1.1.10 fork via `overrides`. Both are reached only
through the optional `@ardrive/turbo-sdk` and carry known advisories with no fix
in the versions it pins.
