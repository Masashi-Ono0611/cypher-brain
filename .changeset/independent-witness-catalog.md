---
'cypher-brain': minor
---

Add opt-in `push --witness` and MCP `snapshot_now` witness publication on Arweave,
using the existing signing identity and spend caps. `witness verify` distinguishes
verified bounded history, signed sequence conflicts, and unknown freshness.
Recovery kits carry optional witness anchors, and doctor warns about coverage gaps.
