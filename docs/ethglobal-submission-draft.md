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
- **Storage:** cypher-brain supports Arweave/Turbo and TON storage paths in addition to a free local `file` backend used for this demo (storage availability and ENS identity are separate concerns; production usage would use a paid, permanent backend).
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
- **Implementation PRs:** [#973 — agent wallet / #966](https://github.com/Masashi-Ono0611/cypher-brain/pull/973), [#974 — ENS setup / #967](https://github.com/Masashi-Ono0611/cypher-brain/pull/974), [#975 — ENS publish / #968](https://github.com/Masashi-Ono0611/cypher-brain/pull/975), [#976 — ENS verify / #969 and generic text writes for #971](https://github.com/Masashi-Ono0611/cypher-brain/pull/976), [#978 — ens-verify positive-check fix](https://github.com/Masashi-Ono0611/cypher-brain/pull/978)
- **Sepolia ENSv2 name:** `masashi-ono0611.eth` — registered live for this demonstration on the fresh Sepolia ENSv2 redeployment (tag `sepolia-deployment-2026-09-15`).
- **Registration transaction:** [`0x792e25195e32f096e5bc8d0486a2a36fbc9de8eb051e2bdb6a30ba81cf9aed1d`](https://sepolia.etherscan.io/tx/0x792e25195e32f096e5bc8d0486a2a36fbc9de8eb051e2bdb6a30ba81cf9aed1d) (commit) / [`0x93909f43c0e58642b5c651e85cdfe64dbc56783dd1f8487a83539174865c6fbb`](https://sepolia.etherscan.io/tx/0x93909f43c0e58642b5c651e85cdfe64dbc56783dd1f8487a83539174865c6fbb) (register)
- **Resolver:** deployed through ENS `VerifiableFactory` at `0xFe544BFED75001379E01434951623Ea80FbDb3CF`. **Transaction:** [`0x92a4dece440260206a548ad0fa6b53c3b7eea15dcf8e3d990565f92baf4dec32`](https://sepolia.etherscan.io/tx/0x92a4dece440260206a548ad0fa6b53c3b7eea15dcf8e3d990565f92baf4dec32)
- **Scoped grants** (each an independent `ens-setup` run, owner wallet only): `masa-brain` ([`0x2b9124bba063e0bb1b03d47093538f9e20e2b094f59fa6309deb00c0f256aac0`](https://sepolia.etherscan.io/tx/0x2b9124bba063e0bb1b03d47093538f9e20e2b094f59fa6309deb00c0f256aac0)), `agent-context` ([`0x1ff5cd8229aeb192869185e5664b99646809e37256b973ede82c49b9509a9b8d`](https://sepolia.etherscan.io/tx/0x1ff5cd8229aeb192869185e5664b99646809e37256b973ede82c49b9509a9b8d)), `agent-endpoint[mcp]` ([`0x37abc554efa4160fcd975f9a1ed4629f62432718b5d6931d5a34abc48bb6d445`](https://sepolia.etherscan.io/tx/0x37abc554efa4160fcd975f9a1ed4629f62432718b5d6931d5a34abc48bb6d445))
- **Pointer publish** (`push --backend file` then `ens-set-text`, agent wallet only): [`0x48386ea6e1b1d5ffbf83ed0406a0abecb1456003408cc14bfcb96826b38a7d8d`](https://sepolia.etherscan.io/tx/0x48386ea6e1b1d5ffbf83ed0406a0abecb1456003408cc14bfcb96826b38a7d8d)
- **`ens-verify` run (masa-brain):** both checks PASS —
  ```
  PASS positive: masashi-ono0611 text record 'masa-brain' matches --expected-value
  PASS negative: out-of-scope text key 'masa-brain.scope-probe' reverted with EACUnauthorizedAccountRoles
  ENS scope verification: PASS (negative check was simulated; no transaction was broadcast)
  ```
- **ENSIP-26 records** (agent-wallet only, independent of any push — see #971 below): `agent-context` written ([`0xce264cb187212dcd406ddcfa65c92decf41856deee5ab0264bbb0c474ee36d0f`](https://sepolia.etherscan.io/tx/0xce264cb187212dcd406ddcfa65c92decf41856deee5ab0264bbb0c474ee36d0f)), `agent-endpoint[mcp]` written ([`0x2cbdf516b6909b652721752fdc238def6914a888dd977288ef982aeca67a53e8`](https://sepolia.etherscan.io/tx/0x2cbdf516b6909b652721752fdc238def6914a888dd977288ef982aeca67a53e8)); both independently pass `ens-verify`'s positive/negative check, confirming the bracket-key syntax round-trips correctly.
- **ENSv2 Sepolia explorer:** [explorer.ens.dev](https://explorer.ens.dev)
- **Team name:** TODO
- **Demo video:** TODO
- **Deployed frontend:** TODO — this submission is CLI-only; confirm whether ETHGlobal's form requires a URL regardless.

## 6. Future work

Issue [#971](https://github.com/Masashi-Ono0611/cypher-brain/issues/971) (ENSIP-26 agent self-description keys) is **closed** — see the on-chain evidence above. The generic `ens-set-text` write path from PR #976 was verified to handle both plain (`agent-context`) and bracketed (`agent-endpoint[mcp]`) keys correctly, with no code change needed.

While closing #971, `ens-verify`'s positive check was found to call a nonexistent resolver function (`getText` — the real ENSv2 PermissionedResolver only exposes text records through the ENSIP-10 `resolve()` wildcard-resolution entrypoint). Fixed in PR #978, verified live against the same Sepolia name.

Separately, the broader Scoped Brain direction still needs a per-use-case export pipeline from gbrain into distinct encrypted snapshots. The brief's gbrain export work is explicitly outside the ENS Epic and is not claimed as implemented here.
