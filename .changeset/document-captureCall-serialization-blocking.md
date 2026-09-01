---
'cypher-brain': patch
---

Document, in `keygen`, `wallet_create`, and `wallet_address`'s tool descriptions,
that a call to this server may sit waiting behind an unrelated in-flight
`snapshot_now`/`restore_now`/`verify_restore` call (#690). `captureCall()`
(`src/mcp.ts`) serializes every captured lib call through one module-level
promise-chain mutex, because it swaps in shared `console.log`/`console.error`
and `process.exitCode`. A multi-minute `snapshot_now` push can legitimately
queue a fast, advertised-read-only call like `wallet_address` behind it with no
signal distinguishing "queued" from "hung" — so callers/agents are now told not
to mistake a slow response from these tools for a failure. No behavior change;
the actual concurrency/console-capture mechanism is untouched.
