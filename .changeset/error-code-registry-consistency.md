---
"cypher-brain": patch
---

Error-code registry and docs consistency fixes found during an error-code
registry audit (#600, #601, #608, #609, #610, #611):

- `push --backend arweave`/`turbo` with a missing wallet now gives the same
  friendly `CB-E019` "no wallet at ... — run 'cypher-brain wallet create'
  first" message `wallet address`/`wallet balance` already gave, instead of a
  raw ENOENT `CB-E011`.
- `--sign-identity`/`--sign-recipient` missing-file errors now carry stable
  `CB-E022`/`CB-E023` codes, matching the pattern the rest of the registry
  follows for "a referenced file is missing".
- `MANAGEMENT.md`'s `CB-E011` row now also covers the `wallet address`/`wallet
  balance` non-ENOENT read-failure case, not just the arweave/turbo backend.
- `MANAGEMENT.md`'s error-codes intro no longer states a stale registry size;
  `src/lib/errors.ts`'s `ERROR_CODES` array is the count's single source of
  truth going forward.
- `scripts/selftest-error-codes.mjs`'s and `src/lib/errors.ts`'s header
  comments now reflect the current registry size and end-to-end coverage
  instead of long-stale figures.
