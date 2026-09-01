---
"cypher-brain": patch
---

`readJsonlLog()` (`util.ts`) now `stat()`s its path and refuses to `readFile()`
anything that is not a regular file, mirroring the guard `doctor`'s own
identity-file check already applied (#333). Previously, `doctor`'s
`audit-chain-integrity`/`receipt-ledger-readability` checks — and the
standalone `audit`/`ledger` commands, since all three share this helper —
could hang indefinitely if `AUDIT_LOG`/`RECEIPT_LEDGER` happened to be a
FIFO/named pipe with no writer on the other end, turning a routine, read-only
diagnostic into an unbounded freeze instead of a fast, explicit `FAIL` (#695).
