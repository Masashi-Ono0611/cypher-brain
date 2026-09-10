---
'cypher-brain': minor
---

`keygen --sss <m>-of-<n> --sss-out-dir <path> ...` (#207) additionally splits the
identity into N Shamir shares, any M of which reconstruct it — a disaster-recovery
mechanism alongside (never instead of) the normal `identity.age` this command already
writes. A fresh random key is AES-256-GCM-encrypted with the identity and split
(never the identity string itself, which is not uniformly random), so reconstruction
is authenticated by a real cryptographic MAC. Reconstruct with the new
`sss-combine --share <path> --share <path> ... --out <path>` command, which writes a
completely normal identity file usable with `restore --identity`/`verify` unchanged.
