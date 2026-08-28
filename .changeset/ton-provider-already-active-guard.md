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
already-funded contract. A newly-selected provider on the retry could also silently
replace the first one in the on-chain providers dict (`modify_providers` replaces,
not merges), stranding the first payment.

Both paths now check the derived contract's on-chain status before moving any funds,
refusing/skipping unless tonapi reports the address as `nonexist` (genuinely never
funded) — not just "not `active`". `uninit` (funded, contract code not yet run — the
exact few-second window right after a broadcast lands) and `frozen` both count as
non-fresh too, since `active`-only would still let a retry landing in that `uninit`
window double-send:

- `push --backend ton-provider` (`src/lib/backends/ton-provider.ts`): if the contract
  already shows any on-chain history, it skips re-funding, warns why (surfaced in an
  MCP caller's structured `warnings[]`, not just a background log), and proceeds
  straight to notifying the provider (no receipt is recorded for this run, since no
  new spend occurred). A failed check falls back to the pre-fix behavior (attempt to
  fund) rather than risk silently skipping a genuine first-time deploy — this backend
  must keep working unattended (nightly `schedule`/MCP), so a transient tonapi hiccup
  cannot be allowed to wedge it.
- `storage-v1-client deploy` (`scripts/go/storage-v1-client/deploy.go`): if the
  contract already shows any on-chain history, it refuses outright — pointing the
  operator at `update-providers` (gas-only, does not re-send the storage cost) when
  it's `active`, or at re-checking `status` when it's still settling. Unlike the
  auto-sign path above, a failed state check here is also a hard refusal — this is a
  manual, human-reviewed, mainnet-money operation, so failing closed is the safer
  default (matching `update-providers`' own existing precedent for the same kind of
  tonapi read failure).

This closes the specific double-payment gap described in issue #638. A retry landing
in the brief window where tonapi's indexer hasn't yet reflected a just-broadcast
transaction (so the address still reads back as `nonexist` for a moment) remains a
narrower, documented residual gap bounded by TON's own seqno-replay protection (at
most one of the two transfers is ever accepted on-chain).
