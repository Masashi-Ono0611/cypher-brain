# ETHGlobal Tokyo 2026 — Submission Draft

Working draft for the ENS Track 2 submission. Replace every `TODO` and transaction placeholder before submitting. Product claims below distinguish the implemented ENS integration from the broader Scoped Brain direction.

## 1. Project name and tagline

**Scoped Brain**

Give every AI agent only the part of your brain it needs.

The submission builds on the existing [cypher-brain project](https://github.com/Masashi-Ono0611/cypher-brain).

## 2. Project description

Scoped Brain connects three separate controls for personal AI memory. **gbrain** provides logical isolation through source-aware access. **Cypher Brain** packages selected local inputs into an age-encrypted snapshot and stores the ciphertext using a configured backend. **ENSv2** gives the snapshot pointer a human-readable identity and lets its owner delegate a narrowly scoped, revocable permission to an agent wallet.

The problem is that an agent often needs continuity across sessions, but giving it broad access to a personal memory store or an owner's wallet grants more authority than the task needs. Scoped Brain keeps those boundaries distinct: an application-level source grant is not a decryption key, and an ENS text-record permission is not access to the snapshot contents. The current submission demonstrates the ENS delegation and pointer-publication layer. It does not yet implement automatic per-use-case gbrain export or one encrypted snapshot per use case; those remain separate work.

## 3. How it's made

- **TypeScript CLI:** `cypher-brain` creates and verifies snapshots, manages the local Ethereum agent wallet, and runs the ENS setup, publish, verify, and text-write commands.
- **Encryption:** age encrypts snapshot contents before they are sent to a storage backend. The ENS record contains a pointer, not the snapshot plaintext or its decryption key.
- **Storage:** cypher-brain supports Arweave/Turbo and TON storage paths. TODO: name the backend used for the demo after recording the push locator. Storage availability and ENS identity are separate concerns.
- **ENS/EVM:** `viem` is loaded lazily for wallet and Sepolia RPC operations. The integration targets ENSv2's Permissioned Resolver and Enhanced Access Control (EAC). The owner grants `ROLE_SET_TEXT` for a specific text key; the agent wallet uses that grant to update the record. Contract ABI/address details follow the ENS `contracts-v2` Sepolia deployment source and must be refreshed after testnet redeployments.

The owner wallet is entered through a hidden interactive prompt for setup and is not persisted by cypher-brain. The separate agent wallet is stored locally with restrictive file permissions. `ens-setup` reuses an existing registered name and resolver; it does not register names or deploy resolver proxies.

## 4. What ENSv2 changes

ENS is part of the working flow, not a profile badge. After a successful push, `push --publish-ens` writes the locator returned by that push to the granted text record using the agent wallet. `ens-verify` then performs both sides of the permission check:

1. It reads the granted text key back and checks that the value matches the expected locator.
2. It simulates a `setText` call to a different key and requires the resolver's `EACUnauthorizedAccountRoles` error. The negative probe is not broadcast.

The pair matters: a successful write alone does not show that the wallet is constrained, and a rejected write alone does not show that publishing succeeded. After the owner grants additional keys with `ens-setup`, `ens-set-text` lets the agent wallet write independent metadata without tying those writes to a push event.

The owner supplies the delegated permission once; routine pointer updates use the agent key. The grant is scoped to one text-key resource and can be changed or revoked by the owner through resolver administration. This provides on-chain control over pointer updates; it does not authorize decryption of the age snapshot.

## 5. Links and demo

- **Repository:** [Masashi-Ono0611/cypher-brain](https://github.com/Masashi-Ono0611/cypher-brain)
- **ENS Track 2 Epic:** [Issue #972](https://github.com/Masashi-Ono0611/cypher-brain/issues/972)
- **Implementation PRs:** [#973 — agent wallet / #966](https://github.com/Masashi-Ono0611/cypher-brain/pull/973), [#974 — ENS setup / #967](https://github.com/Masashi-Ono0611/cypher-brain/pull/974), [#975 — ENS publish / #968](https://github.com/Masashi-Ono0611/cypher-brain/pull/975), [#976 — ENS verify / #969 and generic text writes for #971](https://github.com/Masashi-Ono0611/cypher-brain/pull/976)
- **Sepolia ENSv2 name:** `masashi-ono0611.eth` — registered for this demonstration on the fresh Sepolia ENSv2 redeployment.
- **Resolver:** deployed through ENS `VerifiableFactory`. **Transaction:** `[TX_HASH_PLACEHOLDER]`
- **Scoped grant:** agent wallet granted `ROLE_SET_TEXT` for `masa-brain`. **Transaction:** `[TX_HASH_PLACEHOLDER]`
- **Registration transaction:** `[TX_HASH_PLACEHOLDER]`
- **Pointer publish and `ens-verify` run:** TODO — run against the current demo state and record the locator, positive readback, and negative simulation result.
- **ENSv2 Sepolia explorer:** [explorer.ens.dev](https://explorer.ens.dev) — TODO: add a direct link to the name or resolver if the explorer supports it.
- **Team name:** TODO
- **Demo video:** TODO
- **Deployed frontend:** TODO — confirm whether the submission is CLI-only or provide a URL.

Transaction hashes and the end-to-end publish/verify evidence are pending. Do not submit this draft with placeholders.

## 6. Future work

Issue [#971](https://github.com/Masashi-Ono0611/cypher-brain/issues/971) tracks ENSIP-26 agent self-description keys: `agent-context` and protocol-specific `agent-endpoint[<protocol>]` records. PR #976 adds the generic `ens-set-text` write path these records need, but the canonical-key path is not yet verified against the live resolver. The remaining demo work is to grant the relevant keys, write values such as `agent-endpoint[mcp]`, read them back, and record the live evidence. Issue #971 remains open.

Separately, the broader Scoped Brain direction still needs a per-use-case export pipeline from gbrain into distinct encrypted snapshots. The brief's gbrain export work is explicitly outside the ENS Epic and is not claimed as implemented here.
