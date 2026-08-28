---
"cypher-brain": patch
---

#465/#504 added a `--wait has no effect for --backend X` warning that fires
for any backend outside `WAIT_RETRY_BACKENDS` (arweave/turbo) — which
already included `ton`/`ton-provider` (`p2pFetchInto` in
`src/lib/backends/ton.ts`, which `ton-provider.ts`'s `get()` delegates to,
throws a plain `Error` on a not-yet-retrievable bag, not
`util.ts`'s `RetryableError`). #496 flagged this as an apparent gap, but
verifying against the mock TON/ton-provider infrastructure showed the
warning already firing correctly for both — no production code change
was needed.

This adds explicit `scripts/selftest-ton.sh`/`scripts/selftest-ton-provider.sh`
coverage locking that behavior in (a guard nobody has seen fire for a given
backend is not yet a guard for that backend), so `pull --backend ton --wait N`
and `pull --backend ton-provider --wait N` staying silent about a no-op
`--wait` can't regress unnoticed.

Fixes #496
