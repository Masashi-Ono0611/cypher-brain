// `publish-latest` — opt-in publication of the LATEST ton-backend snapshot's bag id to
// the operator's own .ton DNS domain, so a fresh machine can discover the newest
// encrypted-backup bag from a human-memorable name instead of needing the
// --from-locator-file bytes themselves. NEVER part of the nightly (`schedule install`
// does not touch this file) — a deliberate, operator-invoked action, because it also
// makes the snapshot cadence and current bag id PUBLIC (docs/durability.md).
//
// Record building (TEP-0081 dns_storage_address, magic 0x7473) and the
// change_dns_record transaction body (op 0x4eb1f0f9) are ported from ton-mesh-harness's
// src/dns.ts (buildDnsStorageRecord/storageRecordKey/buildChangeDnsRecordBody) — credit
// where this is borrowed from, same as ton-client.ts credits that project's daemon code.
// The Tonkeeper deeplink shape is ported from that project's src/deeplink.ts.
//
// This module NEVER signs anything: it prints a Tonkeeper transfer deeplink and stops.
// The operator opens it, reviews the transaction in their own wallet, and approves (or
// doesn't) themselves.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TON_BIN, TON_NETWORK_CONFIG, TON_TONAPI_URL, CIPHER_YES } from './config.js';
import { errMsg, exists, rmrf, sdkImportAdvice, sleep } from './util.js';
import { warn } from './warn.js';
import { installStageSignalGuard, addActiveTonTmpDir, removeActiveTonTmpDir } from './signal-guard.js';
import { readSavedLocatorLine } from './pushpull.js';
import { bagIdFrom, tonLocator } from './backends/ton.js';
import { tonAdd, tonDetails, startLocalTonDaemon } from './backends/ton-client.js';
import type { CliOptions } from './types.js';

// How long the availability probe (below) waits for the bag's metadata to arrive via
// DHT and at least one byte to be served before refusing to publish. Deliberately a
// PROBE, not a full download — a brain-sized bag would take minutes to fully fetch, and
// proving the network CAN start serving it is what matters here (get()'s own P2P phase
// in ton.ts is the thing that actually downloads the whole object, on pull).
const AVAILABILITY_PROBE_TIMEOUT_MS = 180_000;

// The gas the DNS-update transaction itself needs, in nanoTON (1 TON = 1e9 nanoTON).
// Mirrors ton-mesh-harness's own `site` record deeplink amount — enough to cover a
// single change_dns_record message with headroom, never enough to be worth padding.
const DNS_UPDATE_GAS_NANO = 20_000_000n; // 0.02 TON

// A SECOND, independent place to look up the same address (multi-model review W1's
// destination-trust mitigation below) — a different service than tonapi, so an operator
// who bothers to check has genuine cross-source corroboration, not a second look at the
// same answer.
const TONVIEWER_BASE = 'https://tonviewer.com';

// --domain: lowercase dot-labels ending in ".ton" (multi-model review S1). Rejects
// mixed case/other TLDs/empty labels up front rather than letting a typo travel all the
// way to a confusing tonapi 404.
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ton$/;

function validateDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(
      `--domain must be a lowercase .ton domain (dot-separated labels of [a-z0-9-], ending in ".ton", e.g. "myname.ton") — got ${JSON.stringify(domain)}`,
    );
  }
}

// --wait: a strict non-negative integer number of seconds, capped at 24h (multi-model
// review S2). The all-digits regex alone rules out NaN/Infinity/negative/decimal/scientific
// notation (Number() would otherwise accept "1e5" or " 5" and silently coerce them).
const MAX_WAIT_SECONDS = 86_400;

function parseWaitSeconds(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `--wait must be a non-negative whole number of seconds (0-${MAX_WAIT_SECONDS}) — got ${JSON.stringify(raw)}`,
    );
  }
  const n = Number(raw);
  if (n > MAX_WAIT_SECONDS) {
    throw new Error(`--wait must be at most ${MAX_WAIT_SECONDS} seconds (24h) — got ${raw}`);
  }
  return n;
}

// TON DNS record keys are SHA256(<record name>) read as a 256-bit unsigned integer
// (TEP-0081). "storage" is the only record this command ever writes.
function storageRecordKey(): bigint {
  const hash = createHash('sha256').update('storage').digest();
  return BigInt(`0x${hash.toString('hex')}`);
}

// Type-only references (erased at build time — see scripts/build.ts's TS stripping —
// so this never forces a runtime import): `typeof import(...)` only needs @ton/ton's
// TYPES resolvable while THIS package is being typechecked/built, not while a consumer
// who never runs `publish-latest` is running the shipped dist/cli.mjs.
type TonModule = typeof import('@ton/ton');
type TonAddress = InstanceType<TonModule['Address']>;
type TonCell = InstanceType<TonModule['Cell']>;
interface TonSdk {
  Address: TonModule['Address'];
  beginCell: TonModule['beginCell'];
}

// Lazily loaded so a `publish-latest` invocation is the only thing that ever needs
// @ton/ton installed (optionalDependency) — exactly the pattern turbo.ts/estimate.ts use
// for @ardrive/turbo-sdk: missing package -> actionable install advice, never a raw
// import crash.
async function loadTonSdk(): Promise<TonSdk> {
  try {
    const { Address, beginCell } = await import('@ton/ton');
    return { Address, beginCell };
  } catch (e) {
    const problem = sdkImportAdvice(e, '@ton/ton');
    if (problem !== null) throw new Error(`publish-latest: ${problem.advice}`);
    throw e;
  }
}

// dns_storage_address#7473 bag_id:bits256 (TEP-0081) — ported from ton-mesh-harness's
// buildDnsStorageRecord. bagId is trusted 64-lowercase-hex here: it always arrives via
// backends/ton.ts's bagIdFrom(), which already enforces that shape.
function buildDnsStorageRecord(sdk: TonSdk, bagId: string): TonCell {
  return sdk
    .beginCell()
    .storeUint(0x7473, 16) // magic: "ts" = TON Storage
    .storeBuffer(Buffer.from(bagId, 'hex')) // 256-bit bag id
    .endCell();
}

// change_dns_record#4eb1f0f9 query_id:uint64 key:uint256 flag:(## 1) value:flag?^Cell —
// ported from ton-mesh-harness's buildChangeDnsRecordBody, specialized to the "storage"
// key (flag=1 always: this command only ever SETS the record, never deletes it).
function buildChangeDnsRecordBody(sdk: TonSdk, bagId: string): TonCell {
  return sdk
    .beginCell()
    .storeUint(0x4eb1f0f9, 32) // op: change_dns_record
    .storeUint(0, 64) // query_id = 0
    .storeUint(storageRecordKey(), 256)
    .storeBit(1) // flag: 1 = set
    .storeRef(buildDnsStorageRecord(sdk, bagId))
    .endCell();
}

// RFC 4648 §5 base64url — Tonkeeper's `bin` transfer-link param expects the message
// body BOC encoded this way (ported from ton-mesh-harness's deeplink.ts).
function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Ported from ton-mesh-harness's buildTonkeeperTransferDeeplink. cypher-brain never
// signs — this link only asks the operator's OWN wallet to.
function buildTonkeeperDeeplink(nftAddr: TonAddress, bodyCell: TonCell): string {
  const addr = nftAddr.toString({ urlSafe: true, bounceable: true });
  const bin = toBase64Url(bodyCell.toBoc());
  const params = new URLSearchParams({ amount: DNS_UPDATE_GAS_NANO.toString(), bin });
  return `https://app.tonkeeper.com/transfer/${addr}?${params.toString()}`;
}

async function tonapiJson<T>(url: string, timeoutMs: number): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`tonapi ${url} -> HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

interface TonApiDnsInfo {
  item?: { address: string };
}

async function resolveDomainNftAddress(sdk: TonSdk, domain: string): Promise<TonAddress> {
  const url = `${TON_TONAPI_URL}/v2/dns/${encodeURIComponent(domain)}`;
  let data: TonApiDnsInfo;
  try {
    data = await tonapiJson<TonApiDnsInfo>(url, 10_000);
  } catch (e) {
    throw new Error(`publish-latest: could not resolve domain "${domain}" via tonapi (${url}): ${errMsg(e)}`);
  }
  if (!data.item?.address) {
    throw new Error(
      `publish-latest: domain "${domain}" has no NFT item address in tonapi's response — make sure you own this .ton domain and it is minted (${url})`,
    );
  }
  return sdk.Address.parse(data.item.address);
}

// TONAPI `/v2/dns/{domain}/resolve` — `storage` is observed live as a plain hex string
// (ton-mesh-harness's dns.ts also defensively accepts a legacy `{bag_id}` object shape;
// mirrored here for the same reason).
interface TonApiDnsRecord {
  storage?: string | { bag_id?: string };
}

async function resolvedStorageBagId(domain: string): Promise<string | null> {
  const url = `${TON_TONAPI_URL}/v2/dns/${encodeURIComponent(domain)}/resolve`;
  try {
    const data = await tonapiJson<TonApiDnsRecord>(url, 5_000);
    const s = data.storage;
    if (!s) return null;
    if (typeof s === 'string') return s.toLowerCase();
    if (typeof s.bag_id === 'string') return s.bag_id.toLowerCase();
    return null;
  } catch {
    return null; // best-effort poll target — a flaky read just means "not yet"
  }
}

// The availability gate (required before anything is printed for signing): prove the
// bag is actually discoverable + served on the P2P network RIGHT NOW, via the same
// ephemeral local daemon get()'s P2P phase (ton.ts) uses — tonAdd, then poll tonDetails
// until info_loaded (metadata found via DHT) AND downloaded > 0 (at least one byte
// served, proving a reachable seeder). This is a PROBE, not a full download: a
// brain-sized bag would take minutes to fully fetch, and first bytes are enough to prove
// reachability. Any failure (the daemon can't even start, the bag is not on the mock/
// real network, no metadata/bytes within the timeout) is refused with the SAME "DNS must
// never point at an unavailable bag" wording, so a caller/selftest greps one message
// regardless of which sub-step failed.
//
// Timeout budget (multi-model review W3): `deadline` is computed ONCE, before the tmp
// dir/daemon even exist, and covers the WHOLE probe — daemon startup included — not just
// the poll loop, so a slow startLocalTonDaemon start-up (its own internal bounds: up to
// ~30s config-gen + ~30s ready-wait, ~60s worst case) eats into the SAME 180s budget
// rather than stacking on top of it. Honest worst-case total for this function: the
// ~180s deadline, plus at most one more in-flight tonAdd/tonDetails HTTP call
// (CYPHER_BRAIN_TON_HTTP_TIMEOUT, default 30s) that can straddle the deadline before the
// loop gets to re-check it, plus daemon.stop()'s own bound (killAndWait in
// ton-client.ts, ~5s) — under 4 minutes, never the ~240s a naive "60s startup + 180s
// poll, stacked" reading would suggest.
async function assertBagAvailable(bagId: string): Promise<void> {
  const deadline = Date.now() + AVAILABILITY_PROBE_TIMEOUT_MS;
  // #644: publish-latest never installs the signal guard on its own (unlike snapshot()/
  // restore()'s own self-install) — installStageSignalGuard() is idempotent, so calling
  // it here, before the tmp dir even exists, is what makes a SIGINT/SIGTERM/SIGHUP mid-
  // probe actually kill the ephemeral daemon this probe spawns (ACTIVE_CHILDREN, already
  // registered by ton-client.ts's spawnDaemon) and sweep this directory.
  installStageSignalGuard();
  // Same outer-try-owns-tmp-dir / inner-try-owns-daemon-stop shape as ton.ts's own
  // p2pFetch/p2pFetchInto (multi-model review W2 there, mirrored here): the tmp dir is
  // created BEFORE the daemon starts and removed only AFTER daemon.stop() has been
  // awaited — a still-dying daemon writing into a directory mid-removal is a race.
  const tmpRoot = await mkdtemp(join(tmpdir(), 'cypher-brain-ton-dns-'));
  addActiveTonTmpDir(tmpRoot);
  try {
    await probeInto(tmpRoot, bagId, deadline);
  } catch (e) {
    throw new Error(
      `publish-latest: bag ${bagId} does not appear discoverable and served on the TON Storage P2P network right now (${errMsg(e)}) — ` +
        `DNS must never point at an unavailable bag. Confirm your seeder is up and reachable, then retry.`,
    );
  } finally {
    // Cleanup failure must not be silently swallowed (multi-model review W2): it does
    // not change the PASS/FAIL verdict above (already decided), but an operator running
    // many publish-latest calls deserves to know disk is being left behind.
    await rmrf(tmpRoot).catch((e) => warn(`publish-latest: could not remove temp probe dir ${tmpRoot}: ${errMsg(e)}`));
    removeActiveTonTmpDir(tmpRoot);
  }
}

async function probeInto(tmpRoot: string, bagId: string, deadline: number): Promise<void> {
  const dbDir = join(tmpRoot, 'db');
  const dlDir = join(tmpRoot, 'dl');
  await mkdir(dbDir, { recursive: true });
  await mkdir(dlDir, { recursive: true });
  const daemon = await startLocalTonDaemon(TON_BIN, dbDir, TON_NETWORK_CONFIG || undefined);
  try {
    await tonAdd(daemon.apiUrl, { bag_id: bagId, path: dlDir });
    for (;;) {
      const d = await tonDetails(daemon.apiUrl, bagId);
      if (d.info_loaded && d.downloaded > 0) return;
      if (Date.now() > deadline) {
        throw new Error(`no metadata/bytes served within the ${AVAILABILITY_PROBE_TIMEOUT_MS}ms probe budget`);
      }
      await sleep(1000);
    }
  } finally {
    // Await the exit before the caller removes tmpRoot — same reasoning as ton.ts's
    // p2pFetchInto: a still-dying daemon writing into a directory mid-removal is a race.
    await daemon.stop();
  }
}

export async function publishLatest(o: CliOptions): Promise<void> {
  if (!o.domain) throw new Error('--domain <name>.ton required');
  validateDomain(o.domain);
  const waitS = parseWaitSeconds(o.wait);
  if (!o.from_locator_file) throw new Error('--from-locator-file <path> required (written by push --save-locator)');
  // #482: distinguish "file missing" from "file has no valid locator" — same two
  // failure modes pull's --from-locator-file already separates (pushpull.ts, pull()),
  // instead of collapsing both into readSavedLocatorLine's generic null.
  if (!(await exists(o.from_locator_file))) throw new Error(`no such locator file: ${o.from_locator_file}`);
  const saved = await readSavedLocatorLine(o.from_locator_file);
  if (!saved) {
    throw new Error(
      `${o.from_locator_file} has no locator line — run a push with --save-locator first, and point ` +
        '--from-locator-file at the file it wrote',
    );
  }
  if (saved.backend !== 'ton') {
    throw new Error(
      `publish-latest only works with the ton backend — ${o.from_locator_file} records backend "${saved.backend}" (locator: ${saved.locator})`,
    );
  }
  const bagId = bagIdFrom(saved.locator); // throws on a non ton:v1:<64-hex> locator
  const domain = o.domain;

  console.error(
    `publish-latest: probing whether ${tonLocator(bagId)} is discoverable and served right now (not a full download)...`,
  );
  await assertBagAvailable(bagId);
  console.error(`publish-latest: bag ${bagId} is reachable — metadata found via DHT, at least one byte served.`);

  const sdk = await loadTonSdk();
  const nftAddr = await resolveDomainNftAddress(sdk, domain);
  const nftAddrStr = nftAddr.toString({ urlSafe: true, bounceable: true });
  const body = buildChangeDnsRecordBody(sdk, bagId);

  console.error(`Domain: ${domain}`);
  console.error(`NFT address: ${nftAddrStr}`);
  console.error(`  view on tonviewer: ${TONVIEWER_BASE}/${nftAddrStr}`);
  console.error(`Bag id: ${bagId}`);
  // Destination-trust disclosure (multi-model review W1): tonapi is the SOLE source of
  // the domain -> NFT ADDRESS mapping above (the Tonkeeper transfer's actual
  // destination). We looked for a genuinely independent on-chain cross-check —
  // ton-mesh-harness's src/sdk/dns-onchain.ts (resolveStorageRecordOnChain, calling the
  // `dnsresolve` get-method directly via Toncenter's TonClient, bypassing tonapi) — but
  // it does not solve THIS problem: it verifies a domain NFT's OWN "storage" record
  // given an ALREADY-KNOWN nftAddress, and even that project's own domain -> NFT-address
  // resolution (dns-helpers.ts's getDomainNftAddress) is itself sourced from tonapi —
  // there is no independent domain -> NFT-address resolver to port. Cross-checking
  // against the SAME source would be theater, so instead: disclose it plainly, and give
  // the operator a SECOND, different-vendor surface (tonviewer.com, printed above) to
  // manually corroborate before they approve anything in their wallet.
  warn(
    `publish-latest: the NFT address above came from tonapi.io and is NOT independently verified on-chain here — ` +
      `before approving in Tonkeeper, confirm the recipient address it shows equals ${nftAddrStr} (cross-check ` +
      `against ${TONVIEWER_BASE}/${nftAddrStr}, a different service). Do not approve if they differ.`,
  );
  console.error(
    'cypher-brain never signs transactions — the deeplink below only asks YOUR OWN wallet to review and approve a ' +
      'change_dns_record update to this domain\'s "storage" record. Nothing is sent unless you approve it yourself.',
  );

  const yes = !!o.yes || CIPHER_YES;
  if (!yes) {
    throw new Error(
      `publish-latest: opening and approving the Tonkeeper transfer link spends ~0.02 TON gas from your wallet to update ` +
        `${domain}'s DNS storage record — re-run with --yes or set CYPHER_BRAIN_YES=1 to confirm you want to see it ` +
        `(cypher-brain itself never signs anything; this only gates PRINTING the link).`,
    );
  }

  const deeplink = buildTonkeeperDeeplink(nftAddr, body);
  console.log(deeplink); // stdout = the deeplink only, so a script can capture it

  if (waitS > 0) {
    console.error(
      `publish-latest: waiting up to ${waitS}s for ${domain}'s DNS storage record to resolve to ${bagId}...`,
    );
    const deadline = Date.now() + waitS * 1000;
    let confirmed = false;
    for (;;) {
      const current = await resolvedStorageBagId(domain);
      if (current === bagId) {
        confirmed = true;
        break;
      }
      if (Date.now() > deadline) break;
      await sleep(Math.min(10_000, Math.max(0, deadline - Date.now())));
    }
    console.error(
      confirmed
        ? `CONFIRMED: ${domain}'s DNS storage record now resolves to ${bagId}`
        : `NOT-YET: ${domain}'s DNS storage record did not resolve to ${bagId} within ${waitS}s (the on-chain update may still be pending — approve the deeplink above if you have not, then check again with a longer --wait)`,
    );
  }
}
