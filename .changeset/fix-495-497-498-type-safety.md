---
"cypher-brain": patch
---

Three small type-safety/error-handling fixes found by a code-quality audit:

- `scanForSecrets()` (`--scan-secrets warn|deny`) now validates that a parsed
  gitleaks report is actually an array of findings before iterating it. A
  report that parses as JSON but isn't shaped like one (a future gitleaks
  wrapping results in `{Results: [...]}`, or a truncated-but-valid write that
  lands as `null`) used to throw an unhandled `TypeError: raw is not
  iterable`; it now fails closed with the same clear "refusing to treat this
  as 'no findings'" error the module already documents as its intent (#495).
- `wallet address` (and `wallet balance`'s address derivation) now checks
  that a parsed wallet file actually looks like a JWK (`kty`/`e`/`n` present)
  before handing it to `arweave-js`. A syntactically-valid-but-wrong-shape
  wallet file (e.g. after a bad edit, or `CYPHER_BRAIN_AR_WALLET` pointed at
  the wrong file) used to surface a raw, unprefixed error from inside
  `arweave-js`; it now gets the same `"wallet address: cannot read JWK
  wallet..."` treatment every other failure path in this function already
  gets (#497).
- `config.ts` and `runbook.ts` now use the codebase's own `errMsg()` helper
  instead of hand-rolling `(e as Error)?.message ?? e` — the one
  un-consolidated duplicate of a pattern already centralized at ~90+ other
  call sites specifically to prevent this kind of drift. No behavior change
  for `Error` throws; a non-`Error` throw now goes through `errMsg`'s
  explicit `String(e)` like everywhere else (#498).
