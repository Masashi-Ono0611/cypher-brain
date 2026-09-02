---
'cypher-brain': patch
---

ton-provider: a retry of an already-funded contract now reads the provider back from the contract itself

When `push --backend ton-provider` retries a push whose StorageV1 contract is already
funded on-chain, it skips re-funding and goes straight to notifying a provider. Which
provider that is now comes, first and foremost, from the contract's OWN on-chain
`providers` dict, read through the new `storage-v1-client providers --address <contract>`
subcommand. That outranks the pending-spend intent and the receipt this machine wrote,
because `modify_providers` replaces that dict rather than merging into it — whatever the
chain holds now is the registration, and a local note is only ever a claim about it.

In practice this closes the one case the previous behaviour could not answer at all: a
funded contract this machine has no record of (a different machine, a wiped ledger) used
to notify whoever the current mytonprovider.org snapshot happened to return, which may
be a provider that never held the bag. It now notifies the one the contract names.

If the on-chain read cannot answer (the Go client is not configured, tonapi is
unreachable, the contract is not active yet), behaviour is unchanged from before — the
local records decide — and a warning says so, naming the reason. When the chain and a
local record disagree, both are reported and the chain wins.

Two situations now refuse the push rather than notify someone: a contract whose on-chain
dict is empty (it registers nobody, so notifying anyone addresses a provider it does not
name), and a contract naming several providers none of which this machine recorded. No
funds move on this path either way, so a refusal costs only a retry.
