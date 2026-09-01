---
'cypher-brain': patch
---

`scripts/go/storage-v1-client` (the experimental Go client for the live TON Storage
Go/StorageV1 provider market) gets three fixes:

- `status.go`'s `fetchAccountState()` no longer hard-fails when tonapi's
  `blockchain/accounts` endpoint answers a genuinely fresh address with HTTP 404
  (`{"error":"entity not found"}`) — confirmed against the real API for multiple
  independently-generated fresh addresses. It now falls back to the plain
  `/v2/accounts/` endpoint, which answers the same address with an ordinary 200
  `{"status":"nonexist"}`, mirroring the equivalent tonapi-404 workaround already in
  `src/lib/backends/ton-provider.ts`. Since `status`, `deploy`, `notify`,
  `update-providers`, and `withdraw` all share this one function, the fix covers all
  five subcommands — most notably `deploy`'s own pre-deploy freshness check, which
  previously refused to even offer a Tonkeeper deeplink for a brand-new bag/owner pair
  (the normal case for a first-ever deploy). A non-404 failure (timeout/5xx/malformed
  body) is still surfaced as an error, never silently treated as "nonexist". (#716)
- `main.go`'s `run()` now exits 1 (not 2) for a bare invocation (no args) or an unknown
  subcommand, matching the exit code a missing required flag already used — exit 2 is
  now reserved exclusively for `guardError` (a deliberate, semantic on-chain-safety
  refusal, as every subcommand's own `--help` section already documents), so a caller
  can reliably branch on exit code alone between "you invoked this wrong" and "a real
  refusal happened". (#750)
- `deploy --help`/`update-providers --help`/`withdraw --help`'s per-flag description
  columns are now internally consistent within each subcommand's help block (both the
  first line and any wrapped continuation lines share one left-alignment column) —
  fixes hand-typed padding that had drifted whenever a flag name's length wasn't
  accounted for (`--rate-nano-per-mb-day <int>` in `deploy`, `--gas-ton <float>` in
  `update-providers`, and `--contract`/`--max-spend-ton`/`--mainnet` in `withdraw`).
  Pure formatting, no functional change. (#752)

New tests: `status_test.go` gains a 404-fallback regression test plus two negative
controls (both endpoints failing; a non-404 failure not triggering the fallback);
`main_test.go` gains an exit-code regression test for all three "invoked this wrong"
shapes (no-args/unknown-subcommand/missing-flag) alongside a `guardError` positive
control, and a help-text alignment assertion covering all six subcommands.
