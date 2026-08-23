# TON Storage — measured status log

What we have actually MEASURED about TON Storage, organized by network and by
who runs the storage. Every claim here has a date; nothing is folklore. Update
this file when a new measurement changes a verdict — do not append a diary,
rewrite the verdict it invalidates (repo style: later decisions get merged in,
not stapled on).

The product stance this log justifies is unchanged (docs/durability.md):
Arweave/`turbo` is the permanence mainline; `ton` is a sovereign self-hosted
replica; third-party TON providers are an experiment lane, not a dependency.

## The landscape (role × network)

Three independent roles exist, each on mainnet and testnet. Keep them
separate — "our droplet seeds our own bag" (free, self-hosted), "our droplet
is registered so OTHERS can pay it to store THEIR bags" (earns, not spends),
and "we pay someone else's provider to store OUR bag" (spends) are three
different things that happen to share the same droplet and the same Go
binaries.

| role | network | verdict (date) |
|---|---|---|
| **Self-hosted seeder** — droplet seeds our own bags directly, no payment | mainnet | **WORKS, in production** (2026-08-22) |
| **Self-hosted seeder** | testnet | dogfood only; not used for real backups |
| **Our droplet as a paid provider** (earns — discoverable by other users) | mainnet | **registered & live, econ params fixed** in the mytonprovider.org registry (2026-08-23, pubkey `f5f603c7…`, uptime 100%, rating 17.9, telemetry on, wallet funded ~1 TON); zero paid contracts received yet |
| **Our droplet as a paid provider** | testnet | standing twin (same Go binaries, isolated units) — controlled environment, no real earnings expected |
| **We pay a legacy C++ provider** (spends — fabric-contract ecosystem) | mainnet | **GRAVEYARD** (115 listed, 0 active ≤7d, 94 silent >1y) — not pursuing |
| **We pay a legacy C++ provider** | testnet | **DEAD DAEMONS, live contracts** (2026-08-22 experiment) |
| **We pay a live Go provider** (spends — mytonprovider.org registry) | mainnet | **IN PROGRESS** (2026-08-23) — building a small Go client (reuses xssnick's own `pkg/contract` + `pkg/transport`) to deploy a StorageV1 contract against a real registry provider and pay for masabrain (481 MB) |
| **We pay a live Go provider** | testnet | not attempted (mainnet-first, per operator decision — the registry itself is a mainnet market) |

**The single most important 2026-08-23 correction**: the provider market is TWO
incompatible ecosystems, and every earlier "dormant/graveyard" measurement
(ours of 2026-05 and 2026-08; the 2026-04 third-party write-up describes the
same doorway — storage-daemon tooling and provider-contract lookups — though we
can only attribute, not re-run, that author's method) was made through the
LEGACY C++ doorway (tonapi index, storage-daemon docs). The
living market — Go providers registered on mytonprovider.org, contracts
deployed by the CLIENT — is invisible from that doorway. Both lanes must be
checked in any future assessment.

## Mainnet — our own seeder (production)

- 2026-08-22: the real 481 MB encrypted brain snapshot round-trips: `push
  --backend ton` (upload + seeder-side piece hashing inside the create budget),
  strict P2P pull back in **95 s (~5 MB/s)** with the sha256 pin matching
  (`CYPHER_BRAIN_TON_NO_FALLBACK=1`, so the P2P network provably served it).
  That bag is the live replica; the domain's TON DNS `storage` record points at
  it (published + resolver-confirmed the same day).
- Small-bag latency (20 KB dogfood, same day): push ~34 s, strict P2P pull
  7–14 s across runs, DHT discovery included.
- Known limit, unchanged: one seeder box is one failure domain. A second
  independent seeder is the real durability upgrade (open follow-up).

## Mainnet — third-party providers, legacy C++ ecosystem (tonapi-indexed)

- 2026-05-10 (ton-mesh-harness era): 7-round soak. Offers deployed contracts,
  **zero `accept_storage_contract` ever arrived**; funds reclaimed via
  `op::close_contract` (0.022 TON lost to fees per round). Verdict then:
  provider economy dormant.
- 2026-08-23 census (all 115 listed providers, last on-chain activity via
  tonapi, read-only): **0 active within 7 days, 1 within 30 days, 94 dead for
  over a year.** The listing is overwhelmingly a graveyard of configurations
  whose operators left years ago.
- The one faint candidate: `0:f0a21e2e5630caee3034879b789dd5fd8fd060e6bf4b9f5ef94fc0b49238c633`
  — last activity 8.8 d before the census, and its recent history shows an
  incoming ~1.5 TON offer followed by several externally-signed messages,
  which is the signature of a daemon actually reacting. Rate is in the
  expensive tier (1,000,000 nanoTON/MB/day ≈ 365 TON/GB/yr). A single
  bounded mainnet offer at it is the only measurement left that could flip
  this lane's verdict; everything cheaper on the list has shown no on-chain
  activity for months to years (which is strong — but activity-based, not
  proof the daemons are gone).

## Mainnet — third-party providers, live Go ecosystem (mytonprovider.org)

- Discovery (2026-08-23, `POST https://mytonprovider.org/api/v1/providers/search`):
  **77 registered providers (76 third-party + our own, added 2026-08-23),
  21 with uptime >90%**. The top-rated operator
  (Dallas, uptime 99.2%, 370 days of continuous operation) **self-reports
  2,263 GB used of 2,700 GB offered** via registry telemetry — a strong demand
  signal, but allocation/usage as REPORTED, not yet an independently verified
  paid contract (the first live test will settle that).
  Spans are sane here too: min_span typically 7 days (vs the C++ listing's 1 day).
- How it works (verified from xssnick source, re-confirmed 2026-08-23 by a
  targeted read of `tonutils-storage` @ `e80866d`, `tonutils-storage-provider`
  @ `e624ea4`, `tonutils-contracts` @ `1fa35d6`): the provider deploys NO
  contract — the CLIENT builds and deploys a per-bag `StorageV1` contract
  (`contracts/storage/storage-contract.fc`; address = `hash(StateInit)`,
  workchain 0) and funds it, then submits proofs against gas the provider's
  own wallet spends (0.05 TON/proof).
  **Correction from the earlier "ADNL push" description**: there is no push.
  `FetchStorageInfo` (the provider-side handler that registers a new contract)
  is reachable from exactly three call sites in the provider daemon, and only
  one is a discovery path — the **client must send a direct ADNL/RLDP query**
  (`storageProvider.storageRequest`) to the provider's own ADNL address
  (resolved via DHT) after deploying. The other two call sites
  (`startup_wallet_scan.go`, `stopped_reconciler.go`) only re-confirm
  contracts that already had at least one accepted proof — they cannot
  discover a brand-new contract. **Practical consequence, scoped to the
  inspected commits (`tonutils-storage-provider` @ `e624ea4`) — not confirmed
  as a protocol guarantee across all versions: on-chain deploy + fund alone
  will not be noticed by this daemon implementation; the client must also
  send the RLDP query.**
- The `price` field in the mytonprovider.org registry response is **not**
  the on-chain `rate_per_mb_day` — both are nanoTON-denominated (confirmed
  from the `dearjohndoe/mytonprovider-backend` SQL source comment: `p.rate_
  per_mb_per_day * 1024 * 200 * 30 as price, -- NanoTON per 200GB per month`).
  Using `price` directly as a contract rate overshoots by ~6.1M×; recover the
  real rate via `rate_per_mb_day = price / (1024 × 200 × 30)`, or query the
  provider's live ADNL rate directly.
- The production client is **mytonstorage.org** (TON Connect + upload +
  provider choice + contract management) — still the only *browser* path.
  Re-uploading a 481 MB file through it is impractical from a remote laptop,
  so the CLI path below is what we're building instead.
- **Automation status (2026-08-23)**: `tonutils-storage`'s `rent-storage` REPL
  is TTY-only (piped/expect drives produced multi-GB prompt-redraw storms, no
  parseable output) — ruled out for scripting. Reimplementing ADNL/RLDP/DHT
  from scratch in JS was considered and rejected as too risky for a P2P crypto
  protocol with no mature JS implementation confirmed production-ready.
  **Current path: a small standalone Go program that imports xssnick's own
  `pkg/contract` (deploy-message construction, non-`internal`) and
  `pkg/transport` (`RequestStorageInfo`, the same RLDP client the real daemon
  uses, also non-`internal`) directly** — reuses tested code instead of
  re-deriving the cell layout and ADNL handshake by hand. Lives alongside the
  other operator-run experiment scripts, not the shipped CLI. In progress.

## Testnet — third-party providers (C++ lane)

- 2026-08-22 live experiment (bag `a2b26f1c…`, 8 KB, seeded from the droplet's
  testnet C++ storage-daemon):
  - 173 providers listed; 2 passed the offer filters (size/span/accepting).
  - `new-contract-message` over ADNL (tried against 3 providers picked from
    the raw list before filtering): **2 of the 3 answered the rate query** —
    some daemons DO respond at the P2P layer.
  - Signed offer (0.3 testnet TON) → the provider's main contract
    **mechanically deployed** the per-bag storage contract (its first activity
    since January 2023) — contract code working ≠ operator alive.
  - **No accept within 30+ min.** Meanwhile an independent fresh client
    (NAT-ed laptop, new identity) fetched the same bag via DHT in **6 s** —
    so generic unreachability of the bag is excluded (a provider-SPECIFIC
    network/configuration failure cannot be fully ruled out from outside);
    the behavior is most consistent with a dead or ignoring storage daemon.
    Funds recovered via `close` — measured round-trip on 2026-08-23: sent
    0.35 testnet TON (offer 0.3 + close gas 0.05), refunded 0.328, net fee
    loss 0.022 TON, matching the 2026-05 mainnet figure.
- Net: same shape as mainnet 2026-05 — the chain-side machinery is alive, the
  operator-side daemons are not.
- The droplet's C++ testnet seeder used for this experiment was **torn down**
  after use (2026-08-22): `tsp-testnet-storage` unit, `testnet-db` and
  `testnet-experiment` dirs removed, udp 17777 firewall rule closed. Its
  binaries remain at `/opt/tsp/testnet-bin/` (harmless leftovers, not
  wired to any running unit) — kept because the same C++ `storage-daemon`
  binary is a candidate tool for cross-checking a bag's TorrentInfo hash
  offline if that's ever needed again.

## Our own droplet as a Go provider (mainnet: registered; testnet: standing twin)

- **Mainnet (2026-08-23): registration transaction confirmed recorded.** The
  0.01 TON `tsp-<pubkey>` registration transfer (to the shared TON Storage
  registration address `0:7777…7777`, verified against the
  `igroman787/mytonprovider` tooling source — not a placeholder) was sent, and
  a separate query (run from this session, not taking the sender's word for
  it) confirmed the registry now lists it: `POST
  https://mytonprovider.org/api/v1/providers/search` → pubkey
  `f5f603c7a2d1719a834e153c27b4fad4fa9da0d532d6ac5f013547cafc91fb0b`,
  `address: EQAwUvvYnPpImBfrKl3-KRYh05aNrUKTGgcarTB_yzhAt1eh`, `uptime: 100`,
  `reg_time` matching the day of registration. **Scope of this confirmation**:
  it proves the self-reported registration was recorded by mytonprovider.org
  — the same registry the transaction targets — not that the provider daemon
  is independently reachable or functioning (uptime/telemetry in this
  registry are also self-reported by the same daemon). No paid contracts
  received yet (expected — registration alone doesn't generate demand).
- **Default config, then a self-inflicted bounty trap, both found + fixed
  (2026-08-23).** The provider ran with unmodified
  `tonutils-storage-provider` defaults: `MaxBagSizeBytes: 0` (confirmed
  byte-identical to the config's own `envDefault` — silently caps every
  contract to zero bytes, regardless of price), `MinSpan: 600s`,
  `MaxSpan: 172800s` (2 days), `MinRatePerMBDay: "0.0001"`. First fix pass
  targeted the size cap and moved pricing toward the live market:
  `MinRatePerMBDay` → `"0.0000008"` (discount-tier, in line with the
  cheapest live third-party providers), `MinSpan` → `604800s` (7 days),
  `MaxSpan` → `8294400s` (96 days). That combination introduced a *new*
  problem: the daemon's own bounty check (`internal/service/worker.go`:
  `bounty = rate × size × MaxSpan / (86400×1024×1024)`, contract
  auto-dropped if `bounty < 0.05 TON` proof gas) computed a 481 MB
  (481×1024×1024 bytes) contract at the new discount rate + 96-day span to
  **0.037 TON bounty — below the
  0.05 TON gas fee — so the daemon would have silently refused the exact
  size of bag we care about**, with no error visible anywhere in the
  registry (caught only because a bounty recheck was run after the price
  drop). Fixed by extending `MaxSpan` further, to `16588800s` (192 days,
  matching the longest live provider, Hetzner/FI) — 481 MB now bounties at
  **0.074 TON, clearing the gas fee** at the discount rate. Verified via a
  fresh `providers/search` query after each change (`price`/`min_span`/
  `max_span` updated within ~1–2 min of the `systemctl restart`, matching
  the backend's 1-minute `UpdateKnownProviders` ADNL rate-poll cycle).
- **Telemetry implemented (2026-08-23).** `is_send_telemetry` was `false`,
  and the registry's `max_bag_size_bytes` field — a *separate* reporting
  channel from the bounty bug above, but one that was echoing the same
  `MaxBagSizeBytes: 0` config value — also showed `0` until telemetry
  started reporting the post-fix config. Source read of
  `dearjohndoe/mytonprovider-backend` confirmed `POST
  /api/v1/providers` has **no auth middleware and no `telemetry_pass`
  field in the current API** (that field only exists in the unrelated
  Python `igroman787/mytonprovider` client) — the only server-side checks
  are a non-empty `provider.pubkey` and a body-size cap. A minimal Python
  sender (`/opt/tsp/telemetry-send.py`, gzip JSON POST every 15 min via a
  `systemd` oneshot timer, independent unit with no `After`/`Requires` on
  the provider service so a sender failure can't touch it) reads only
  non-secret fields from `config.json` via `jq` (never touches
  `ADNLKey`/`ProviderKey`) plus local `df`/`free`/`uname`/`/proc/cpuinfo`.
  Confirmed live in the registry: `max_bag_size_bytes` 0 → `4294967296`,
  `is_send_telemetry` → `true`, `rating` 5.96 → **17.9** (on par with
  established third-party providers).
- **Wallet funded (2026-08-23).** Provider wallet
  (`UQCCrKrQHLpB75vvrd5js78eB7qK6v7Cpz4WJpV2DoZnY-GC`) topped up from 0.1 TON
  to **~1 TON** (operator-sent) — enough headroom for the first several proof
  cycles (0.05 TON/proof) before contract income needs to cover it.
- **Two registry-UI fields stayed unresolved and why (2026-08-23):**
  `Location` shows "Unknown" and `Status` shows "No Data" on
  mytonprovider.org, unlike established providers ("United States (US)",
  "Stable (100%)"). Source-traced both: `Location` is filled by the
  backend's own `UpdateIPInfo` worker, which only sweeps every **240
  minutes** — expected to self-resolve, not a config problem (droplet's
  `ExternalIP`/firewall for ADNL udp/18555 were confirmed correctly set).
  `Status`, however, **will not self-resolve** — the backend's
  `UpdateStatuses` SQL `LEFT JOIN`s `providers.storage_contracts`, so a
  provider with zero contracts has no join row to derive a status from and
  stays "No Data" indefinitely; it only starts showing "Stable" once at
  least one real contract exists. (A same-droplet self-contract — using our
  own provider to store our own masabrain bag — would clear this: 481 MB at
  the fixed rate/span bounties above the gas fee, so it's technically viable.
  Deprioritized versus the third-party test though, since seeder and provider
  would be the same single failure domain — fixing the cosmetic status this
  way adds zero real redundancy. The Go client being built for the "pay a
  live Go provider" lane above takes the provider address as a parameter, so
  pointing it at our own pubkey later is a cheap follow-up if the cosmetic
  fix is ever wanted.)
- **Testnet: standing twin, unchanged.** tonutils-storage-provider v0.4.3 +
  its own testnet tonutils-storage, running as transient systemd units on the
  droplet (isolated under `/opt/tsp/testnet-*`, mainnet services untouched);
  provider wallet funded with 2 testnet TON. Original purpose was to separate
  protocol from market within the Go scheme; with live third-party Go
  providers now known and reachable, testing against a real third party
  (see the section above) largely supersedes this twin for that goal — it
  stays standing as a controlled environment.
- Two findings from source (xssnick/tonutils-storage-provider), still valid:
  1. The Go provider **never self-deploys a contract** — deployment is always
     client-initiated; the daemon answers ADNL rate queries and reacts to a
     deployed contract once it learns about it (see the RLDP discovery
     requirement above — this applies symmetrically whether OUR droplet is
     the provider being paid, or we're paying SOMEONE ELSE'S).
  2. The C++-scheme `ton-provider-experiment.mjs offer` command (this repo's
     existing experiment script) cannot be pointed at a Go provider — it
     builds the legacy `OP_OFFER_STORAGE_CONTRACT` message, which a
     StorageV1-scheme provider does not understand. It stays valid for
     C++-contract providers only (the graveyard lane above). The Go program
     described in the section above is the real client for this lane.

## Cost reality check (so nobody misreads "cheap")

Comparing self-hosted TON seeding to Arweave is category confusion — it is
"own hard drive" vs "paid permanence". The like-for-like comparison is
Arweave (~$28/GB one-time, measured via turbo) vs provider contracts
(listed floor ~0.73 TON/GB/yr): as of 2026-08-23 and assuming ~$3/TON,
breakeven at the floor rate is over a decade, mid-tier listed rates 2–9 years — and the market behind those listed rates is, per
above, mostly not real IN THE LEGACY LANE — the live Go lane (mytonprovider)
reports usage consistent with real paid demand (2,263/2,700 GB self-reported
by the top operator), though this is telemetry the provider's own daemon
reports about itself, not yet independently verified against an actual paid
contract; its pricing surfaces as a `price` field per provider (see the
unit-conversion note above — divide by 1024×200×30 to get back to
nanoTON/MB/day before comparing). Self-hosted TON is cheap because you are
the storage; it buys availability, not permanence.

## Operational inventory (what exists where, as of 2026-08-23)

- Droplet (mainnet, production): `tonutils-storage.service` +
  `tonutils-storage-provider.service` (long-standing, binary refreshed to
  clean v0.4.3 2026-08-22 — was `v0.4.3-dirty`), the cypher-brain bag layout
  under `~/cypher-brain-ton/`, healthcheck pinned to the live brain bag. The
  provider service is now also registered in the mytonprovider.org registry
  (see above) — same binary, two roles (seeds our bag for free; separately,
  discoverable as a paid provider for others). `tsp-telemetry.service` +
  `tsp-telemetry.timer` (added 2026-08-23, 15 min interval) run independently
  alongside it to report registry telemetry — see the telemetry bullet above.
- Droplet (testnet, experiment, transient systemd units — disposable):
  `tsp-testnet-provider-storage` (Go storage, udp 17556),
  `tsp-testnet-provider` (provider daemon, udp 18556), both under
  `/opt/tsp/testnet-*`. The C++ testnet seeder (`tsp-testnet-storage`, udp
  17777) that was here earlier was torn down 2026-08-22 (see the C++ lane
  section above) — its binaries remain on disk but nothing runs them.
  Stop remaining units with `systemctl stop <unit>`; nothing survives a
  reboot by design.
- Experiment wallet (testnet, throwaway): provider key lives in
  `/opt/tsp/testnet-provider/config.json` on the droplet only.
- Go toolchain: available locally (`go1.26.5`, macOS arm64) for building the
  StorageV1 client program described above; **not installed on the droplet**
  (the droplet only runs prebuilt Go binaries, it doesn't compile).
