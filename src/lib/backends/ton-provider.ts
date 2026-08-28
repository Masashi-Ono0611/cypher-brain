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
import { mkdir, mkdtemp, copyFile, access } from 'node:fs/promises';
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
} from '../config.js';
import { run } from '../proc.js';
import { sleep, rmrf, errMsg, throwForSdkImport, makeBagLocator } from '../util.js';
import { warn } from '../warn.js';
import { tonApi, startLocalTonDaemon, type TonBagDetails, type LocalTonDaemon } from './ton-client.js';
import { p2pFetch, entryNameFor } from './ton.js';
import { progressReporter } from '../progress.js';
import { tonWalletConfigured, loadTonWallet } from '../wallet.js';
import type { StorageBackend, PutOpts, FetchShape } from '../types.js';

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
async function autoSignAndBroadcastDeploy(
  wallet: TonWalletContractV4,
  secretKey: Buffer,
  deploy: BuildDeployResult,
): Promise<void> {
  const { beginCell, contractAddress, external, internal, loadStateInit, SendMode, storeMessage } = await getTon();

  const parsedInit = loadStateInit(deploy.stateInit.beginParse());
  if (!contractAddress(0, parsedInit).equals(deploy.contractAddress)) {
    throw new Error(
      'ton-provider backend: StorageV1 StateInit/address mismatch after loadStateInit() round-trip — ' +
        'auto-sign aborted before spending anything',
    );
  }

  const walletState = await fetchAccountState(wallet.address).catch(() => null);
  if (walletState?.status === 'frozen') {
    throw new Error(
      `ton-provider backend: local wallet ${wallet.address.toRawString()} is frozen on-chain — cannot auto-sign`,
    );
  }
  const walletActive = walletState?.status === 'active';
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
// `isAutoSign` distinguishes the two ways put() can reach this call (#480): with
// CYPHER_BRAIN_TON_WALLET configured, put() already signed and broadcast the deploy
// itself and printed NO deeplink ("no Tonkeeper deeplink needed") — so a timeout here
// must NOT tell the operator to "sign the deeplink printed above" (issue #480: that
// instruction is inapplicable, and was actively misleading, on this exact path). The
// most likely real cause on the auto-sign path is the wallet not having enough TON to
// cover gas — tonapi's broadcast endpoint accepts (HTTP 200) a doomed transaction just as
// readily as a good one, so "broadcast succeeded" proves nothing about "will confirm".
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
async function waitForContractActive(addr: TonAddress, isAutoSign: boolean): Promise<void> {
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
      const remediation = isAutoSign
        ? "the auto-signed broadcast may not have landed — check the wallet's TON balance and this " +
          "address's transaction history on a TON explorer (a common cause is the wallet not holding enough " +
          "TON to cover gas; tonapi's broadcast endpoint accepts a doomed transaction the same as a good one), " +
          'then re-run push'
        : 'sign the deeplink printed above, then re-run push';
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
  const status = /^\s*status:\s*(\S+)/m.exec(out)?.[1] ?? 'unknown';
  const downloadedRaw = /^\s*downloaded:\s*(\d+)\s*bytes/m.exec(out)?.[1];
  const reason = /^\s*reason:\s*(.*)$/m.exec(out)?.[1]?.trim() ?? '';
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
  for (;;) {
    try {
      const res = await notifyProvider(providerPubkeyHex, contractAddrRaw);
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
      const tmpRoot = await mkdtemp(join(tmpdir(), 'cypher-brain-ton-provider-'));
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

        const deploy = await buildDeploy({
          bagId: Buffer.from(bag.bagId, 'hex'),
          merkleHash: bag.merkleHash,
          dataSizeBytes: bag.dataSizeBytes,
          pieceSize: bag.pieceSize,
          owner,
          providerPubkey: Buffer.from(provider.pubkey, 'hex'),
          rateNanoPerMB,
          spanDays,
          maxSpendNano: TON_PROVIDER_MAX_SPEND,
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
        // 10-minute notify timeout.
        const bounty = estimatedBountyNano(rateNanoPerMB, bag.dataSizeBytes, spanDays);
        if (bounty < PROVIDER_BOUNTY_FLOOR_NANO) {
          warn(
            `ton-provider: the computed bounty for this deploy (${bounty} nanoTON, from rate ${rateNanoPerMB} ` +
              `nanoTON/MB/day × ${bag.dataSizeBytes} bytes × ${spanDays} day(s)) looks BELOW the ~${PROVIDER_BOUNTY_FLOOR_NANO} ` +
              "nanoTON floor providers built on tonutils-storage-provider enforce — this specific provider's notify " +
              'may refuse to ever fetch the bag even though the deploy itself will still succeed and be paid for. ' +
              'A bigger bag, a longer span, or a higher rate would raise this estimate.',
          );
        }
        // Advisory pre-deploy funds check (turbo.ts has the equivalent for its own
        // signer balance, #342) — WARN only, never abort, for BOTH signing paths: a
        // balance read has no freshness guarantee, so it must never be what blocks a
        // push (same posture turbo.ts uses for its non-TTY/unattended callers, now that
        // ton-provider can ALSO run unattended via auto-signing, #396 PR2). Whichever
        // path actually sends the transaction gives its own unambiguous refusal on a
        // real shortfall — a human's Tonkeeper app, or the auto-sign broadcast/on-chain
        // processing itself — so this exists only to save the wait through
        // waitForContractActive() on a spend that was always going to fail.
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
        if (autoSignWallet) {
          console.error(
            `ton-provider: auto-signing with local wallet ${owner.toString({ bounceable: true })} ` +
              '(CYPHER_BRAIN_TON_WALLET) — no Tonkeeper deeplink needed',
          );
          await autoSignAndBroadcastDeploy(autoSignWallet.wallet, autoSignWallet.secretKey, deploy);
        } else {
          console.error(`ton-provider: sign this to deploy the contract (bag stays seeded locally while you do):`);
          console.error(`  ${deploy.deeplink}`);
        }

        await waitForContractActive(deploy.contractAddress, Boolean(autoSignWallet));
        console.error(`ton-provider: contract ${deploy.contractAddress.toRawString()} is active on-chain`);

        await notifyProviderWithRetry(provider.pubkey, deploy.contractAddress.toRawString(), bag.dataSizeBytes);
        console.error(`ton-provider: provider ${provider.pubkey} has the full bag — safe to stop the local seed`);

        // #484: ledger's cumulative-cost tracking was arweave/turbo-only despite
        // ton-provider being a real paid backend with its own MAX_SPEND cap (doctor/
        // audit/estimate/schedule already treat it on par with the other backends —
        // ledger was the one place it diverged). `deploy.amountNano` (storage cost +
        // deploy buffer, see the console.error just above buildDeploy()'s call) is the
        // AUTHORITATIVE actual spend, not a pre-flight estimate: by this point
        // waitForContractActive() has already confirmed the contract is live on-chain,
        // which only happens once the transfer carrying this exact amount has been
        // processed — same "confirmed, not just requested" posture as arweave's signed
        // tx.reward (receipt.ts's own header comment). `raw` is a small normalized
        // summary (ton-provider has no single SDK response object to defer to, same
        // reasoning as arweave's own raw L1 backend).
        opts.onReceipt?.(
          {
            contract_address: deploy.contractAddress.toRawString(),
            bag_id: bag.bagId,
            provider_pubkey: provider.pubkey,
            cost_nano: deploy.costNano.toString(),
            deploy_buffer_nano: DEPLOY_BUFFER_NANO.toString(),
            amount_nano: deploy.amountNano.toString(),
          },
          { amount: deploy.amountNano.toString(), unit: 'nanoton' },
        );

        return tonProviderLocator(bag.bagId);
      } finally {
        // Each cleanup step runs regardless of whether the other one throws (Codex
        // review): a daemon.stop() failure must not skip the tmpRoot removal, or a
        // paid-for push leaves both the daemon and its temp directory behind.
        if (daemon) await daemon.stop().catch(() => undefined);
        await rmrf(tmpRoot).catch(() => undefined);
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
