---
"cypher-brain": patch
---

Fixes #693: `publish-latest`'s printed "cross-check this address on a second,
independent service" link (the multi-model-review W1 destination-trust mitigation) was
hardcoded to `https://tonviewer.com` — unlike `TON_NETWORK_CONFIG` and `TON_TONAPI_URL`,
the only two other network-dependent parts of the same function, it had no override, so
the link was dead on TON testnet (mainnet tonviewer does not index testnet addresses).
Adds `CYPHER_BRAIN_TON_TONVIEWER_URL` (default `https://tonviewer.com`), mirroring the
`CYPHER_BRAIN_TON_TONAPI_URL` pattern exactly — set it to `https://testnet.tonviewer.com`
alongside `CYPHER_BRAIN_TON_TONAPI_URL` when running against testnet.
