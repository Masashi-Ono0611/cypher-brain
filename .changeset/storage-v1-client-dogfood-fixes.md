---
'cypher-brain': patch
---

Fixes three dogfooding findings around `scripts/go/storage-v1-client` and its
TypeScript caller:

- `parseNotifyOutput` (`src/lib/backends/ton-provider.ts`) matched the FIRST
  `status:` line in the Go client's `notify` output — which is always the
  pre-flight on-chain state check (`notify.go`'s own check BEFORE it ever
  contacts the provider), not the real `== notify response ==` status. Now
  slices to that marker first, so the operator-facing `status=...` diagnostic
  reflects the actual provider response (issue #561).
- `--owner`/`--contract` validation errors now tell the operator how to
  convert a wallet's friendly-form address (`EQ.../UQ...`, what every wallet
  app including Tonkeeper displays) into the raw `wc:hex64` form this CLI
  requires, instead of only restating the required shape (issue #562).
- `seeder.go`'s `assertSafe()` now distinguishes an unset (empty) env var from
  one that actually contains disallowed characters, instead of reporting both
  as "contains characters this program refuses to place in a remote command"
  — the empty case previously read as a quoting/encoding mystery rather than
  a simple missing-config problem (issue #563).
