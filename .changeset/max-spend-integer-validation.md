---
'cypher-brain': patch
---

`CYPHER_BRAIN_MAX_SPEND` and `CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND` set to a non-integer
value (e.g. `0.5`, `1,000,000`, `notanumber`) no longer crash every command, including
`--help` and `doctor` (#715). Both variables fed straight into `BigInt(...)` at
module-import time — before either entry point's own error formatting ever ran — so any
value `BigInt()` could not parse threw a raw, unhandled `SyntaxError` with a full Node
stack trace exposing internal `.ts` source paths. `config.ts` now validates the value the
same way `CONFIG_FILE_ERROR`/`IDEMPOTENCY_TTL_ERROR` already do: it records the failure
as a value at import time instead of throwing, and both `cli.ts`'s and `mcp.ts`'s `main()`
re-enter the normal error path with it, so a bad value now prints a clean
`error: CYPHER_BRAIN_MAX_SPEND must be an integer (got "0.5")` on stderr with a normal
non-zero exit code — matching every other env-var validation in this CLI — instead of
crashing.

A negative value (e.g. `-1`) is refused too, with its own `must be a non-negative
integer` message: `BigInt()` parses a negative string without error, but both spend
checks gate on `> 0n`, so a negative cap would otherwise parse "successfully" into one
silently indistinguishable from 0/unset (no cap at all) — the opposite of what setting a
negative number here could ever sensibly mean (multi-model review).
