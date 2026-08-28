---
"cypher-brain": patch
---

`ledger`'s plain-text report no longer reuses the "no receipts yet" sentence for a
ledger where every line is unreadable/corrupt (#457). A ledger file that has content
but 0 parseable receipts (`skipped_lines > 0`) now prints a visibly different message
naming the skipped count and clarifying this is not necessarily an empty ledger — the
same distinction `audit`'s human report already makes for the equivalent "all lines
garbage" case (`total entries: 0` / `unreadable lines skipped: N` / `VERDICT: FAIL`,
vs a true-empty log's silent PASS). A genuinely empty ledger (no file, or zero lines)
is unaffected and still prints the original sentence. `ledger --json`'s
`skipped_lines` field was already correct and is unchanged.
