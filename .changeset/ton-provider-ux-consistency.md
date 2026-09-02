---
'cypher-brain': patch
---

Fixes several TON/ton-provider UX/consistency rough edges found during dogfooding
(round 4):

- `push`/`pull` no longer print a doubled backend prefix for `ton`/`ton-provider`
  locators ("pushed ... -> ton:ton:v1:\<hex\>") — `pushpull.ts`'s new `displayLocator()`
  checks whether the locator already carries the backend prefix (as `ton`/`ton-provider`'s
  own schema-versioned locators do, via `util.ts`'s `makeBagLocator()`) before adding one
  (#724).
- `wallet create --chain ton` no longer tells the user to "back up the mnemonic now"
  without ever printing the 24-word mnemonic anywhere — the mnemonic is never echoed to
  the terminal (same posture as the age identity and the Arweave JWK wallet), so the
  message now says "back up the wallet file now", matching the Arweave wallet's own
  correct wording (#725).
- `ledger`'s empty-ledger message now names `ton-provider` alongside `arweave`/`turbo` as
  a backend that writes receipts — the hardcoded literal was never updated when #484
  added ton-provider receipts (#748).
- `CostEstimate` (and the `estimate`/`estimate_cost` `--json` output) gains a `warnings:
  string[]` field, always present (possibly empty), alongside the existing free-text
  `note` — the ton-provider bounty-floor warning is now also placed there as a
  machine-detectable string, not just buried inline in `note`'s prose (#749).
- The `nanoTON` unit casing is now consistent everywhere this physical unit appears
  (`estimate --json`, receipts, `ledger`) — `ton-provider`'s own receipts previously wrote
  lowercase `nanoton` while `estimate.ts` used `nanoTON` everywhere else. Receipts already
  on disk with the old lowercase casing are still read back correctly, and `ledger`'s
  aggregated sums (`by_backend`/`by_day`/`by_month`) merge the legacy and current casing
  under the one canonical `nanoTON` key instead of reporting the same spend split across
  two units — the raw `receipts` array and `--csv` export still show each receipt's
  original casing verbatim (#751).
