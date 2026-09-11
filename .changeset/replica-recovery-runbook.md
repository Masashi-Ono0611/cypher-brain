---
'cypher-brain': patch
---

Document a manual runbook for rebuilding a secondary replica (#906): if a
`ton`/`ton-provider` seeder or an `rclone` target becomes unreachable while the
permanent Arweave/Turbo copy is fine, `docs/durability.md` now walks through
pulling the trusted source (with its signature), pushing it to the replacement
destination, and verifying the new destination against the *original* trusted
hash — one-directional recovery using existing `pull`/`push`/`--sha256`
primitives, no new persistent state or automated reconciliation engine. Also
explains why a general cross-backend reconciliation engine was scoped out
(Arweave/Turbo have no "provider" to disappear the way the other backends do).
