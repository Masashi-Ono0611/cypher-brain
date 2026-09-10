---
'cypher-brain': patch
---

Improve SSS key generation and recovery guidance: directory output paths now explain that each share needs a full file path, and partial write failures explain that regeneration creates a new identity and a complete new share set. Successful SSS setup explains threshold recovery, duplicate shares receive a specific error, and share files include preservation instructions and a recovery example. Recovery output and CLI help show a working snapshot verification command, and recovered identities are explicitly labeled private and not passphrase-protected.
