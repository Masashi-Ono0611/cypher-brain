---
'cypher-brain': patch
---

`arweave` backend's `put()` now refuses an L1 upload upfront when the signer's wallet
cannot cover the (already-estimated) cost, instead of signing and broadcasting a
transaction that could only fail on-chain/at the gateway afterward. `turbo.ts` has had
the equivalent (`getBalance`/`summarizeBalance`/`insufficientFundsError`, #342) since
issue #33's original ask for both backends — `arweave.ts` never received the
balance-check half of it (#701). The check fetches the signer's address
(`ar.wallets.jwkToAddress`) and native on-chain balance (`ar.wallets.getBalance`,
winston) and compares it against the pre-flight cost estimate; a balance READ failure is
advisory-only (proceeds with a warning) — only a successfully-read, genuinely
insufficient balance aborts, with an actionable message naming the shortfall and how to
fund the wallet.
