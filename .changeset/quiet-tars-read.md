---
"cypher-brain": patch
---

Avoid intermittent EPIPE errors when restoring or verifying a valid snapshot by reading its authenticated tar stream through EOF, including trailing zero padding.
