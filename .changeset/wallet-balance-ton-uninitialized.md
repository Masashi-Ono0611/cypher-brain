---
'cypher-brain': patch
---

`wallet balance --chain ton` no longer errors with a raw HTTP 404 on a freshly
generated, never-funded wallet — exactly the case its own `--help` text names as the
primary use case ("no funds needed"). It now reports a clean `balance : 0 nanoTON` /
`status : nonexist` in both plain and `--json` output, same as any other zero-balance
address.

The bug: the CLI queried tonapi's `GET /v2/blockchain/accounts/<addr>`, which 404s for
any address that has never sent or received a transaction. `GET /v2/accounts/<addr>` (a
different tonapi endpoint) returns 200 with `{"balance":0,"status":"nonexist",...}` for
that identical address, and is what the CLI now uses instead — confirmed directly
against tonapi.io for both a never-active address and an already-active one (no
regression: an active address still reports its real balance/status). The error message
for any future genuine network failure also now prints the actual endpoint queried
(previously always said `GET tonapi accounts/<addr>`, which never matched the real
`blockchain/accounts/<addr>` path being hit — misleading if someone tried to reproduce
a failure themselves).
