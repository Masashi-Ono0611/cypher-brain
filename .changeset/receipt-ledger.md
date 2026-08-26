---
"cypher-brain": minor
---

Persist provider receipts + a cumulative cost ledger (#232). Every `push
--backend arweave|turbo` that actually spends money now appends a receipt to
`$CYPHER_BRAIN_HOME/receipt-ledger.jsonl` (or `CYPHER_BRAIN_RECEIPT_LEDGER`)
— Turbo's official upload response persisted as-is, or, for the raw arweave
L1 backend, the actually-signed transaction reward — alongside the ACTUAL
native-unit cost paid. This is deliberately separate from `estimate`'s
pre-flight forecast (never conflated): a receipt answers "what did this
push actually cost", not "what would it cost".

New `cypher-brain ledger [--json] [--csv]` command reads that ledger and
reports cumulative cost by backend, by month, and by day (UTC), each kept
separate per native unit (winston/winc are never summed together). `--json`
returns the full aggregate plus every raw receipt; `--csv` exports one row
per receipt. file/rclone/ton/ton-provider pushes never write a receipt
(nothing paid, or no receipt object to persist) and so never appear in the
ledger. A receipt-write failure is advisory only — it warns on stderr but
never fails an already-successful, already-paid push.
