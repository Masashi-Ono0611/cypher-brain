---
"cypher-brain": patch
---

Fixed two stale claims in `SECURITY.md`: it said the CLI had no `--version`
flag yet (it's had one since `--version`/`-V` shipped) and that a
post-quantum hybrid recipient was "on the roadmap" (`keygen --pq` already
ships it, CI-verified via `selftest:pq`). The version-checking guidance now
points to `cypher-brain --version` first, and the threat-model caveat now
describes `keygen --pq` as available today instead of planned. Docs-only,
no behavior change. Fixes #556, #557.
