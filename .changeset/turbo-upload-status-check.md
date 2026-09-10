---
'cypher-brain': minor
---

Add `push-status --locator <data-item-id> [--json]` to look up Turbo's own
reported upload-processing status on demand, without a wallet or SDK. Preserve
raw status responses and distinguish a missing item from an unavailable lookup.
This is a manual check of Turbo's report, not independent Arweave L1 confirmation.
