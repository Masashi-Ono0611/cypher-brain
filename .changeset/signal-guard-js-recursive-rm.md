---
"cypher-brain": patch
---

`restore`: the signal handler no longer relies on a single `fs.rmSync` to erase the freshly-decrypted scratch directory when SIGTERM/SIGINT lands mid-merge. On ubuntu CI that call left roughly 230 of 400 entries behind three times (#826); the handler now walks the tree itself (re-listing the directory until it is empty, bounded passes with a short synchronous backoff), so a directory being drained by the in-flight merge is re-read instead of trusted once.
