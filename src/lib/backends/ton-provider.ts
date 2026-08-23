// ton-provider backend: pays a live TON Storage market provider (the current Go/
// StorageV1 scheme, self-registered via mytonprovider.org) to hold the bag — issue
// #396's "the real option 2 general users need", as distinct from ton.ts's self-hosted-
// seeder-only mode. A user with no always-on box of their own can still use TON
// Storage: this backend deploys a per-bag StorageV1 contract, has a chosen provider
// fetch the bag over P2P, and the provider is who keeps it available afterward — the
// same "pay once, don't operate infrastructure yourself" shape arweave/turbo already
// have, not a self-hosted "sovereignty lane" (that stays ton.ts's job).
//
// PR1 scope (issue #396 Phase A) — what this does NOT do yet:
//   - No local TON wallet: the StorageV1 deploy is signed via a Tonkeeper deeplink,
//     same as this project's own dogfooding (docs/ton-storage-status.md). Unlike
//     arweave/turbo's wallet.ts (a locally-held JWK signs with no human in the loop,
//     which is what lets THOSE backends run under `schedule install`), push()ing this
//     backend requires an interactive human present to approve in their wallet app.
//     Fully automated signing (a TON-side wallet.ts equivalent) is a separate PR.
//   - Provider-payment mode only: the self-hosted ton.ts backend is unchanged and
//     stays the "sovereignty" path for operators who want to run their own seeder.
//   - No wizard/--help/estimate/README symmetry work (issue #396 Phase B) — this PR
//     only makes `--backend ton-provider` a real, working capability.
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
import type { Builder as TonBuilder, Slice as TonSlice, Address as TonAddress, Cell as TonCell } from '@ton/ton';
import {
  TON_PROVIDER_OWNER,
  TON_PROVIDER_MAX_SPEND,
  TON_PROVIDER_NOTIFY_BIN,
  TON_PROVIDER_MYTONPROVIDER_URL,
  TON_PROVIDER_NOTIFY_RETRY_MS,
  TON_PROVIDER_NOTIFY_INTERVAL_MS,
  TON_TONAPI_URL,
  TON_BIN,
  TON_NETWORK_CONFIG,
} from '../config.js';
import { run } from '../proc.js';
import { sleep, rmrf, errMsg, SdkMissingError, sdkImportAdvice } from '../util.js';
import { tonApi, startLocalTonDaemon, type TonBagDetails, type LocalTonDaemon } from './ton-client.js';
import { p2pFetch, entryNameFor } from './ton.js';
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
    const problem = sdkImportAdvice(e, '@ton/ton');
    if (problem?.kind === 'absent') throw new SdkMissingError(`ton-provider: ${problem.advice}`);
    if (problem !== null) throw new Error(`ton-provider: ${problem.advice}`);
    throw e;
  }
}

// ---------- locator ----------
const LOCATOR_RE = /^ton-provider:v1:([0-9a-f]{64})$/;
export const tonProviderLocator = (bagId: string): string => `ton-provider:v1:${bagId.toLowerCase()}`;
export function bagIdFrom(locator: string): string {
  const m = LOCATOR_RE.exec(locator);
  if (!m)
    throw new Error(
      `ton-provider backend: locator does not match the expected ton-provider:v1:<64-hex-bag-id> shape: ${locator}`,
    );
  return m[1];
}

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

const DEPLOY_CONFIRM_TIMEOUT_MS = 20 * 60_000; // human has to open their wallet and approve — generous
const DEPLOY_POLL_INTERVAL_MS = 5_000;

// Waits for the operator to sign the deeplink and for the deploy to land, by polling
// tonapi's account-state endpoint until it reports 'active'. Bounded (20 min): a human
// is on the other end of this, not a script, so timing out is a real, expected outcome
// (the operator can re-run push once they have signed), not a bug.
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
async function waitForContractActive(addr: TonAddress): Promise<void> {
  const deadline = Date.now() + DEPLOY_CONFIRM_TIMEOUT_MS;
  for (;;) {
    const acc = await fetchAccountState(addr).catch(() => null); // tonapi indexing lag / transient errors: keep polling, don't abort on one bad read
    if (acc?.status === 'active') return;
    if (Date.now() > deadline) {
      throw new Error(
        `ton-provider backend: contract ${addr.toRawString()} did not become active on-chain within ` +
          `${DEPLOY_CONFIRM_TIMEOUT_MS}ms — sign the deeplink printed above, then re-run push (the same ` +
          'ciphertext will resolve to the same bag id and reuse this bag).',
      );
    }
    await sleep(DEPLOY_POLL_INTERVAL_MS);
  }
}

// ---------- notify (shells out to scripts/go/storage-v1-client — see header) ----------
export interface NotifyResult {
  status: string;
  downloaded: bigint;
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
  return { status, downloaded: downloadedRaw ? BigInt(downloadedRaw) : 0n };
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
    const { out } = await run(
      TON_PROVIDER_NOTIFY_BIN,
      ['notify', '--provider-pubkey', providerPubkeyHex, '--contract', contractAddrRaw, '--mainnet'],
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
  for (;;) {
    try {
      const res = await notifyProvider(providerPubkeyHex, contractAddrRaw);
      if (res.downloaded >= dataSizeBytes) return;
      console.error(`ton-provider: provider has ${res.downloaded}/${dataSizeBytes} bytes so far — waiting`);
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
    async put(file: string, _opts: PutOpts = {}): Promise<string> {
      if (!TON_PROVIDER_OWNER) {
        throw new Error(
          'ton-provider backend: CYPHER_BRAIN_TON_PROVIDER_OWNER (the TON wallet address that will own the ' +
            'deployed contract) is required to push',
        );
      }
      const { Address } = await getTon();
      let owner: TonAddress;
      try {
        owner = Address.parse(TON_PROVIDER_OWNER);
      } catch {
        throw new Error(
          `ton-provider backend: CYPHER_BRAIN_TON_PROVIDER_OWNER is not a valid TON address: ${TON_PROVIDER_OWNER}`,
        );
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
        console.error(`ton-provider: sign this to deploy the contract (bag stays seeded locally while you do):`);
        console.error(`  ${deploy.deeplink}`);

        await waitForContractActive(deploy.contractAddress);
        console.error(`ton-provider: contract ${deploy.contractAddress.toRawString()} is active on-chain`);

        await notifyProviderWithRetry(provider.pubkey, deploy.contractAddress.toRawString(), bag.dataSizeBytes);
        console.error(`ton-provider: provider ${provider.pubkey} has the full bag — safe to stop the local seed`);

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
}> {
  const candidates = await searchProviders(sizeBytes);
  const provider = selectProvider(candidates);
  const rateNanoPerMB = providerRateNanoPerMB(provider.price);
  const spanDays = spanDaysFor(provider);
  const costNano = storageCostNano(BigInt(sizeBytes), rateNanoPerMB, spanDays);
  return { costNano, amountNano: costNano + DEPLOY_BUFFER_NANO, provider, spanDays };
}
