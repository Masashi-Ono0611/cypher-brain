---
'cypher-brain': patch
---

Fix overlapping pushes of identical ciphertext to a self-hosted TON seeder failing
because they shared temporary upload and inventory files. Each push now uses its
own temporary paths and cleans up failed transfers.

Fix TON seeder-fallback pulls failing when the output parent directory does not yet
exist. Fallback downloads now use a private temporary directory, avoid overwriting
pre-existing temporary-path siblings, and remove partial downloads when scp fails.
