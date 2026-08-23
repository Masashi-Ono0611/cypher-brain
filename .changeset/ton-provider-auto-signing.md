---
'cypher-brain': minor
---

`wallet create/address/balance` now accept `--chain arweave|ton` (default `arweave`,
backward compatible). `--chain ton` generates a locally-held TON wallet (a 24-word BIP39
mnemonic, `WalletContractV4`, written to `$CYPHER_BRAIN_HOME/ton-wallet.json` — same
no-clobber/0600 posture as the Arweave JWK) for the `ton-provider` backend's new
auto-signing mode (issue #396 PR2).

When `CYPHER_BRAIN_TON_WALLET` points at that file, `push --backend ton-provider` derives
the StorageV1 contract's owner from the wallet's own address and signs+broadcasts the
deploy itself — no Tonkeeper deeplink, no human in the loop — instead of the
`CYPHER_BRAIN_TON_PROVIDER_OWNER` + Tonkeeper-deeplink path PR1 shipped, which still works
unchanged when no wallet is configured. (If both are set and disagree, push REFUSES
outright rather than picking one silently — auto-signing requires the sender to equal the
on-chain owner, so there is no safe way to guess which address the operator meant; this is
the exact failure mode a real mainnet dogfooding session hit, now closed by refusing
instead of guessing.)

This is the same "presence-checkable capability" shape `arweave`/`turbo`'s wallet already
has, which is what makes `ton-provider` reachable from `schedule install` (unattended
nightly runs, which now also requires `CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND`/
`_NOTIFY_BIN` set before install and carries them into the generated runner) and the MCP
server (AI-driven pushes) for the first time — both only ever offer it when a TON wallet
is actually configured, so an unattended caller can never get stuck waiting on a
signature nobody is there to give. `doctor` also checks the new wallet file's
permissions, mirroring the existing Arweave JWK check.

Design proven end-to-end against real testnet (wallet generated, StorageV1 deploy signed
and broadcast locally, contract observed `active` on-chain via tonapi — zero Tonkeeper
involvement) before landing here.
