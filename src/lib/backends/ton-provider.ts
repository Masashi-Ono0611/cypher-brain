// ton-provider backend: pays a live TON Storage market provider (the current Go/
// StorageV1 scheme, self-registered via mytonprovider.org) to hold the bag — issue
// #396's "the real option 2 general users need", as distinct from ton.ts's self-hosted-
// seeder-only mode. A user with no always-on box of their own can still use TON
// Storage: this backend deploys a per-bag StorageV1 contract, has a chosen provider
// fetch the bag over P2P, and the provider is who keeps it available afterward — the
// same "pay once, don't operate infrastructure yourself" shape arweave/turbo already
// have, not a self-hosted "sovereignty lane" (that stays ton.ts's job).
//
// PR1 (issue #396 Phase A) shipped Tonkeeper-deeplink signing only: a human had to
// approve every deploy in their own wallet app, which is why this backend originally
// stayed out of `schedule install` and MCP (both need to run with nobody watching).
//
// PR2 closed that gap: `wallet create --chain ton` (src/lib/wallet.ts) generates a
// locally-held TON wallet, and put() below auto-signs and broadcasts the deploy itself
// — no Tonkeeper, no human — whenever CYPHER_BRAIN_TON_WALLET is configured (see
// autoSignAndBroadcastDeploy() below). Absent that, the original Tonkeeper-deeplink
// path still runs unchanged, so an operator with no local wallet is unaffected. This is
// now the SAME "presence-checkable capability" shape arweave/turbo's wallet.ts already
// established (wizard.ts's `ton-provider` inclusion used this precedent even before PR2
// existed) — which is also what makes MCP/`schedule install` exposure safe to turn on
// (see mcp.ts/schedule.ts): both only ever list this backend when a wallet is actually
// configured, so an unattended caller never gets stuck waiting on a Tonkeeper signature
// nobody is there to give.
//
// Phase B (issue #396) landed the wizard select() prompt (src/lib/wizard.ts),
// --help/estimate/README structural parity with arweave/turbo (see push's --help
// section below and README's "## Backends"), a USD line on estimate (tonUsdRate()
// below), and put()'s advisory pre-deploy funds check plus a shared-module progress
// line during the notify-until-full wait (mirroring turbo.ts's own funds
// check/progress reporting).
//
// Provider-payment mode only, still: the self-hosted ton.ts backend is unchanged and
// stays the "sovereignty" path for operators who want to run their own seeder.
//
// Cell-encoding correctness: the StorageV1 data-cell layout and the modify_providers
// deploy-message body below were cross-verified, byte-for-byte, against
// scripts/go/storage-v1-client's TESTED Go implementation (which itself calls
// xssnick/tonutils-storage-provider's PrepareV1DeployData directly) — both the
// derived CONTRACT ADDRESS and the message BODY's cell HASH matched independently for
// identical inputs. See that Go tool's deploy.go / pkg/contract/v1.go (vendored at
// github.com/xssnick/tonutils-storage-provider@v0.4.3) for the canonical layout this
// ports. `notify` (ADNL/RLDP "storageProvider.storageRequest", the only way a provider
// discovers a new contract — docs/ton-storage-status.md) has no mature TypeScript
// library (checked: thekiba/tonutils's storage package is explicitly unimplemented),
// so it shells out to that same Go binary rather than reimplementing a P2P protocol
// handshake by hand; everything else here (provider search, cost math, contract
// deploy/build, on-chain status polling) is pure TypeScript via @ton/ton (already an
// optionalDependency).
//
// Locator: "ton-provider:v1:<64-hex-bag-id>" — same schema-versioned shape as ton.ts's
// locator (nothing mutable embedded: no contract address, no provider — those can
// change over the contract's life without invalidating the recovery artifact). get()
// is pure P2P fetch (ton.ts's exported p2pFetch — protocol-level content-addressed
// retrieval, correct regardless of who is seeding); there is no seeder-SSH fallback
// here, because this backend never operates a seeder of its own — a P2P failure is a
// hard error, not a silent downgrade to a less-verified path.
import { mkdtempSync } from 'node:fs';
import { mkdir, copyFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// `@ton/ton` is an optionalDependency (package.json) — like `arweave` (wallet.ts's
// getArweave()) and `@ardrive/turbo-sdk` (estimate.ts/turbo.ts), it must be a LAZY
// import so a machine without it installed only fails at the call site that actually
// needs it, not at module load. A static top-level value import here would break every
// OTHER backend too, the moment anything imports backends/index.ts (which imports this
// file unconditionally) — caught by scripts/selftest-arweave-nodeps.mjs, which runs the
// arweave backend from an isolated dir with no optional SDKs installed at all.
// Type-only imports are erased at compile time and never touch the module at runtime,
// so the TYPES below stay a plain top-level import.
import type {
  Builder as TonBuilder,
  Slice as TonSlice,
  Address as TonAddress,
  Cell as TonCell,
  WalletContractV4 as TonWalletContractV4,
} from '@ton/ton';
import {
  TON_PROVIDER_OWNER,
  TON_PROVIDER_MAX_SPEND,
  TON_PROVIDER_NOTIFY_BIN,
  TON_PROVIDER_MYTONPROVIDER_URL,
  TON_PROVIDER_NOTIFY_RETRY_MS,
  TON_PROVIDER_NOTIFY_INTERVAL_MS,
  TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS,
  TON_PROVIDER_DEPLOY_CONFIRM_POLL_MS,
  TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS,
  TON_TONAPI_URL,
  TON_BIN,
  TON_NETWORK_CONFIG,
  TON_WALLET,
  SKIP_FUNDS_CHECK,
  RECEIPT_LEDGER,
} from '../config.js';
import { run } from '../proc.js';
import { sleep, rmrf, errMsg, throwForSdkImport, makeBagLocator } from '../util.js';
import { warn } from '../warn.js';
import { installStageSignalGuard, addActiveTonTmpDir, removeActiveTonTmpDir } from '../signal-guard.js';
import { tonApi, startLocalTonDaemon, type TonBagDetails, type LocalTonDaemon } from './ton-client.js';
import { p2pFetch, entryNameFor } from './ton.js';
import { progressReporter } from '../progress.js';
import { tonWalletConfigured, loadTonWallet } from '../wallet.js';
import type { StorageBackend, PutOpts, FetchShape } from '../types.js';
// issue #654: imported from this NEUTRAL leaf module (never from pushpull.ts) to avoid
// an import cycle — pushpull.ts imports backendFor() from backends/index.ts, which
// imports this file; if this file imported from pushpull.ts, that would close the loop.
// See push-partial-success.ts's own header comment.
import { PushFundingConfirmedButIncompleteError } from '../push-partial-success.js';
import { PushUncertainSpendError } from '../push-uncertain-spend.js';
import { spentSoFar, remainingSpendBudget, chargeSpendTracker } from '../spend-tracker.js';
// #808/#665: the durable "a paid deploy is about to happen / has happened" sidecar, and
// the receipt ledger it settles against. Both are leaf modules (config/util only), so
// neither closes an import cycle back into this file — same reasoning as the
// push-partial-success.ts import above.
import {
  recordSpendIntent,
  advanceSpendIntent,
  readSpendIntents,
  unsettledIntentsForContract,
  recordedProvidersForContract,
  fsyncPath,
  PENDING_SPENDS_LOG,
  type SpendIntentRecord,
} from '../pending-spend.js';
import { readReceipts, type ReceiptEntry } from '../receipt.js';

// Lazy loader for @ton/ton's VALUE exports (beginCell/Cell/Dictionary/Address/
// contractAddress/storeStateInit) — mirrors wallet.ts's getArweave(). Cached after the
// first successful load (module resolution itself is the expensive/one-time part).
type TonModule = typeof import('@ton/ton');
let tonModuleCache: TonModule | null = null;
async function getTon(): Promise<TonModule> {
  if (tonModuleCache !== null) return tonModuleCache;
  try {
    tonModuleCache = await import('@ton/ton');
    return tonModuleCache;
  } catch (e) {
    throwForSdkImport(e, '@ton/ton', 'ton-provider');
  }
}

// ---------- locator ----------
// Built via the shared makeBagLocator() factory (util.ts) — ton.ts uses the same
// factory with the 'ton' schema, so the two locator shapes cannot drift apart (#505).
const { locator: tonProviderLocator, bagIdFrom } = makeBagLocator('ton-provider');
export { tonProviderLocator, bagIdFrom };

// ---------- StorageV1 contract code (xssnick/tonutils-storage-provider@v0.4.3) ----------
// The exact V1Code BOC pkg/contract/v1.go embeds — identical bytes, so any BOC this
// module builds against it produces the same contract address a Go-side deploy would.
const V1_CODE_HEX =
  'b5ee9c7241021101000362000114ff00f4a413f4bcf2c80b01020162090202014804030089b8d31ed44d0d3ff31f404306f007f8e2a228307f47c6fa5208e1b02d33fd31fd33fd430d0d31ffa00302550554414036f06136f8c029132e201b3e630318201247ded43d880201580605005db006bb513434ffcc7d010c20c1fd039be87cb86534cff4c7f4cff5d33434c7fe800c3e09dbc420821312d028440d6002014808070026a87df8276f1082084c4b40a120c100923070de002aa9e9ed44d0d3ff71d721fa40d33fd31fd3ff304130039ed001d0d3030171b0925f04e0fa403020fa4430c000f2e06f21c700925f04e001d31f21c000925f05e0d33f22821048f548cebae3023133332282103dc680aeba9131e30d01821061fff683bae302300e0b0a007eed44d0d3ff71d721fa40305122c705f2e19182084c4b4070fb02f8258210b6236d63708010c8cb055005cf1624fa0214cb6a13cb1f12cb3fcbffc98306fb0002fced44d0d3fff404fa40d33fd31fd3ffd307305374c705f2e19120c00099955320ac24b991a4e8de08f404307f8e3a268307f47c6fa5208e2b53138307f40e6fa1b399303252088307f45b308e1403d74cd05003c705b39852088307f45b3007de07e2079132e201b3e630708ae6318308bef2d19605c8cbff14f40058cf160d0c0018cb3fcb1fcbff12cb07c9ed5400a8018307f4966fa5208e4404a453198307f40e6fa131b38e3102d31ffa00d121c000f2d19720c000f2d19801c8cb1f01fa02c9843ff8117029f811c8cb3fcb1fcb3fcc40198307f44307926c21e202926c21e2b31201fe6c12d3ff8308d71820f901541023f910f2e191d33fed44d0d3fff404fa40d33fd31fd3ffd3073053958307f40e6fa1f2e191d33fd31fd33f0cbaf2e1910ad74c20d0d31ffa0030111082084c4b40a001111101a120c100923070def823500ca1205611bc9130925710e2525fa8500f8102a3aa1aa9845390b9923028de19a10f01fe82084c4b40a070fb0206d74c5446d054530052a011103302d739b3f24dd30701c303f24e20d70bff5005bdf24f03d5315023a904219b01a55cad71b013d748d059e45bd7498307baf290f823843ff81122f811c8cb3f12cb1fcb3f1acc50628307f4438210a91baf56708010c8cb055009cf1628fa0218cb6a17cb1f15cb3f100038c98306fb0003c8cbff14f40001cf1613cb3f13cb1fcbffcb07c9ed54a985f39e';
let v1CodeCache: TonCell | null = null;
async function v1Code(): Promise<TonCell> {
  if (v1CodeCache === null) {
    const { Cell } = await getTon();
    v1CodeCache = Cell.fromBoc(Buffer.from(V1_CODE_HEX, 'hex'))[0];
  }
  return v1CodeCache;
}

// modify_providers / deploy op — xssnick/tonutils-storage-provider pkg/contract/v1.go.
const OP_MODIFY_PROVIDERS = 0x3dc680ae;

// A single provider entry in the on-chain `providers` dict: key = the provider's
// ProviderKey (Ed25519) pubkey as a 256-bit big-endian int; value = maxSpan (uint32,
// seconds) + PricePerMBDay (Coins), stored INLINE in the dict leaf — NOT as a ref
// (verified against a real Go-built body: the leaf cell has 0 refs). @ton/core's
// built-in Dictionary.Values.Cell() stores refs, which is why this is a custom value
// codec rather than that built-in.
interface ProviderEntry {
  maxSpanSeconds: number;
  rateNanoPerMB: bigint;
}
const ProviderEntryCodec = {
  serialize(src: ProviderEntry, builder: TonBuilder): void {
    builder.storeUint(src.maxSpanSeconds, 32).storeCoins(src.rateNanoPerMB);
  },
  parse(slice: TonSlice): ProviderEntry {
    return { maxSpanSeconds: slice.loadUint(32), rateNanoPerMB: slice.loadCoins() };
  },
};

// ---------- cost math (ported from scripts/go/storage-v1-client/amount.go) ----------
const MB_BYTES = 1_000_000n; // decimal MB — the contract's OWN per-MB unit (matches mytonprovider.org's rate_per_mb_day, see providerRateNanoPerMB below)
const MIN_SIZE_MB_BYTES = 100_000n; // 0.1 MB floor, same as amount.go
// 0.3 TON gas buffer, same as amount.go — this is a TRANSFER-AMOUNT cap (Codex review):
// CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND bounds `amountNano` (storage cost + this buffer),
// not the wallet's total on-chain debit. The buffer is sized generously against real
// TON network fees (fractions of a cent), matching the already real-money-tested
// scripts/go/storage-v1-client reference this ports, but an operator relying on the cap
// as an exact ceiling on wallet balance movement should read it that way.
export const DEPLOY_BUFFER_NANO = 300_000_000n;

// ceil(max(dataSizeBytes, 0.1MB) * rateNanoPerMB * spanDays / 1_000_000), exact
// integer arithmetic throughout (no floating point ever touches a money value).
export function storageCostNano(dataSizeBytes: bigint, rateNanoPerMB: bigint, spanDays: bigint): bigint {
  const effBytes = dataSizeBytes < MIN_SIZE_MB_BYTES ? MIN_SIZE_MB_BYTES : dataSizeBytes;
  const num = effBytes * rateNanoPerMB * spanDays;
  return (num + MB_BYTES - 1n) / MB_BYTES; // ceil division, num/den both non-negative
}

// mytonprovider.org's `price` field is NOT the on-chain rate — it is a 200GB/30-day
// cost estimate (docs/ton-storage-status.md, sourced from the registry backend's own
// SQL: `p.rate_per_mb_per_day * 1024 * 200 * 30 as price`). Recover the real
// nanoTON/MB/day rate the contract itself expects.
export function providerRateNanoPerMB(price: number): bigint {
  const rate = price / (1024 * 200 * 30);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`ton-provider backend: provider "price" field is not a usable positive number: ${price}`);
  }
  return BigInt(Math.ceil(rate));
}

// Default span = the provider's own min_span, converted to WHOLE days (rounded up) —
// docs/ton-storage-status.md: "min_span is typically 7+ days for Go-scheme providers",
// i.e. shorter spans are usually refused anyway. Rounding up can push the requested
// span past the provider's own max_span when min_span isn't an exact multiple of a day
// (Codex review) — checked here rather than left to the provider's own eventual refusal,
// since by the time that would surface the deploy has already been paid for.
function spanDaysFor(provider: ProviderCandidate): bigint {
  const spanDays = BigInt(Math.ceil(provider.min_span / 86400)) || 1n;
  if (spanDays * 86400n > BigInt(provider.max_span)) {
    throw new Error(
      `ton-provider backend: provider ${provider.pubkey}'s min_span (${provider.min_span}s) rounds up to ` +
        `${spanDays} day(s), which exceeds its own max_span (${provider.max_span}s) — refusing to deploy terms ` +
        'this provider would reject',
    );
  }
  return spanDays;
}

// A too-low deploy is a real, observed dead end (issue #403): the provider's own
// `notify` handler refuses to ever fetch a bag whose computed "bounty" (what a proof
// transaction would net the provider) falls below a fixed floor it enforces regardless
// of how the deploy's rate/size/span were chosen — and by the time that refusal
// surfaces, the deploy has already been paid for and confirmed on-chain, with no
// in-product way to notice this BEFORE spending. The floor and the formula below are
// not a guess: read directly from tonutils-storage-provider@v0.4.3's
// internal/service/service.go (`ErrLowBounty`) — the same library mytonprovider.org's
// listed Go/StorageV1 providers are built on, so this floor is a shared PROTOCOL
// constant, not something an individual provider configures. `PROVIDER_BOUNTY_FLOOR_NANO`
// could still drift in a future provider-library version; that's why the check below
// only WARNS (matching the funds-check precedent just below it in put()) rather than
// refusing — an assumption about someone else's code should never be what blocks a
// user's own deploy, only what alerts them to a real risk before they commit to it.
export const PROVIDER_BOUNTY_FLOOR_NANO = 50_000_000n; // 0.05 TON
const BOUNTY_MB_BYTES = 1024n * 1024n; // binary MB — the PROVIDER's own formula's unit (service.go: `24*60*60*1024*1024`), deliberately NOT this file's own decimal MB_BYTES above (that one is cypher-brain's OWN cost-estimate unit; matching the provider's exact math is what matters here)

// bounty (nanoTON) = rateNanoPerMB * dataSizeBytes * spanSeconds / (86400 * 1024 * 1024)
// — the exact expression tonutils-storage-provider computes before comparing it against
// its 0.05 TON floor (service.go: `mul := rate * size; mul *= maxSpanSeconds; bounty :=
// mul / (24*60*60*1024*1024)`). Integer arithmetic throughout, matching Go's own
// (rate/size/span are all non-negative, so floor-division here matches Go's).
export function estimatedBountyNano(rateNanoPerMB: bigint, dataSizeBytes: bigint, spanDays: bigint): bigint {
  const spanSeconds = spanDays * 86400n;
  return (rateNanoPerMB * dataSizeBytes * spanSeconds) / (86400n * BOUNTY_MB_BYTES);
}

// ---------- provider search (mytonprovider.org) ----------
export interface ProviderCandidate {
  pubkey: string; // ProviderKey (Ed25519) — NOT ADNLKey, NOT the `address` field (see main.go field-notes in scripts/go/storage-v1-client — the same distinction applies here)
  address: string;
  uptime: number;
  rating: number;
  price: number; // NanoTON per 200GB per month (see providerRateNanoPerMB)
  min_span: number; // seconds
  max_span: number; // seconds
  max_bag_size_bytes: number;
  status: number;
}

interface ProviderSearchResponse {
  providers: ProviderCandidate[] | null;
}

// Fetches the live registry and picks one candidate by a simple heuristic: must be
// able to hold the bag at all (max_bag_size_bytes), must report a healthy status
// (0 == online per mytonprovider.org's own API), then highest rating wins (rating
// already blends uptime + real usage — docs/ton-storage-status.md's own field notes).
// A richer heuristic (price-weighted, multi-candidate fallback on notify failure) is
// left for a follow-up — this is the minimum viable selection for a real payment path
// to exist at all.
export async function searchProviders(sizeBytes: number): Promise<ProviderCandidate[]> {
  const res = await fetch(`${TON_PROVIDER_MYTONPROVIDER_URL}/api/v1/providers/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ton-provider backend: mytonprovider.org search failed: HTTP ${res.status}`);
  const body = (await res.json()) as ProviderSearchResponse;
  const providers = Array.isArray(body?.providers) ? body.providers : [];
  // Numeric fields are explicitly finite-checked (Codex review), not just compared with
  // `>`/`>=`: a JS comparison against a malformed value (a string, NaN, or a field the
  // registry omitted entirely) can be true or false in surprising ways, and the fields
  // checked here (price, min_span, max_span) all end up driving on-chain payment/deploy
  // parameters downstream — a candidate with an unusable value must be filtered out here,
  // not let through to fail confusingly (or not fail at all) later.
  return providers.filter(
    (p) =>
      p &&
      p.status === 0 &&
      typeof p.pubkey === 'string' &&
      /^[0-9a-f]{64}$/.test(p.pubkey) &&
      Number.isFinite(p.max_bag_size_bytes) &&
      p.max_bag_size_bytes >= sizeBytes &&
      Number.isFinite(p.price) &&
      p.price > 0 &&
      Number.isFinite(p.min_span) &&
      p.min_span > 0 &&
      Number.isFinite(p.max_span) &&
      p.max_span > 0,
  );
}

export function selectProvider(candidates: ProviderCandidate[]): ProviderCandidate {
  if (candidates.length === 0) {
    throw new Error(
      'ton-provider backend: no live mytonprovider.org provider can hold this bag right now ' +
        '(none reported status=online with enough capacity) — try again later, or see docs/ton-storage-status.md',
    );
  }
  return [...candidates].sort((a, b) => b.rating - a.rating)[0];
}

// ---------- StorageV1 deploy build (matches deploy.go's buildDeploy; async only because
// the @ton/ton VALUE exports it needs are lazy-loaded — see getTon() above) ----------
export interface BuildDeployParams {
  bagId: Buffer; // 32 bytes
  merkleHash: Buffer; // 32 bytes
  dataSizeBytes: bigint;
  pieceSize: number;
  owner: TonAddress;
  providerPubkey: Buffer; // 32 bytes — the provider's ProviderKey pubkey, NOT a wallet address (see header)
  rateNanoPerMB: bigint;
  spanDays: bigint;
  maxSpendNano: bigint;
}

export interface BuildDeployResult {
  contractAddress: TonAddress;
  stateInit: TonCell;
  body: TonCell;
  costNano: bigint;
  amountNano: bigint;
  deeplink: string;
}

const UINT32_MAX = 4_294_967_295n;

export async function buildDeploy(p: BuildDeployParams): Promise<BuildDeployResult> {
  if (p.bagId.length !== 32) throw new Error(`ton-provider backend: bag id must be 32 bytes, got ${p.bagId.length}`);
  if (p.merkleHash.length !== 32)
    throw new Error(`ton-provider backend: merkle hash must be 32 bytes, got ${p.merkleHash.length}`);
  if (p.providerPubkey.length !== 32)
    throw new Error(`ton-provider backend: provider pubkey must be 32 bytes, got ${p.providerPubkey.length}`);
  if (p.spanDays <= 0n) throw new Error(`ton-provider backend: span-days must be positive, got ${p.spanDays}`);
  // Overflow guard BEFORE multiplying (the exact bug class scripts/go/storage-v1-client's
  // deploy.go fixed after a Codex review finding): checking after multiplication would
  // let spanDays wrap silently and pass.
  if (p.spanDays > UINT32_MAX / 86400n) {
    throw new Error(`ton-provider backend: span-days ${p.spanDays} exceeds the uint32 max_span range`);
  }
  const spanSeconds = Number(p.spanDays * 86400n);
  if (p.rateNanoPerMB <= 0n) throw new Error('ton-provider backend: rate must be positive');
  // Bounded at Number.MAX_SAFE_INTEGER, not the on-chain uint64 max (Codex review
  // suggestion): callers elsewhere in this module convert dataSizeBytes to a JS `number`
  // (e.g. searchProviders(Number(bag.dataSizeBytes))), which silently loses precision
  // past 2^53-1 — a value that big would already have been mis-selected against a
  // provider's capacity before reaching here, so this is the last chance to fail loudly
  // instead of deploying a contract for a size that was never accurately compared.
  if (p.dataSizeBytes <= 0n || p.dataSizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `ton-provider backend: data size must be a positive integer no larger than ${Number.MAX_SAFE_INTEGER} bytes, got ${p.dataSizeBytes}`,
    );
  }
  if (p.pieceSize <= 0 || p.pieceSize > 0xffffffff || !Number.isInteger(p.pieceSize)) {
    throw new Error(`ton-provider backend: piece size must be a positive uint32, got ${p.pieceSize}`);
  }
  // Defense-in-depth on this function's own money-safety boundary (Codex review): this
  // is exported, so a caller other than put() (which always passes a validated positive
  // bigint from TON_PROVIDER_MAX_SPEND) could in principle pass something that slipped
  // past TypeScript. A non-positive value here must never be treated as "no cap".
  if (p.maxSpendNano <= 0n) {
    throw new Error(`ton-provider backend: maxSpendNano must be positive, got ${p.maxSpendNano}`);
  }

  const { beginCell, Dictionary, contractAddress, storeStateInit } = await getTon();

  // StorageV1 data cell: TorrentHash(256) + ActiveProviders(dict 256, absent — a fresh
  // contract starts with none, even though this SAME deploy body adds one in the
  // `providers` dict below: the dict on-chain is populated by the message handler when
  // the deploy body runs, not baked into StateInit.Data) + OwnerAddr(addr) +
  // DataSize(64) + PieceSize(32) + MerkleHash(256) + KeyLen(8, unset in the upstream Go
  // struct literal, so 0). Verified byte-for-byte (contract-address AND cell-hash
  // equality) against a real Go-built StateInit for identical inputs.
  const data = beginCell()
    .storeBuffer(p.bagId)
    .storeBit(0) // ActiveProviders — Maybe ^Dict, absent
    .storeAddress(p.owner)
    .storeUint(p.dataSizeBytes, 64)
    .storeUint(p.pieceSize, 32)
    .storeBuffer(p.merkleHash)
    .storeUint(0, 8) // KeyLen
    .endCell();

  const code = await v1Code();
  const addr = contractAddress(0, { code, data });
  const stateInit = beginCell().store(storeStateInit({ code, data })).endCell();

  const providers = Dictionary.empty(Dictionary.Keys.BigUint(256), ProviderEntryCodec);
  providers.set(BigInt(`0x${p.providerPubkey.toString('hex')}`), {
    maxSpanSeconds: spanSeconds,
    rateNanoPerMB: p.rateNanoPerMB,
  });
  // query_id is a nonce, echoed but not otherwise checked by the contract — random,
  // masked to 63 bits to mirror the Go reference's rand.Int63() range (not a security
  // requirement, just parity with the proven implementation this ports).
  const queryId = randomBytes(8).readBigUInt64BE() & 0x7fffffffffffffffn;
  const body = beginCell().storeUint(OP_MODIFY_PROVIDERS, 32).storeUint(queryId, 64).storeDict(providers).endCell();

  const costNano = storageCostNano(p.dataSizeBytes, p.rateNanoPerMB, p.spanDays);
  const amountNano = costNano + DEPLOY_BUFFER_NANO;
  if (amountNano > p.maxSpendNano) {
    throw new Error(
      `ton-provider backend: computed amount ${amountNano} nanoTON exceeds the ` +
        `CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND guard ${p.maxSpendNano} nanoTON — refusing to build the deploy`,
    );
  }

  const deeplink = buildTonkeeperUniversalLink(addr, body, stateInit, amountNano);

  return { contractAddress: addr, stateInit, body, costNano, amountNano, deeplink };
}

// https://app.tonkeeper.com/transfer/... universal link — same query param shape as the
// upstream reference CLI's ton://transfer/... deeplink (padded, URL-safe base64), but the
// https:// scheme+host so it opens directly from a browser/terminal without an OS-level
// ton: protocol handler being registered (established this session: ton:// links silently
// no-op when clicked from Chrome on a machine with no such handler; the https universal
// link does not have that problem).
function buildTonkeeperUniversalLink(addr: TonAddress, body: TonCell, stateInit: TonCell, amountNano: bigint): string {
  const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const friendly = addr.toString({ bounceable: true, testOnly: false });
  return (
    `https://app.tonkeeper.com/transfer/${friendly}` +
    `?bin=${b64url(body.toBoc())}&init=${b64url(stateInit.toBoc())}&amount=${amountNano.toString()}`
  );
}

// ---------- on-chain status polling (tonapi, same endpoint scripts/go/storage-v1-client's status.go uses) ----------
// #805: how hard put()'s "has this contract already been funded?" guard tries before it
// gives up and REFUSES to broadcast. Small and fixed rather than deadline-driven: the
// failure this absorbs is a transient tonapi blip, and a longer wait would only delay a
// refusal the operator has to act on anyway. Also reused by the #664 post-broadcast
// probe, which asks the same endpoint the same way.
const ALREADY_ACTIVE_CHECK_ATTEMPTS = 3;
const ALREADY_ACTIVE_CHECK_INTERVAL_MS = 2000;
interface AccountState {
  status: string;
  balance: number;
}

async function fetchAccountState(addr: TonAddress): Promise<AccountState> {
  const url = `${TON_TONAPI_URL}/v2/blockchain/accounts/${addr.toRawString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ton-provider backend: GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as AccountState;
}

// ---------- PR2: local auto-signing (issue #396) ----------
// Everything below signs and broadcasts a deploy with a LOCALLY-HELD TON wallet
// (wallet.ts's `wallet create --chain ton`) instead of printing a Tonkeeper deeplink for
// a human to approve — the alternative put() picks between depending on whether
// CYPHER_BRAIN_TON_WALLET is configured (tonWalletConfigured(), checked in put() below).
//
// Design proven end-to-end against real testnet (wallet generated -> local sign ->
// broadcast -> StorageV1 contract observed `active` on-chain via tonapi, zero Tonkeeper
// involvement) and reviewed with a second model (masa-codex/agmsg) before landing here;
// see the PR description for the exact exchange. Two deliberate departures from that
// review's suggestion, both because this session's OWN real-Tonkeeper dogfooding already
// proved the actual on-chain behavior directly, which outranks a general suggestion:
//   - bounce:true (not the reviewer's suggested false): a real mainnet Tonkeeper deploy
//     with a mismatched owner was observed to correctly BOUNCE the value back (minus
//     fees) when modify_providers' authorization check failed, rather than stranding it
//     in a half-deployed, provider-less contract. Deploy (stateInit application) still
//     succeeds regardless of bounce — also directly observed then.
//   - the StorageV1 StateInit/address round-trip gets an explicit assert
//     (contractAddress(0, parsedInit).equals(deploy.contractAddress)) before any funds
//     move, catching a loadStateInit()/storeStateInit() mismatch before it becomes an
//     on-chain mistake instead of after.

// tonapi's TVM get-method endpoint for a wallet's own seqno (distinct from
// fetchAccountState's plain account-state read above). Only ever called when
// fetchAccountState already reported the wallet 'active' — calling it on an
// uninitialized wallet (the normal case for a BRAND NEW auto-sign wallet's first
// deploy) returns `{"error":"entity not found"}`, not a decodable seqno (checked
// directly against tonapi before relying on this), so callers must gate on status
// first rather than treat this as a self-contained "get seqno or 0" helper.
async function fetchWalletSeqno(addr: TonAddress): Promise<number> {
  const url = `${TON_TONAPI_URL}/v2/blockchain/accounts/${addr.toRawString()}/methods/seqno`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ton-provider backend: GET ${url} -> HTTP ${res.status}`);
  const body = (await res.json()) as { success?: unknown; decoded?: { state?: unknown } };
  const seqno = Number(body.decoded?.state);
  if (body.success !== true || !Number.isInteger(seqno) || seqno < 0) {
    throw new Error(`ton-provider backend: unexpected seqno response from tonapi for ${addr.toRawString()}`);
  }
  return seqno;
}

// Signs the deploy with `wallet`/`secretKey` (loaded by wallet.ts's loadTonWallet) and
// broadcasts it — no Tonkeeper, no human. Caller (put() below) still runs
// waitForContractActive() afterward, unchanged: a 200 here means "tonapi accepted the
// broadcast", never "the deploy succeeded on-chain" (masa-codex review; also directly
// observed in the testnet PoC — the wallet's balance had already moved by the time the
// client-side response parsing failed on an unrelated bug, proving the two are separate
// events).
//
// KNOWN LIMITATIONS (Codex review, xhigh pass — accepted as-is, not fixed here):
// - No cross-process seqno lock: two overlapping pushes against the SAME wallet (a manual
//   CLI run racing a cron-fired schedule, or two concurrent MCP calls) can read the same
//   seqno and race to broadcast. TON's own seqno-replay-protection bounds the blast
//   radius — the SECOND external message to actually land on-chain is rejected outright
//   (wrong seqno), not silently double-spent or misdirected — so the worst case is "one of
//   the two pushes fails and needs a retry," not fund loss. A file lock would close this
//   gap but adds real complexity for a rare edge case with a self-healing failure mode;
//   left as a documented limitation rather than implemented speculatively.
// - CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND caps `deploy.amountNano` (the internal transfer
//   value), not literally every nanoTON the wallet's balance drops by: SendMode.PAY_GAS_SEPARATELY
//   means the wallet's own forward/network fee (observed ~0.001 TON in real dogfooding,
//   negligible next to a multi-0.1-TON deploy) is debited ADDITIONALLY, same as Tonkeeper's
//   own UI already shows the "Fee" line separately from the transfer amount for the
//   human-signed path. Pre-existing PR1 semantics (MAX_SPEND was never a hard ceiling on
//   Tonkeeper's total wallet debit either) — not a gap PR2 introduces or worsens.
// issue #664: `submitted` is set to true at the exact moment the signed BOC leaves this
// process, and never before. put()'s catch around this call uses it to tell a failure
// that CANNOT have moved funds (a frozen wallet, an unreadable seqno, a StateInit
// mismatch — all of them before the POST) from one that MIGHT have (the POST itself
// throwing or answering non-2xx, where tonapi may well have accepted the message and
// only lost the response). Probing the contract's on-chain state after a pre-broadcast
// failure would be actively wrong: the address can read as non-`nonexist` for reasons
// that have nothing to do with this run, and the caller would then treat a refusal that
// spent nothing as a confirmed spend.
async function autoSignAndBroadcastDeploy(
  wallet: TonWalletContractV4,
  secretKey: Buffer,
  deploy: BuildDeployResult,
  submitted?: { value: boolean },
): Promise<void> {
  const { beginCell, contractAddress, external, internal, loadStateInit, SendMode, storeMessage } = await getTon();

  const parsedInit = loadStateInit(deploy.stateInit.beginParse());
  if (!contractAddress(0, parsedInit).equals(deploy.contractAddress)) {
    throw new Error(
      'ton-provider backend: StorageV1 StateInit/address mismatch after loadStateInit() round-trip — ' +
        'auto-sign aborted before spending anything',
    );
  }

  // #640: tonapi answers a genuinely-never-used wallet with an ORDINARY 200 (status
  // "uninitialized"/"nonexist", balance 0 — confirmed against both the mock and the
  // real API, see scripts/selftest-ton-provider.sh's unfunded-address mock) — it does
  // NOT throw. fetchAccountState() therefore only throws on an ACTUAL lookup failure
  // (network/timeout/5xx), which must never be treated the same as "unused": letting
  // that error collapse to `null` here (the previous `.catch(() => null)`) silently
  // selected seqno 0 for a wallet that may well already be active, producing a
  // doomed on-chain transaction (wrong seqno) that tonapi's broadcast endpoint still
  // accepts with HTTP 200. Fail loudly instead — a transient failure right before
  // signing is worth a retry, not a guess.
  let walletState: AccountState;
  try {
    walletState = await fetchAccountState(wallet.address);
  } catch (e) {
    throw new Error(
      `ton-provider backend: could not look up local wallet ${wallet.address.toRawString()}'s on-chain state ` +
        `(${errMsg(e)}) — this may be a transient tonapi failure, not proof the wallet has never been used; ` +
        'refusing to guess seqno 0 and risk broadcasting a message the wallet contract will reject. Retry once ' +
        'tonapi is reachable.',
    );
  }
  if (walletState.status === 'frozen') {
    throw new Error(
      `ton-provider backend: local wallet ${wallet.address.toRawString()} is frozen on-chain — cannot auto-sign`,
    );
  }
  const walletActive = walletState.status === 'active';
  const seqno = walletActive ? await fetchWalletSeqno(wallet.address) : 0;

  const transferBody = wallet.createTransfer({
    seqno,
    secretKey,
    timeout: Math.floor(Date.now() / 1000) + 300, // 5min — the createTransfer default (60s) is tight against network/API latency
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: deploy.contractAddress,
        value: deploy.amountNano,
        bounce: true, // see file-header note above — proven safety net, kept deliberately
        init: parsedInit,
        body: deploy.body,
      }),
    ],
  });
  // The signature is already computed and embedded in transferBody — secretKey is no
  // longer needed past this point. Zeroed IN PLACE (Codex review, xhigh pass), not just
  // dropped: this Buffer is the SAME object put() below still holds a reference to
  // (autoSignWallet.secretKey) for the duration of the subsequent up-to-20-minute
  // waitForContractActive() wait, so zeroing here also clears what that reference sees —
  // shrinking the in-memory exposure window to "while signing", not "until push returns".
  secretKey.fill(0);

  const extMsg = external({
    to: wallet.address,
    // A wallet not yet active on-chain (seqno===0, no code deployed yet) must carry its
    // OWN init in this external message — once it has sent >=1 transaction, it is active
    // and init is omitted (attaching it again would be a wasted/rejected no-op).
    init: walletActive ? undefined : wallet.init,
    body: transferBody,
  });
  const boc = beginCell().store(storeMessage(extMsg)).endCell().toBoc({ idx: false, crc32: true });

  const url = `${TON_TONAPI_URL}/v2/blockchain/message`;
  // Set BEFORE the await, not after it: the whole point is to cover the window where the
  // request may have reached tonapi while this process never learns the outcome.
  if (submitted) submitted.value = true;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boc: boc.toString('base64') }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ton-provider backend: broadcast POST ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

// Waits for the deploy to land, by polling tonapi's account-state endpoint until it
// reports 'active'. Bounded (20 min default, TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS):
// on the Tonkeeper-deeplink path a human is on the other end of this, so timing out is a
// real, expected outcome (the operator can re-run push once they have signed), not a bug.
//
// `fundingPath` distinguishes the THREE ways put() can reach this call:
//   - 'auto-sign': CYPHER_BRAIN_TON_WALLET configured, put() already signed and
//     broadcast the deploy itself and printed NO deeplink ("no Tonkeeper deeplink
//     needed") — so a timeout here must NOT tell the operator to "sign the deeplink
//     printed above" (issue #480: that instruction is inapplicable, and was actively
//     misleading, on this exact path). The most likely real cause on this path is the
//     wallet not having enough TON to cover gas — tonapi's broadcast endpoint accepts
//     (HTTP 200) a doomed transaction just as readily as a good one, so "broadcast
//     succeeded" proves nothing about "will confirm".
//   - 'deeplink': no wallet configured, put() printed a Tonkeeper deeplink for a human
//     to sign — the original #480 guidance applies unchanged.
//   - 'skipped' (issue #638): the already-non-fresh check above found the contract
//     already had on-chain history and skipped funding entirely THIS run — no deeplink
//     was printed and nothing was broadcast, so BOTH of the above instructions would be
//     wrong (there is nothing to sign, and no broadcast to check the balance for).
//
// 'active' alone does not prove the deploy message's modify_providers body specifically
// added THIS provider to the on-chain dict (Codex review) — it only proves some message
// initialized the contract. This backend does not read back the on-chain provider dict
// here to confirm that; instead, the notify step right after this (notifyProviderWithRetry)
// provides that confirmation indirectly: the provider daemon's own FetchStorageInfo
// handler looks itself up in the SAME dict this deploy populated, and replies "provider
// does not exist in this contract" if it isn't there — which is exactly the failure mode
// that surfaced the original ProviderV1.Address field-mapping incident this session
// (docs/ton-storage-status.md). A silently-empty provider dict would fail loudly at that
// step, not pass silently through this one.
async function waitForContractActive(
  addr: TonAddress,
  fundingPath: 'auto-sign' | 'deeplink' | 'skipped',
): Promise<void> {
  const start = Date.now();
  const deadline = start + TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS;
  // #480: a real 20-minute wait with zero output in between reads as a hang, not a wait
  // (the issue's own repro: "produced ZERO further output for 13+ minutes"). Anchored at
  // start + interval (not "every Nth poll") so the cadence stays correct regardless of
  // what the poll interval itself is set to.
  let nextProgressAt = start + TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS;
  for (;;) {
    const acc = await fetchAccountState(addr).catch(() => null); // tonapi indexing lag / transient errors: keep polling, don't abort on one bad read
    if (acc?.status === 'active') return;
    const now = Date.now();
    if (now > deadline) {
      const remediation =
        fundingPath === 'auto-sign'
          ? "the auto-signed broadcast may not have landed — check the wallet's TON balance and this " +
            "address's transaction history on a TON explorer (a common cause is the wallet not holding enough " +
            "TON to cover gas; tonapi's broadcast endpoint accepts a doomed transaction the same as a good one), " +
            'then re-run push'
          : fundingPath === 'deeplink'
            ? 'sign the deeplink printed above, then re-run push'
            : 'this run skipped funding because the contract already looked non-fresh on-chain before ' +
              'broadcasting anything (issue #638 — see the warning above) — no deeplink was printed and no new ' +
              "transfer was sent this time, so there is nothing to sign here; check the address's transaction " +
              'history on a TON explorer directly to see what state it is actually in';
      throw new Error(
        `ton-provider backend: contract ${addr.toRawString()} did not become active on-chain within ` +
          `${TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS}ms — ${remediation} (the same ciphertext will resolve to the ` +
          'same bag id and reuse this bag).',
      );
    }
    if (now >= nextProgressAt) {
      console.error(
        `ton-provider: still waiting for contract ${addr.toRawString()} to become active on-chain ` +
          `(${Math.round((now - start) / 1000)}s elapsed)`,
      );
      nextProgressAt = now + TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS;
    }
    await sleep(TON_PROVIDER_DEPLOY_CONFIRM_POLL_MS);
  }
}

// ---------- notify (shells out to scripts/go/storage-v1-client — see header) ----------
export interface NotifyResult {
  status: string;
  downloaded: bigint;
  reason: string; // the provider's own stated reason for a non-full-download response (e.g. "bounty should be at least 0.05 TON to cover fees") — empty string when the tool prints none (notify.go always prints the line, but often empty)
}

// Parses the Go tool's plain-text "== notify response ==" block (notify.go's own
// fmt.Fprintf lines) rather than requiring a --json mode neither side has — brittle to
// upstream wording changes, but bounded: a parse miss makes downloaded read as 0n (an
// under-count, never an over-count), so put()'s "wait until fully downloaded" loop below
// fails closed (keeps waiting / eventually times out) rather than declaring success early.
// `downloaded` is parsed straight from the regex-captured decimal digits into a BigInt
// (Codex review) — routing it through `Number` first could round a very large byte count
// UP past Number.MAX_SAFE_INTEGER, which would make the "under-count, never over-count"
// guarantee above false for a large enough bag.
function parseNotifyOutput(out: string): NotifyResult {
  // notify.go prints a pre-flight "  status: %s — %s\n" line (its own on-chain account
  // state check, notify.go:164) BEFORE ever calling the provider, then prints the
  // "== notify response ==" marker followed by the REAL response's own status/reason/
  // downloaded lines (notify.go:182-185). The regexes below are intentionally
  // non-anchored to tolerate leading whitespace, so without first slicing to the marker
  // they matched the earlier pre-flight status line instead of the actual notify
  // response (issue #561). Falling back to the full output when the marker is absent
  // preserves the previous best-effort behavior for unexpected/truncated output.
  const marker = '== notify response ==';
  const markerIdx = out.indexOf(marker);
  const response = markerIdx === -1 ? out : out.slice(markerIdx + marker.length);
  const status = /^\s*status:\s*(\S+)/m.exec(response)?.[1] ?? 'unknown';
  const downloadedRaw = /^\s*downloaded:\s*(\d+)\s*bytes/m.exec(response)?.[1];
  const reason = /^\s*reason:\s*(.*)$/m.exec(response)?.[1]?.trim() ?? '';
  return { status, downloaded: downloadedRaw ? BigInt(downloadedRaw) : 0n, reason };
}

async function notifyProvider(providerPubkeyHex: string, contractAddrRaw: string): Promise<NotifyResult> {
  if (!TON_PROVIDER_NOTIFY_BIN) {
    throw new Error(
      'ton-provider backend: CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN is not set — build ' +
        "scripts/go/storage-v1-client ('go build .' in that directory) and point this at the resulting " +
        'binary. Notifying a provider requires an ADNL/RLDP query with no mature TypeScript implementation, ' +
        'so this step shells out to that tested Go program rather than reimplementing the protocol.',
    );
  }
  try {
    // Network selection (issue #404) matches every OTHER network-sensitive call this
    // backend makes: CYPHER_BRAIN_TON_NETWORK_CONFIG unset/empty means mainnet (the
    // daemon's own default — config.ts's own comment on TON_NETWORK_CONFIG), a path
    // means testnet. This is this project's own documented CONTRACT for the variable
    // (cli.ts --help: "path to a TON global config JSON for testnet") — presence, not
    // the file's actual contents, is the signal; nothing here (or in
    // startLocalTonDaemon() above, which already keys off the exact same
    // `TON_NETWORK_CONFIG || undefined` check) verifies a given path truly points at
    // testnet vs. some other network (Codex review). Pointing it at a non-testnet
    // config would already have misconfigured the bag-hashing daemon identically,
    // before this notify call is ever reached — this is an existing characteristic of
    // the variable's contract, not a new risk this fix introduces. Before this fix,
    // notify() alone ignored the signal and always queried mainnet tonapi — hit
    // directly while dogfooding a testnet push: a contract confirmed active on testnet
    // still 404'd here because the account genuinely doesn't exist on the mainnet this
    // call was hard-coded to ask.
    const { out } = await run(
      TON_PROVIDER_NOTIFY_BIN,
      [
        'notify',
        '--provider-pubkey',
        providerPubkeyHex,
        '--contract',
        contractAddrRaw,
        ...(TON_NETWORK_CONFIG ? [] : ['--mainnet']),
      ],
      { timeoutMs: 60_000 },
    );
    console.error(out.trim());
    return parseNotifyOutput(out);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(
        `ton-provider backend: CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN (${TON_PROVIDER_NOTIFY_BIN}) not found`,
      );
    }
    throw new Error(`ton-provider backend: notify failed: ${errMsg(e)}`);
  }
}

// ---------- live provider terms check (issue #651) ----------
// mytonprovider.org's registry snapshot (searchProviders() above) is what selectProvider()
// picked a provider FROM and what rateNanoPerMB/spanDays below were computed FROM — but
// that snapshot can go stale between when a client searched it and when a deploy is
// actually broadcast. Before this check existed, a stale-registry mismatch (the provider
// has since raised its minimum rate, narrowed its span window, or run out of capacity for
// this bag) was only ever discovered by notifyProviderWithRetry() further down, AFTER the
// contract had already been funded and paid for — real money locked in a contract the
// provider will not service, with no in-product way to have noticed BEFORE spending
// (issue #651's own repro). scripts/go/storage-v1-client grew a `rates` subcommand
// (rates.go) for exactly this purpose: an ADNL/RLDP "storageProvider.ratesRequest" that
// asks the provider for its CURRENT terms, the same live signal notify's own "storageProvider.
// storageRequest" already gets, just BEFORE funds move instead of after.
export interface LiveRatesResult {
  available: boolean;
  rateNanoPerMB: bigint;
  minBountyNano: bigint;
  minSpanSeconds: number;
  maxSpanSeconds: number;
}

// Parses the Go tool's plain-text "== rates response ==" block (rates.go's own
// fmt.Fprintf lines) — same marker-based shape as parseNotifyOutput above, but a
// DIFFERENT fail-closed direction: parseNotifyOutput's caller (the notify-retry loop)
// treats an under-parsed value as "keep waiting", which is harmless there. This
// function's caller runs BEFORE any funds move, so a field this cannot confidently
// parse must ABORT the deploy rather than silently proceed as if it were permissive
// (e.g. a missing rate line must never be read as "rate 0, always affordable") —
// hence throwing here instead of defaulting fields the way parseNotifyOutput does.
function parseRatesOutput(out: string): LiveRatesResult {
  const marker = '== rates response ==';
  const markerIdx = out.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(`ton-provider backend: could not find the "${marker}" marker in the rates output: ${out}`);
  }
  const response = out.slice(markerIdx + marker.length);
  const availableRaw = /^\s*available:\s*(\S+)/m.exec(response)?.[1];
  const rateRaw = /^\s*rate_nano_per_mb_day:\s*(\d+)/m.exec(response)?.[1];
  const minBountyRaw = /^\s*min_bounty_nano:\s*(\d+)/m.exec(response)?.[1];
  const minSpanRaw = /^\s*min_span:\s*(\d+)/m.exec(response)?.[1];
  const maxSpanRaw = /^\s*max_span:\s*(\d+)/m.exec(response)?.[1];
  if (
    availableRaw === undefined ||
    rateRaw === undefined ||
    minBountyRaw === undefined ||
    minSpanRaw === undefined ||
    maxSpanRaw === undefined
  ) {
    throw new Error(`ton-provider backend: could not parse the rates response fields: ${response.trim()}`);
  }
  return {
    available: availableRaw === 'true',
    rateNanoPerMB: BigInt(rateRaw),
    minBountyNano: BigInt(minBountyRaw),
    minSpanSeconds: Number(minSpanRaw),
    maxSpanSeconds: Number(maxSpanRaw),
  };
}

// Shells out to the SAME notify binary (TON_PROVIDER_NOTIFY_BIN — already checked for
// presence/executability earlier in put(), before this is ever reached), its `rates`
// subcommand. Called from put() right after rateNanoPerMB/spanDays are computed from the
// registry snapshot and right BEFORE buildDeploy()/signing — i.e. before any funds move —
// deliberately kept as its own standalone function/call site (not inlined into the
// broadcast step itself) so it stays independent of the separate already-active-contract
// check issue #638 adds around the actual broadcast call further down in put().
async function checkProviderLiveTerms(
  providerPubkeyHex: string,
  dataSizeBytes: bigint,
  rateNanoPerMB: bigint,
  spanDays: bigint,
): Promise<LiveRatesResult> {
  let out: string;
  try {
    ({ out } = await run(
      TON_PROVIDER_NOTIFY_BIN,
      [
        'rates',
        '--provider-pubkey',
        providerPubkeyHex,
        '--size-bytes',
        dataSizeBytes.toString(),
        ...(TON_NETWORK_CONFIG ? [] : ['--mainnet']),
      ],
      // 60s, matching notifyProvider()'s own budget above for the SAME Go binary's
      // connection setup (Codex review): rates.go's two ADNL/DHT phases (DHT client
      // construction, then the RLDP query itself) each default to a 20s --timeout, so a
      // legitimately slow-but-succeeding call can take up to ~40s — a shorter Node-side
      // timeout here would kill a call the Go binary's own bound would have let succeed.
      { timeoutMs: 60_000 },
    ));
  } catch (e) {
    throw new Error(
      `ton-provider backend: could not confirm provider ${providerPubkeyHex}'s live ADNL terms before deploying ` +
        `(${errMsg(e)}) — refusing to broadcast against a possibly-stale mytonprovider.org registry snapshot`,
    );
  }
  console.error(out.trim());
  const live = parseRatesOutput(out);
  if (!live.available) {
    throw new Error(
      `ton-provider backend: provider ${providerPubkeyHex} reports itself as NOT available for a bag this size ` +
        'right now (live ADNL ratesRequest) — the mytonprovider.org registry snapshot that selected it is ' +
        'stale; refusing to broadcast a deploy this provider would refuse to service. Re-run push to search again.',
    );
  }
  if (live.rateNanoPerMB > rateNanoPerMB) {
    throw new Error(
      `ton-provider backend: provider ${providerPubkeyHex}'s LIVE rate (${live.rateNanoPerMB} nanoTON/MB/day, ` +
        `via ADNL ratesRequest) is higher than the ${rateNanoPerMB} nanoTON/MB/day this deploy was built with ` +
        "(from mytonprovider.org's registry snapshot) — the registry is stale and this deploy would underpay. " +
        'Refusing to broadcast before funds move; re-run push to re-search at the current rate.',
    );
  }
  const spanSeconds = spanDays * 86400n;
  if (spanSeconds < BigInt(live.minSpanSeconds) || spanSeconds > BigInt(live.maxSpanSeconds)) {
    throw new Error(
      `ton-provider backend: provider ${providerPubkeyHex}'s LIVE span range (${live.minSpanSeconds}s..` +
        `${live.maxSpanSeconds}s, via ADNL ratesRequest) no longer includes the ${spanSeconds}s span this deploy ` +
        "was built with (from mytonprovider.org's registry snapshot) — refusing to broadcast before funds move; " +
        're-run push to re-search at the current terms.',
    );
  }
  // live.minBountyNano is returned (not compared here) — see the call site in put():
  // Codex review (Critical) found it was parsed but never used at all. It is used to
  // REPLACE the static assumption the existing advisory bounty check (issue #403) used
  // (PROVIDER_BOUNTY_FLOOR_NANO, tonutils-storage-provider's library default) with this
  // SAME provider's own LIVE-reported floor (which could be higher OR lower than that
  // guess) — kept as a WARN there, not a refusal here,
  // matching that check's own established posture (an under-bounty deploy still succeeds
  // and gets paid; it is the provider's own subsequent notify that may then refuse to
  // fetch it, not this broadcast itself), unlike availability/rate/span above, which are
  // hard refusals because those conditions are exactly what would make the CONTRACT
  // ITSELF get built with terms this provider does not agree to yet.
  return live;
}

// ---------- local ephemeral bag creation (put()'s first phase) ----------
// Unlike ton.ts (which creates the bag on a REMOTE, persistent seeder over SSH), this
// backend has no seeder of its own — the file must be hashed into a bag SOMEWHERE
// before a provider can be told to fetch it. A local, ephemeral tonutils-storage
// daemon (the same TON_BIN already required for get()'s P2P download — see ton.ts)
// does the hashing AND temporarily seeds the bag so the chosen provider has something
// to download from; put() stops it once the provider confirms receipt.
interface LocalBagInfo {
  bagId: string;
  dataSizeBytes: bigint;
  pieceSize: number;
  merkleHash: Buffer;
}

async function createLocalBag(apiUrl: string, bagDir: string): Promise<LocalBagInfo> {
  const created = await tonApi<TonBagDetails>(apiUrl, '/api/v1/create', {
    method: 'POST',
    body: JSON.stringify({ path: bagDir, description: 'cypher-brain ton-provider' }),
  });
  const bagId = created.bag_id?.toLowerCase?.();
  if (!bagId || !/^[0-9a-f]{64}$/.test(bagId)) {
    throw new Error('ton-provider backend: local daemon returned an invalid bag id from /api/v1/create');
  }
  // Wait for the daemon to finish hashing (same "completed" gate ton.ts's put() uses)
  // before reading piece_size/merkle_hash — those fields are only meaningful once
  // hashing has actually run.
  const deadline = Date.now() + 600_000;
  for (;;) {
    const details = await tonApi<TonBagDetails & { piece_size?: number; merkle_hash?: string; bag_size?: number }>(
      apiUrl,
      `/api/v1/details?bag_id=${bagId}`,
    );
    if (details.completed) {
      const pieceSize = details.piece_size;
      const merkleHashHex = details.merkle_hash;
      const dataSize = details.bag_size ?? details.size;
      if (!pieceSize || !merkleHashHex || !/^[0-9a-f]{64}$/.test(merkleHashHex) || !dataSize) {
        throw new Error(
          'ton-provider backend: local daemon reported the bag complete but omitted piece_size/merkle_hash/size',
        );
      }
      return { bagId, dataSizeBytes: BigInt(dataSize), pieceSize, merkleHash: Buffer.from(merkleHashHex, 'hex') };
    }
    if (Date.now() > deadline) {
      throw new Error(`ton-provider backend: local daemon did not finish hashing bag ${bagId} within 600000ms`);
    }
    await sleep(1000);
  }
}

// ---------- #665 authority (b): the contract's OWN on-chain provider dict ----------
// The only source that outranks this machine's records about which provider a contract
// was deployed with. `modify_providers` REPLACES the dict rather than merging into it,
// so whatever the chain holds now IS the registration — a local note can only ever be a
// (possibly stale) claim about it, and for a contract this machine has no record of at
// all it is the ONLY answer that exists.
//
// Shells out to the same tested Go program notify/rates already go through
// (scripts/go/storage-v1-client, CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN) rather than
// decoding a StorageV1 account's TL-B data cell a second time in TypeScript: that program
// already owns the cell layout — it BUILDS the same dict for `deploy`/`update-providers`,
// against the upstream bindings — so a divergence between the two languages' idea of the
// layout is impossible by construction rather than by review.
//
// The read either ANSWERS (`pubkeys`, possibly the empty list — a contract that names
// nobody is a real answer, and one the caller must act on differently from silence) or it
// does not (`pubkeys: null` plus a human-readable `reason`). Every failure mode — binary
// not configured, spawn error, non-zero exit, output that does not parse or does not
// describe the contract we asked about — lands in the second shape, deliberately soft:
// the caller's fallback is authority (a), the behaviour that shipped in #824, and turning
// a tonapi blip into a hard refusal would break retries that used to work. The `reason`
// travels with it so the warning can say WHY the chain did not answer instead of leaving
// an operator to guess (#347's relay contract).
interface OnChainProvidersOutput {
  address?: unknown;
  providers?: unknown;
}

interface OnChainProvidersRead {
  pubkeys: string[] | null;
  reason: string | null;
}

const PROVIDERS_READ_TIMEOUT_MS = 30_000;

// `expectedAddress` is checked, not assumed (multi-model review): a well-formed answer
// ABOUT ANOTHER CONTRACT would otherwise be adopted as this one's authority. The Go side
// echoes back the address it actually read, which is what makes that checkable at all.
function parseOnChainProvidersOutput(out: string, expectedAddress: string): OnChainProvidersRead {
  const unusable = (reason: string): OnChainProvidersRead => ({ pubkeys: null, reason });
  let parsed: OnChainProvidersOutput;
  try {
    parsed = JSON.parse(out) as OnChainProvidersOutput;
  } catch {
    return unusable('its output was not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers)) {
    return unusable('its JSON had no `providers` array');
  }
  if (typeof parsed.address !== 'string' || parsed.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    return unusable(`it answered for a different address (${String(parsed.address)})`);
  }
  const pubkeys: string[] = [];
  for (const entry of parsed.providers) {
    const pubkey = (entry as { pubkey?: unknown } | null)?.pubkey;
    // A malformed entry makes the WHOLE read unusable rather than shrinking the set:
    // silently dropping one entry could turn "the contract names two providers, pick
    // carefully" into "it names one, use it" — the failure mode this authority exists to
    // prevent, arrived at from the other direction.
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) {
      return unusable('one of the providers it listed had no usable pubkey');
    }
    pubkeys.push(pubkey.toLowerCase());
  }
  return { pubkeys: [...new Set(pubkeys)], reason: null };
}

async function readOnChainProviders(contractAddrRaw: string): Promise<OnChainProvidersRead> {
  if (!TON_PROVIDER_NOTIFY_BIN) {
    return { pubkeys: null, reason: 'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN is not set' };
  }
  try {
    const { out } = await run(
      TON_PROVIDER_NOTIFY_BIN,
      ['providers', '--address', contractAddrRaw, ...(TON_NETWORK_CONFIG ? [] : ['--mainnet'])],
      { timeoutMs: PROVIDERS_READ_TIMEOUT_MS },
    );
    return parseOnChainProvidersOutput(out, contractAddrRaw);
  } catch (e) {
    // run() puts the child's exit code and stderr in the message, so exit 2 (the Go
    // side's "this account is not active, there is no dict to read") and exit 1 (the
    // read itself failed) both reach the operator as text even though both leave
    // authority (a) in charge — neither can name a provider, which is all the caller
    // needs to branch on.
    return { pubkeys: null, reason: errMsg(e) };
  }
}

// ---------- #808: the receipt-ledger side of the pending-spend reconciliation ----------
// The receipt ledger is the AUTHORITY on "has this contract's spend already been
// recorded" — the pending-spend sidecar is only ever a hint about it. Both are consulted
// because they can disagree in one direction that matters: a run can append the receipt
// and die before advancing its intent to `settled`, and a later run that trusted the
// intent alone would then write the SAME spend a second time. Matched on the contract
// address inside `raw` (what ton-provider.ts's own onReceipt call writes, #484), not on
// the locator: two DIFFERENT deploys of the same bag by different owners share a locator
// but never share a contract address.
// `skippedLines` travels with the answer (multi-model review): "no receipt for this
// contract" and "no receipt for this contract that this version can read" are the same
// return value but opposite facts, and the caller's decision — write a receipt on an
// earlier run's behalf — is wrong for the second one.
async function ledgerReceiptForContract(
  contractAddrRaw: string,
): Promise<{ receipt: ReceiptEntry | null; skippedLines: number }> {
  const { receipts, skippedLines } = await readReceipts();
  for (let i = receipts.length - 1; i >= 0; i--) {
    const r = receipts[i];
    if (r.backend !== 'ton-provider') continue;
    const raw = r.raw as { contract_address?: unknown } | null;
    if (raw && typeof raw === 'object' && raw.contract_address === contractAddrRaw) return { receipt: r, skippedLines };
  }
  return { receipt: null, skippedLines };
}

// The provider pubkey a #654/#484 receipt recorded for a contract — #665's authority (a)
// fallback when no pending-spend intent covers it (a spend recorded by a cypher-brain
// that predates the intent sidecar still has its receipt).
function providerPubkeyFromReceipt(receipt: ReceiptEntry | null): string | null {
  const raw = receipt?.raw as { provider_pubkey?: unknown } | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  return typeof raw.provider_pubkey === 'string' && raw.provider_pubkey ? raw.provider_pubkey : null;
}

// Advance an intent to `settled` ONLY once a receipt for its contract is verifiably on
// disk. Deliberately not "onReceipt returned, therefore the receipt exists": pushpull.ts's
// persistReceipt() CATCHES its own append failure and warns rather than throwing, so a
// caller that settled on return alone would mark the ledger complete precisely when it is
// not — reopening #808's gap with a record claiming it is closed. When the receipt is
// absent (or cannot be checked), the intent is left where it is, which is what makes
// `doctor`'s pending-spend-intents check report it.
// The `intent_id` a receipt was written for, if it carries one. Receipts written before
// #808 (and any hand-made line) have none — settling those by contract address is exactly
// right, since the run that wrote them had no intent to link to.
function intentIdFromReceipt(receipt: ReceiptEntry | null): string | null {
  const raw = receipt?.raw as { intent_id?: unknown } | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  return typeof raw.intent_id === 'string' && raw.intent_id ? raw.intent_id : null;
}

async function settleIntentAgainstLedger(intent: SpendIntentRecord, contractAddrRaw: string): Promise<void> {
  let recorded: ReceiptEntry | null;
  try {
    ({ receipt: recorded } = await ledgerReceiptForContract(contractAddrRaw));
  } catch (e) {
    warn(
      `ton-provider: could not confirm the receipt for contract ${contractAddrRaw} reached the receipt ledger ` +
        `(${errMsg(e)}) — leaving its pending-spend record in ${PENDING_SPENDS_LOG} unsettled so 'cypher-brain ` +
        "doctor' keeps reporting it",
    );
    return;
  }
  if (recorded === null) {
    // Deliberately a warning rather than a thrown PushFundingConfirmedButIncompleteError
    // (multi-model review, considered and declined): the bytes ARE stored and notify still
    // has to run, so failing the push would report a successful storage outcome as a
    // failure over a bookkeeping write — and pushpull.ts's persistReceipt has always
    // warned rather than thrown here, for every backend. What was missing was durability,
    // not severity, and that is what the unsettled record now supplies: this reaches the
    // CLI's end-of-run summary and the MCP result's warnings[] (warn(), #347) AND survives
    // the run as a doctor finding, which no exception would have done.
    warn(
      `ton-provider: the confirmed spend for contract ${contractAddrRaw} did NOT reach the receipt ledger — its ` +
        `pending-spend record in ${PENDING_SPENDS_LOG} stays unsettled, 'cypher-brain doctor' reports it, and a ` +
        'later push of the same artifact will write the missing receipt',
    );
    return;
  }
  const recordedFor = intentIdFromReceipt(recorded);
  if (recordedFor !== null && recordedFor !== intent.intent_id) {
    // One funded contract is one spend here — #638's guard refuses to re-fund a non-fresh
    // address, and the residual indexing-lag race it documents is bounded by the wallet's
    // own seqno replay protection, so a second accepted transfer to the SAME address is
    // not a state this backend can reach on its own. Settling this intent against that
    // receipt is therefore right, but it is not something to do silently: if the premise
    // ever fails (two owners, a hand-funded address), this line is the only place an
    // operator would see it (second review pass).
    warn(
      `ton-provider: the receipt for contract ${contractAddrRaw} was written for a DIFFERENT recorded attempt ` +
        `(${recordedFor}, not ${intent.intent_id}) — one funded contract is one spend, so this record is being ` +
        'settled against it. If that address really was funded twice, the ledger holds one receipt for two ' +
        'transfers: check it on a TON explorer.',
    );
  }
  try {
    // fsync the LEDGER before recording that it is durable (second review pass).
    // receipt.ts's appendReceipt() deliberately does not sync (it is a report written
    // after the fact), so without this the `settled` transition — which IS fsync'd — could
    // outlive the receipt it attests to across a power loss, leaving a durable record
    // saying nothing is owed and no receipt to back it. Fail closed: if the ledger cannot
    // be flushed, the intent stays unsettled and doctor keeps reporting it.
    await fsyncPath(RECEIPT_LEDGER);
  } catch (e) {
    warn(
      `ton-provider: could not flush the receipt ledger to disk (${errMsg(e)}) — leaving the pending-spend record ` +
        `for ${contractAddrRaw} unsettled rather than claiming a receipt is durable when it may not be`,
    );
    return;
  }
  try {
    await advanceSpendIntent(intent, 'settled');
  } catch (e) {
    // Harmless in the direction that matters: the receipt IS on disk, so the ledger is
    // correct and the only cost is a stale entry doctor will keep reporting.
    warn(`ton-provider: could not mark the pending-spend record for ${contractAddrRaw} settled (${errMsg(e)})`);
  }
}

// Calls notify() repeatedly (each call re-sends the RLDP request, safe/idempotent on the
// provider side) until it reports having downloaded the FULL bag — only THEN is it safe
// for put() to stop the local ephemeral seed, since until that point the provider's own
// fetch may still be relying on this machine as its sole source. This is still the
// provider's own self-report, not a merkle-proof — the same "self-report, not proof of
// custody" caveat scripts/go/storage-v1-client's own notify --help documents — but it is
// the strongest signal available without reimplementing proof verification here too.
// Bounded by TON_PROVIDER_NOTIFY_RETRY_MS/INTERVAL_MS (config.ts) — real network work for
// a large brain is not instantaneous, and the default budget also covers transient notify
// failures (the provider daemon, or the DHT lookup to find it, can be unreachable for a
// few seconds right after a contract lands, since tonapi's own index can lag the
// just-signed deploy). scripts/selftest-ton-provider.sh overrides both to seconds so its
// "push waits, does not succeed early" positive control runs quickly and deterministically.
async function notifyProviderWithRetry(
  providerPubkeyHex: string,
  contractAddrRaw: string,
  dataSizeBytes: bigint,
): Promise<void> {
  const deadline = Date.now() + TON_PROVIDER_NOTIFY_RETRY_MS;
  // Same shared cadence/formatting module turbo's upload and rclone's transfer progress
  // use (progress.ts, #283) — a rate + ETA line instead of a bare byte count, and it
  // self-limits how often a line is written on an unattended run (nightly log / MCP
  // result) the same way those backends already do (this loop's own retry interval,
  // 15s by default, is already well below the throttle turbo's per-event SDK callback
  // needs, but the shared module is what gives rate/ETA math, not just the throttle).
  // dataSizeBytes is bounded well under Number.MAX_SAFE_INTEGER by buildDeploy()'s own
  // guard before a push ever reaches this loop, so narrowing it to Number() here is safe.
  const progress = progressReporter('ton-provider notify');
  const total = Number(dataSizeBytes);
  // Surfaces the provider's own stated reason (issue #403) the FIRST time it appears,
  // and again if it changes — not every attempt, since a long retry window (10min
  // default / 15s interval) would otherwise spam an identical line ~40 times. A silent
  // retry loop that discards the provider's own diagnosis (e.g. "bounty should be at
  // least 0.05 TON to cover fees") until a generic timeout 10 minutes later is exactly
  // what made this issue hard to diagnose in the first place.
  let lastReason = '';
  // #652: the provider's `downloaded` figure is its own self-report — no merkle proof
  // or independent spot-check retrieval verifies it (see this function's own header
  // comment above, and docs/ton-storage-status.md for the documented gap; a full
  // cryptographic proof-of-custody check is out of scope here and proposed there as a
  // follow-up issue instead). These two running checks are the minimum available
  // corroboration without reimplementing proof verification:
  //   - a FIRST-EVER response that already claims the full size, with no gradual
  //     progress ever observed, cannot be told apart from a genuinely fast small
  //     transfer using self-reported bytes alone — flagged (not refused: a small bag
  //     really can transfer in one round trip), so the operator at least sees this was
  //     never corroborated by an observed partial read.
  //   - a LATER response reporting FEWER bytes than a previously reported high-water
  //     mark is not merely uncorroborated, it is internally INCONSISTENT (a real
  //     download cannot un-download bytes) — a stronger signal something is wrong (a
  //     buggy provider, or one whose self-report cannot be trusted).
  let sawFirstResponse = false;
  let maxDownloadedSoFar = 0n;
  for (;;) {
    try {
      const res = await notifyProvider(providerPubkeyHex, contractAddrRaw);
      if (!sawFirstResponse) {
        sawFirstResponse = true;
        if (res.downloaded >= dataSizeBytes) {
          warn(
            `ton-provider: provider ${providerPubkeyHex} reported the FULL bag (${res.downloaded} bytes) ` +
              'downloaded on its very FIRST notify response, with no gradual progress observed — this is the ' +
              "provider's own self-report, not independently verified (no cryptographic proof-of-custody or " +
              'spot-check retrieval is performed here; see docs/ton-storage-status.md and issue #652). Treat ' +
              'this as unconfirmed until a later independent check (e.g. re-`notify` or mytonstorage.org).',
          );
        }
      } else if (res.downloaded < maxDownloadedSoFar) {
        warn(
          `ton-provider: provider ${providerPubkeyHex}'s self-reported downloaded byte count DECREASED between ` +
            `notify calls (${maxDownloadedSoFar} -> ${res.downloaded}) — a real download cannot lose bytes, so ` +
            'this self-report is internally inconsistent (no cryptographic proof-of-custody is checked here; ' +
            'see issue #652). Treat a later "full" report from this provider with extra suspicion.',
        );
      }
      if (res.downloaded > maxDownloadedSoFar) maxDownloadedSoFar = res.downloaded;
      if (res.downloaded >= dataSizeBytes) {
        progress.report(total, total);
        return;
      }
      if (res.reason && res.reason !== lastReason) {
        warn(`ton-provider: notify response so far — status=${res.status}: ${res.reason}`);
        lastReason = res.reason;
      }
      progress.report(Number(res.downloaded), total);
    } catch (e) {
      if (Date.now() > deadline) {
        throw new Error(
          `ton-provider backend: provider did not report a full download within ${TON_PROVIDER_NOTIFY_RETRY_MS}ms: ${errMsg(e)}`,
        );
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `ton-provider backend: provider did not finish fetching the bag within ${TON_PROVIDER_NOTIFY_RETRY_MS}ms — ` +
          'the contract is deployed and the provider was notified, but this push cannot confirm it has a full ' +
          'copy yet. It may still complete on its own; re-check with `notify` (scripts/go/storage-v1-client) later.',
      );
    }
    await sleep(TON_PROVIDER_NOTIFY_INTERVAL_MS);
  }
}

export function tonProviderBackend(): StorageBackend {
  return {
    async put(file: string, opts: PutOpts = {}): Promise<string> {
      const { Address } = await getTon();
      // PR2: when a local TON wallet is configured, IT is the owner — auto-signing
      // requires sender===owner (storage-contract.fc's modify_providers throws
      // error::unauthorized otherwise, an exact bug this session hit and fixed with a
      // real mainnet Tonkeeper deploy: CYPHER_BRAIN_TON_PROVIDER_OWNER pointed at a
      // DIFFERENT address than the wallet that actually signed). Deriving owner from the
      // wallet, rather than trusting a separately-set env var, removes that mismatch
      // class structurally instead of just documenting it.
      //
      // A LEFTOVER, DISAGREEING CYPHER_BRAIN_TON_PROVIDER_OWNER is a HARD ERROR, not a
      // warning (Codex review, xhigh pass): this push is reachable unattended now (MCP,
      // `schedule install`, #396 PR2) — nobody may be watching stderr for a warning that
      // silently overrides what the operator's config says the owner should be. The
      // wallet's own address is cryptographically the only one that COULD sign here, so
      // this is never "the wrong wallet spends" (only one wallet ever can) — but a stale
      // TON_PROVIDER_OWNER left over from a pre-PR2 Tonkeeper-only setup is exactly the
      // kind of drift that deserves a stop, not a silent proceed: unset it, or fix it to
      // match, before this backend spends anything.
      let owner: TonAddress;
      let autoSignWallet: { wallet: TonWalletContractV4; secretKey: Buffer } | null = null;
      if (await tonWalletConfigured()) {
        autoSignWallet = await loadTonWallet(TON_WALLET, 'ton-provider push');
        owner = autoSignWallet.wallet.address;
        if (TON_PROVIDER_OWNER) {
          let explicit: TonAddress | null = null;
          try {
            explicit = Address.parse(TON_PROVIDER_OWNER);
          } catch {
            /* invalid value — the mismatch error below covers this too, no separate message needed */
          }
          if (explicit === null || !explicit.equals(owner)) {
            throw new Error(
              `ton-provider: CYPHER_BRAIN_TON_PROVIDER_OWNER (${TON_PROVIDER_OWNER}) is set but does not match ` +
                `the configured CYPHER_BRAIN_TON_WALLET's own address (${owner.toString({ bounceable: true })}) — ` +
                'refusing to proceed with an ambiguous owner. Auto-signing requires sender===owner, so this can ' +
                "only ever deploy as the wallet's own address; unset CYPHER_BRAIN_TON_PROVIDER_OWNER (it is not " +
                'needed when a wallet is configured) or fix it to match, then re-run.',
            );
          }
        }
      } else {
        if (!TON_PROVIDER_OWNER) {
          throw new Error(
            'ton-provider backend: CYPHER_BRAIN_TON_PROVIDER_OWNER (the TON wallet address that will own the ' +
              'deployed contract) is required to push — or set CYPHER_BRAIN_TON_WALLET to a local wallet ' +
              '(`wallet create --chain ton`) to auto-sign without one',
          );
        }
        try {
          owner = Address.parse(TON_PROVIDER_OWNER);
        } catch {
          throw new Error(
            `ton-provider backend: CYPHER_BRAIN_TON_PROVIDER_OWNER is not a valid TON address: ${TON_PROVIDER_OWNER}`,
          );
        }
      }
      if (TON_PROVIDER_MAX_SPEND <= 0n) {
        throw new Error(
          'ton-provider backend: CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND must be set to a positive nanoTON amount ' +
            '(a StorageV1 deploy spends real funds) — see `estimate --backend ton-provider` for a preview first',
        );
      }
      // #639: a SIGNED push calls put() TWICE — once for the ciphertext, once for its
      // ".minisig" sidecar — each deploying its OWN StorageV1 contract. Checking
      // TON_PROVIDER_MAX_SPEND against each deploy's amountNano IN ISOLATION (as
      // buildDeploy() alone did before this) lets the two calls' spends each individually
      // clear the cap while their SUM blows well past it, and the operator only ever saw
      // the ciphertext's estimate before consenting (pushpull.ts's pre-consent display).
      // pushpull.ts's push() passes the SAME `spendTracker` object reference to both
      // put() calls (types.ts's PutOpts) — this deploy's REMAINING budget is what gets
      // handed to buildDeploy() as its cap below, and spendTracker.spentNano is charged
      // the moment this deploy's own amount is known, so the SECOND call sees the FIRST
      // call's spend already counted against the same cap.
      //
      // NOT safe against two overlapping put() calls sharing the SAME spendTracker
      // concurrently (multi-model review): this read-then-charge is not atomic, so two
      // in-flight calls could each read the same spentSoFarNano and both pass under the
      // cap. pushpull.ts's push() never does this — it `await`s the ciphertext's put()
      // to completion before starting the sidecar's, so the two charges against one
      // push's tracker are always strictly sequential, never concurrent. A caller
      // outside pushpull.ts that deliberately ran two put() calls in parallel against
      // the same spendTracker would defeat this cap; nothing in this codebase does
      // that, and this is a documented assumption of the contract (types.ts), not an
      // enforced invariant — same posture as the pre-existing cross-process wallet
      // seqno race documented above (autoSignAndBroadcastDeploy's KNOWN LIMITATIONS).
      // #797 factored this arithmetic into src/lib/spend-tracker.ts so arweave and turbo
      // can enforce the SAME combined-spend rule against their own caps; the behaviour
      // here is unchanged.
      const spentSoFarNano = spentSoFar(opts.spendTracker);
      const remainingMaxSpendNano = remainingSpendBudget(TON_PROVIDER_MAX_SPEND, opts.spendTracker);
      if (remainingMaxSpendNano <= 0n) {
        throw new Error(
          `ton-provider backend: this push already committed ${spentSoFarNano} nanoTON toward ` +
            `CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND=${TON_PROVIDER_MAX_SPEND} nanoTON (ciphertext + ".minisig" ` +
            'signature spend is checked TOGETHER) — no budget remains for this deploy',
        );
      }
      // Checked up front, not just inside notifyProvider(): a missing/misconfigured
      // binary is a PERMANENT failure, not a transient one — surfacing it only once
      // notifyProviderWithRetry() is already inside its retry loop would make that loop
      // retry a call that can never succeed until its full timeout elapses (caught by
      // this backend's own selftest: scripts/selftest-ton-provider.sh's "notify binary
      // missing" positive control hung for the full retry budget before this check was
      // added here). Failing fast here also avoids spending a real deploy's worth of
      // work (bag creation, provider search) — and, more importantly, the deploy PAYMENT
      // itself — on a push that cannot finish anyway. Checks the path is actually an
      // EXECUTABLE file, not just a non-empty string (Codex review): a stale/typo'd path
      // would otherwise only surface as an ENOENT after the operator has already signed
      // and paid for the deploy.
      if (!TON_PROVIDER_NOTIFY_BIN) {
        throw new Error(
          'ton-provider backend: CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN is not set — build ' +
            "scripts/go/storage-v1-client ('go build .' in that directory) and point this at the resulting " +
            'binary. Notifying a provider requires an ADNL/RLDP query with no mature TypeScript implementation, ' +
            'so this step shells out to that tested Go program rather than reimplementing the protocol.',
        );
      }
      try {
        await access(TON_PROVIDER_NOTIFY_BIN, fsConstants.X_OK);
      } catch {
        throw new Error(
          `ton-provider backend: CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN (${TON_PROVIDER_NOTIFY_BIN}) does not exist ` +
            "or is not executable — build scripts/go/storage-v1-client ('go build .' in that directory) and " +
            'point this at the resulting binary before pushing (checked before any funds are spent).',
        );
      }

      const entry = entryNameFor(file);
      // #644: push/pull never install the signal guard themselves — see ton.ts's
      // p2pFetch() for the identical rationale (installStageSignalGuard() is idempotent,
      // called here before the tmp dir exists so a signal mid-hash/mid-deploy actually
      // kills the ephemeral daemon this put() is about to spawn AND sweeps its dir).
      installStageSignalGuard();
      // mkdtempSync (not the async mkdtemp), then register, with NO await in between —
      // multi-model review: see ton.ts's p2pFetch() for why an async mkdtemp() would
      // leave a signal-landing window where the directory exists but is untracked.
      const tmpRoot = mkdtempSync(join(tmpdir(), 'cypher-brain-ton-provider-'));
      addActiveTonTmpDir(tmpRoot);
      const dbDir = join(tmpRoot, 'db');
      const bagDir = join(tmpRoot, 'bag');
      let daemon: LocalTonDaemon | null = null;
      try {
        await mkdir(dbDir, { recursive: true });
        await mkdir(bagDir, { recursive: true });
        await copyFile(file, join(bagDir, entry));

        daemon = await startLocalTonDaemon(TON_BIN, dbDir, TON_NETWORK_CONFIG || undefined);
        const bag = await createLocalBag(daemon.apiUrl, bagDir);

        const candidates = await searchProviders(Number(bag.dataSizeBytes));
        const provider = selectProvider(candidates);
        const rateNanoPerMB = providerRateNanoPerMB(provider.price);
        const spanDays = spanDaysFor(provider);

        // #651: confirm the provider's CURRENT ADNL-reported terms (rate/span/capacity)
        // still match the registry snapshot above, BEFORE building/broadcasting a deploy
        // against them — see checkProviderLiveTerms()'s own doc comment for why this is
        // a separate call site from the broadcast step further down. The returned
        // liveRates also carries the provider's own live bounty floor, used below in
        // place of the existing advisory bounty check's static assumption (issue #403).
        const liveRates = await checkProviderLiveTerms(provider.pubkey, bag.dataSizeBytes, rateNanoPerMB, spanDays);

        const deploy = await buildDeploy({
          bagId: Buffer.from(bag.bagId, 'hex'),
          merkleHash: bag.merkleHash,
          dataSizeBytes: bag.dataSizeBytes,
          pieceSize: bag.pieceSize,
          owner,
          providerPubkey: Buffer.from(provider.pubkey, 'hex'),
          rateNanoPerMB,
          spanDays,
          // #639: the REMAINING budget (TON_PROVIDER_MAX_SPEND minus whatever this same
          // push already committed via an earlier put() call), not the full cap — see
          // the comment above spentSoFarNano/remainingMaxSpendNano for why.
          maxSpendNano: remainingMaxSpendNano,
        });
        console.error(
          `ton-provider: selected provider ${provider.pubkey} (rating ${provider.rating.toFixed(2)}, uptime ${provider.uptime.toFixed(1)}%)`,
        );
        console.error(
          `ton-provider: storage cost ${deploy.costNano} nanoTON + ${DEPLOY_BUFFER_NANO} nanoTON deploy buffer = ${deploy.amountNano} nanoTON`,
        );
        // Advisory pre-deploy bounty check (issue #403) — see estimatedBountyNano()'s
        // own comment for what this is and why it warns rather than refuses. Placed
        // BEFORE the deploy is signed (both paths below) so the warning is visible to
        // whoever/whatever is about to commit real funds, not discovered only after a
        // 10-minute notify timeout. Compared against liveRates.minBountyNano — this
        // SAME provider's own LIVE-reported floor (checkProviderLiveTerms() above,
        // issue #651) — rather than the static PROVIDER_BOUNTY_FLOOR_NANO assumption,
        // since an actual measured value is strictly more accurate than a guess about
        // which tonutils-storage-provider library default this specific provider runs.
        const bounty = estimatedBountyNano(rateNanoPerMB, bag.dataSizeBytes, spanDays);
        if (bounty < liveRates.minBountyNano) {
          warn(
            `ton-provider: the computed bounty for this deploy (${bounty} nanoTON, from rate ${rateNanoPerMB} ` +
              `nanoTON/MB/day × ${bag.dataSizeBytes} bytes × ${spanDays} day(s)) looks BELOW the provider's own ` +
              `LIVE-reported minimum bounty (${liveRates.minBountyNano} nanoTON, via ADNL ratesRequest) — this ` +
              "specific provider's notify may refuse to ever fetch the bag even though the deploy itself will " +
              'still succeed and be paid for. A bigger bag, a longer span, or a higher rate would raise this estimate.',
          );
        }
        // ---------- money-safety: skip re-funding a non-fresh contract (issue #638) ----------
        // The StorageV1 contract ADDRESS is fully determined by bagId + owner +
        // dataSizeBytes + pieceSize + merkleHash (buildDeploy()'s `data` cell above) —
        // NONE of which depend on which provider was picked or its rate. A retry of the
        // SAME file (same content -> same bag hash -> identical StateInit) after ANY
        // broadcast-adjacent failure therefore derives the IDENTICAL contract address,
        // whether the previous attempt's HTTP response was lost after tonapi already
        // accepted the BOC (the broadcast POST throws but the transfer still lands), or
        // the deploy itself landed and only the LATER notify() step timed out. Before
        // this fix, autoSignAndBroadcastDeploy() (or a human re-approving the same
        // Tonkeeper deeplink) unconditionally sent `amountNano` again with a fresh
        // seqno/query id — funding an already-funded contract a second time, and a
        // newly-selected provider on the retry could also silently replace the
        // first one in the on-chain dict (modify_providers REPLACES, not merges — see
        // scripts/go/storage-v1-client/updateproviders.go's own field notes), stranding
        // the first payment. Checking here, BEFORE any funds move, closes that gap.
        //
        // Checked as "anything other than 'nonexist'" (Codex review, xhigh pass), not
        // literal 'active' only: tonapi's `status` vocabulary also has 'uninit' (funded,
        // contract code not yet run — the exact few-second window right after a
        // broadcast lands) and 'frozen' (was deployed, now suspended) — neither is a
        // fresh address either, and checking 'active' alone would still let a retry
        // landing in that 'uninit' window double-send. `nonexist` (no funds present at
        // all) is the only status this backend's own first-ever deploy for a bag/owner
        // pair should ever observe here.
        //
        // A narrower race remains: tonapi's own indexing can lag a JUST-broadcast
        // transaction by a moment, during which this SAME address can still read back
        // as 'nonexist' even though a transfer is already in flight. A retry landing in
        // that indexing-lag window is bounded by the SAME seqno-replay protection
        // already documented above (at most one of the two transfers is accepted), not
        // by this check — closing it fully would need a persisted "broadcast in flight"
        // record surviving process restarts, real complexity for an edge window this
        // fix does not claim to eliminate, left as a known limitation (see this PR's
        // description) rather than implemented speculatively.
        //
        // #805: a check that cannot ANSWER now fails CLOSED. This guard originally fell
        // back to "proceed as if the contract is fresh" on a lookup failure, reasoning
        // that doing so could only make double-funding less likely and could never skip
        // a real first deploy. That reasoning holds for a fresh deploy and is exactly
        // inverted for the case the guard exists for: a retry after an ambiguous
        // broadcast, where the very instability that produced the ambiguity is what
        // makes the lookup fail — so the fail-open branch fired precisely when it was
        // most likely to be re-funding an already-funded contract.
        //
        // Failing closed costs no working path here: waitForContractActive() below polls
        // this SAME endpoint and put() always reaches it, so a genuinely unreachable
        // tonapi already fails this push — the only change is that it now fails BEFORE
        // the transfer instead of after it. Retried a few times first, because the usual
        // cause is a transient blip rather than an outage.
        //
        // `nonexist` must be POSITIVELY observed. An unread state is "unknown", never
        // "fresh": the only status this backend's own first-ever deploy for a bag/owner
        // pair should ever see here is `nonexist`, and anything we did not actually read
        // could equally be `uninit`/`active`/`frozen`.
        let alreadyActive = false;
        let observedStatus = '';
        let lastLookupError: unknown = null;
        for (let attempt = 0; attempt < ALREADY_ACTIVE_CHECK_ATTEMPTS; attempt++) {
          if (attempt > 0) await sleep(ALREADY_ACTIVE_CHECK_INTERVAL_MS);
          try {
            const contractState = await fetchAccountState(deploy.contractAddress);
            observedStatus = contractState.status;
            alreadyActive = observedStatus !== 'nonexist';
            lastLookupError = null;
            break;
          } catch (e) {
            lastLookupError = e;
          }
        }
        if (lastLookupError !== null) {
          throw new Error(
            `ton-provider backend: could not determine whether contract ${deploy.contractAddress.toRawString()} ` +
              `has already been funded (${ALREADY_ACTIVE_CHECK_ATTEMPTS} tonapi lookups failed, last: ` +
              `${errMsg(lastLookupError)}) — refusing to broadcast a ${deploy.amountNano} nanoTON transfer that ` +
              'could be a SECOND payment for the same contract. This is a fail-closed refusal: no funds moved. ' +
              "Check the address's state on a TON explorer, or re-run push once tonapi is reachable again (the " +
              'same ciphertext resolves to the same bag id and reuses this bag, so nothing is lost by waiting).',
          );
        }
        if (!alreadyActive) {
          // Charge this deploy's amount against the shared tracker THE MOMENT it is
          // known to be within budget AND actually going to be broadcast (i.e. after
          // the #638 already-active check above finds nothing to skip) — before
          // autoSignAndBroadcastDeploy()/the Tonkeeper deeplink below even run, so a
          // SECOND put() call in the same push (the ".minisig" sidecar) sees this one
          // counted regardless of how far the current call gets afterward (#639).
          // Deliberately NOT charged in the alreadyActive branch: that branch moves no
          // funds at all (see the money-safety comment above), so charging it there
          // would falsely shrink the sidecar's remaining budget for a spend that never
          // happened this run.
          chargeSpendTracker(opts.spendTracker, deploy.amountNano);
        }
        if (alreadyActive) {
          // warn() (#347), not a raw console.error: this is a safety-relevant skip
          // decision, not routine progress output — an MCP-driven caller (an agent
          // retrying a failed push, exactly issue #638's own motivating scenario) must
          // see this in the structured result's warnings[] array, not only in a
          // background log nobody is watching.
          warn(
            `ton-provider: contract ${deploy.contractAddress.toRawString()} already shows on-chain activity ` +
              `(status=${observedStatus}) — this looks like a retry of an already-broadcast (or already-completed) ` +
              `deploy for the same bag/owner. Skipping re-funding (no new ${deploy.amountNano} nanoTON transfer) ` +
              "and going straight to notify. Which provider is notified is NOT this run's registry pick: it is " +
              "read back from the contract's own on-chain providers dict, falling back to this machine's " +
              'pending-spend intent and then the receipt if that read cannot answer, and refusing rather than ' +
              'guessing if none of them can (#665). The lines below say which source answered.',
          );
        }

        // ---------- #808/#665: reconcile with what an EARLIER run durably recorded ----------
        // Keyed on the contract address for the same reason the #638 guard above is: it
        // is stable across runs (bag id + owner + size + piece size + merkle hash — never
        // which provider was picked), and it is the identifier an operator checks on an
        // explorer.
        const contractAddressRaw = deploy.contractAddress.toRawString();
        // #665: which provider to notify. On a fresh deploy that is this run's own
        // selection. On the already-active branch it must NOT be — the contract's
        // on-chain `providers` dict was written by whichever run actually deployed it,
        // and `modify_providers` REPLACES rather than merges (see
        // scripts/go/storage-v1-client/updateproviders.go), so notifying a provider this
        // run happened to pick from a fresher mytonprovider.org snapshot can address a
        // provider that never held this bag at all.
        let notifyPubkey = provider.pubkey;
        // #808: an earlier run's confirmed-but-unrecorded spend, if there is one.
        let resumable: SpendIntentRecord | null = null;
        let priorReceipt: ReceiptEntry | null = null;
        if (alreadyActive) {
          // Read failures propagate rather than degrading to "nothing recorded": the two
          // decisions below (write a missing receipt / notify the deployed provider) are
          // both WRONG if taken on a log that could not be read, and this branch has
          // moved no funds, so refusing costs nothing but a retry — the same fail-closed
          // posture as the #805 guard above.
          const { intents, skippedLines: intentSkipped } = await readSpendIntents();
          const receiptLookup = await ledgerReceiptForContract(contractAddressRaw);
          priorReceipt = receiptLookup.receipt;
          // An UNREADABLE line is not an absent one (multi-model review): a line this
          // version cannot parse — a future schema, a truncated write, a hand edit — could
          // be the very record that names this contract's provider or its already-written
          // receipt. Both decisions below therefore treat "some line could not be read" as
          // "this log cannot answer", not as "the answer is no".
          const logsFullyReadable = intentSkipped === 0 && receiptLookup.skippedLines === 0;
          // Authority (a): this backend's own durable records — the intent written before
          // the deploy that actually paid (#808), else the receipt written after it
          // (#654/#484). Authority (b) — the contract's own on-chain dict, read just
          // below — outranks both; this block computes (a) first because (b) also uses
          // it to disambiguate a contract that names more than one provider, and because
          // (a) is what stays in charge when the on-chain read cannot answer.
          //
          // Ranked, not "most recent wins": a CONFIRMED intent and a receipt each describe
          // a deploy that was actually observed on-chain, while a `pending` intent records
          // only that a transfer was attempted — and local append order says nothing about
          // which `modify_providers` message won on-chain. Two confirmed records that
          // disagree cannot both be right, so that fails closed rather than picking one.
          const recorded = recordedProvidersForContract(intents, contractAddressRaw);
          const receiptPubkey = providerPubkeyFromReceipt(priorReceipt);
          const attested = [...new Set([...recorded.confirmed, ...(receiptPubkey ? [receiptPubkey] : [])])];
          const haveSomeRecord =
            intents.some((i) => i.contract_address === contractAddressRaw) || priorReceipt !== null;
          // Everything this machine's own logs offer as a candidate, attested or not —
          // used below both as authority (a)'s answer and, when the chain names more than
          // one provider, as the tie-break among them. Order is the tie-break's priority
          // and is load-bearing: confirmed pending-spend intents first, then the receipt,
          // then unconfirmed intents — strongest evidence that a deploy actually happened
          // to weakest.
          const localCandidates = [...new Set([...attested, ...recorded.unconfirmed])];
          // Unchanged from #824 except for the explicit `attested.length === 0` guard,
          // which used to be implied by position (this was computed only after the
          // disagreement throw, so attested.length was 0 or 1 by then). An unconfirmed
          // candidate is still used only when it is the ONLY one and nothing attested
          // contradicts it.
          const recordedPubkey =
            attested.length === 1
              ? attested[0]
              : attested.length === 0 && recorded.unconfirmed.length === 1
                ? recorded.unconfirmed[0]
                : null;

          // Authority (b), the top of the ranking: the contract's OWN on-chain
          // `providers` dict. Read AFTER the logs above because a contract naming more
          // than one provider still needs a local record (or this run's own pick) to
          // choose between them — the chain says who is registered, not which of several
          // registrations this push is a retry of.
          const { pubkeys: onChainPubkeys, reason: onChainFailure } = await readOnChainProviders(contractAddressRaw);
          // The tie-break for a contract naming SEVERAL providers considers only what
          // this machine durably recorded — never this run's registry pick (multi-model
          // review, Critical). That pick is the untrusted input this whole authority
          // exists to overrule; letting it break a tie would smuggle it back in as an
          // answer for a contract nothing local can vouch for.
          const fromChain =
            onChainPubkeys === null || onChainPubkeys.length === 0
              ? null
              : onChainPubkeys.length === 1
                ? onChainPubkeys[0]
                : (localCandidates.find((c) => onChainPubkeys.includes(c)) ?? null);
          if (onChainPubkeys === null) {
            // Soft, on purpose: this is exactly the case authority (a) already handles,
            // and it shipped working in #824. Reported rather than swallowed because a
            // reader of the run summary must be able to tell an answer that came from the
            // chain from one that came from a local note (#347's relay contract).
            warn(
              `ton-provider: could not read contract ${contractAddressRaw}'s own on-chain providers dict via ` +
                `scripts/go/storage-v1-client (${onChainFailure ?? 'unknown reason'}) — falling back to this ` +
                "machine's own records to decide whom to notify (#665).",
            );
          }

          if (onChainPubkeys !== null && onChainPubkeys.length === 0) {
            // An EMPTY dict is an ANSWER, not silence (multi-model review, Critical):
            // the contract itself says no provider is registered for it, so notifying
            // anyone — this run's pick or a local record — addresses a provider the
            // contract does not name, which is precisely what #665 exists to stop. Fail
            // loudly instead. Free to do here: this branch has moved no funds, and the
            // same artifact re-derives the same bag and contract on a later run.
            throw new Error(
              `ton-provider backend: contract ${contractAddressRaw} is funded on-chain but its own providers dict ` +
                'is EMPTY — it currently registers NO provider, so notifying anyone would address a provider the ' +
                'contract does not name. Register one deliberately with `update-providers` ' +
                '(scripts/go/storage-v1-client) and push again (#665). No funds moved.',
            );
          }
          if (onChainPubkeys !== null && onChainPubkeys.length > 0) {
            if (fromChain === null) {
              throw new Error(
                `ton-provider backend: contract ${contractAddressRaw}'s on-chain providers dict names ` +
                  `${onChainPubkeys.length} providers (${onChainPubkeys.join(', ')}) and this machine recorded ` +
                  'none of them — refusing to pick one on your behalf, since notifying the wrong one addresses a ' +
                  "provider that may never have held this bag, and this run's own registry pick " +
                  `(${provider.pubkey}) is not evidence of which one did. Re-run \`update-providers\` ` +
                  '(scripts/go/storage-v1-client) to register a single provider deliberately (#665). No funds moved.',
              );
            }
            notifyPubkey = fromChain;
            const contradicted = localCandidates.filter((c) => !onChainPubkeys.includes(c));
            if (contradicted.length > 0) {
              warn(
                `ton-provider: this machine's records name provider(s) ${contradicted.join(', ')} for contract ` +
                  `${contractAddressRaw}, but the contract's OWN on-chain providers dict names ` +
                  `${onChainPubkeys.join(', ')} — using the on-chain answer (${fromChain}), which outranks a local ` +
                  'note because `modify_providers` REPLACES the dict rather than merging into it, so whatever the ' +
                  `chain holds now IS the registration. Reconcile ${PENDING_SPENDS_LOG} / ${RECEIPT_LEDGER} if this ` +
                  'is a surprise (#665).',
              );
            } else if (localCandidates.length === 0) {
              warn(
                `ton-provider: no local record names the provider contract ${contractAddressRaw} was deployed with, ` +
                  `so the contract's own on-chain providers dict was read instead — notifying ${fromChain}, the ` +
                  'provider the contract itself registers (#665).',
              );
            }
            if (fromChain !== provider.pubkey) {
              warn(
                `ton-provider: contract ${contractAddressRaw} was deployed with provider ${fromChain}, but this ` +
                  `run's registry snapshot selected ${provider.pubkey} — notifying ${fromChain}, the one the ` +
                  "contract's own on-chain dict names (#665). To hand this bag to a DIFFERENT provider, register " +
                  'it deliberately with `update-providers` (scripts/go/storage-v1-client) — a retry must not do it ' +
                  'by accident.',
              );
            }
          } else if (attested.length > 1) {
            throw new Error(
              `ton-provider backend: this machine's records disagree about which provider contract ` +
                `${contractAddressRaw} was deployed with (${attested.join(', ')}) — refusing to notify any of them, ` +
                'since `modify_providers` REPLACES rather than merges and notifying the wrong one addresses a ' +
                `provider that may never have held this bag. Reconcile ${PENDING_SPENDS_LOG} and ${RECEIPT_LEDGER}, ` +
                'or re-run `update-providers` (scripts/go/storage-v1-client) to register one deliberately (#665). ' +
                'No funds moved.',
            );
          } else if (recordedPubkey !== null) {
            notifyPubkey = recordedPubkey;
            if (attested.length === 0) {
              warn(
                `ton-provider: the only local record of contract ${contractAddressRaw}'s provider ` +
                  `(${recordedPubkey}) comes from a spend this machine never saw confirm — notifying it as the best ` +
                  'available answer, but it is not proof of what the contract’s on-chain dict names (#665).',
              );
            }
            if (recordedPubkey !== provider.pubkey) {
              warn(
                `ton-provider: contract ${contractAddressRaw} was deployed with provider ${recordedPubkey}, but this ` +
                  `run's registry snapshot selected ${provider.pubkey} — notifying the RECORDED provider ` +
                  `${recordedPubkey}, the one the contract's on-chain dict actually names (#665). To hand this bag ` +
                  'to a DIFFERENT provider, register it deliberately with `update-providers` ' +
                  '(scripts/go/storage-v1-client) — a retry must not do it by accident.',
              );
            }
          } else if (haveSomeRecord || !logsFullyReadable) {
            // Either a record for this exact contract exists but names no usable provider
            // (a hand-edited or foreign line), or several unconfirmed candidates disagree,
            // or a line could not be read at all. Refusing beats guessing: notifying this
            // run's freshly selected provider would address one that may never have held
            // the bag, and no funds move either way on this branch.
            throw new Error(
              `ton-provider backend: contract ${contractAddressRaw} is already funded on-chain and this machine has ` +
                'a record of that spend, but nothing readable names the provider it was deployed with — refusing ' +
                `to notify this run's freshly selected provider ${provider.pubkey}, which may never have held this ` +
                `bag. Check ${PENDING_SPENDS_LOG} / ${RECEIPT_LEDGER} for the contract's own provider pubkey, or ` +
                're-run `update-providers` (scripts/go/storage-v1-client) to register a provider deliberately (#665).',
            );
          } else {
            warn(
              `ton-provider: no local record names the provider contract ${contractAddressRaw} was deployed with ` +
                `(no pending-spend intent, no receipt) — notifying this run's selected provider ${provider.pubkey}, ` +
                'which may not be the one holding the bag. Reading the provider back from the contract itself is ' +
                'issue #665.',
            );
          }

          // #808 recovery candidate. A contract address identifies a CONTRACT, not one
          // spend, so more than one unsettled intent for it is ambiguous — which of them a
          // single receipt would be for cannot be decided from a contract-level
          // observation. That fails closed (record nothing, leave both for doctor and the
          // operator) rather than settling an arbitrary one, which would leave a real
          // transfer represented by no ledger entry at all (multi-model review). Unreadable
          // lines block recovery for the same reason: a receipt may already exist in a line
          // this version could not parse, and writing a second one would overstate spend.
          const unsettled = unsettledIntentsForContract(intents, contractAddressRaw);
          if (unsettled.length > 1) {
            warn(
              `ton-provider: ${unsettled.length} unsettled pending-spend records name contract ${contractAddressRaw} ` +
                '— refusing to decide which of them a receipt would be for. None is being recorded automatically; ' +
                `check the contract on a TON explorer and reconcile ${PENDING_SPENDS_LOG} by hand (#808).`,
            );
          } else if (unsettled.length === 1 && !logsFullyReadable) {
            warn(
              `ton-provider: an unrecorded spend for contract ${contractAddressRaw} cannot be safely recovered while ` +
                `${PENDING_SPENDS_LOG} / ${RECEIPT_LEDGER} contain line(s) this version cannot read — a receipt may ` +
                'already exist in one of them. Not writing one (#808).',
            );
          } else {
            resumable = unsettled[0] ?? null;
          }
        }

        // #808: the durable record goes down BEFORE anything can move funds, so a
        // SIGKILL/OOM/power loss anywhere after the broadcast leaves evidence that a
        // spend was attempted. Refuses the push if it cannot be written, rather than
        // broadcasting a transfer nothing would be able to account for: no funds have
        // moved at this point, and the same artifact re-derives the same bag and contract
        // on a later run, so nothing is lost by stopping here (same "fail closed while it
        // is still free" reasoning as the #805 guard above).
        let intent: SpendIntentRecord | null = null;
        if (!alreadyActive) {
          try {
            intent = await recordSpendIntent({
              backend: 'ton-provider',
              contract_address: contractAddressRaw,
              bag_id: bag.bagId,
              provider_pubkey: provider.pubkey,
              amount_nano: deploy.amountNano.toString(),
              cost_nano: deploy.costNano.toString(),
              deploy_buffer_nano: DEPLOY_BUFFER_NANO.toString(),
              locator: tonProviderLocator(bag.bagId),
            });
          } catch (e) {
            throw new Error(
              `ton-provider backend: could not write the pending-spend record to ${PENDING_SPENDS_LOG} ` +
                `(${errMsg(e)}) — refusing to broadcast a ${deploy.amountNano} nanoTON transfer that nothing would ` +
                'be able to account for if this process died before the receipt reached disk (#808). No funds ' +
                'moved. Fix the path (permissions, a full disk, or CYPHER_BRAIN_RECEIPT_LEDGER pointing somewhere ' +
                'unwritable) and re-run push — the same ciphertext reuses the same bag, so nothing is lost.',
            );
          }
        }
        // Advisory pre-deploy funds check (turbo.ts has the equivalent for its own
        // signer balance, #342) — WARN only, never abort, for BOTH signing paths: a
        // balance read has no freshness guarantee, so it must never be what blocks a
        // push (same posture turbo.ts uses for its non-TTY/unattended callers, now that
        // ton-provider can ALSO run unattended via auto-signing, #396 PR2). Whichever
        // path actually sends the transaction gives its own unambiguous refusal on a
        // real shortfall — a human's Tonkeeper app, or the auto-sign broadcast/on-chain
        // processing itself — so this exists only to save the wait through
        // waitForContractActive() on a spend that was always going to fail. Left
        // unconditional even when alreadyActive (the check above never blocks on it
        // either) — a harmless, still-informative balance read either way.
        // CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 silences it for one run (shared with turbo's
        // check, not a ton-provider-specific flag). Both lines go through warn() (#347),
        // not a raw console.error, so an agent-driven push (MCP) carries this in the
        // result's warnings[] array instead of only ever landing in a background log.
        if (!SKIP_FUNDS_CHECK) {
          try {
            const ownerState = await fetchAccountState(owner);
            if (!Number.isFinite(ownerState.balance)) {
              throw new Error(`tonapi returned a non-numeric balance: ${JSON.stringify(ownerState.balance)}`);
            }
            if (ownerState.balance < Number(deploy.amountNano)) {
              warn(
                `ton-provider: owner ${owner.toString({ bounceable: true })}'s on-chain balance ` +
                  `(${ownerState.balance} nanoTON) looks lower than the ${deploy.amountNano} nanoTON this deploy ` +
                  `needs; the ${autoSignWallet ? 'auto-sign broadcast' : 'Tonkeeper signature'} below may be ` +
                  'rejected for insufficient funds. Fund the wallet first, or set ' +
                  'CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 to silence this check.',
              );
            }
          } catch (e) {
            warn(`ton-provider: could not pre-check the owner's balance (${errMsg(e)}); proceeding`);
          }
        }
        if (alreadyActive) {
          // Nothing to sign or broadcast — see the money-safety comment above.
        } else if (autoSignWallet) {
          console.error(
            `ton-provider: auto-signing with local wallet ${owner.toString({ bounceable: true })} ` +
              '(CYPHER_BRAIN_TON_WALLET) — no Tonkeeper deeplink needed',
          );
          const submitted = { value: false };
          try {
            await autoSignAndBroadcastDeploy(autoSignWallet.wallet, autoSignWallet.secretKey, deploy, submitted);
          } catch (e) {
            // Nothing left this process: a frozen wallet, an unreadable seqno, a
            // StateInit mismatch. No funds can have moved, so this is an ordinary
            // failure and must stay one — probing the contract here would let an
            // unrelated on-chain state turn a refusal into a "confirmed spend".
            if (!submitted.value) {
              // #808: retire the intent explicitly rather than leaving it `pending`
              // forever. This is the one branch that can PROVE no funds moved, so the
              // record it wrote a moment ago is not a possible spend — leaving it as one
              // would give doctor a permanent false finding and hand a later run a
              // candidate to write a phantom receipt from (multi-model review).
              if (intent) {
                await advanceSpendIntent(intent, 'abandoned').catch((markErr) =>
                  warn(
                    `ton-provider: could not retire the pending-spend record for ${contractAddressRaw} after a ` +
                      `broadcast that never left this process (${errMsg(markErr)}) — it will show up in ` +
                      "'cypher-brain doctor' as an unsettled spend even though no funds moved",
                  ),
                );
              }
              throw e;
            }
            // issue #664: a broadcast POST that FAILS can still have landed — tonapi can
            // accept the BOC and then lose the response. Rethrown as-is, the transfer is
            // invisible: put() never reaches waitForContractActive(), so #654's receipt
            // checkpoint never fires, and a later retry hits #638's already-active branch
            // which deliberately writes no receipt (it moved no funds). The spend is then
            // absent from the ledger forever.
            //
            // Probe the derived contract address before letting the error out, the same
            // bounded way the pre-broadcast guard above asks. If it is no longer
            // `nonexist` the transfer DID land: fall through to waitForContractActive()
            // and the normal confirmation/receipt path, which is exactly what would have
            // happened had the response arrived. If the probe cannot say, the outcome is
            // genuinely ambiguous — say so and name the address, rather than let it read
            // as "nothing happened".
            let landed = false;
            for (let attempt = 0; attempt < ALREADY_ACTIVE_CHECK_ATTEMPTS && !landed; attempt++) {
              if (attempt > 0) await sleep(ALREADY_ACTIVE_CHECK_INTERVAL_MS);
              try {
                landed = (await fetchAccountState(deploy.contractAddress)).status !== 'nonexist';
              } catch {
                // one more inconclusive read; keep the remaining attempts
              }
            }
            if (!landed) {
              // #818: a TYPED error, not a plain one — see the identical change on
              // arweave.ts's own ambiguous-POST branch and PushUncertainSpendError's doc
              // comment. The contract address travels as structured data
              // (checkIdentifier) so mcp.ts can persist it under the idempotency key and
              // refuse a same-key retry, instead of releasing the key and letting the
              // retry broadcast a second transfer.
              throw new PushUncertainSpendError({
                backend: 'ton-provider',
                checkKind: 'ton_contract_address',
                checkIdentifier: deploy.contractAddress.toRawString(),
                detail:
                  `broadcasting the deploy failed (${errMsg(e)}) — the transfer of ${deploy.amountNano} nanoTON ` +
                  `to ${deploy.contractAddress.toRawString()} may or may not have been accepted (a probe could ` +
                  'not find the contract, which is not proof it is absent)',
                verifyHint: "the address's state on a TON explorer",
                cause: e,
              });
            }
            // Attribution is inferential, not proven (Codex review): what is observed is
            // that this address read `nonexist` moments ago, immediately before this run
            // broadcast, and does not now. A concurrent push against the SAME bag+owner,
            // or someone funding the address by hand inside that window, would produce
            // the same transition. Correlating the exact message (seqno / balance delta)
            // would settle it and is not done here. The alternative — treating a landed
            // transfer as "nothing happened" — is the strictly worse error, because it
            // is the one that leads to paying twice.
            warn(
              `ton-provider: the deploy broadcast reported a failure (${errMsg(e)}) but contract ` +
                `${deploy.contractAddress.toRawString()} — which read as 'nonexist' immediately before this run ` +
                'broadcast — now shows on-chain activity, so the transfer is treated as having landed despite the ' +
                'error. Continuing with confirmation and the receipt for that spend (#664). If something else ' +
                'funded this exact address inside that window, the receipt below is attributed to this run in error.',
            );
          }
        } else {
          console.error(`ton-provider: sign this to deploy the contract (bag stays seeded locally while you do):`);
          console.error(`  ${deploy.deeplink}`);
        }

        await waitForContractActive(
          deploy.contractAddress,
          alreadyActive ? 'skipped' : autoSignWallet ? 'auto-sign' : 'deeplink',
        );
        console.error(`ton-provider: contract ${deploy.contractAddress.toRawString()} is active on-chain`);

        // issue #654: computed HERE (not re-derived at the old, later `return` site)
        // because it is now needed twice — once for the receipt event immediately
        // below, once for the typed error the notify try/catch further down can throw.
        // tonProviderLocator() is a pure function of bag.bagId alone (see its own
        // definition, module-top) — it does not depend on notify ever succeeding.
        const locator = tonProviderLocator(bag.bagId);

        // #484: ledger's cumulative-cost tracking was arweave/turbo-only despite
        // ton-provider being a real paid backend with its own MAX_SPEND cap (doctor/
        // audit/estimate/schedule already treat it on par with the other backends —
        // ledger was the one place it diverged). `deploy.amountNano` (storage cost +
        // deploy buffer, see the console.error just above buildDeploy()'s call) is the
        // AUTHORITATIVE actual spend, not a pre-flight estimate: waitForContractActive()
        // above has already confirmed the contract is live on-chain, which only happens
        // once the transfer carrying this exact amount has been processed — same
        // "confirmed, not just requested" posture as arweave's signed tx.reward
        // (receipt.ts's own header comment). `raw` is a small normalized summary
        // (ton-provider has no single SDK response object to defer to, same reasoning
        // as arweave's own raw L1 backend).
        //
        // issue #654: called HERE — right after on-chain confirmation, BEFORE
        // notifyProviderWithRetry() below — not after notify succeeds. The spend is
        // already IRREVERSIBLE at this point regardless of whether notify subsequently
        // succeeds, and pushpull.ts's onReceipt callback now persists the receipt
        // durably to disk from INSIDE this awaited call (types.ts's PutOpts doc comment)
        // — so a notify failure right after this line can no longer make an
        // already-spent amount vanish from the ledger (previously: onReceipt only fired
        // after notify succeeded, so a notify timeout meant put() threw before ever
        // reaching it, and the receipt was lost even though the money was already gone).
        //
        // issue #638: skipped when alreadyActive — this run did not actually move any
        // funds (see the money-safety comment above), so `deploy.amountNano` here is a
        // hypothetical recomputation (possibly against a DIFFERENT provider/rate than
        // whichever run actually paid), not an "ACTUAL-cost record" receipt.ts's own
        // contract requires. Recording one would double-count the ledger's cumulative
        // cost for a single real on-chain spend — even if THIS run's notify below goes
        // on to succeed, no new receipt is written (the spend, if any, was already
        // recorded — or never recorded at all — by whichever earlier run actually paid;
        // see issue #654's own follow-up issues for the residual gaps this does not
        // attempt to backfill).
        //
        // #808: the receipt write is STILL not instantaneous (persistReceipt hashes the
        // whole ciphertext first), so the intent recorded before the broadcast is
        // advanced to `confirmed` here — between the irreversible fact and the durable
        // record of it — and only advanced to `settled` once the receipt is verifiably
        // on disk. A crash in that window now leaves a `confirmed` record naming the
        // contract, the provider and the exact amount, which is what lets the
        // already-active branch below finish the job on a later run instead of skipping
        // silently forever.
        if (!alreadyActive) {
          if (intent) intent = await advanceSpendIntent(intent, 'confirmed');
          await opts.onReceipt?.({
            locator,
            raw: {
              contract_address: contractAddressRaw,
              bag_id: bag.bagId,
              provider_pubkey: provider.pubkey,
              cost_nano: deploy.costNano.toString(),
              deploy_buffer_nano: DEPLOY_BUFFER_NANO.toString(),
              amount_nano: deploy.amountNano.toString(),
              // #808: links this receipt back to the pending-spend record written before
              // the broadcast, so settlement is a 1:1 match rather than an inference from
              // the contract address alone.
              ...(intent ? { intent_id: intent.intent_id } : {}),
            },
            // #751: 'nanoTON' (matching estimate.ts's CostEstimate.unit casing) — this
            // used to write lowercase 'nanoton', the one place this physical unit's
            // casing disagreed with every other surface (estimate --json, this file's
            // own comments/errors, the Go client's own output).
            cost: { amount: deploy.amountNano.toString(), unit: 'nanoTON' },
          });
          if (intent) await settleIntentAgainstLedger(intent, contractAddressRaw);
        } else if (resumable !== null) {
          // KNOWN LIMITATION (multi-model review), documented rather than locked: two
          // already-active retries running CONCURRENTLY against the same contract can both
          // read "no receipt yet", both append one, and both settle — overstating the
          // ledger by one entry. The read-check-append is not atomic and this file adds no
          // lock, the same posture the spendTracker's own check-then-charge contract takes
          // a few hundred lines above. Nothing in this codebase produces that overlap:
          // push() awaits each put() to completion, and mcp.ts serializes whole tool calls
          // through its captureCall promise-chain mutex. Two operators pushing the same
          // artifact from the same machine at the same moment could, and would end up with
          // one duplicate ledger line — an over-count that `ledger` shows and `audit` can
          // be reconciled against, not a second spend.
          //
          // #808 recovery. This run moved no funds, so the #638 reasoning that forbids
          // writing a receipt HERE from this run's own recomputed numbers still holds —
          // and is not what happens: every figure below comes from the intent an EARLIER
          // run wrote against the deploy that actually paid, so this is that run's
          // receipt, written late, not a second record of one spend.
          if (priorReceipt !== null) {
            // The earlier run got further than its own record says (appended the receipt,
            // died before marking the intent settled). Nothing is owed but the marker.
            await advanceSpendIntent(resumable, 'settled');
          } else {
            if (resumable.state === 'pending') {
              // The earlier run never observed confirmation — it died, or ended in a #822
              // uncertain-spend refusal. What settles it is the same evidence #664 uses:
              // this address is not `nonexist`. Attribution stays inferential (a
              // concurrent push, or someone funding the address by hand, would look the
              // same), and saying so is better than either silently recording it or
              // silently dropping it.
              warn(
                `ton-provider: a pending-spend record for contract ${contractAddressRaw} was never confirmed by the ` +
                  'run that wrote it, and the contract now shows on-chain activity — treating that spend as having ' +
                  'landed and recording it now. If something else funded this exact address, the receipt is ' +
                  'attributed to that earlier run in error (#808).',
              );
            }
            warn(
              `ton-provider: recording a receipt an earlier run confirmed but never wrote — contract ` +
                `${contractAddressRaw}, ${resumable.amount_nano} nanoTON, provider ${resumable.provider_pubkey} ` +
                `(recorded ${resumable.timestamp}). The spend was already made; the ledger was short by it until ` +
                'now (#808).',
            );
            if (resumable.state !== 'confirmed') resumable = await advanceSpendIntent(resumable, 'confirmed');
            await opts.onReceipt?.({
              locator,
              raw: {
                contract_address: resumable.contract_address,
                bag_id: resumable.bag_id,
                provider_pubkey: resumable.provider_pubkey,
                cost_nano: resumable.cost_nano,
                deploy_buffer_nano: resumable.deploy_buffer_nano,
                amount_nano: resumable.amount_nano,
                intent_id: resumable.intent_id,
                // The one field that is NOT the earlier run's: this receipt is being
                // appended now, by this run, on that run's behalf.
                recorded_by_later_run: true,
              },
              // pending-spend.ts's validator already refuses any record whose
              // `amount_nano` is not a bare integer string (such a line is counted as
              // unreadable, which blocks recovery entirely), so this is always a real
              // amount — the earlier run's own, never a recomputation.
              cost: { amount: resumable.amount_nano, unit: 'nanoTON' },
            });
            await settleIntentAgainstLedger(resumable, contractAddressRaw);
          }
        }

        // issue #654: notify is the only remaining step, and by now the spend above is
        // already durably recorded (or, on a retry, was already durably recorded by an
        // earlier run) — a failure here must be distinguishable from "nothing happened"
        // (a caller assuming the latter, e.g. an MCP idempotency-key retry or an
        // unattended `schedule` re-run, could resend a second real transfer). Thrown as
        // PushFundingConfirmedButIncompleteError, not a plain Error, regardless of
        // alreadyActive: the on-chain funding fact is true either way by this point.
        try {
          // #665: `notifyPubkey`, not `provider.pubkey` — on the already-active branch
          // those differ whenever this run's registry snapshot picked someone other than
          // the provider the contract was actually deployed with (see its resolution
          // above).
          await notifyProviderWithRetry(notifyPubkey, contractAddressRaw, bag.dataSizeBytes);
        } catch (e) {
          throw new PushFundingConfirmedButIncompleteError(locator, e);
        }
        // #652: made explicit here (not just in this file's own doc comments) since this
        // is the line an operator actually sees before their local seed stops — "safe"
        // is the provider's OWN claim, not a cryptographic proof this push verified.
        console.error(
          `ton-provider: provider ${notifyPubkey} reports the full bag downloaded — stopping the local seed ` +
            "(this is the provider's own self-report, not independently verified against a merkle proof or a " +
            'spot-check retrieval — see docs/ton-storage-status.md and issue #652 for the known gap)',
        );

        return locator;
      } finally {
        // Each cleanup step runs regardless of whether the other one throws (Codex
        // review): a daemon.stop() failure must not skip the tmpRoot removal, or a
        // paid-for push leaves both the daemon and its temp directory behind.
        if (daemon) await daemon.stop().catch(() => undefined);
        // Deregister only AFTER rmrf() actually removed the tree (multi-model review,
        // #644) — if cleanup itself fails (EACCES under the dir, say), the entry
        // deliberately STAYS registered so a LATER signal's forceRmSync (chmod+retry)
        // is the one path left that can still clear it. The failure is still swallowed
        // (advisory-only cleanup): a leftover temp dir must never fail an
        // otherwise-successful (or already-failing) push.
        try {
          await rmrf(tmpRoot);
          removeActiveTonTmpDir(tmpRoot);
        } catch {
          /* left registered on purpose — see comment above */
        }
      }
    },

    async get(locator: string, out: string, expect: FetchShape = 'age'): Promise<void> {
      const bagId = bagIdFrom(locator);
      await p2pFetch(bagId, expect, out);
      console.error(`ton-provider: fetched ${bagId} over the TON Storage P2P network (availability proven)`);
    },
  };
}

// Exported so estimate.ts (issue #396) can offer a REAL cost preview before a human is
// ever asked to sign anything — it queries mytonprovider.org and runs the identical
// cost math put() uses, without deploying or spending anything.
export async function estimateTonProviderCost(sizeBytes: number): Promise<{
  costNano: bigint;
  amountNano: bigint;
  provider: ProviderCandidate;
  spanDays: bigint;
  bountyNano: bigint;
  belowBountyFloor: boolean;
}> {
  const candidates = await searchProviders(sizeBytes);
  const provider = selectProvider(candidates);
  const rateNanoPerMB = providerRateNanoPerMB(provider.price);
  const spanDays = spanDaysFor(provider);
  const costNano = storageCostNano(BigInt(sizeBytes), rateNanoPerMB, spanDays);
  const bountyNano = estimatedBountyNano(rateNanoPerMB, BigInt(sizeBytes), spanDays);
  return {
    costNano,
    amountNano: costNano + DEPLOY_BUFFER_NANO,
    provider,
    spanDays,
    bountyNano,
    belowBountyFloor: bountyNano < PROVIDER_BOUNTY_FLOOR_NANO,
  };
}
