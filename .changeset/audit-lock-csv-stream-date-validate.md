---
'cypher-brain': patch
---

Three fixes to the audit/ledger machinery, found via dogfooding:

- **Fixes #744**: `appendAuditEntry()` (`audit.ts`) now serializes its
  read-tail-then-append critical section behind a cross-process exclusive-create
  lockfile (mirroring `idempotency.ts`'s own `withLogLock`, staleness-based steal
  included, hardened further with an ownership TOKEN so a removal — the staleness
  steal, or this lock's own release — only ever deletes a lock this call actually owns,
  never a different process's live one, mirroring `claimIdempotencyKey`'s own token
  design; Codex review). Previously, two processes finishing `push`/`restore`/`verify`
  at the same time could both read the same last hash and each append an entry chained
  to it — the second becoming a sibling rather than a child of the first, which
  `verifyAuditChain()` then reported as a permanent, false "chain broken — possible
  tamper" `VERDICT: FAIL` for what was actually two legitimate concurrent runs.

- **Fixes #765**: `readJsonlLog()` (`util.ts`, shared by `audit.ts`/`receipt.ts`/
  `idempotency.ts`) now reads its file line-by-line via a stream instead of loading the
  entire file into one in-memory string first. `ledger --csv` (`ledger.ts`) now writes
  each row directly to stdout as it is rendered (respecting `Writable.write()`
  backpressure — awaiting `drain` rather than queuing every remaining row into the
  stream's own internal buffer regardless, which would silently recreate the same
  problem for a slow consumer; Codex review) instead of building an array of every
  rendered row and then joining that into a second, complete CSV string. Together these
  remove several full-log-sized allocations that used to coexist in memory at once for
  a large history — measured at 100k receipts (1 KiB `raw` payload each) producing a
  334.8 MiB RSS delta for a 110.3 MiB CSV export, enough to OOM-kill a modestly
  constrained scheduled/container process; a large enough export could also hit V8's
  own single-string length ceiling. `audit --json`'s full-entries serialization
  (`audit.ts`) still holds the parsed entries array plus one `JSON.stringify()` copy —
  a genuine streaming JSON writer for that path is out of scope here; the `util.ts` fix
  already removes the extra whole-file-string layer underneath it.

- **Fixes #766**: `ledger`'s day/month bucketing (`ledger.ts`) now confirms a receipt
  timestamp names a real calendar instant, not just that its digits are in the right
  positions. `ISO_UTC_PATTERN`'s shape-only regex previously accepted values like
  `2026-02-31T00:00:00.000Z` (a day that does not exist in February) and
  `9999-99-99T00:00:00.000Z` (a month that does not exist at all) as valid dated
  receipts; both sort lexically above every genuine recent day, so each one silently
  evicted a real day from the `by day (UTC, most recent 14)` truncated human report. Such
  a receipt is now counted as `undated_receipts` instead (still included in
  `by_backend`, same as any other undated-but-priced receipt) rather than being bucketed
  as if it were real. The round-trip check anchors at year 2000 and overwrites the year
  via `setUTCFullYear()` rather than passing the parsed year directly to `Date.UTC()`
  (Codex review): the latter's multi-arg form special-cases a 0-99 "year" by adding 1900
  to it (same legacy quirk `new Date(year, month, ...)` has), which would have wrongly
  flagged a genuinely valid `0000-...`/`0099-...` timestamp as impossible.

New positive-control tests: `scripts/selftest-audit.mjs` fires two concurrent
`appendAuditEntry()` calls via `Promise.all` and confirms the resulting chain still
verifies (reproduces the fork reliably without the #744 fix — confirmed by temporarily
reverting it locally, 5/5 red without the fix, 5/5 green with it); `scripts/selftest-ledger.sh`
adds a `(d)` section asserting a Feb-31 and a month-99 timestamp are excluded from
`by_day` and counted as `undated_receipts` instead (reproduces the #766 bug the same
way against the old regex-only check), plus a year-0000 receipt confirming it is still
bucketed normally (the Date.UTC() 0-99 quirk above). No new test was added specifically
for #765's memory-scaling claim — reproducing the measured RSS delta needs a large
(100k-row) fixture that would make the selftest slow and its outcome sensitive to the
runner's own memory conditions; the existing `ledger`/`receipt`/`idempotency-lib`/
`doctor` selftests (which all exercise `readJsonlLog()`/`ledger --csv`, including the
FIFO fast-fail invariant `readJsonlLog()` must preserve) all still pass unchanged,
confirming the streaming rewrite is behavior-preserving.

All three fixes above were refined once against a `codex exec` read-only review of this
diff, which found and this PR addresses: the audit lock's missing ownership check on
removal, `writeCsv()` ignoring `Writable.write()` backpressure, and the `Date.UTC()`
0-99-year quirk in the calendar-instant check.
