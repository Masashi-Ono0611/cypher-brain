---
'cypher-brain': patch
---

Fixed a check-lookup race in the MCP `snapshot_now` idempotency-key guard (#636) that
could let a concurrent duplicate call spend twice on a paid backend (arweave/turbo)
despite carrying the same `idempotency_key` — the exact double-spend the feature exists
to prevent.

- **Same-process race**: `idempotencyInFlight` (the in-process, per-`(tool, key)` lock)
  was checked only AFTER awaiting the idempotency-log lookup. If call A started working
  under key K while call B's own (slower) log read was still in flight, B could observe
  A's already-completed-and-cleaned-up state — a cache miss AND an empty in-flight set —
  and spend again. The check-then-add is now done BEFORE the log lookup (and held
  through it, the spend gate, the real work, and the final record write), so a
  concurrent duplicate is rejected outright regardless of how long either call's own log
  read takes.
- **Cross-process race**: two `cypher-brain-mcp` server processes sharing one
  `CYPHER_BRAIN_HOME` each have their OWN `idempotencyInFlight` Set, so one process's
  claim did nothing to stop the other from racing the identical sequence. A new
  cross-process claim (`claimIdempotencyKey`/`src/lib/idempotency.ts`) — an
  exclusive-create lockfile per `(tool, key)`, held for the caller's entire call — closes
  this too. A concurrent claim attempt (same-process or a sibling process) is refused
  immediately with `ERR_IDEMPOTENCY_IN_FLIGHT` rather than queued or silently allowed
  through. There is deliberately no automatic staleness-based recovery of an abandoned
  claim (an earlier design attempt could not be made fully race-free without an OS-level
  advisory lock this codebase does not depend on) — a claim survives until its own caller
  releases it, and a confirmed-crashed holder's claim is cleared by removing the named
  lock file by hand, the same fail-closed/manual-repair pattern already used for a
  corrupted idempotency log.

No change to `snapshot_now`'s public argument or result shape.
