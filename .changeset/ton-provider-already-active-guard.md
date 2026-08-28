---
'cypher-brain': patch
---

**Money-safety fix (issue #638):** `push --backend ton-provider` and the manual
`storage-v1-client deploy` subcommand no longer unconditionally send the storage-cost
transfer again when retried.

The StorageV1 contract address is fully determined by the bag id, owner, data size,
piece size, and merkle hash — never by which provider was picked or its rate. A retry
of the same backup (after a lost/ambiguous broadcast response, or a deploy that
succeeded but whose later provider `notify` timed out) therefore derives the
*identical* contract address, and previously `autoSignAndBroadcastDeploy()` — and the
manual `deploy` link — would resend `amountNano` unconditionally, double-funding an
already-active contract. A newly-selected provider on the retry could also silently
replace the first one in the on-chain providers dict (`modify_providers` replaces,
not merges), stranding the first payment.

Both paths now check the derived contract's on-chain status before moving any funds:

- `push --backend ton-provider` (`src/lib/backends/ton-provider.ts`): if the contract
  is already `active`, it skips re-funding, logs why, and proceeds straight to
  notifying the provider (no receipt is recorded for this run, since no new spend
  occurred). A failed check falls back to the pre-fix behavior (attempt to fund)
  rather than risk silently skipping a genuine first-time deploy.
- `storage-v1-client deploy` (`scripts/go/storage-v1-client/deploy.go`): if the
  contract is already `active`, it refuses outright and points the operator at
  `update-providers` (gas-only, does not re-send the storage cost) instead. Unlike
  the auto-sign path above, a failed state check here is also a hard refusal — this
  is a manual, human-reviewed, mainnet-money operation, so failing closed is the
  safer default (matching `update-providers`' own existing precedent for the same
  kind of tonapi read failure).

This closes the specific double-payment gap; a fast retry landing in tonapi's brief
`uninit` window (funded, code not yet run) right after a broadcast remains a narrower,
documented residual gap bounded by TON's own seqno-replay protection.
