---
"cypher-brain": patch
---

`wallet_create`'s `out` containment check now resolves symlinks (via the
nearest existing ancestor's real path) before comparing against
`CYPHER_BRAIN_HOME`, instead of comparing lexically-resolved path strings —
a symlinked ancestor directory under `CYPHER_BRAIN_HOME` could otherwise
smuggle the write outside the intended scope (#648).

`snapshot_now`'s structured `warnings` field now includes push-phase warnings
(e.g. a receipt-persistence failure, an insufficient-funds-buffer notice)
in addition to snapshot-phase warnings — they used to be silently dropped
from the structured result, including from a cached idempotency-key replay
(#649).

`restore_now` no longer turns an already-successful restore into an
`ERR_INTERNAL` response when only the post-restore fetch/scratch-dir cleanup
fails; the cleanup failure now rides the successful result as a warning
instead of overriding it — avoiding an unnecessary second destructive
`pg_restore --clean` if an agent retries on what looked like a full failure
(#650).

A late OTel export-flush warning (one that only resolves after the tool
handler already built its result) is now attached to the SAME MCP call that
caused it, instead of bleeding into whichever unrelated call happens to run
next and drain the shared warning buffer first (#653).
