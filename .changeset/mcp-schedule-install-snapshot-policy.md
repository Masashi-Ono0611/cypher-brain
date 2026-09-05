---
"cypher-brain": patch
---

MCP `schedule_install` now enforces the same MCP snapshot policy (#800,
`CYPHER_BRAIN_MCP_SOURCE_ROOTS` / `CYPHER_BRAIN_PIN_RECIPIENTS`) that
`snapshot_now` already enforces. Previously `schedule_install` was the one
tool that read a caller-supplied `dirs`/`recipients` (the same
plaintext-source/key-recipient shape the policy exists to gate) without
checking either allowlist, so an MCP caller could install a recurring,
unattended nightly snapshot+push of any directory the server process can
read — the exact disclosure #800 closed for a one-off `snapshot_now` call,
left open on its sibling tool. The check now runs at the same point
`snapshot_now`'s does: after basic type validation, before any side
effect, including the `confirm_install` consequential-action gate.

Also fixed a narrower cross-request log-attribution bug: a handful of
module-level diagnostic lines (the ones explicitly documented as
"logged to the server's stderr, not relayed to the caller") used
`console.error`, which this server swaps to a per-call capture buffer
while a *different*, concurrently-in-flight tool call is inside its own
`captureCall()` window (the MCP SDK dispatches tool calls without
awaiting the previous one to finish). That let one call's server-only
diagnostic (e.g. an MCP snapshot policy refusal naming a resolved path)
leak into an unrelated, concurrently-running call's own structured
result. Those sites now write straight to stderr via the same
underlying helper `captureCall()` itself falls back to when no capture
is active, instead of going through the swappable `console.error`.
