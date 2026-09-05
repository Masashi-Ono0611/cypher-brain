---
'cypher-brain': patch
---

Three narrow correctness fixes found during a full-file audit of the key-handling and
push/spend-tracking modules:

- `pending-spend.ts`'s `syncDirectories()` (the pre-broadcast spend-intent durability
  write, #808) stopped one directory level short of fsyncing the parent of the topmost
  newly-created directory — so when `mkdir(recursive)` created only ONE new directory
  (or when it created several, for the topmost one), that directory's own entry in its
  parent was never made durable. A crash right after could leave the fsync'd spend-intent
  record itself missing after a reboot, in the exact window it exists to protect.
- `signal-guard.ts`'s `unlockRecursiveSync()` (best-effort permission repair before the
  emergency, signal-handler cleanup of a plaintext scratch/staging tree, #782) called
  `readdirSync()` before `chmodSync()`, so a directory extracted from an archive with no
  read/execute bit at all (`0o000`, or write-only) failed to list before its permissions
  were ever restored — leaving it (and its contents) unswept after a signal, even though
  chmod (ownership-gated, not permission-gated) would have succeeded first.
- `push()`'s audit-trail catch block (`pushpull.ts`) only recognized `PushPartialSuccessError`
  when extracting a `locator` to record — `PushUncertainSpendError` is deliberately NOT a
  subclass of that class (see its own doc comment), so an uncertain-spend push whose
  ciphertext had already confirmed-uploaded before the ambiguous sidecar spend recorded
  `locator: null` in the audit log, losing that already-paid recovery pointer from the
  audit trail specifically (the error message and MCP's own idempotency handling already
  carry it independently).

All three are additive/corrective only — no change to any success-path behavior, no
change to lock/idempotency protocol, no change to crypto semantics. Full `typecheck`,
`lint`, and the full `selftest.sh` suite (100/100) plus targeted selftests
(`push-partial-failure`, `mcp-uncertain-spend`, `audit`, `ledger`, `receipt`,
`wallet-balance`, `idempotency-lib`, `minisign`, `keygen-force`, `pq`) pass.

A separate, larger set of Critical/Warning findings from the same audit — covering
lock-ownership/fsync durability tradeoffs already documented as deliberate in
`push-lock.ts`/`idempotency.ts`, TOCTOU races in key backup/rotation, a secret-leak-into-
error-message concern in `crypt.ts` that an existing regression test locks in as
intentional, and several `--skip-unchanged`/replay design questions in `pushpull.ts` —
is left for human review rather than fixed here, per this project's higher review bar for
key-handling and spend-tracking code.
