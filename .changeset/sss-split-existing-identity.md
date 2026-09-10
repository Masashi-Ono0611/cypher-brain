---
'cypher-brain': minor
---

`sss-split --sss <m>-of-<n> --sss-out-dir <path> ... [--identity <path>]` (#890)
adds Shamir recovery shares to an identity you already have, without rotating it
or touching `identity.age`/`recipient.txt`. Prompts for the identity's passphrase
if it's protected (or reads `CYPHER_BRAIN_PASSPHRASE`), splits the plain identity
in memory the same way `keygen --sss` does, and writes shares compatible with the
existing `sss-combine` command. Snapshots already encrypted to the identity —
including ones made before `sss-split` ran — stay recoverable with the shares it
produces.
