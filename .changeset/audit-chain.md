---
"cypher-brain": minor
---

Hash-chain audit trail (#226, parts 1+2 of the issue merged into one
mechanism): every `push`/`restore`/`verify` run (success OR failure) now
appends an entry to `$CYPHER_BRAIN_HOME/audit-log.jsonl` (or
`CYPHER_BRAIN_AUDIT_LOG`) — an append-only JSONL log where each entry's
hash is bound to the previous entry's hash. This is a local integrity
check against accidental or casual tampering, not a cryptographically
authenticated log: it has no independent, externally-anchored checkpoint,
so a rewrite of the entire local file (or a clean deletion from the end)
is undetectable — the same trust boundary as any other file under
`$CYPHER_BRAIN_HOME`, the identity key included. This is distinct from
both the receipt ledger (#232, cost data for paid backends only) and the
MCP idempotency log (replay detection): the audit trail covers every
command, records no cost data, and never mutates or drops a past entry
on its own.

New `cypher-brain audit [--json]` command reads the log and recomputes
the chain, reporting VERDICT: PASS/FAIL — a broken hash link OR any
unreadable line (a deleted/corrupted entry looks exactly like one) is
sufficient to fail. Recording is advisory only — an audit-write failure
warns on stderr but never fails the underlying push/restore/verify run.

Part 3 of the original issue (an opt-in OpenTelemetry span wrapper) is
tracked separately as a follow-up PR, since it introduces new optional
runtime dependencies — a different risk profile from this dependency-free
change.
