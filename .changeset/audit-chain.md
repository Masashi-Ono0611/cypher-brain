---
"cypher-brain": minor
---

Hash-chain audit trail (#226, parts 1+2 of the issue merged into one
mechanism): every `push`/`restore`/`verify` run (success OR failure) now
appends an entry to `$CYPHER_BRAIN_HOME/audit-log.jsonl` (or
`CYPHER_BRAIN_AUDIT_LOG`) — an append-only JSONL log where each entry's
hash is bound to the previous entry's hash, a Certificate-Transparency-
style tamper-evidence chain. This is distinct from both the receipt
ledger (#232, cost data for paid backends only) and the MCP idempotency
log (replay detection): the audit trail covers every command, records no
cost data, and never mutates or drops a past entry.

New `cypher-brain audit [--json]` command reads the log and recomputes
the chain, reporting VERDICT: PASS/FAIL and, on a break, which entry
index it occurred at. Recording is advisory only — an audit-write failure
warns on stderr but never fails the underlying push/restore/verify run.

Part 3 of the original issue (an opt-in OpenTelemetry span wrapper) is
tracked separately as a follow-up PR, since it introduces new optional
runtime dependencies — a different risk profile from this dependency-free
change.
