---
"cypher-brain": patch
---

`wallet address` / `wallet balance` (and their `--chain ton` equivalents) now
name the fix when no wallet has been created yet — `no wallet at <path> — run
'cypher-brain wallet create' first` (or `... --chain ton` for the TON wallet) —
instead of surfacing a raw `ENOENT` filesystem error, matching the posture
`doctor`'s SKIP message already uses for the same "not created yet" fact
(#437). Any other read failure (permissions, a corrupt/non-JSON wallet file)
still surfaces its real underlying error, unchanged.
