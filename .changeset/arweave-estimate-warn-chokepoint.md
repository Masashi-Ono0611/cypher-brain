---
'cypher-brain': patch
---

`arweave` backend's `put()`: when `CYPHER_BRAIN_MAX_SPEND` is 0 (no cap) and the
pre-flight L1 cost estimate fails, the "could not estimate L1 cost; proceeding"
fallback now goes through `warn()` instead of a raw `process.stderr.write` —
matching `turbo.ts`'s structurally identical branch. A raw stderr write bypasses both
the MCP server's `console.error` interception and the `warnings` array an MCP tool
result carries (#347), so an unattended/MCP-driven push whose price estimate transiently
failed proceeded uncapped with that one explanatory line invisible to an agent relaying
the run (#692).
