---
'cypher-brain': patch
---

Split `src/mcp.ts`'s ten MCP `Tool` schema constants (JSON-schema data + prose
descriptions, ~630 of the file's 2300+ lines) out into a new `src/mcp-tool-schemas.ts`
(#507) — a pure extraction, so `tools/list` and every tool's behavior are unchanged
(verified via a live MCP round-trip: byte-identical `tools/list` output, and the full
`scripts/mcp-smoke.mjs` suite passing before and after). `restore_now`'s dual-mode
locator/file/locator_file input resolution is now its own `resolveRestoreTarget()`
helper (#509), also a pure extraction — `handleRestoreNow` reads as validate → resolve
target → restore → format result instead of interleaving all four.

Also two documentation fixes found alongside: `snapshot_now`'s `recipients` field now
notes that, unlike the CLI `snapshot` (which defaults to
`<CYPHER_BRAIN_HOME>/recipient.txt`), this MCP tool requires `recipients` explicitly
with no default (#478); and README/the tool schemas now disclose that `ledger`,
`audit`, and `wallet balance` are CLI-only with no MCP tool, matching the disclosure
already given for `schedule uninstall`, `doctor`, and the recovery kit (#477).
