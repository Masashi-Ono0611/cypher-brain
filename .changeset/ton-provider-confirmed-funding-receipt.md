---
'cypher-brain': patch
---

**Accounting fix (issue #654):** a `push --backend ton-provider` deploy whose funding
was confirmed on-chain no longer disappears from the receipt ledger if the following
provider-notify handshake times out.

Previously, `onReceipt` (the callback that persists a receipt) fired only after
`notifyProviderWithRetry()` succeeded. If notify failed (a provider that never
confirms the download within `CYPHER_BRAIN_TON_PROVIDER_NOTIFY_RETRY_MS`), `put()`
threw before ever reaching that callback — the money had already left the wallet
(confirmed by `waitForContractActive()`), but no receipt was ever written, and
`audit.ts`'s own log recorded the run as a plain failure. An operator relying on
`cypher-brain ledger` for cumulative cost reporting would silently undercount real
spend, and this compounded the (separately fixed, issue #638) double-funding risk if
an operator retried based on the incomplete ledger data.

Design consulted with a second model (Codex, via agmsg) before implementing:

- `PutOpts.onReceipt` is now locator-aware and async (`(event: ReceiptEvent) => Promise<void>`,
  `ReceiptEvent = { locator, raw, cost }`) instead of two positional, synchronous
  arguments — every paid backend (arweave, turbo, ton-provider) computes its own
  locator without waiting for `put()`'s own return.
- `pushpull.ts`'s `push()` persists the receipt **synchronously from inside the
  awaited `onReceipt` callback**, not after `backend.put()` resolves — the receipt is
  durably on disk before ton-provider's `put()` goes on to attempt
  `notifyProviderWithRetry()`, closing the crash/kill window a simple "catch and
  persist after the fact" fix would still have left open.
- `ton-provider.ts` now calls `onReceipt` immediately after `waitForContractActive()`
  confirms the deploy on-chain — before notify runs, not after — and wraps
  `notifyProviderWithRetry()` in a `try`/`catch` that re-throws a new
  `PushFundingConfirmedButIncompleteError` (a `PushPartialSuccessError` subclass,
  living in a new `src/lib/push-partial-success.ts` leaf module to avoid an import
  cycle with `backends/index.ts`) instead of a plain `Error`, so a caller (an MCP
  idempotency-key retry, `wizard.ts`'s own push-catch, a human reading stderr) can
  tell "funding already happened, only the provider handshake remains" apart from
  "nothing happened yet".
- `mcp.ts`'s `snapshot_now` idempotency-key handling gives this new error its own
  classification (`funding_confirmed: true`, `provider_download_confirmed: false`,
  `partial_stage: 'provider_notify'`) instead of falling into the existing
  `PushLocatorWriteError` fallback bucket, which would have misreported it as a
  `--save-locator` bookkeeping failure.
- The already-active retry-skip path (issue #638) still never writes a NEW receipt
  (no real spend happens on that run) — even when that retry's own notify attempt
  succeeds, no receipt is written a second time for the same on-chain spend.

Verified with real red/green positive controls (temporarily reverted each fix,
confirmed the new tests fail with the exact expected message, restored, confirmed
all-PASS): `scripts/selftest-ton-provider.sh` gained a CLI-level test (notify timeout
after confirmed funding persists exactly one receipt and names the confirmed-funding
fact; a subsequent retry that completes notify does not double-count) and an MCP-level
test (`scripts/selftest-ton-provider-mcp-partial.mjs`, reusing the same run's mock
tonapi/mytonprovider/notify infrastructure) proving the idempotency-key replay carries
the correct classification, not the generic `locator_file_write_failed` fallback.
Full `selftest-ton-provider.sh`/`selftest-ton.sh`/`selftest-ton-dns.sh`/`selftest.sh`/
`selftest-receipt.mjs`/`selftest-push-partial-failure.sh`/`mcp-smoke.mjs` all still
pass, confirming the `onReceipt` signature change didn't regress arweave/turbo.

**Known residual gaps, deliberately not addressed here** (filed as follow-ups):
an auto-sign broadcast whose HTTP response fails but whose transaction still lands
on-chain can still hide a confirmed spend (#664 — a narrower variant of the same root
cause, triggered before `waitForContractActive()` is ever reached); a retry that
selects a different provider than the one originally paid can notify the wrong
provider for an already-deployed contract (#665). Receipts already missing before
this fix are **not** backfilled — the fix direction from the design consultation was
explicit that "already active on-chain" alone is not sufficient evidence to safely
reconstruct a historical amount/run.
