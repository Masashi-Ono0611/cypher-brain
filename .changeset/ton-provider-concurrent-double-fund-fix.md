---
'cypher-brain': patch
---

**Money-safety fix (issue #948):** `push --backend ton-provider` no longer risks
double-funding a StorageV1 contract when two SEPARATE processes race it concurrently.

Issue #638 already closed the *sequential* retry case: one process re-checking a
contract it (or an earlier run) had already funded. It did nothing for two processes
that were never sequential to begin with — an operator's manual `push` overlapping a
`schedule`d nightly run, or simply two terminals, pushing the same wallet+ciphertext
with no `--save-locator` coordination. Both independently derive the same contract
address, both pass the #638 already-active check while it still reads `nonexist`,
and — once one process's transfer lands — the OTHER fetches the wallet's now-advanced
seqno and sends its own transfer with that fresh, valid seqno: a second, genuinely
accepted transaction, not a replay TON's own seqno-replay protection rejects (an
earlier code comment wrongly assumed that protection bounded this case; corrected
here).

`put()` now holds a same-machine, cross-process advisory lock —
`src/lib/push-lock.ts`'s `acquirePushLock()`, extended with a new `'ton-provider-contract'`
kind keyed on the derived contract address, the SAME primitive `--save-locator` (#806)
and the rclone backend (#807) already use for their own analogous check-then-act
races — around the whole already-active-check → broadcast/deeplink →
on-chain-confirmation sequence. A second process racing the same contract now either
waits behind the first and then correctly observes it active (skipping funding), or
is refused outright with the existing `CB-E028` "another push is in flight" error
(a new user-visible refusal for this backend, not previously reachable from
`ton-provider`) rather than silently sending a second transfer.

One residual risk remains, documented rather than claimed away: TonAPI's own indexing
can lag a just-broadcast transaction by a moment, and if a run's own broadcast outcome
is itself ambiguous (the POST throws), that run correctly refuses to guess and
releases the lock on its way out — a later, independent retry that then acquires the
freed lock can still land inside that same brief indexing-lag window. Closing that
fully would need a persisted "broadcast in flight" record surviving process restarts,
left as a known limitation (same posture the pre-existing #805/#638 analysis already
took) rather than implemented speculatively.

A new regression test in `scripts/selftest-ton-provider.sh` reproduces the race
against two concurrent `cb push` processes and confirms exactly one funding transfer
is ever broadcast — verified RED (both transfers sent) with the lock removed, GREEN
with it restored.
