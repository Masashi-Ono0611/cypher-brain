---
"cypher-brain": patch
---

`restore`: when a signal (SIGTERM/SIGINT) lands while a restore is merging into an existing `--out-dir`, the handler now retries removing the freshly-decrypted scratch directory a few times instead of giving up after one attempt. A single removal could fail transiently while the merge was still moving entries out of that directory, leaving plaintext on disk (observed once in CI, #826).
