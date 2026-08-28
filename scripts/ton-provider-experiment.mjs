#!/usr/bin/env node
// Operator-run, EXPERIMENTAL probe for the TON Storage *provider market* — third
// parties paid (in TON) to retain a bag, as opposed to the `ton` backend's own
// seeder box (src/lib/backends/ton.ts), which is the only retention path the
// shipped CLI actually uses. This script is deliberately NOT a CLI feature and
// changes nothing under src/ — it exists to re-test one fact: ton-mesh-harness's
// docs/provider-contract.md recorded the mainnet provider market as dormant as of
// 2026-05-10 ("the five cheapest providers have never once issued
// accept_storage_contract"). ~110 providers are listed on tonapi now; this script
// re-checks whether any of them actually accept and activate a contract.
//
// Ported (faithfully, with credit) from the sibling project ton-mesh-harness:
//   - src/provider.ts          — fetchProviders, selectCheapestProvider,
//                                 buildOfferStorageContractMessage (incl. its
//                                 max_span uint8-CLI-bug workaround)
//   - scripts/close-storage-contract.cjs — op::close_contract fund-recovery body
//   - src/deeplink.ts          — buildTonkeeperTransferDeeplink / toBase64Url
//   - docs/provider-contract.md — protocol notes, amount formula, dormancy record
//
// Dependency note: `@ton/ton` is added to THIS worktree as a devDependency only,
// for this script's own BOC construction. cypher-brain's shipped runtime
// dependencies (see package.json `dependencies`) are untouched — this repo is
// aggressively minimal by design and that does not change for an experiment.
//
// Honesty gap vs. the reference (see report / --help for detail): the offer
// message needs a bag's TorrentInfo cell + 256-bit microchunk_hash, which in
// ton-mesh-harness come from a RUNNING `storage-daemon-cli` (TON's C++ reference
// daemon) that has the bag loaded. cypher-brain's seeder runs `tonutils-storage`
// (a different, Go implementation) instead, whose HTTP API (src/lib/backends/
// ton-client.ts) exposes no such fields. Rather than reimplement TON's
// MicrochunkTree::Builder (ton-mesh-harness's own docs list this as unfinished
// upstream work), `offer` requires the operator to produce that sample BOC
// out-of-band with storage-daemon-cli and pass it via --sample-boc. This is an
// operational gap, not an invented shortcut.
//
// Similarly, `status` does NOT attempt to derive "did the provider accept this
// contract" from raw account/tx data (that decode is the same class of
// invented-derivation risk) — it reports the on-chain account state tonapi
// already computes (status, balance) and defers acceptance judgement to the
// wallet app or tonviewer, exactly as instructed for this experiment.
//
// Usage:
//   node scripts/ton-provider-experiment.mjs offer --locator ton:v1:<64hex> --sample-boc <path> [--mainnet] [--provider <addr>] [--max-spend-ton 0.5] [--span-days 1] [--size-bytes <n>]
//   node scripts/ton-provider-experiment.mjs status --contract <raw-addr> [--mainnet]
//   node scripts/ton-provider-experiment.mjs close --contract <raw-addr> [--mainnet]
//   node scripts/ton-provider-experiment.mjs --help
//
// THE SCRIPT NEVER TOUCHES A PRIVATE KEY. Every on-chain action it produces is a
// Tonkeeper transfer deeplink (+ raw base64 BOC for other wallets) — signing
// always happens in the operator's own wallet app.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Address, beginCell, Cell, toNano } from '@ton/ton';
import { API_RE, HEX64_RE, assertSafe, sshRun } from './ton-ssh-lib.mjs';

// -----------------------------------------------------------------------
// Constants (ported)
// -----------------------------------------------------------------------

// storage/storage-daemon/smartcont/{storage-provider,constants}.fc — verified
// against ton-blockchain/ton @ v2026.04-1 (ton-mesh-harness src/provider.ts).
const OP_OFFER_STORAGE_CONTRACT = 0x107c49ef;
// storage-contract.fc — verified in the same project, scripts/close-storage-contract.cjs.
const OP_CLOSE_CONTRACT = 0x79f937ea;

const NETWORKS = {
  mainnet: { tonapiUrl: 'https://tonapi.io', tonviewerHost: 'tonviewer.com' },
  testnet: { tonapiUrl: 'https://testnet.tonapi.io', tonviewerHost: 'testnet.tonviewer.com' },
};

// S3: testnet.tonviewer.com when not --mainnet — tonviewer, like tonapi, has a
// separate testnet host; using the mainnet one for a testnet address 404s.
function tonviewerHost(testnet) {
  return NETWORKS[testnet ? 'testnet' : 'mainnet'].tonviewerHost;
}
function tonviewerUrl(addr, testnet) {
  return `https://${tonviewerHost(testnet)}/${addr}`;
}

// W3: status --watch polling.
const STATUS_WATCH_INTERVAL_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ton-mesh-harness src/provider.ts: dummy registry entries have rate 0/1; a
// hardcoded upper bound flags scam entries. Same numbers, same rationale.
const MIN_REASONABLE_RATE_NANO_PER_MB_DAY = 10;
const MAX_REASONABLE_RATE_NANO_PER_MB_DAY = 10_000;
const MIN_REASONABLE_MAX_SPAN_SECONDS = 3600;

// docs/provider-contract.md "Amount calculation": 0.3 TON buffer covers contract
// deployment gas regardless of bag size.
const DEPLOY_BUFFER_NANO = 300_000_000n;
// docs/provider-contract.md "Fund recovery": 0.05 TON gas for op::close_contract;
// the contract's stash (>= the 0.3 TON buffer) comes back with it.
const CLOSE_GAS_NANO = toNano('0.05');

const HTTP_TIMEOUT_MS = 10_000;
const LOCATOR_RE = /^ton:v1:([0-9a-f]{64})$/;
// Raw TON address form (workchain:hex256) — used to validate an operator-
// supplied --provider address when it bypasses the tonapi index (see
// --provider-rate / --provider-span below).
// Workchains in practice are 0 (base) and -1 (masterchain) — reject anything
// else instead of validating mere syntax (Codex review S3).
const RAW_ADDR_RE = /^(?:0|-1):[0-9a-fA-F]{64}$/;
const UINT32_MAX = 0xffff_ffff;

const HELP = `ton-provider-experiment — operator-run probe of the TON Storage provider market

This is an EXPERIMENT, not a CLI feature. It never touches a private key: every
on-chain action prints a Tonkeeper transfer deeplink for YOU to review and sign.

Usage:
  node scripts/ton-provider-experiment.mjs offer --locator ton:v1:<64hex> --sample-boc <path> [options]
  node scripts/ton-provider-experiment.mjs status --contract <raw-addr> [--mainnet] [--watch <seconds>]
  node scripts/ton-provider-experiment.mjs close --contract <raw-addr> [--mainnet]
  node scripts/ton-provider-experiment.mjs --help

offer options:
  --locator <ton:v1:hex>   required. The bag's cypher-brain ton locator.
  --sample-boc <path>      required. See "sample BOC" below.
  --allow-unverified-boc   required alongside --sample-boc — see "sample BOC" below.
  --mainnet                opt in to mainnet (REAL FUNDS). Default: testnet.
  --provider <raw-addr>    use this provider instead of auto-selecting cheapest.
                            By default it must appear in tonapi's provider index
                            (exit 2 if not — e.g. your own never-deployed provider
                            is not indexed). Pass --provider-rate AND
                            --provider-span together to bypass the index lookup
                            entirely and build the offer straight against this
                            address with those operator-supplied values.
  --provider-rate <int>    nanoTON/MB/day for the address named by --provider.
                            Requires --provider-span too. See --provider above.
  --provider-span <int>    seconds — that provider's own max_span capacity, used
                            only to sanity-check --span-days fits under it (the
                            offered span is still --span-days). Requires
                            --provider-rate too. See --provider above.
  --max-spend-ton <float>  refuse (exit 2) if the offer would cost more. Default 0.5.
                            Compared as nanoTON (BigInt), never as a float.
  --span-days <int>        contract duration in days. Default 1. Providers whose
                            max_span is shorter than this are filtered out before
                            cheapest-selection (not just checked afterward).
  --size-bytes <n>         bag size override — skips the seeder lookup (needed
                            for a bag not tracked by CYPHER_BRAIN_TON_SSH_HOST).
                            Strict ^[0-9]+$, must be a safe integer.

status: queries tonapi for the contract's on-chain account state. Informational
only — always exits 0. It does NOT decode whether a provider accepted the
contract; check the wallet app or tonviewer for that.
  --watch <seconds>  keep polling every 30s until this many seconds have
                     elapsed, printing each poll and any status transition.
                     Default: unset — a single one-shot check.

close: builds the op::close_contract (0x79f937ea) fund-recovery message for a
contract stuck without an accept_storage_contract. Fetches the account state
first and refuses (exit 2) if it is 'nonexist' (no funds present to recover).
Signing does NOT guarantee funds return — only a real storage-provider contract
you funded, that still honors op::close_contract, will actually send them back;
this script cannot check the account's code hash against a known one (none is
pinned anywhere in the ported reference), so verify on tonviewer first.

sample BOC (offer only): this experiment cannot compute a bag's TorrentInfo +
microchunk_hash itself — that requires a RUNNING storage-daemon-cli (TON's C++
reference daemon, not the tonutils-storage this repo's seeder runs) with the
bag loaded. Produce one out-of-band and pass its path via --sample-boc:
  storage-daemon-cli ... -c "new-contract-message <bagId> <outFile> --rate 1 --max-span 200"
(rate/span here are throwaway sample values — see ton-mesh-harness
docs/provider-contract.md "self-generated contract message BOC".) The bag id is
the locator's 64-hex suffix.

  --sample-boc <-> --locator binding is UNVERIFIED: the reference material does
  not precisely confirm that a bag id equals a specific hash of the extracted
  TorrentInfo cell (cypher-brain's src/lib/backends/ton.ts says "the bag id is
  the torrent's merkle root"; ton-mesh-harness's docs/v0.9/provenance.md:37 says
  "bag_id is the content hash of the bag" — neither pins the exact TL-B
  structure hashed). This script refuses (exit 2) to silently assume they mean
  the same thing and gate money on it; pass --allow-unverified-boc, after
  manually confirming you generated --sample-boc for this exact bag id, to
  proceed. The extracted TorrentInfo cell's own hash is printed either way so
  you can cross-check by hand.

Env (offer, only when --size-bytes is not given — mirrors ton-dogfood.mjs):
  CYPHER_BRAIN_TON_SSH_HOST   (required) user@host of the seeder
  CYPHER_BRAIN_TON_SSH_KEY    (optional) -i identity file for ssh
  CYPHER_BRAIN_TON_REMOTE_API (optional) tonutils-storage API addr on the seeder,
                               default 127.0.0.1:9955
`;

// -----------------------------------------------------------------------
// Remote-command safety: HOST_RE/API_RE/HEX64_RE, assertSafe(), sshBaseArgs(),
// sshRun() live in scripts/ton-ssh-lib.mjs, shared with scripts/ton-dogfood.mjs
// (see that file's comment for why, #604) — itself mirroring the allowlist in
// src/lib/backends/ton.ts: every value interpolated into a REMOTE shell
// command line must pass a narrow allowlist first.
// -----------------------------------------------------------------------

// Bag size, read from the seeder's OWN tonutils-storage — the same daemon our
// `ton` backend already talks to for push/pull (src/lib/backends/ton-client.ts:
// TonBagDetails.size). Not a local storage-daemon-cli call: cypher-brain's seeder
// never runs that binary (see header "Honesty gap").
function getBagSizeBytesFromSeeder(bagId) {
  const api = assertSafe(
    process.env.CYPHER_BRAIN_TON_REMOTE_API || '127.0.0.1:9955',
    'CYPHER_BRAIN_TON_REMOTE_API',
    API_RE,
  );
  const safeBag = assertSafe(bagId, 'bag id', HEX64_RE);
  const out = sshRun(`curl -sS --fail -m 30 'http://${api}/api/v1/details?bag_id=${safeBag}'`, 60_000);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`seeder /api/v1/details returned non-JSON for bag ${safeBag}: ${out.slice(0, 200)}`);
  }
  if (parsed && typeof parsed.error === 'string') {
    throw new Error(`seeder /api/v1/details failed for bag ${safeBag}: ${parsed.error}`);
  }
  const size = Number(parsed?.size);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(
      `seeder returned no positive size for bag ${safeBag} — is it actually seeded there? Pass --size-bytes to override.`,
    );
  }
  return size;
}

// -----------------------------------------------------------------------
// Provider discovery (ported from ton-mesh-harness src/provider.ts)
// -----------------------------------------------------------------------

async function fetchJson(url, timeoutMs = HTTP_TIMEOUT_MS) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`GET ${url} -> HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

// Returns ALL registered providers (unfiltered) — callers apply the eligibility
// filter themselves so `--provider <addr>` can still target an address tonapi
// lists but which is not currently accept_new_contracts (useful for the probe:
// we want to SEE dormancy, not have it filtered away silently).
async function fetchAllProviders(testnet) {
  const url = `${NETWORKS[testnet ? 'testnet' : 'mainnet'].tonapiUrl}/v2/storage/providers`;
  const data = await fetchJson(url);
  return (data.providers ?? []).map((p) => ({
    address: p.address,
    acceptNewContracts: !!p.accept_new_contracts,
    ratePerMbDay: p.rate_per_mb_day,
    maxSpan: p.max_span,
    minimalFileSize: p.minimal_file_size,
    maximalFileSize: p.maximal_file_size,
  }));
}

// S1: filter by the REQUESTED span (not just the sanity floor) before cheapest-
// selection runs, so auto-select never hands back a provider that would then
// fail the post-selection span check below.
function eligibleProviders(all, sizeBytes, spanSeconds) {
  const minSpan = Math.max(MIN_REASONABLE_MAX_SPAN_SECONDS, spanSeconds);
  return all
    .filter(
      (p) =>
        p.acceptNewContracts &&
        p.ratePerMbDay > MIN_REASONABLE_RATE_NANO_PER_MB_DAY &&
        p.ratePerMbDay <= MAX_REASONABLE_RATE_NANO_PER_MB_DAY &&
        p.maxSpan >= minSpan,
    )
    .filter((p) => sizeBytes >= p.minimalFileSize && sizeBytes <= p.maximalFileSize)
    .sort((a, b) => a.ratePerMbDay - b.ratePerMbDay);
}

function selectCheapestProvider(providers) {
  if (providers.length === 0) {
    throw new Error('no eligible storage providers found');
  }
  return providers[0];
}

function storageCostNano(sizeBytes, ratePerMbDay, spanDays) {
  const sizeMb = Math.max(sizeBytes / 1_000_000, 0.1); // docs/provider-contract.md floor
  return BigInt(Math.ceil(sizeMb * ratePerMbDay * spanDays));
}

// -----------------------------------------------------------------------
// Offer-storage-contract message BOC (ported from ton-mesh-harness
// src/provider.ts buildOfferStorageContractMessage — including its workaround
// for storage-daemon-cli's --max-span uint8 parser bug, storage-daemon-
// storage-daemon-cli.cpp:681: the on-chain contract takes uint32, so this repo
// re-emits the BOC itself instead of trusting the CLI's own span argument).
// -----------------------------------------------------------------------

function buildOfferStorageContractMessage({
  queryId,
  torrentInfo,
  microchunkHash,
  expectedRateNanoPerMbDay,
  expectedMaxSpanSeconds,
}) {
  if (microchunkHash.length !== 32) {
    throw new Error(`microchunkHash must be 32 bytes (got ${microchunkHash.length})`);
  }
  if (!Number.isInteger(expectedMaxSpanSeconds) || expectedMaxSpanSeconds < 1) {
    throw new Error(`expectedMaxSpanSeconds must be a positive integer (got ${expectedMaxSpanSeconds})`);
  }
  if (expectedMaxSpanSeconds > 0xffff_ffff) {
    throw new Error(`expectedMaxSpanSeconds exceeds uint32 max (got ${expectedMaxSpanSeconds})`);
  }
  if (queryId < 0n || queryId > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`queryId out of uint64 range (got ${queryId})`);
  }
  if (expectedRateNanoPerMbDay < 0n) {
    throw new Error(`expectedRateNanoPerMbDay must be non-negative (got ${expectedRateNanoPerMbDay})`);
  }
  const microchunkBig = BigInt(`0x${microchunkHash.toString('hex')}`);
  return beginCell()
    .storeUint(OP_OFFER_STORAGE_CONTRACT, 32)
    .storeUint(queryId, 64)
    .storeRef(torrentInfo)
    .storeUint(microchunkBig, 256)
    .storeCoins(expectedRateNanoPerMbDay)
    .storeUint(expectedMaxSpanSeconds, 32)
    .endCell();
}

// Extract TorrentInfo + microchunk_hash from an operator-supplied sample BOC
// (see --sample-boc / HELP "sample BOC"). Mirrors generateContractMessage's
// "Step 2" parse in src/provider.ts.
function extractFromSampleBoc(path) {
  const bytes = readFileSync(path);
  const cell = Cell.fromBoc(bytes)[0];
  const slice = cell.beginParse();
  const op = slice.loadUint(32);
  if (op !== OP_OFFER_STORAGE_CONTRACT) {
    throw new Error(
      `--sample-boc has opcode 0x${op.toString(16)}, expected 0x107c49ef (offer_storage_contract) — ` +
        `was this produced by 'storage-daemon-cli new-contract-message'?`,
    );
  }
  slice.loadUintBig(64); // queryId — discarded, we mint our own below
  if (cell.refs.length !== 1) {
    throw new Error(`--sample-boc: expected 1 ref (TorrentInfo), got ${cell.refs.length}`);
  }
  const torrentInfo = cell.refs[0];
  const microchunkBig = slice.loadUintBig(256);
  const microchunkHash = Buffer.from(microchunkBig.toString(16).padStart(64, '0'), 'hex');
  return { torrentInfo, microchunkHash };
}

// -----------------------------------------------------------------------
// Tonkeeper transfer deeplink (ported from ton-mesh-harness src/deeplink.ts)
// -----------------------------------------------------------------------

const TONKEEPER_TRANSFER_BASE = 'https://app.tonkeeper.com/transfer';

function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildTonkeeperTransferDeeplink({ to, amountNano, body, testnet }) {
  if (amountNano <= 0n) {
    throw new Error(`Transfer amount must be positive (got ${amountNano})`);
  }
  const addr = to.toString({ urlSafe: true, bounceable: true, testOnly: !!testnet });
  const bin = toBase64Url(body.toBoc());
  const params = new URLSearchParams({ amount: amountNano.toString(), bin });
  return `${TONKEEPER_TRANSFER_BASE}/${addr}?${params.toString()}`;
}

// -----------------------------------------------------------------------
// Account state (status / close) — W5: tonapi's `status` field distinguishes
// three states this script must not conflate:
//   nonexist — no funds present, contract code never ran (nothing to recover)
//   uninit   — funded but not yet deployed (the normal state right after an
//              offer lands, before the provider/anyone runs the contract code)
//   active   — deployed, contract code is running
//   frozen   — was deployed, suspended (e.g. out of storage-fee balance)
// -----------------------------------------------------------------------

function stateVerdict(status) {
  switch (status) {
    case 'nonexist':
      return 'NOT deployed — no funds present at this address';
    case 'uninit':
      return 'NOT deployed — funded but contract code has not run yet (normal right after an offer lands, before deploy)';
    case 'active':
      return 'deployed — contract code is running';
    case 'frozen':
      return 'frozen — was deployed, now suspended (e.g. out of storage-fee balance); funds may still be recoverable';
    default:
      return `<unrecognized tonapi status '${status}'>`;
  }
}

async function fetchAccountState(addr, testnet) {
  const url = `${NETWORKS[testnet ? 'testnet' : 'mainnet'].tonapiUrl}/v2/blockchain/accounts/${addr}`;
  return fetchJson(url);
}

function printAccountState(acc) {
  console.log(`  status:            ${acc.status ?? '<unknown>'}`);
  console.log(`  verdict:           ${stateVerdict(acc.status)}`);
  console.log(`  balance:           ${(Number(acc.balance ?? 0) / 1e9).toFixed(6)} TON (${acc.balance ?? 0} nanoTON)`);
  console.log(`  last_transaction:  lt=${acc.last_transaction_lt ?? '<none>'}`);
}

// -----------------------------------------------------------------------
// Arg parsing (deliberately manual — same house style as ton-dogfood.mjs)
// -----------------------------------------------------------------------

function parseFlags(args, { valued, boolean }) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (boolean.has(a)) {
      out[a] = true;
    } else if (valued.has(a)) {
      const v = args[i + 1];
      if (v === undefined) throw new Error(`${a} requires a value`);
      out[a] = v;
      i++;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function mainnetWarning(amountLabel) {
  console.log('');
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.log('!! MAINNET MODE — REAL TON, REAL MONEY. NO --mainnet ROLLBACK.             !!');
  console.log(`${`!! ${amountLabel}`.padEnd(78)}!!`);
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.log('');
}

// -----------------------------------------------------------------------
// offer
// -----------------------------------------------------------------------

async function cmdOffer(args) {
  const flags = parseFlags(args, {
    valued: new Set([
      '--locator',
      '--provider',
      '--provider-rate',
      '--provider-span',
      '--max-spend-ton',
      '--span-days',
      '--size-bytes',
      '--sample-boc',
    ]),
    boolean: new Set(['--mainnet', '--allow-unverified-boc']),
  });
  const testnet = !flags['--mainnet'];
  const locator = flags['--locator'];
  if (!locator) throw new Error('offer requires --locator ton:v1:<64hex>');
  const m = LOCATOR_RE.exec(locator);
  if (!m) throw new Error(`--locator does not match ^ton:v1:[0-9a-f]{64}$: ${JSON.stringify(locator)}`);
  const bagId = m[1];

  // Explicit-provider bypass: --provider named together with BOTH
  // --provider-rate and --provider-span skips the tonapi index lookup
  // entirely, so an operator can offer to a provider tonapi has never indexed
  // (e.g. their own, never-deployed one — see header "chicken-egg", measured
  // 2026-08-23). Only one of the pair is a mistake, not a fallback signal, so
  // it is refused rather than silently falling back to the index lookup.
  // Validated here, offline, before the --sample-boc gate below.
  const providerRateRaw = flags['--provider-rate'];
  const providerSpanRaw = flags['--provider-span'];
  // Codex review W4: these two are meaningless without --provider — accepting
  // and ignoring them would let a typo'd invocation look like it took effect.
  if (flags['--provider'] === undefined && (providerRateRaw !== undefined || providerSpanRaw !== undefined)) {
    throw new Error(
      '--provider-rate/--provider-span only make sense together with --provider <addr> — refusing to ignore them',
    );
  }
  if (flags['--provider'] !== undefined && (providerRateRaw !== undefined) !== (providerSpanRaw !== undefined)) {
    throw new Error(
      `--provider-rate and --provider-span must be given together (or neither) — missing ` +
        `${providerRateRaw === undefined ? '--provider-rate' : '--provider-span'}`,
    );
  }
  const bypassIndex =
    flags['--provider'] !== undefined && providerRateRaw !== undefined && providerSpanRaw !== undefined;
  let bypassSelected;
  if (bypassIndex) {
    if (!RAW_ADDR_RE.test(flags['--provider'])) {
      throw new Error(
        `--provider must be a raw TON address (workchain 0 or -1) matching ^(0|-1):[0-9a-fA-F]{64}$, got ${JSON.stringify(flags['--provider'])}`,
      );
    }
    if (!/^[0-9]+$/.test(providerRateRaw)) {
      throw new Error(`--provider-rate must match ^[0-9]+$ (nanoTON/MB/day), got ${JSON.stringify(providerRateRaw)}`);
    }
    const providerRate = Number(providerRateRaw);
    if (
      !Number.isSafeInteger(providerRate) ||
      providerRate <= MIN_REASONABLE_RATE_NANO_PER_MB_DAY ||
      providerRate > MAX_REASONABLE_RATE_NANO_PER_MB_DAY
    ) {
      throw new Error(
        `--provider-rate must be a safe integer in (${MIN_REASONABLE_RATE_NANO_PER_MB_DAY}, ` +
          `${MAX_REASONABLE_RATE_NANO_PER_MB_DAY}] nanoTON/MB/day, got ${providerRateRaw}`,
      );
    }
    if (!/^[0-9]+$/.test(providerSpanRaw)) {
      throw new Error(`--provider-span must match ^[0-9]+$ (seconds), got ${JSON.stringify(providerSpanRaw)}`);
    }
    const providerSpan = Number(providerSpanRaw);
    if (
      !Number.isSafeInteger(providerSpan) ||
      providerSpan < MIN_REASONABLE_MAX_SPAN_SECONDS ||
      providerSpan > UINT32_MAX
    ) {
      throw new Error(
        `--provider-span must be a safe integer in [${MIN_REASONABLE_MAX_SPAN_SECONDS}, ${UINT32_MAX}] seconds, ` +
          `got ${providerSpanRaw}`,
      );
    }
    console.log(
      '[bypass] --provider-rate/--provider-span given — skipping the tonapi provider index lookup; rates came ' +
        'from the operator, not the index.',
    );
    bypassSelected = {
      address: flags['--provider'],
      ratePerMbDay: providerRate,
      maxSpan: providerSpan,
      minimalFileSize: 0,
      maximalFileSize: 0,
    };
  }

  if (!flags['--sample-boc']) {
    console.error('offer: missing --sample-boc — this experiment cannot derive TorrentInfo/microchunk_hash itself.');
    console.error('See --help "sample BOC" for the exact storage-daemon-cli command to produce one.');
    process.exit(2);
  }

  // W2: extract early and check the (unverifiable) binding to --locator BEFORE
  // any network calls — see --help "sample BOC" for the exact citations that
  // decided this is a warn+opt-in gate, not an automatic REFUSE-on-mismatch.
  // The reference material does not pin the exact hash equality precisely
  // enough for this script to compute a "correct" answer and gate money on it.
  const { torrentInfo, microchunkHash } = extractFromSampleBoc(flags['--sample-boc']);
  const torrentInfoHashHex = torrentInfo.hash().toString('hex');
  if (!flags['--allow-unverified-boc']) {
    console.error('');
    console.error('offer: REFUSING — the --sample-boc <-> --locator binding is unverified (see --help "sample BOC").');
    console.error(`  --locator bag id:              ${bagId}`);
    console.error(`  --sample-boc TorrentInfo hash: ${torrentInfoHashHex}`);
    console.error('Pass --allow-unverified-boc, after manually confirming --sample-boc was generated for this');
    console.error('exact bag id, to proceed.');
    process.exit(2);
  }
  console.log('[WARN] --allow-unverified-boc set — proceeding without an automatic --sample-boc <-> --locator check.');
  console.log(`  --locator bag id:              ${bagId}`);
  console.log(`  --sample-boc TorrentInfo hash: ${torrentInfoHashHex}  (compare manually if unsure)`);

  // W1: parse straight to nanoTON as a BigInt — the money guard below never
  // routes through Number. Number is used only for display formatting.
  const maxSpendTonRaw = flags['--max-spend-ton'] !== undefined ? flags['--max-spend-ton'] : '0.5';
  if (!/^\d+(\.\d+)?$/.test(maxSpendTonRaw)) {
    throw new Error(`--max-spend-ton must be a positive decimal number, got ${JSON.stringify(maxSpendTonRaw)}`);
  }
  let maxSpendNano;
  try {
    maxSpendNano = toNano(maxSpendTonRaw);
  } catch (e) {
    throw new Error(`--max-spend-ton is not a valid TON amount: ${e.message}`);
  }
  if (maxSpendNano <= 0n) throw new Error(`--max-spend-ton must be positive, got ${maxSpendTonRaw}`);

  const spanDays = flags['--span-days'] !== undefined ? Number(flags['--span-days']) : 1;
  if (!Number.isInteger(spanDays) || spanDays < 1)
    throw new Error(`--span-days must be a positive integer, got ${flags['--span-days']}`);
  const spanSeconds = spanDays * 86_400;

  if (flags['--mainnet']) mainnetWarning(`This offer will lock up to ${maxSpendTonRaw} TON on MAINNET.`);

  let sizeBytes;
  if (flags['--size-bytes'] !== undefined) {
    // S2: strict digits-only — rejects floats, hex, scientific notation, signs.
    if (!/^[0-9]+$/.test(flags['--size-bytes'])) {
      throw new Error(`--size-bytes must match ^[0-9]+$, got ${JSON.stringify(flags['--size-bytes'])}`);
    }
    sizeBytes = Number(flags['--size-bytes']);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new Error(`--size-bytes must be a positive safe integer, got ${flags['--size-bytes']}`);
    }
  } else {
    if (!process.env.CYPHER_BRAIN_TON_SSH_HOST) {
      console.error(
        'offer: missing required env CYPHER_BRAIN_TON_SSH_HOST (or pass --size-bytes to skip the seeder lookup).',
      );
      console.error(`  CYPHER_BRAIN_TON_SSH_HOST   = ${process.env.CYPHER_BRAIN_TON_SSH_HOST ?? '<unset>'}`);
      console.error(`  CYPHER_BRAIN_TON_SSH_KEY    = ${process.env.CYPHER_BRAIN_TON_SSH_KEY ?? '<unset>'}`);
      console.error(`  CYPHER_BRAIN_TON_REMOTE_API = ${process.env.CYPHER_BRAIN_TON_REMOTE_API ?? '<unset>'}`);
      process.exit(2);
    }
    console.log(`resolving bag size for ${bagId} from the seeder ...`);
    sizeBytes = getBagSizeBytesFromSeeder(bagId);
  }
  console.log(`bag size: ${sizeBytes} bytes`);

  let selected;
  if (bypassIndex) {
    // Validated above (offline, before the --sample-boc gate); bypassSelected
    // does not depend on sizeBytes so it was built there.
    selected = bypassSelected;
  } else {
    console.log(`fetching providers (${testnet ? 'testnet' : 'mainnet'}) ...`);
    const all = await fetchAllProviders(testnet);
    // S1: eligibility now also requires max_span >= the REQUESTED span, so
    // cheapest-selection never picks a provider the later span check rejects.
    const eligible = eligibleProviders(all, sizeBytes, spanSeconds);
    console.log(
      `tonapi lists ${all.length} providers total; ${eligible.length} accept new contracts, fit this bag's size, ` +
        `and support a >= ${spanDays}-day span.`,
    );

    console.log('');
    console.log('address                                            rate(nano/MB/day)  max_span(s)  cost-this-bag');
    for (const p of eligible.slice(0, 10)) {
      const cost = storageCostNano(sizeBytes, p.ratePerMbDay, spanDays);
      console.log(
        `${p.address.padEnd(50)} ${String(p.ratePerMbDay).padStart(17)}  ${String(p.maxSpan).padStart(11)}  ${(Number(cost) / 1e9).toFixed(6)} TON`,
      );
    }
    console.log('');

    if (eligible.length === 0) {
      // W4: this reflects THIS run's filter result only — not a dormancy verdict.
      // Whether that means "the market is dormant" is for the operator/report to
      // judge, with more than one data point.
      console.log(
        `no providers currently pass this run's filters (accept_new_contracts, this bag's size range, a ` +
          `>= ${spanDays}-day max_span) on ${testnet ? 'testnet' : 'mainnet'}, as listed by tonapi right now.`,
      );
      process.exit(3);
    }

    if (flags['--provider']) {
      selected = all.find((p) => p.address === flags['--provider']);
      if (!selected) {
        throw new Error(
          `--provider ${flags['--provider']} was not found in tonapi's provider list at all — if this is your ` +
            `own provider (not yet indexed), pass --provider-rate and --provider-span to bypass the index lookup.`,
        );
      }
      if (!eligible.includes(selected)) {
        console.log(
          `[WARN] --provider ${selected.address} is not in the eligible/accepting list above — proceeding anyway, at your own risk.`,
        );
      }
    } else {
      selected = selectCheapestProvider(eligible);
    }
  }
  console.log(
    `selected provider: ${selected.address} (${selected.ratePerMbDay} nanoTON/MB/day, max_span ${selected.maxSpan}s)`,
  );

  // Defense in depth for the --provider override path (S1 already filters the
  // auto-select path, but an explicit --provider can still name an ineligible one).
  if (selected.maxSpan > 0 && spanSeconds > selected.maxSpan) {
    throw new Error(`--span-days ${spanDays} (${spanSeconds}s) exceeds provider's max_span (${selected.maxSpan}s)`);
  }
  if (selected.minimalFileSize > 0 && sizeBytes < selected.minimalFileSize) {
    throw new Error(`bag is ${sizeBytes} bytes; provider requires >= ${selected.minimalFileSize} bytes`);
  }
  if (selected.maximalFileSize > 0 && sizeBytes > selected.maximalFileSize) {
    throw new Error(`bag is ${sizeBytes} bytes; provider accepts <= ${selected.maximalFileSize} bytes`);
  }

  const cost = storageCostNano(sizeBytes, selected.ratePerMbDay, spanDays);
  const amountNano = cost + DEPLOY_BUFFER_NANO;
  console.log(
    `storage cost: ${(Number(cost) / 1e9).toFixed(6)} TON + ${(Number(DEPLOY_BUFFER_NANO) / 1e9).toFixed(1)} TON deploy buffer = ${(Number(amountNano) / 1e9).toFixed(6)} TON`,
  );

  // W1: BigInt-to-BigInt comparison — the actual guard never touches Number.
  if (amountNano > maxSpendNano) {
    console.error(
      `offer: computed amount ${(Number(amountNano) / 1e9).toFixed(6)} TON (${amountNano} nanoTON) exceeds ` +
        `--max-spend-ton ${maxSpendTonRaw} TON (${maxSpendNano} nanoTON) — refusing to build the offer.`,
    );
    process.exit(2);
  }

  const queryId = (BigInt(Date.now()) << 16n) | BigInt(randomBytes(2).readUInt16BE(0));
  const cell = buildOfferStorageContractMessage({
    queryId,
    torrentInfo,
    microchunkHash,
    expectedRateNanoPerMbDay: BigInt(selected.ratePerMbDay),
    expectedMaxSpanSeconds: spanSeconds,
  });
  const bocBase64 = cell.toBoc({ idx: false, crc32: false }).toString('base64');

  if (flags['--mainnet']) mainnetWarning(`Amount: ${(Number(amountNano) / 1e9).toFixed(6)} TON -> ${selected.address}`);

  const deeplink = buildTonkeeperTransferDeeplink({
    to: Address.parse(selected.address),
    amountNano,
    body: cell,
    testnet,
  });

  console.log('== offer ==');
  console.log(`  network:      ${testnet ? 'testnet' : 'MAINNET'}`);
  console.log(`  provider:     ${selected.address}`);
  console.log(`  amount:       ${(Number(amountNano) / 1e9).toFixed(6)} TON (${amountNano} nanoTON)`);
  console.log(`  span:         ${spanSeconds}s (${spanDays} day(s))`);
  console.log(`  deeplink:     ${deeplink}`);
  console.log(`  raw BOC (b64): ${bocBase64}`);
  console.log('');
  console.log('Review the amount + recipient in your wallet BEFORE approving.');
  console.log('After signing, find the resulting storage-contract address in your wallet');
  console.log(`history or on https://${tonviewerHost(testnet)} (this script does not derive it — see --help),`);
  console.log('then check it with:');
  console.log(
    `  node scripts/ton-provider-experiment.mjs status --contract <addr>${flags['--mainnet'] ? ' --mainnet' : ''}`,
  );
}

// -----------------------------------------------------------------------
// status
// -----------------------------------------------------------------------

async function cmdStatus(args) {
  const flags = parseFlags(args, { valued: new Set(['--contract', '--watch']), boolean: new Set(['--mainnet']) });
  const testnet = !flags['--mainnet'];
  if (!flags['--contract']) throw new Error('status requires --contract <raw-addr>');
  const addr = flags['--contract'];

  // W3: bounded poll loop, default off (single-shot, same as before this flag existed).
  let watchSeconds = 0;
  if (flags['--watch'] !== undefined) {
    if (!/^[0-9]+$/.test(flags['--watch'])) {
      throw new Error(`--watch must be a positive integer (seconds), got ${JSON.stringify(flags['--watch'])}`);
    }
    watchSeconds = Number(flags['--watch']);
    if (!Number.isSafeInteger(watchSeconds) || watchSeconds <= 0) {
      throw new Error(`--watch must be a positive integer (seconds), got ${JSON.stringify(flags['--watch'])}`);
    }
  }

  console.log(`== status: ${addr} (${testnet ? 'testnet' : 'mainnet'}) ==`);
  const startedAt = Date.now();
  const deadline = startedAt + watchSeconds * 1000; // explicit deadline, not an open-ended loop
  let lastStatus;
  for (;;) {
    try {
      const acc = await fetchAccountState(addr, testnet);
      if (lastStatus !== undefined && acc.status !== lastStatus) {
        console.log(`  [TRANSITION] ${lastStatus} -> ${acc.status}`);
      }
      printAccountState(acc);
      lastStatus = acc.status;
    } catch (e) {
      console.log(`  [BLOCKED] could not fetch account state from tonapi: ${e.message}`);
    }
    if (watchSeconds === 0) break;
    const now = Date.now();
    const remainingMs = deadline - now;
    if (remainingMs <= 0) {
      console.log(`  [watch] deadline reached after ${Math.round((now - startedAt) / 1000)}s — stopping.`);
      break;
    }
    const waitMs = Math.min(STATUS_WATCH_INTERVAL_MS, remainingMs);
    console.log(`  [watch] next poll in ${Math.round(waitMs / 1000)}s (${Math.round(remainingMs / 1000)}s left) ...`);
    await sleep(waitMs);
  }

  console.log('');
  console.log('This does NOT decode whether a provider issued accept_storage_contract —');
  console.log(`check your wallet's activity, or ${tonviewerUrl(addr, testnet)}, for that.`);
  // Informational subcommand — always exits 0 per spec.
}

// -----------------------------------------------------------------------
// close
// -----------------------------------------------------------------------

async function cmdClose(args) {
  const flags = parseFlags(args, { valued: new Set(['--contract']), boolean: new Set(['--mainnet']) });
  const testnet = !flags['--mainnet'];
  if (!flags['--contract']) throw new Error('close requires --contract <raw-addr>');
  const addrStr = flags['--contract'];
  const addr = Address.parse(addrStr);

  // W6: check the account before ever offering a deeplink — a nonexist address
  // has no funds to recover at all, and anything short of `active` means this
  // may not be a deployed storage-provider contract yet.
  console.log(
    `checking account state for ${addrStr} (${testnet ? 'testnet' : 'mainnet'}) before building close_contract ...`,
  );
  let acc;
  try {
    acc = await fetchAccountState(addrStr, testnet);
  } catch (e) {
    console.error(
      `close: could not fetch account state from tonapi — refusing to build a deeplink blind: ${e.message}`,
    );
    process.exit(2);
  }
  console.log(`  status: ${acc.status ?? '<unknown>'} — ${stateVerdict(acc.status)}`);
  if (acc.status === 'nonexist') {
    console.error(
      `close: refusing — ${addrStr} is nonexist on ${testnet ? 'testnet' : 'mainnet'} (no funds present to recover).`,
    );
    process.exit(2);
  }
  if (acc.status !== 'active') {
    console.log(
      `[WARN] account status is '${acc.status}', not 'active' — this may not be (yet) a deployed storage-provider contract.`,
    );
  }
  console.log(
    `[WARN] this script cannot check the account's code against a known storage-provider contract code hash ` +
      `(none is pinned in the ported reference) — verify on ${tonviewerUrl(addrStr, testnet)} before signing.`,
  );

  if (flags['--mainnet']) mainnetWarning(`Amount: ${(Number(CLOSE_GAS_NANO) / 1e9).toFixed(2)} TON gas -> ${addrStr}`);

  const body = beginCell().storeUint(OP_CLOSE_CONTRACT, 32).storeUint(0n, 64).endCell();
  const bocBase64 = body.toBoc({ idx: false, crc32: false }).toString('base64');
  const deeplink = buildTonkeeperTransferDeeplink({ to: addr, amountNano: CLOSE_GAS_NANO, body, testnet });

  console.log('');
  console.log('== close_contract (fund recovery) ==');
  console.log(`  network:      ${testnet ? 'testnet' : 'MAINNET'}`);
  console.log(`  contract:     ${addrStr}`);
  console.log(`  gas sent:     ${(Number(CLOSE_GAS_NANO) / 1e9).toFixed(2)} TON`);
  console.log(`  deeplink:     ${deeplink}`);
  console.log(`  raw BOC (b64): ${bocBase64}`);
  console.log('');
  console.log(
    'Funds return only if this address is a storage-provider contract you funded that honors ' +
      `op::close_contract — verify on ${tonviewerUrl(addrStr, testnet)} first.`,
  );
  console.log('Review the recipient in your wallet BEFORE approving.');
}

// -----------------------------------------------------------------------
// main
// -----------------------------------------------------------------------

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === '--help' || sub === '-h' || sub === undefined) {
    process.stdout.write(HELP);
    process.exit(sub === undefined ? 2 : 0);
  }
  if (!['offer', 'status', 'close'].includes(sub)) {
    console.error(`ton-provider-experiment: unknown subcommand '${sub}'\n`);
    process.stdout.write(HELP);
    process.exit(2);
  }
  try {
    if (sub === 'offer') await cmdOffer(rest);
    else if (sub === 'status') await cmdStatus(rest);
    else if (sub === 'close') await cmdClose(rest);
  } catch (e) {
    console.error(`ton-provider-experiment: ${e.message}`);
    process.exit(2);
  }
}

main();
