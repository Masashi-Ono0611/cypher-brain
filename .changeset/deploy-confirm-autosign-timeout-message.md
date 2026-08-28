---
"cypher-brain": patch
---

Fixes #480: `push --backend ton-provider` with an auto-signing wallet
(`CYPHER_BRAIN_TON_WALLET`) that never confirms on-chain used to time out after up to
20 minutes with "sign the deeplink printed above, then re-run push" — but the
auto-sign path never printed a deeplink ("no Tonkeeper deeplink needed"), so that
instruction pointed at nothing. The timeout error now gives auto-sign-appropriate
guidance instead (check the wallet's TON balance and the contract's transaction
history on a TON explorer, re-run push); the Tonkeeper-deeplink path's original
wording is unchanged.

The 20-minute wait itself also used to produce zero output between the initial
broadcast and either success or the timeout — indistinguishable from a hang. It now
prints a "still waiting for contract ... to become active on-chain (Ns elapsed)" line
every 30s by default. Both the timeout and the progress cadence are overridable via
`CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS` /
`CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_POLL_MS` /
`CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS` (test-only, same pattern as the
existing notify-retry overrides).
