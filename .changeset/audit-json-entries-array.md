---
"cypher-brain": minor
---

`audit --json` now includes an `entries` array with every readable audit-log entry
(in log order, oldest first), not just `last_entry` (#458). Previously the only way
to list or browse the audit trail via the CLI was reading
`$CYPHER_BRAIN_HOME/audit-log.jsonl` directly, bypassing `audit`'s own
read/parse/validate path entirely — this follows the same precedent `ledger --json`'s
`receipts` array already set (the summary fields plus the full source records in one
call). `last_entry` is unchanged and kept for existing scripts. `--help`'s documented
JSON shape is updated to match.
