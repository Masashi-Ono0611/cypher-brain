---
'cypher-brain': minor
---

The MCP `snapshot_now` tool (the only tool that can spend money) accepts an optional
`idempotency_key` (#220, the Stripe idempotency-key pattern): a repeat call with the SAME
key and the same `dirs`/`pg`/`recipients`/`out`/`backend`/`scan_secrets` returns the FIRST
call's result — `idempotent_replay: true`, no new snapshot, no new spend — instead of
re-executing, so an AI agent's own retry logic (a network blip after an arweave/turbo
upload already succeeded, say) cannot spend twice for what it believes is one call. The
same key reused for a call that differs in any of those fields is refused
(`ERR_IDEMPOTENCY_KEY_REUSED`) rather than silently answered with an unrelated result.

Results are cached in `<CIPHER_BRAIN_HOME>/idempotency-log.jsonl` (the same
CIPHER_BRAIN_HOME-scoped bookkeeping style `push --skip-unchanged`'s save-locator file
already uses) and expire after `CIPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS` (default 24h).

Multi-model review made this materially more robust before ship:

- A **partial-success push** — the ciphertext already uploaded (a real, permanent spend
  on arweave/turbo) and only a LATER step then fails (the `.minisig` signature sidecar
  upload, or the local `--save-locator` bookkeeping) — is now recorded under the
  `idempotency_key` even though the overall call reports an error. A retry with the SAME
  key replays that recorded partial success instead of spending a second time for exactly
  the scenario this feature exists to make retry-safe. (`src/lib/pushpull.ts` now surfaces
  both shapes as `PushPartialSuccessError` subclasses; previously only the
  `--save-locator`-write failure was caught, so a signature-sidecar failure after a
  successful upload recorded nothing at all.)
- Idempotency-log reads are now **fail-closed**: a read error that is not "the file does
  not exist yet" (a permission error, a directory sitting where the log should be), or a
  file that reads but contains an unparseable line with no exact match for the key being
  checked, refuses the call (`ERR_IDEMPOTENCY_STORE_UNREADABLE`) instead of silently
  treating "could not check" the same as "definitely unused".
- A record-write failure can no longer mask the error it was trying to record alongside —
  it is now a best-effort warning, so the original (often recovery-critical) error always
  reaches the caller.
- Concurrent writers of the idempotency log (two processes, or two calls racing on
  different keys) no longer silently clobber each other's records — writes are now
  serialized through a lockfile. (Two SEPARATE processes racing on the exact SAME key
  reading a cache miss and both spending was a known follow-up gap this lockfile alone
  did not close — see the separate #636 fix, which closes it with a wider-scope,
  whole-call cross-process claim.)
- `idempotency_key` replay now honors a `locator_file` that differs from the original
  call's — the recovery pointer is written to the newly-requested path instead of being
  silently skipped on a cache hit.
- `CIPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS` is now validated at MCP server startup: a
  NaN/zero/negative/Infinity override refuses to start (naming the variable) instead of
  silently disabling replay or never expiring a stale result.
