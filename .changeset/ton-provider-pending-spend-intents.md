---
'cypher-brain': patch
---

A confirmed `ton-provider` spend can no longer disappear from the cost ledger because
the process died at the wrong moment, and a retry no longer notifies a provider the
contract was never deployed with (#808, #665).

A `push --backend ton-provider` deploy now records what it is about to spend — contract
address, bag id, provider pubkey and amount — to a `pending-spends.jsonl` file next to
`receipt-ledger.jsonl`, *before* it broadcasts, and settles that record only once the
receipt is verifiably on disk. Previously there was a several-second window between the
contract going live on-chain (the money is gone from that instant) and the receipt being
written, because the receipt write hashes the whole encrypted brain first. A SIGKILL, an
OOM kill or a power loss inside that window left the spend permanently unrecorded, and a
later retry deliberately wrote nothing because that run moved no funds — so `ledger` and
`audit` understated real spend forever, with nothing reporting that anything was missing.
A retry of the same artifact now finds that record and writes the missing receipt (once —
retry it as often as you like), using the amounts the run that actually paid recorded, not
a fresh recomputation.

`cypher-brain doctor` gains a `pending-spend-intents` check that reports any recorded
spend still unsettled: a `confirmed` one means the ledger is short by that amount until
you push the same artifact again, and a `pending` one means this machine never saw the
transfer confirm and only you, looking at the contract address on an explorer, can say
whether the funds moved. That is the same state an UNCERTAIN paid-push refusal
(`CB-E027`) leaves behind, so the reminder to go and look now outlives the session that
produced it.

Retrying a push against a contract that is already funded also notifies the provider the
contract was actually deployed with — read back from that record, or from the receipt —
instead of whichever provider this run's registry lookup happened to return. Registering
a provider replaces rather than adds to the contract's on-chain list, so a retry after the
registry changed could otherwise notify a provider that never held the bag. If nothing
recorded names the deployed provider, the warning about it is now explicit.
