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
| **Our droplet as a paid provider** (earns — discoverable by other users) | mainnet | **registered, live, econ params fixed, and has now processed one real contract** — but it's our own (see "We pay a live Go provider" row below): mytonprovider.org registry, now under pubkey `3a7fe754…` (`tsp-canary.service`), telemetry on — the original pubkey `f5f603c7…` daemon (`tonutils-storage-provider.service`) was stopped and disabled 2026-08-25 after a parallel-canary migration (see the bounce=true root-cause and migration writeup below); no THIRD-PARTY-originated paid contract yet, so "does this provider earn from strangers" is still unproven |
| **Our droplet as a paid provider** | testnet | standing twin (same Go binaries, isolated units) — controlled environment, no real earnings expected |
| **We pay a legacy C++ provider** (spends — fabric-contract ecosystem) | mainnet | **GRAVEYARD** (115 listed, 0 active ≤7d, 94 silent >1y) — not pursuing |
| **We pay a legacy C++ provider** | testnet | **DEAD DAEMONS, live contracts** (2026-08-22 experiment) |
| **We pay a live Go provider** (spends — mytonprovider.org registry) | mainnet | **WORKS end to end, including a confirmed proof-reward payout** (2026-08-23) — `scripts/go/storage-v1-client` (deploy/notify/status/update-providers/withdraw) deployed and funded a StorageV1 contract for masabrain (481 MB) against our own registered droplet-as-provider, the provider self-reported the full bag downloaded, and a `storage_reward_withdrawal` (op `0xa91baf56`) transaction of 0.119662827 TON from the contract to the provider's registered wallet followed shortly after. Getting there required one real-money field-mapping bug (fixed by an in-place repair, not a re-deploy) — see below. That original contract (pubkey `f5f603c7…`) was orphaned by the 2026-08-25 canary migration, then drained via the new `withdraw` subcommand the next morning (see below) |
| **We pay a live Go provider** | testnet | **WORKS end to end** (2026-08-23) — `scripts/go/storage-v1-client` deployed and funded a StorageV1 contract for a throwaway 71-byte bag against our own droplet's testnet standing twin, notified it, and the provider fetched the bag; content verified byte-identical via sha256 on both sides. No public testnet registry exists (mytonprovider.org is mainnet-only — see below), so this is dev-only, not an OSS-facing feature — see below |

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
  signal, but allocation/usage as REPORTED, not yet independently verified
  against a paid contract with a STRANGER's provider — our own first live
  test (below) proves the payment mechanism works, but paid our own droplet,
  so it doesn't settle whether third-party operators like the Dallas one
  actually honor contracts from strangers.
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
  so the CLI path below is what we built instead (and is now the one that's
  actually confirmed working, not just the fallback).
- **Automation status (2026-08-23): built, and the first real payment
  succeeded.** `tonutils-storage`'s `rent-storage` REPL is TTY-only
  (piped/expect drives produced multi-GB prompt-redraw storms, no parseable
  output) — ruled out for scripting. Reimplementing ADNL/RLDP/DHT from
  scratch in JS was considered and rejected as too risky for a P2P crypto
  protocol with no mature JS implementation confirmed production-ready.
  Built instead: `scripts/go/storage-v1-client`, a standalone Go program that
  imports xssnick's own `pkg/contract` (deploy-message construction,
  non-`internal`) and `pkg/transport` (`RequestStorageInfo`, the same RLDP
  client the real daemon uses, also non-`internal`) directly — reuses tested
  code instead of re-deriving the cell layout and ADNL handshake by hand.
  `deploy`/`notify`/`status`/`update-providers` subcommands; never touches a
  wallet private key (prints a Tonkeeper deeplink for a human to sign). Lives
  alongside the other operator-run experiment scripts, not the shipped CLI.
- **Real-money incident during the first live use (2026-08-23) — full
  account, since it's the reason two PRs exist between "built" and
  "confirmed working"**: one wrong mental model about `ProviderV1.Address`
  produced two attempts before landing on the correct design — an earlier,
  never-actually-deployed version of this tool already had `deploy` take a
  wallet address and `notify` take a pubkey on that theory; the FIRST
  attempt ever run for real used that same split and failed. So it's one
  root cause, tested for real exactly once before the fix below. The first
  real `deploy` + `notify` against our own
  registered provider (see the section below) failed with `"provider does
  not exist in this contract"`. Root cause: `ProviderV1.Address` (the
  on-chain field identifying which provider a contract is for) was assumed
  to be the provider's real TON wallet address — the tool's *first* version
  had already split a single `--provider` flag into a wallet-address `deploy`
  variant and a pubkey `notify` variant on exactly that theory, reasoning
  from a `.Address.Data() != .pubkey` byte comparison against two real
  registry entries. That split was itself wrong. A from-scratch Codex
  deep-check (source + web search, run at the operator's explicit request to
  "double check with Codex, official docs included") found the real rule:
  `address.NewAddress(0, 0, pubkey)` is just how the Go SDK's dict-key API
  wants the type shaped — only `.Data()` (the raw ProviderKey pubkey bytes)
  is ever serialized on-chain, and the contract's `proof_storage` handler
  runs `check_signature` against that same key, which only an Ed25519 public
  key (not a wallet's StateInit hash) can satisfy. **Both `deploy` and
  `notify` take the SAME value: the provider's ProviderKey pubkey**
  (mytonprovider.org's registry `pubkey` field, not its `address` field) —
  confirmed independently by decoding the droplet's own
  `config.json`'s `ProviderKey` public half and matching it byte-for-byte to
  the registry `pubkey`. Funds were not sent to a wrong recipient: StorageV1
  pays proof rewards to whoever *sends* a valid signed proof, not to the
  dictionary key, so a contract with the wrong key just sits inert rather
  than paying out incorrectly — but "inert" is not "safe": absent the repair
  below, the balance would have stayed stranded in that contract (recoverable
  in principle via the owner's withdrawal path, which this incident did not
  need and so did not exercise). It's repairable in place, since the provider list
  never touches the StateInit that determines the contract's address (added
  `update-providers`, a bare `modify_providers`-only repair subcommand, for
  exactly this). Real transactions involved: 0.374 TON initial deploy,
  0.05 TON repair message — both against the operator's own droplet, so a
  successful proof payout nets back to the operator's own provider wallet
  (see the next two bullets for what *is* confirmed, including that payout).
- **Confirmed working: contract deploy, on-chain landing, RLDP discovery, and
  provider fetch (2026-08-23)**: after the repair,
  `notify --provider-pubkey f5f603c7… --contract 0:465347a9…` returned
  `status: active, downloaded: 481489880 bytes` — matching masabrain's bag
  size — i.e. the (self-owned) provider daemon found the corrected contract
  and already fetched the full bag via P2P. This is the provider's own
  self-report (the tool does not call `VerifyStorageADNLProof`/
  `checkProofBranch` to check it against a merkle proof), not yet
  cross-checked against an independent source (e.g. mytonstorage.org), but
  it is the first real evidence the whole pipeline — deploy → on-chain
  landing → RLDP discovery → provider fetch — works end to end against the
  live Go ecosystem.
- **Confirmed working: proof-reward payout (2026-08-23)**: shortly after the
  repair, tx `eeb27bd1a40046a8878cd4b1f1e06ec83b811471be2eb7138217d4a6020e27b1`
  (2026-08-23 05:21:22 UTC) shows the masabrain contract
  (`0:465347a9…`) sending 0.119662827 TON to the provider's registered wallet
  (`UQCCrKrQHLpB75vvrd5js78eB7qK6v7Cpz4WJpV2DoZnY-GC`) with `op_code
  0xa91baf56`, decoded by tonapi as `storage_reward_withdrawal` — the same
  opcode used in #376 to detect proof activity. Independently confirmed by
  fetching that transaction directly from tonapi (source/destination/opcode/
  amount/timestamp all match). The amount is about 62% above the theoretical
  ~0.074 TON estimate (rate × size × elapsed span); the reason for the
  discrepancy has not been determined — but the withdrawal itself, and that
  it lands back in the operator's own wallet as expected, is now real,
  observed, on-chain evidence, not a projection.

### Known trust-boundary gaps with the live Go provider market (2026-08-29)

Three Codex-audit findings against `src/lib/backends/ton-provider.ts` /
`scripts/go/storage-v1-client`, third dogfooding round — the fixes for the
first two landed alongside this doc update (issues #651/#652); the third's
full remediation is intentionally left as future work:

- **Stale registry terms, now checked BEFORE funds move (issue #651,
  fixed)**: `put()` used to build and broadcast a deploy purely from
  mytonprovider.org's registry snapshot (rate/span/capacity) — the selected
  provider's *live* terms were never asked for until `notify` ran, which is
  AFTER the contract is funded. `checkProviderLiveTerms()` now queries the
  provider directly (a new `rates` subcommand on `storage-v1-client`, the
  ADNL/RLDP `storageProvider.ratesRequest` — ported from
  `pkg/transport/client.go`'s `GetStorageRates`, the same library `notify`
  already uses for `storageProvider.storageRequest`) right before
  `buildDeploy()`, and refuses the push if the provider reports itself
  unavailable for this bag's size, a live rate higher than what was assumed,
  or a live span window that no longer covers the chosen span.
- **Self-reported `downloaded` byte count still not a cryptographic proof of
  custody (issue #652, partially mitigated)**: `notify`'s `downloaded` field
  is the provider's own claim — this codebase does not call
  `VerifyStorageADNLProof`/`checkProofBranch` against a merkle proof (a gap
  this doc already noted above, e.g. the masabrain confirmation). Full
  proof-of-custody verification is out of scope for #652 and proposed here
  as separate future work (a real fix would need either (a) a spot-check
  retrieval of a specific piece from the provider independent of its notify
  claim, or (b) wiring up `StorageResponse.Proof`/`VerifyStorageADNLProof`
  from `pkg/transport` against the contract's own merkle root — neither is
  implemented). What #652 DID add, as the minimum available corroboration
  without reimplementing proof verification: `notifyProviderWithRetry()` now
  flags (a) a FIRST-EVER response that already claims the full size with no
  gradual progress ever observed, and (b) a LATER response reporting FEWER
  bytes than a previously reported high-water mark (internally inconsistent
  — a real download cannot un-download bytes) — both as warnings, not
  refusals, since a genuinely fast small-bag transfer is legitimate and
  cannot be told apart from a false claim using self-reported bytes alone.
  The operator-facing "safe to stop the local seed" line also now says
  explicitly that this is a self-report, not a verified proof.
- **Retry-after-timeout can double-fund the same contract (issue #638,
  tracked separately)**: the StorageV1 contract address is deterministic
  from bag metadata + owner, but a retry after an ambiguous broadcast or a
  notify timeout can re-send `amountNano` against the same (already funded)
  address. Being fixed independently — see that issue.

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

## Testnet — the Go lane, end to end (dev-only, not an OSS feature)

**No public testnet registry exists for the Go/StorageV1 scheme** —
mytonprovider.org is a mainnet-only market (`testnet.mytonprovider.org`
does not resolve), so a third party running cypher-brain has no discovery
path to a testnet provider even if one exists. This is why
`push --backend ton-provider` stays mainnet-only in cypher-brain proper:
shipping a testnet code path with zero real-world discoverability behind it
would be dead weight for every OSS user except an operator who, like this
one, already runs their own standing Go provider twin (see below) and wants
to test against it directly. `scripts/go/storage-v1-client` (the same
operator-run CLI already used for the mainnet Go-lane proof above) is
EXPERIMENTAL and explicitly says so in its own `--help` output — that
framing is unchanged by this section; what changed is that it has now also
been exercised against a real testnet provider, not just mainnet.

- 2026-08-23 live experiment (bag `881203e8…`, 71 bytes, seeded from a
  throwaway `tonutils-storage` instance started on the droplet for this
  test — the droplet's testnet Go provider standing twin,
  `tsp-testnet-provider(-storage)`, was already running):
  - `deploy` — first attempt used a throwaway generated wallet as
    `--owner`, distinct from the wallet actually used to sign in Tonkeeper.
    Tonkeeper's own deeplink signing always uses whichever wallet is
    currently selected in the extension, not necessarily the address the
    deeplink assumed as `--owner` — a client-side mismatch, not a protocol
    bug. Result: `modify_providers`' `sender == owner` check failed on-chain
    exactly like the real mainnet incident earlier in this doc (see
    "Mainnet — third-party providers, live Go ecosystem" above) — same root
    cause, reproduced on purpose this time. Re-deployed with `--owner` set
    to the operator's actual signing wallet; landed `active` cleanly.
  - `notify` — first call was refused by the provider (`bounty should be at
    least 0.05 TON to cover fees`): the initial `--rate-nano-per-mb-day`
    was too low for a 71-byte bag to clear the provider's own minimum
    bounty floor. Fixed in place with `update-providers` (same contract,
    same balance, corrected rate) — no re-deploy needed, confirming the
    Phase-A repair path works on testnet too.
  - Re-`notify` succeeded: `resolving` → `active`, `downloaded: 71 bytes`
    (self-reported).
  - Independently verified via the provider's OWN `tonutils-storage` HTTP
    API (not the notify self-report): `completed: true, downloaded: 71/71`,
    with the seeder correctly listed as a peer. Content verified
    byte-identical: `sha256sum` of the file on both the seeder and the
    provider's storage directory matched exactly.
  - Net: the full `deploy` → `notify` → provider-fetch cycle from the
    mainnet Go-lane proof above reproduces on testnet against a real
    (self-run) provider daemon, byte-for-byte verified — with the SAME two
    failure modes (owner mismatch, bounty-too-low) hit and recovered from
    in the process, reinforcing that both are real operational hazards
    worth the guardrails cypher-brain's `push --backend ton-provider`
    already has (the hard owner-mismatch refusal, specifically) rather
    than corner cases.

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
  registry are also self-reported by the same daemon). At registration time,
  no paid contracts had been received yet (expected — registration alone
  doesn't generate demand); it has since processed exactly one, from
  ourselves — see the "Confirmed working end to end" bullet above.
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
- **Two registry-UI fields, both still pending despite a real contract now
  existing (2026-08-23):** `Location` showed "Unknown" and `Status`
  showed "No Data" on mytonprovider.org, unlike established providers
  ("United States (US)", "Stable (100%)"). Source-traced both: `Location` is
  filled by the backend's own `UpdateIPInfo` worker, which only sweeps every
  **240 minutes** — expected to self-resolve, not a config problem (droplet's
  `ExternalIP`/firewall for ADNL udp/18555 were confirmed correctly set).
  `Status` needs at least one real contract to stop being "No Data" (the
  backend's `UpdateStatuses` SQL `LEFT JOIN`s `providers.storage_contracts`,
  so zero contracts means no join row). This section originally deprioritized
  fixing `Status` via a same-droplet self-contract, reasoning that seeder and
  provider sharing one droplet is a single failure domain that adds no real
  redundancy — **that plan changed**: the "pay a live Go provider" lane above
  needed a real end-to-end payment test regardless, and paying our own
  already-registered provider was the lowest-friction way to get one (no
  waiting on a third-party operator's daemon behavior). The self-contract now
  exists (`0:465347a9…`, masabrain, 481 MB) and the provider confirmed the
  full download — but as of the incident's resolution, `status`/`location`
  on the registry are **still `null`**, even after the contract landed and
  `notify` succeeded; whether that's a scan-cycle lag or something else is
  unresolved and being checked separately.
- **Testnet: standing twin, unchanged.** tonutils-storage-provider v0.4.3 +
  its own testnet tonutils-storage, running as transient systemd units on the
  droplet (isolated under `/opt/tsp/testnet-*`, mainnet services untouched);
  provider wallet funded with 2 testnet TON. Original purpose was to separate
  protocol from market within the Go scheme; with live third-party Go
  providers now known and reachable, testing against a real third party
  (see the section above) largely supersedes this twin for that goal — it
  stays standing as a controlled environment.
- **Registration address bug, and a re-registration mistake it caused
  (2026-08-24/25).** The original mainnet registration above (pubkey
  `f5f603c7…`) turned out to have been submitted from the operator's personal
  Tonkeeper wallet rather than the provider's own operating wallet. The
  registry backend's `AddProviders` does `ON CONFLICT DO NOTHING` on
  `public_key`, so simply re-sending a registration tx for that same pubkey
  cannot update the stored `address` — as observed, `status`/`location` stay
  unpopulated for it, since the backend's status/location workers scan the
  registered `address` for activity, not the real provider wallet (whether an
  administrative fix on the backend's side is possible is unknown; not
  pursued here). A second pubkey (`4c9f6003…`), registered correctly this
  time (send from the provider's own wallet), landed on-chain successfully
  but never appeared in `/api/v1/providers/search` after 9+ hours — reported
  as [dearjohndoe/mytonprovider-backend#21](https://github.com/dearjohndoe/mytonprovider-backend/issues/21),
  still unexplained, abandoned as a dead end. A third attempt (pubkey
  `3a7fe754…`) hit a second, unrelated, self-inflicted problem, discovered in
  two steps:
  1. A transaction (`79c7f3f9…`) was initially reported to the same upstream
     issue as a second instance of the backend problem — "sent, landed
     on-chain, still not showing up in the registry." That report was wrong:
     re-deriving the transaction's actual destination showed it wasn't sent
     to the shared registration address (`0:7777…7777`) at all — it was an
     unrelated wallet-to-wallet funding transfer the sender had
     mis-identified as the registration tx. This was corrected in the issue
     thread.
  2. Once the *real* registration transaction for that pubkey was located on
     the shared registration address, it told a different story: it had
     `bounce: true`, and the shared address is deliberately `uninit`
     (no code deployed) — TON's standard behavior for a bounceable message to
     an uninit account is to skip the compute phase and bounce the funds back
     to the sender, so this message never reached the registry at all. This
     explains the third attempt's non-appearance without invoking any
     backend fault.
  **Root cause, confirmed by reading both client implementations**:
  `xssnick/tonutils-go`'s `wallet.SimpleMessage()` hardcodes `Bounce: true` —
  a footgun for exactly this case — whereas the official Python registration
  tool (`igroman787/mytonprovider`, via `pytoniq`) passes the destination as
  a raw `workchain:hex` string, and `pytoniq_core`'s `Address` class only
  sets `is_bounceable = True` when parsing the base64 (user-friendly) form —
  a raw address always leaves it at its `False` default — so the official
  tool sends `bounce=false` without anyone having to think about it.
  Re-sent with `wallet.TransferNoBounce()` (the dedicated non-bounceable
  transfer method); confirmed on-chain (`bounce: false`, `bounced: false`,
  `success: true`). **Operational rule going forward**: any future
  registration send (key rotation, additional provider identities) should
  either use the official `igroman787/mytonprovider` `register` command
  directly, or, if scripted against `tonutils-go`, always use
  `TransferNoBounce` (or an explicit `.Bounce(false)`) — never
  `SimpleMessage` — for a send to the shared registration address.
- **Registry listing needs more than a successful registration tx — a live
  daemon answering the same probe the backend makes (2026-08-25).** After
  pubkey `3a7fe754…` registered successfully on-chain, it still did not
  appear in `/api/v1/providers/search`. Reading
  `dearjohndoe/mytonprovider-backend`'s `pkg/workers/providersMaster/worker.go`
  showed why: `UpdateKnownProviders` polls every known pubkey with the same
  `transport.Client.GetStorageRates` ADNL/RLDP call this repo's own
  `storage-v1-client` uses, and only flips `is_initialized` to `true` on a
  successful response; the search query itself additionally requires
  `rating`/`uptime` populated by separate periodic workers
  (`is_initialized AND rating IS NOT NULL AND uptime IS NOT NULL`). The
  droplet's actual running daemon (`/opt/tsp/config.json`) still had the
  *old* pubkey's `ProviderKey` loaded — the newly-registered pubkeys had no
  daemon answering for them at all, so the backend's probe could never
  succeed. This was **not a backend defect**; it was our own sequencing
  ("register, then switch the daemon" instead of "run the daemon under the
  new identity, then register"). Verified independently from an external
  machine (not the droplet) with a standalone program built against the same
  `xssnick/tonutils-go` + `xssnick/tonutils-storage-provider` libraries the
  backend uses — `GetStorageRates` succeeded for `3a7fe754…` once the daemon
  was actually running under that key, and a positive control against the
  old, known-working pubkey confirmed the test method itself wasn't a false
  positive. The provider appeared in the registry **28 minutes** after daemon
  startup (not the "one day+" first reported — that was a same-day/UTC-date
  mixup, corrected before being acted on). Reported to
  [dearjohndoe/mytonprovider-backend#21](https://github.com/dearjohndoe/mytonprovider-backend/issues/21)
  as a root-cause writeup and closed (no backend fix needed).

- **Parallel canary, not in-place rotation — and a real near-miss found in
  time (2026-08-25).** The safe way to move masabrain onto a corrected
  identity is NOT to overwrite the running provider's config in place: doing
  so risks the live daemon (still actively serving the real `f5f603c7…`
  contract) going dark mid-migration with nothing to fall back to. Instead, a
  second `tonutils-storage-provider` instance was run side by side — separate
  systemd unit (`tsp-canary.service`), separate `config.json`/db directory
  (`/opt/tsp-canary/`), separate UDP port (`18557`, picked only after
  confirming `18556` was already in live use by the unrelated testnet
  experiment twin) — so the old daemon was never touched until the new one
  was independently verified end to end.

  A second, more serious near-miss surfaced at the deploy step itself:
  reusing the *same* bag + *same* owner address as the original masabrain
  contract to "redeploy" for the new provider pubkey produced the **identical
  contract address** — StorageV1's address is `hash(StateInit)`, which for a
  fixed contract code and workchain depends only on
  `(TorrentHash, MerkleHash, DataSize, PieceSize, OwnerAddr)`;
  the provider pubkey isn't part of it at all (it only enters via a separate
  `modify_providers` message body). Signing that deeplink would not have
  deployed an independent canary — `modify_providers` **replaces the entire
  on-chain provider set** with whatever dict is in the message body (verified
  against `xssnick/tonutils-contracts`' `storage-contract.fc`, and consistent
  with this repo's own `update-providers` warning that it "REPLACES the
  entire on-chain provider list"). A single-provider deploy body would have
  silently dropped the old, real, actively-serving provider and swapped in
  the new one in-place — exactly the risky in-place rotation this whole
  exercise was trying to avoid, with real money already moving. Caught before
  signing by asking a second model to check the deeplink's simulated effect
  against the contract source, not by observation alone. Fixed by using a
  **different owner wallet** for the canary deploy, which (correctly)
  produces a distinct contract address — confirmed by offline address
  recomputation before any funds moved.

  A second, unrelated near-miss happened at the signing step: Tonkeeper's
  pre-sign simulation showed the `Call contract` step as `Failed`. Root cause
  was mundane — the wallet actually selected/active in the Tonkeeper app at
  that moment wasn't the new owner wallet the deploy was built for, so the
  contract's `equal_slices(sender_address, owner)` check in
  `modify_providers` would have rejected the call. Re-selecting the correct
  account in Tonkeeper before opening the deeplink again produced a clean
  simulation and a successful send. (The `EQ…`/`UQ…` address prefixes shown
  in that same Tonkeeper screen are not different accounts — they're the
  same raw address in bounceable vs. non-bounceable friendly-address form,
  same 32-byte account ID.)

  Once deployed to the independent contract (`0:ebf4e8cb…`), the full cycle
  was verified end to end before touching the old daemon: `notify` succeeded
  (provider self-reported the full 481 MB bag, corroborated by the seeder's
  own log line acknowledging the same bag as already fully held — no
  separate re-download needed, since provider and seeder share the same
  underlying bag storage on this droplet); a real `proof_storage` →
  `storage_reward_withdrawal` cycle completed on-chain (0.1197 TON payout,
  matching the original contract's payout amount exactly, as expected for an
  identical bag/rate/span); the canary daemon was restarted twice and
  self-recovered cleanly each time (re-discovered the contract, re-verified
  the bag, resumed). Only after all of that — and confirming the old
  contract had no overdue proof obligation at the time — was the old
  provider daemon (`tonutils-storage-provider.service`, pubkey `f5f603c7…`)
  stopped and disabled. Its contract (`0:465347a9…`, ~0.35 TON balance) is
  now orphaned but not unrecoverable: `xssnick/tonutils-storage-provider`'s
  `pkg/contract.PrepareWithdrawalRequest` gives the owner a withdrawal path,
  just not yet wired into this repo's tooling.
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

## Operational inventory (what exists where, as of 2026-08-26)

- Droplet (mainnet, production): `tonutils-storage.service` (seeder, unchanged)
  plus `tsp-canary.service` (provider role, pubkey `3a7fe754…`, udp 18557,
  `/opt/tsp-canary/`) — the live provider identity since the 2026-08-25
  parallel-canary migration (see above). `tonutils-storage-provider.service`
  (the original provider role, pubkey `f5f603c7…`) was stopped and disabled
  the same day and is no longer running; its contract is orphaned (see the
  `storage-v1-client` bullet below). The cypher-brain bag layout lives under
  `~/cypher-brain-ton/`, healthcheck pinned to the live brain bag. The
  provider service is registered in the mytonprovider.org registry (see
  above) — same binary as the seeder, two roles (seeds our bag for free;
  separately, discoverable as a paid provider for others). `tsp-telemetry.service` +
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
- `scripts/go/storage-v1-client` (local, not deployed anywhere — a laptop
  CLI): `deploy`/`notify`/`status`/`update-providers`/`withdraw` (the last
  added 2026-08-26), 44 tests, contract deployment + provider
  discovery/fetch confirmed working end to end, including a confirmed
  proof-reward payout (see above). Its original mainnet contract,
  `0:465347a9b5152bf6f69e1bc47ce82c537aee5ae4e3d00437d4a514f0e9cc452a` —
  masabrain (481 MB), rate 800 nanoTON/MB/day, span 192 days, provider
  pubkey `f5f603c7…` (our own droplet) — was orphaned by the 2026-08-25
  canary migration (~0.42 TON observed 2026-08-23, ~0.35 TON observed at
  the 2026-08-25 migration; this log never established why those two
  differed) and then **drained via `withdraw` on 2026-08-26 09:52:15
  JST (2026-08-26 00:52:15 UTC)** — a `withdraw_owner` (op `0x61fff683`) message
  from the owner wallet (`masashi-ono0611.ton`) landed on-chain, the
  contract answered with `storage_contract_terminated` (op `0xb6236d63`)
  and forwarded `0.397118779 TON` back to that same wallet (tx
  `a683d5b2c5baef3b2ef6f6d26cc6b45eac322bfe171260ab0c0a3ea227d49c61`,
  confirmed directly via `GET tonapi.io/v2/blockchain/accounts/<addr>/transactions`,
  not from this repo's own logs). That withdrawn amount implies a
  pre-withdrawal balance of ~0.402 TON — again not reconciled with the
  ~0.35 TON figure observed the day before; this log has not established
  why the balance apparently rose in the interim (or whether the ~0.35 TON
  figure was simply imprecise). The contract remains on-chain
  (`status: active`, not destroyed) with a residual balance of
  ~0.005 TON — this log has not confirmed whether that is a StorageV1
  protocol-mandated minimum or just what `withdraw_owner` happened to
  leave. The live provider identity
  going forward is the canary contract `0:ebf4e8cb…` deployed under
  pubkey `3a7fe754…` (see above for the migration detail; full
  address/balance not yet recorded in this log).
