---
'cypher-brain': patch
---

Several regressions in `src/lib/idempotency.ts` introduced by #871's fsync durability
hardening, found via a whole-session accumulated-diff regression review and several
rounds of bounded Codex re-review of that review's own fixes:

- `withLogLock`'s `isLockAbandoned()` used to treat pure mtime staleness (past
  `LOCK_STALE_MS`, 10s) as abandonment regardless of whether the recorded pid was
  confirmed alive, which only became reachable once #871 put real fsync calls (the lock's
  own claim-write, and `recordIdempotencyResult`'s actual data write) inside the critical
  section this lock guards — a genuinely slow-but-legitimate fsync (disk pressure, a
  network filesystem) could now outlast 10s and let a waiter steal a live, still-working
  holder's lock mid-write, letting the waiter's own write silently disappear when the
  original holder resumed and overwrote it. A lock naming a confirmed-alive pid is now
  never treated as abandoned by staleness alone (mirroring `push-lock.ts`'s own
  live-pid-vs-staleness pattern); a waiter contending with it instead waits out the
  existing bounded timeout and fails closed.
- `claimIdempotencyKey` and `withLogLock`'s own lock acquisition used to leave the just-
  created claim/lock file behind if a fsync durability check failed right after its
  exclusive create succeeded — permanently refusing every future retry of that (tool,
  key) with `IdempotencyClaimHeldError` (or, for `withLogLock`, timing out every future
  write to that log forever, for as long as the process lives, per the live-pid fix
  above) even once the underlying transient I/O fault cleared, since neither lock ever
  auto-steals. Both acquisition paths now use write-then-link — the same pattern
  `push-lock.ts`'s own `publishLock()` already uses: a private, uniquely-named staging
  file is written and fsync'd first, and only then atomically published to the shared
  lock/claim path via `link`. A failure before that publish succeeds needs no path-based
  cleanup logic at all, since nothing else could ever be racing for a uniquely-named
  staging path (two narrower follow-up attempts — an unconditional `rm`, then an
  fstat-identity-based `stat()`-then-`rm()` — both still had their own TOCTOU windows a
  bounded Codex re-review reproduced by fault injection before this design was reached).
- Publishing the claim/lock now also reconciles an ambiguous `link()` failure (including
  `EEXIST` itself) against this call's own token before treating it as a rival holder or
  a genuine fault: on some filesystems (NFS in particular, one of this whole hardening's
  own motivating scenarios) a client can see a failed RPC — or a transparent, client-side
  retry surfaced as `EEXIST` — for an operation the server actually completed, which
  would otherwise misreport this call's own real claim as either lost or already held by
  someone else.
- Ancestor-directory durability for a freshly-created `CYPHER_BRAIN_HOME` subtree is now
  coordinated across concurrent same-key callers via a small process-local registry
  (mirroring the same in-process coordination shape `mcp.ts`'s own `idempotencyInFlight`
  Set already uses): whichever caller's own `mkdir()` actually creates new ancestor
  levels registers that sync so any concurrent caller for the same directory — including
  one that ends up winning the claim without having created anything itself — waits for
  it before reporting success, and that caller's own registered sync is held directly
  rather than solely rediscovered later through the registry, so a bounded re-review
  round's finding (a caller could otherwise miss its own registered failure once the
  registry's cleanup had already run) cannot cause it to be silently swallowed. The
  claim/lock's own newly-published directory entry is now also synced unconditionally,
  independent of whether any ancestor-level work was needed at all.
