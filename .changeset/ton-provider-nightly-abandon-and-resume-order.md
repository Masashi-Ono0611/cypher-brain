---
'cypher-brain': minor
---

`ton-provider` backend: two money-safety fixes for the resume/retry path.

**#951 (reorder)**: resuming an already-active StorageV1 contract no longer
runs provider (re-)selection at all. Before this, `push`'s #638 already-active
check ran only AFTER `searchProviders()`/`selectProvider()`/
`checkProviderLiveTerms()` — so a retry against an already-PAID contract could
be refused by an unrelated condition (a newly-ranked provider's live ADNL rate
disagreeing with the mytonprovider.org registry snapshot that ranked it),
never reaching the resume logic at all. The already-active check (keyed on a
contract address now derived independently of any provider, via the new
`deriveContractAddress()`) runs first; a genuinely fresh deploy still selects
and price-checks a provider exactly as before.

**#950 (new guard)**: an unattended nightly `schedule install` run whose
`notifyProviderWithRetry()` genuinely times out (the funding transfer
confirms on-chain, but the provider's own P2P download does not finish within
`CYPHER_BRAIN_TON_PROVIDER_NOTIFY_RETRY_MS`) records the confirmed-but-
unconfirmed contract, keyed on the PUSHED CONTENT'S plaintext digest, in a new
small durable log (`<receipt-ledger>.ton-provider-notify-incomplete.jsonl`).
A LATER push for the exact same unchanged source content — which would
otherwise re-encrypt to a fresh ciphertext, derive a brand-new contract
address, and pay to deploy an entirely new contract every night the transfer
genuinely needs more than the wait window — now refuses up front instead,
naming the prior contract and pointing at the manual recovery step (re-push
the retained original ciphertext file, which the #951 fix above then resumes
without paying again). New `CYPHER_BRAIN_TON_PROVIDER_NOTIFY_INCOMPLETE_WINDOW_MS`
(default 24h) bounds how long that refusal lasts before self-expiring. This is
deliberately the smallest fix that closes the repeated-payment risk — it does
not automate re-derivation of the abandoned contract from a discarded
ciphertext, which is left as a documented manual step.
