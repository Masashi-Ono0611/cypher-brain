---
'cypher-brain': minor
---

Add a `ton-provider` storage backend (issue #396) — pays a live TON Storage market
provider (self-registered on mytonprovider.org, the current Go/StorageV1 scheme) to
hold the bag, instead of requiring an operator-run seeder box the way `ton` does.
A user with no always-on box of their own now has a real "pay once, don't operate
infrastructure yourself" TON option, the same shape arweave/turbo already have.

`push --backend ton-provider` deploys a per-bag StorageV1 contract (pure TypeScript
via `@ton/ton`, cross-verified byte-for-byte — contract address and message body cell
hash both matched independently — against `scripts/go/storage-v1-client`'s tested Go
implementation), selects a live provider from mytonprovider.org, prints a Tonkeeper
universal-link deeplink for a human to sign, waits for the deploy to land on-chain,
then notifies the provider (shelling out to a locally built
`scripts/go/storage-v1-client` binary — notifying a provider needs an ADNL/RLDP query
with no mature TypeScript implementation) and waits until it reports a full download
before releasing the local ephemeral seed. Requires `CYPHER_BRAIN_TON_PROVIDER_OWNER`,
`CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND`, and `CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN`.

This is Phase A of issue #396 — the backend capability only. A human must still sign
the Tonkeeper deeplink at push time (no local TON wallet exists yet to sign
automatically, unlike arweave/turbo's JWK-based `wallet.ts`), so this backend does not
run under `schedule install` yet, and it is not offered in the `init` wizard or the MCP
server's backend list (both need operator-side setup an automated caller can't
collect). `--help`/`estimate` gained minimal, factual coverage of the new backend;
symmetric UX treatment alongside arweave (issue #396 Phase B) is a follow-up.

The existing `ton` backend (self-hosted seeder) is unchanged.
