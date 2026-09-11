---
"cypher-brain": minor
---

`witness verify` (and any `push --witness` that reaches `loadWitnessIdentity()`) now
produces a more precise exit-code contract — fixes four dogfooding-pass gaps (#930,
#931, #932, #933):

- **Exit codes (#930, behavior change scripts may depend on).** `witness --help`'s
  own wording already claimed conflicts/unknown-freshness and invalid
  signatures/hash links were distinguishable by exit code, but every one of them
  exited **1**. A genuine authenticity/integrity failure — a signature that fails to
  verify (mismatched `--sig-locator` or `--pubkey`), or a broken hash link between
  chained entries — now throws a new `WitnessAuthenticityError` and exits **3**
  instead. The benign, non-error `freshness-unknown`/`conflicting` OUTCOMES are
  unchanged and still exit 1 — only genuinely thrown authenticity errors move.
  `--json`'s `outcome`/`error`/`exit_code` fields already differentiated these; only
  exit-code-only automation was affected.
- **Consistent usage-error exit codes (#932).** `loadWitnessIdentity()`'s two
  adjacent preconditions (missing signing identity, and an unsupported `--backend`
  for `--witness`) are both pure usage mistakes decidable from local flags/state
  alone. Both now throw `UsageError` and exit **2**; the missing-identity check used
  to exit 1.
- **Docs (#931, #933).** `witness --help` now documents that losing the local hint
  cache (`witness-catalog.local.jsonl`) caps how far back a chain can be verified —
  it is untrusted, but load-bearing for chain depth, since `prev_entry_hash` is a
  hash rather than a discoverable locator. `witness --help`'s exit-code prose is
  corrected to match the fix above. `MANAGEMENT.md`'s `CB-E016` entry (and
  `errors.ts`'s registry `source` field) now also names `witness verify`'s chain
  authentication as a source of that code, alongside `restore`/`verify`.
