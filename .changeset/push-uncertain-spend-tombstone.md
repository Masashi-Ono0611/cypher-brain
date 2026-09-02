---
'cypher-brain': patch
---

A paid push whose outcome is genuinely UNCERTAIN — an `arweave` L1 POST that failed and
whose follow-up probe found nothing, or a `ton-provider` deploy broadcast that failed
after the signed message had already left the process and could not be confirmed — is now
a distinct, typed outcome instead of an ordinary error that read like "nothing happened".
The CLI annotates it `[CB-E027]` and names the identifier to check on-chain (the signed
Arweave tx id, or the TON contract address).

Over MCP this is what stops the retry that pays twice. `snapshot_now` records the outcome
against the call's `idempotency_key` as a PERMANENT error tombstone
(`{code: "ERR_PUSH_OUTCOME_UNCERTAIN", spend_outcome: "uncertain", backend, check_kind,
check_identifier, message}` — deliberately with no `pushed`/`locator`, because there may
be no upload to point at), returns it with `isError: true`, and replays it as the same
error on every later call carrying that key, doing no paid work. `CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS`
does not govern it and compaction never drops it: expiring the record would not settle the
ambiguity, only postpone the retry that spends again. Verify `check_identifier` on-chain,
then use a NEW key.

Two related idempotency fixes ship with it:

- A replay now reports the outcome the SAME WAY the first call did. A recorded partial
  success (the paid upload landed, a later stage failed) was returned as an error on the
  first call but replayed through the success-shaped result builder, so an agent retrying
  after a transport hiccup saw `isError: true` once and a clean success with
  `pushed: true` the second time for identical state.
- When a call that may have SPENT cannot write its idempotency-key result, the claim on
  that key is now retained rather than released. Previously the record was missing *and*
  the guard that would have refused the retry was removed, so an ordinary disk-full or
  permissions failure turned into a second charge. The warning (through `warn()`, so it
  reaches the result's `warnings` array) names the claim lock file to remove once the
  outcome has been verified.

Idempotency records gained `disposition` (`success`/`error`) and `retention`
(`ttl`/`permanent`) fields. Records already on disk carry neither and keep behaving
exactly as before (`success`/`ttl`).
