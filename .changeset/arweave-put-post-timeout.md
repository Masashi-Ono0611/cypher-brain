---
'cypher-brain': patch
---

`arweave` backend's `put()` (the L1 signed upload — `ar.transactions.sign()` /
`ar.transactions.post()`) is now bounded by a stall-armed timeout, the same
global-fetch-patch technique `l1ChunkRead()` already uses on the read side (#116). Before
this fix a gateway that accepted the connection but never completed the chunk-upload
response hung `push --backend arweave` forever, with the transaction already signed and
no `CYPHER_BRAIN_AR_HTTP_TIMEOUT_MS`/`PIPE_TIMEOUT_MS` bound applying to it at all —
unlike every read path in this file (#691).
