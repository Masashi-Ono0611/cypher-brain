---
'cypher-brain': patch
---

The recovery kit's printed recovery steps now tell the operator to `chmod 600` the
extracted identity file right after creating it, instead of only finding out from
`restore`'s after-the-fact `mode 644` warning (#538).
