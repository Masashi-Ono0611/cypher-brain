---
"cypher-brain": patch
---

`doctor`: the `mcp-snapshot-policy` warning for a `CYPHER_BRAIN_MCP_SOURCE_ROOTS` entry that does not exist now describes the current behaviour — MCP `snapshot_now` refuses every call that includes `dirs` until the root exists (fail closed since #838; pg-only calls are unaffected) — instead of the pre-#838 "authorizes the nearest existing ancestor" wording.
