---
'cypher-brain': patch
---

Three fixes to the audit/ledger machinery, found via dogfooding:

- **Fixes #744**: two `push`/`restore`/`verify` runs finishing at the same moment could
  each append to the audit log (`$CYPHER_BRAIN_HOME/audit-log.jsonl`) at once, and one of
  the two entries would land as a sibling rather than a child of the other — which
  `verify --level chain`/`cypher-brain audit` then reported as a permanent, false "chain
  broken — possible tamper" `VERDICT: FAIL` for what was actually two legitimate
  concurrent runs. Concurrent audit-log writes are now serialized, so this false positive
  can no longer happen.

- **Fixes #765**: `ledger --csv` (and any other read of a large `audit-log.jsonl`/
  `receipt-ledger.jsonl`/`idempotency-log.jsonl`) used to load the entire file into memory
  as one string before parsing a line of it, and `--csv` built the whole rendered output as
  a second complete string before writing any of it out — together enough to OOM-kill a
  modestly constrained scheduled/container process on a large history (measured: a
  110.3 MiB CSV export briefly held 334.8 MiB of extra memory it no longer needs). Both now
  stream line-by-line instead, removing those whole-file/whole-output string allocations;
  the parsed entries themselves are still held as one in-memory array (unchanged — a
  genuine streaming rewrite of the report/CSV-building logic itself is out of scope here).

- **Fixes #766**: `ledger`'s "by day (UTC, most recent 14)" report used to accept a receipt
  timestamp as a real date from its digits' shape alone, so an impossible one (a
  nonexistent day like `2026-02-31`, or a nonexistent month like `9999-99-99`) sorted
  above every genuine recent day and silently evicted a real day from the report. Such a
  receipt is now excluded from `by_day` and counted in `undated_receipts` instead (it
  still counts toward `by_backend` totals, same as any other undated-but-priced receipt).
