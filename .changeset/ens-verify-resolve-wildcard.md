---
'cypher-brain': patch
---

Fix `ens-verify`'s positive check, which never actually worked: it called a
`getText(bytes name, string key)` function that does not exist on ENSv2's
PermissionedResolver (verified against the real source, contracts-v2 tag
`sepolia-deployment-2026-09-15`). Text records on this resolver are only
readable through the ENSIP-10 wildcard-resolution entrypoint (`resolve(name,
data)`, which internally re-derives the record from the DNS-encoded `name`
argument and ignores the `bytes32 node` inside `data`) -- there is no
standalone `text`/`getText` call. `ens-verify` now encodes the profile call
correctly and decodes `resolve()`'s wrapped return. Confirmed against a live
Sepolia ENSv2 deployment: both the positive readback and the negative
out-of-scope-write check now pass end-to-end through the real CLI.
