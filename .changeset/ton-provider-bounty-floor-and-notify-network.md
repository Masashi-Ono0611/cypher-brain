---
'cypher-brain': minor
---

`push`/`estimate --backend ton-provider` now WARN before a deploy whose computed
"bounty" looks below the fixed floor (~0.05 TON) providers built on
`tonutils-storage-provider` enforce (issue #403). Hit twice while dogfooding real
testnet/mainnet deploys: a small bag at a plausible market rate can pass every
existing check, get deployed and paid for, then have the provider's own `notify`
refuse to ever fetch it — discovered only after the full 10-minute notify retry
window. The formula and floor are read directly from
`tonutils-storage-provider@v0.4.3`'s own source (`internal/service/service.go`), not
guessed, and the check WARNS rather than refuses (an assumption about a provider's
exact library version should never block a user's own deploy). `notifyProviderWithRetry`
also now surfaces the provider's own stated refusal reason (e.g. "bounty should be at
least 0.05 TON to cover fees") the first time it appears, instead of discarding it
until a generic timeout message ten minutes later.

Also fixes issue #404: `notify`'s shell-out to `CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN`
hard-coded `--mainnet` regardless of `CYPHER_BRAIN_TON_NETWORK_CONFIG`, unlike every
other network-sensitive call this backend makes — hit directly while dogfooding a
testnet MCP e2e run (a contract confirmed active on testnet still got a mainnet-tonapi
404 at notify). Now derives the flag from the same `TON_NETWORK_CONFIG` signal
`startLocalTonDaemon()` already uses.
