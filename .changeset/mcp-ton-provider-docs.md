---
'cypher-brain': patch
---

DOCUMENTATION ONLY (#439) — no MCP tool schema or behavior change. `wallet_create` and
`wallet_address` are Arweave-only (no `chain` parameter), and `snapshot_now`/`estimate_cost`/
`schedule_install`'s `backend: "ton-provider"` only appears once a local TON wallet is already
configured; none of that changed. What was missing is that no tool ever SAID so: an agent
driving cypher-brain purely over MCP had no way to discover, before hitting the gap, that
reaching `ton-provider` needs an out-of-band CLI step (`cypher-brain wallet create --chain
ton`), setting `CYPHER_BRAIN_TON_WALLET` in the MCP server's own environment, and restarting
the server. `wallet_create`/`wallet_address`/`snapshot_now`/`estimate_cost`/`schedule_install`'s
tool descriptions (and the README MCP table) now say this explicitly.

This is option 2 of the two the issue laid out. Option 1 — giving `wallet_create`/
`wallet_address` a `chain: 'arweave'|'ton'` parameter so TON wallet creation becomes reachable
over MCP itself — remains open as a possible follow-up; it is a real tool-schema/behavior
change with backward-compatibility implications for existing MCP clients, and the issue
explicitly flagged it as needing a human design decision that has not been made.
