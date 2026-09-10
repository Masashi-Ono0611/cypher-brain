---
'cypher-brain': patch
---

Add opt-in recovery policies: require backup recipients with
`CYPHER_BRAIN_REQUIRE_RECIPIENT`, require all-PQ snapshot recipients with
`CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS=1`, and default CLI/MCP restore and verification
to requiring signatures with `CYPHER_BRAIN_REQUIRE_SIGNATURE=1`. Explicit
`--no-require-signature` or MCP `require_signature: false` permits known-unsigned
historical backups. Doctor now reports policy misconfiguration and recovery-key drift.
