---
'cypher-brain': patch
---

Fix the MCP `keygen` tool's description (and README's MCP tools table) overstating
that `force: true` "discards" the old identity, making prior snapshots unrecoverable.
It actually backs the old identity up first (the same `identity.age.bak-<timestamp>-
<random>` mechanism the CLI's `--force` already documents correctly) — snapshots
encrypted to the old identity stay recoverable from that backup. The `keygen` tool's
structured response now includes `backup_path` when a backup was made, instead of only
being reachable via the unstructured `log` lines. Also documents that Shamir (M-of-N)
recovery shares are deliberately CLI-only (`keygen --sss` / `sss-split`) and not
exposed as an MCP tool argument, since shares are meant for separate physical
locations that an MCP-sandboxed write can't meaningfully reach.
