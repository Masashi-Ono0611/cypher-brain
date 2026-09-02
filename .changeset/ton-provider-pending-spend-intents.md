---
'cypher-brain': patch
---

A confirmed `ton-provider` spend can no longer disappear from the cost ledger because
the process died at the wrong moment, and a retry no longer notifies a provider the
contract was never deployed with (#808, #665).

A `push --backend ton-provider` deploy now records what it is about to spend — contract
address, bag id, provider pubkey and amount — to a `receipt-ledger.jsonl.pending-spends.jsonl` file beside
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
contract was actually deployed with, rather than whichever provider this run's registry
lookup happened to return — this pending-spend record and the receipt name a candidate,
but only as a fallback/disambiguation input: the contract's OWN on-chain `providers` dict
is the authority whenever it can be read (see #830), because `modify_providers` replaces
that dict rather than merging into it, so what the chain holds now is the registration and
a local record is only ever a claim about it. If the on-chain read cannot answer at all
(unconfigured/unreachable/not yet active), this pending-spend record (or the receipt)
decides instead, and a warning says why. A dict that CAN be read but is empty, or names
several providers none of which this pending-spend record or the receipt recorded, is not
a case where a local record steps in either — the push refuses to guess and notifies
nobody. If nothing recorded names the deployed provider at all, the warning about it is
now explicit.
