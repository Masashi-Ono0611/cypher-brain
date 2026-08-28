---
'cypher-brain': patch
---

Hardens three trust-boundary gaps in the `ton-provider` backend and one unrelated
push UX gap, found via Codex agentic audit (2026-08-29, 3rd dogfooding round):

- **#651**: `push --backend ton-provider` used to build and broadcast a deploy purely
  from mytonprovider.org's registry snapshot (rate/span/capacity) — the selected
  provider's LIVE terms were never checked until `notify` ran, which is AFTER the
  contract is already funded. A stale registry (a provider that has since raised its
  rate, narrowed its span window, or run out of capacity) could fund a contract the
  provider would then refuse to service. `scripts/go/storage-v1-client` grew a new
  `rates` subcommand (an ADNL/RLDP `storageProvider.ratesRequest`, the same library
  `notify`'s `storageProvider.storageRequest` already uses), and `put()` now calls it
  right before `buildDeploy()` — before any funds move — refusing the push if the
  provider is currently unavailable for this bag, its live rate exceeds what was
  assumed, or its live span range no longer covers the chosen span.
- **#652**: a provider's self-reported `downloaded` byte count (from `notify`) was
  trusted as proof of custody with zero corroboration. Full cryptographic
  proof-of-custody verification is out of scope here (documented in
  `docs/ton-storage-status.md` as proposed future work); `notifyProviderWithRetry()`
  now flags, as warnings, (a) an immediate full-size claim on the very FIRST notify
  response with no gradual progress observed, and (b) a later response reporting
  FEWER bytes than a previously reported high-water mark (internally inconsistent — a
  real download cannot un-download bytes). The operator-facing "safe to stop the
  local seed" line is also now explicit that this is the provider's own self-report,
  not an independently verified proof.
- **#655**: `push --backend file --remote <val>` (and every other non-rclone backend)
  silently ignored `--remote` — only `rclone.ts` ever reads it. Now warns, naming the
  ignored value, mirroring the existing "flag accepted, never honored" fix pattern
  (#525/#526).

Verified end-to-end against `scripts/selftest-ton-provider.sh`'s mocked
mytonprovider.org/tonapi/notify infrastructure (new positive controls for all three
`rates`-check refusals, the permissive control, and both #652 self-report warnings)
and `scripts/selftest.sh` (the #655 warning and its silent-when-absent control).
