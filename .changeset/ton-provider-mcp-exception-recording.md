---
"cypher-brain": patch
---

issue #949 (financial safety): two post-broadcast ton-provider failures that surfaced as
a plain `Error` — indistinguishable from "nothing was spent" — now throw one of the
existing `PushPartialSuccessError`/`PushUncertainSpendError`-family exceptions instead,
so `src/mcp.ts`'s dedicated idempotency-key recording actually fires and the claim is
RETAINED rather than released. Before this fix, an MCP `snapshot_now` retry carrying the
same `idempotency_key` and `out` path after either failure would re-encrypt to a fresh
bag and pay a second time:

- A successful auto-sign broadcast (tonapi accepted the signed BOC with HTTP 200) whose
  subsequent `waitForContractActive()` confirmation poll then times out (a TonAPI
  outage, not proof the transfer failed — a doomed, insufficient-gas transaction gets
  the same HTTP 200 as a good one) now throws `PushUncertainSpendError`
  (`check_kind: 'ton_contract_address'`, CB-E027) — the same classification issue #818's
  arweave.ts case already gets, not `PushFundingConfirmedButIncompleteError`/a new
  "confirmed" subclass, since this process never actually observed on-chain
  confirmation.
- Funding ALREADY confirmed on-chain (`waitForContractActive()` returned) whose
  confirmed-state pending-spend record write then fails (a full disk, a permissions
  change under `CYPHER_BRAIN_RECEIPT_LEDGER`'s pending-spends sidecar) now throws a new
  sibling of issue #654's `PushFundingConfirmedButIncompleteError` —
  `PushFundingConfirmedIntentWriteError` (`partial_stage: 'confirmed_intent_write'`,
  vs. that class's own `'provider_notify'`) — reusing the SAME `funding_confirmed:true`/
  `provider_download_confirmed:false` MCP result shape but naming its own, earlier
  failure point. Left at `'pending'` rather than forced through to `'confirmed'`, so a
  later retry recovers the missing bookkeeping via issue #808's own already-active-branch
  recovery path instead of needing a second one.

Both wrap/re-throw correctly for a signed push's `.minisig` sidecar deploy
(`src/lib/pushpull.ts`), matching every existing sibling subclass's own convention.
