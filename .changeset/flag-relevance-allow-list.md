---
"cypher-brain": patch
---

A flag that belongs to another command is now refused instead of silently
ignored (#832). `cypher-brain doctor --level quick` used to run the full
health check and exit 0 without ever mentioning `--level` — the parser knows
`--level` (it is `verify`'s depth selector), so it was neither an unknown flag
nor a bad value, just stored and never read. It now exits 2 with an error that
names the command the flag does belong to and points at
`cypher-brain <command> --help`.

Same treatment for every other command/flag pair in that gap — for example
`ledger --level`, `restore --level`, `snapshot --sign` (signing is automatic
whenever a signing identity exists; `--sign` is `keygen`'s flag) and any flag
at all on `init`, which is an interactive wizard that reads none of them.
Under `--json` these print the usual `{error, code, exit_code: 2}` object.

Nothing that was already accepted changes: each command declares the flags its
code actually reads, and the existing, more specific refusals keep their own
wording (`restore --out` still suggests `--out-dir`, `ledger --backend` still
explains the report is already grouped by backend). The commands that print a
JSON document (`doctor`, `ledger`, `audit`, `verify`, `estimate`,
`schedule status`, `wallet balance`) still take `--json` everywhere they did.
