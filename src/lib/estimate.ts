// Cost-estimation math, shared by every surface that needs it: the CLI `estimate`
// command below, the MCP `estimate_cost` tool (src/mcp.ts), and the paid backends'
// own pre-flight cost estimate (src/lib/backends/{arweave,turbo}.ts, via arUsdRate/
// usdApprox) — one home so this math is never re-implemented per surface (#159).
import { stat } from 'node:fs/promises';
import {
  AR_HOST,
  AR_PORT,
  AR_PROTOCOL,
  AR_HTTP_TIMEOUT_MS,
  AR_USD_RATE_URL,
  AR_TURBO_RATES_URL,
  TON_TONAPI_URL,
  TON_WALLET,
} from './config.js';
import { requireFile, errMsg, fmtBytes, sdkImportAdvice, exists, sha256, importQuietly } from './util.js';
import { printJson } from './ui.js';
import { buildPlan, writePlanFile, readRecipientsFingerprint } from './plan.js';
import { didYouMean, nearestName } from './suggest.js';
import { UsageError } from './errors.js';
import { STORAGE_BACKEND_NAMES, type CliOptions } from './types.js';
import { signedDataItemSize } from './backends/ans104.js';

// Every field is REQUIRED and nullable rather than optional (#268): a `--json`
// consumer — the whole point of #211 — gets one stable object shape, so
// `est.unit === null` reads as "this backend prices in no native unit" instead of
// looking like a bug in the caller. These keys used to be dropped entirely for the
// free backends and for turbo-without-the-SDK, which contradicted --help's
// "field-for-field identical to what estimate_cost returns" and was already
// inconsistent with `cost`, which has always been emitted as null when unknown.
export interface CostEstimate {
  backend: string;
  size_bytes: number;
  cost: string | null; // native units (winc/winston/nanoTON), "0" for file, or null when unavailable
  unit: 'winc' | 'winston' | 'nanoTON' | null; // null: no native unit for this backend, or the query failed
  approx_ar: number | null;
  usd_estimate: number | null; // null when the USD/AR rate could not be fetched
  note: string;
  // #749: machine-detectable risk flags alongside `note`'s free-text prose — e.g. the
  // ton-provider bounty-floor warning below, which used to be discoverable only by
  // grepping `note` for a fixed substring (fragile, undocumented). Always an array,
  // possibly empty, never optional/null — same "one stable shape" contract as every
  // other field here (#268): a caller checks `warnings.length`, never whether the key
  // exists at all.
  warnings: string[];
}

// What the per-backend branches below actually build: the priced ones set unit/
// approx_ar (and usd_estimate when a rate was fetchable), the free and
// unavailable ones set none of them. estimateCost() normalizes every branch's
// result to the full CostEstimate shape in ONE place, so a future backend branch
// cannot forget a key and quietly reintroduce the drifting shape #268 fixed.
type PartialCostEstimate = Omit<CostEstimate, 'unit' | 'approx_ar' | 'usd_estimate' | 'warnings'> &
  Partial<Pick<CostEstimate, 'unit' | 'approx_ar' | 'usd_estimate' | 'warnings'>>;

// Current USD price of 1 AR via a plain, unauthenticated GET against Turbo's public
// rate endpoint (AR_USD_RATE_URL — no @ardrive/turbo-sdk involved, #170: that SDK is an
// optional peerDependency most installs don't have, and this is just one public JSON
// endpoint under it). winc is pegged 1:1 to winston; 1 AR = 1e12 of either, so one rate
// converts both. Returns a positive number or null on ANY failure — non-200, malformed
// JSON, non-finite/non-positive rate, network error, timeout — and is raced against
// AR_HTTP_TIMEOUT_MS: the USD line is a courtesy estimate that must never block, fail,
// or stall a push (or an estimate).
export async function arUsdRate(): Promise<number | null> {
  try {
    const ctl = AbortSignal.timeout(AR_HTTP_TIMEOUT_MS);
    const res = await fetch(AR_USD_RATE_URL, { signal: ctl });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const rate = Number((body as { rate?: unknown } | null)?.rate);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

// "~$X USD" for a native amount (winc or winston) at the given USD/AR rate.
// More decimals for sub-cent estimates so a tiny nightly push isn't shown as $0.00.
export const usdApprox = (nativeAmount: bigint | number, rate: number): string => {
  const usd = (Number(nativeAmount) / 1e12) * rate;
  return `~$${usd.toFixed(usd >= 0.01 ? 2 : 6)} USD`;
};

// What a winc actually COSTS in USD, from Turbo's own price sheet (#343). Measured
// motivation: a real 459 MB push printed "~$8.71 USD (at ~$1.81/AR)" — the AR-spot value
// of the winc — while the credits it consumed had been bought minutes earlier at Turbo's
// fiat rate for ≈$13.1, a ~35% understatement. Turbo sells winc at `GET /v1/rates`
// ({ winc: <winc per GiB>, fiat: { usd: <USD per GiB>, ... } }, fees included), so
// usd-per-winc is fiat.usd / winc. Returned SCALED to "USD per 1e12 winc" — the same
// unit arUsdRate() uses for winston — so every existing usdApprox()/rate parameter
// consumes either rate unchanged, and the two stay distinguishable only by which
// fetcher produced them, not by unit gymnastics at each call site.
//
// The distinction is per-BACKEND and deliberate: the raw `arweave` L1 backend spends
// actual AR, where the spot rate IS the truthful price — it keeps arUsdRate(). Only the
// turbo backend (and the wallet-balance view of turbo credits) prices with this.
// Same never-throw/timeout posture as arUsdRate: a dead pricing endpoint may cost the
// USD line, never the push.
export async function turboUsdRate(): Promise<{ ratePer1e12Winc: number; usdPerGiB: number } | null> {
  try {
    const ctl = AbortSignal.timeout(AR_HTTP_TIMEOUT_MS);
    const res = await fetch(AR_TURBO_RATES_URL, { signal: ctl });
    if (!res.ok) return null;
    const body = (await res.json()) as { winc?: unknown; fiat?: { usd?: unknown } } | null;
    // winc arrives as a decimal string (same wire convention as everywhere else on this
    // service); a malformed one must yield null, not NaN-derived garbage in a USD line.
    const wincPerGiB = typeof body?.winc === 'string' && /^\d+$/.test(body.winc) ? Number(body.winc) : Number.NaN;
    // typeof-checked, not coerced: Number(true) is 1 and Number("1") is 1, so a
    // malformed sheet could otherwise launder a wrong type into a plausible rate
    // (Codex review round 2).
    const usdPerGiB = typeof body?.fiat?.usd === 'number' ? body.fiat.usd : Number.NaN;
    if (!Number.isFinite(wincPerGiB) || wincPerGiB <= 0 || !Number.isFinite(usdPerGiB) || usdPerGiB <= 0) return null;
    // A winc past Number's integer precision would make the division quietly wrong, and
    // the DERIVED rate needs its own finite/positive gate: valid-looking inputs can
    // still overflow or round to 0 across the arithmetic, and a USD line built from
    // Infinity or 0 is worse than no line (Codex review).
    if (wincPerGiB > Number.MAX_SAFE_INTEGER) return null;
    const ratePer1e12Winc = (usdPerGiB / wincPerGiB) * 1e12;
    if (!Number.isFinite(ratePer1e12Winc) || ratePer1e12Winc <= 0) return null;
    return { ratePer1e12Winc, usdPerGiB };
  } catch {
    return null;
  }
}

// Current USD price of 1 TON, via tonapi's public rates endpoint — the SAME host
// ton-provider.ts's own on-chain status polling already talks to (TON_TONAPI_URL,
// overridable together with it for tests), so this needs no dedicated new config
// variable the way arUsdRate()'s AR_USD_RATE_URL does (Arweave's USD rate and
// gateway host are genuinely different services; tonapi.io serves both account
// state AND rates). Same never-throw/timeout/positive-finite-only contract as
// arUsdRate()/turboUsdRate(): a dead or malformed rate response degrades the
// ton-provider estimate to "no USD line", never to a failed estimate.
export async function tonUsdRate(): Promise<number | null> {
  try {
    const ctl = AbortSignal.timeout(AR_HTTP_TIMEOUT_MS);
    const res = await fetch(`${TON_TONAPI_URL}/v2/rates?tokens=ton&currencies=usd`, { signal: ctl });
    if (!res.ok) return null;
    const body = (await res.json()) as { rates?: { TON?: { prices?: { USD?: unknown } } } } | null;
    const rate = Number(body?.rates?.TON?.prices?.USD);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

// Estimate what pushing `sizeBytes` to `backend` would cost, WITHOUT uploading
// anything (price queries only). `backend` must be one of STORAGE_BACKEND_NAMES
// (types.ts) — any other value is a caller bug (mcp.ts validates via requireBackend
// before calling this; the CLI estimate() below validates too), so it is rejected
// explicitly rather than silently falling through to the arweave branch.
export async function estimateCost(backend: string, sizeBytes: number): Promise<CostEstimate> {
  const e = await estimateCostFor(backend, sizeBytes);
  // The single normalization point described on PartialCostEstimate above. Written
  // out key by key rather than spread over defaults so the emitted JSON also comes
  // out in the order --help and the estimate_cost tool description list the fields.
  return {
    backend: e.backend,
    size_bytes: e.size_bytes,
    cost: e.cost,
    unit: e.unit ?? null,
    approx_ar: e.approx_ar ?? null,
    usd_estimate: e.usd_estimate ?? null,
    note: e.note,
    warnings: e.warnings ?? [],
  };
}

async function estimateCostFor(backend: string, sizeBytes: number): Promise<PartialCostEstimate> {
  if (backend === 'file') {
    return {
      backend,
      size_bytes: sizeBytes,
      cost: '0',
      note: 'file backend is a local content-addressed store — no upload cost (disk space only).',
    };
  }

  if (backend === 'rclone') {
    return {
      backend,
      size_bytes: sizeBytes,
      cost: '0',
      note:
        'rclone backend delegates the transfer to the rclone binary and the configured remote (#204) — ' +
        'cypher-brain has no visibility into that remote pricing, so unlike arweave/turbo this is not a ' +
        'real cost query. Any transfer/storage cost is whatever the cloud contract for that remote charges.',
    };
  }

  if (backend === 'ton') {
    return {
      backend,
      size_bytes: sizeBytes,
      cost: '0',
      note:
        "ton backend seeds the bag from your OWN tonutils-storage box — no per-upload charge, only that box's " +
        'own running cost. NOT permanent storage: the bag is retrievable only while at least one reachable ' +
        'seeder retains it (see docs/durability.md).',
    };
  }

  if (backend === 'ton-provider') {
    // A REAL priced query (issue #396): selects a live mytonprovider.org provider and
    // runs the same cost math src/lib/backends/ton-provider.ts's put() uses, without
    // deploying or spending anything.
    try {
      const { estimateTonProviderCost } = await import('./backends/ton-provider.js');
      const est = await estimateTonProviderCost(sizeBytes);
      // usd_estimate is OPTIONAL, same posture as the arweave/turbo branches below: a
      // dead/unusable tonapi rates response must drop only this one line, never the
      // (still useful) native nanoTON estimate. nanoTON is 1e9-per-TON (NOT the
      // 1e12-per-AR winston/winc convention arweave/turbo use below) — TON's own
      // "nano" prefix, same as Ethereum's gwei.
      const rate = await tonUsdRate();
      // Inlined rather than importing wallet.ts's tonWalletConfigured() — wallet.ts
      // already imports tonUsdRate FROM this module, so the reverse import would be a
      // circular dependency. The check itself is one line; not worth restructuring
      // either module to share it.
      const autoSigns = !!TON_WALLET && (await exists(TON_WALLET));
      // #749: built once and reused both in `note` (prefixed with the "⚠" a human
      // reads) and in `warnings` (the plain sentence, for a script/agent to detect
      // without pattern-matching `note`'s free text) — so the two can never drift on
      // what this risk actually says.
      const bountyFloorWarning = est.belowBountyFloor
        ? `computed bounty (${est.bountyNano} nanoTON) looks below the ~0.05 TON floor providers built on ` +
          "tonutils-storage-provider enforce — this provider's notify may refuse to ever fetch the bag even " +
          'though the deploy itself would still succeed and be paid for (issue #403)'
        : null;
      return {
        backend,
        size_bytes: sizeBytes,
        cost: est.amountNano.toString(),
        unit: 'nanoTON',
        ...(rate !== null ? { usd_estimate: Number(((Number(est.amountNano) / 1e9) * rate).toFixed(6)) } : {}),
        warnings: bountyFloorWarning ? [bountyFloorWarning] : [],
        note:
          `ton-provider backend pays a live mytonprovider.org provider (pubkey ${est.provider.pubkey}, ` +
          `rating ${est.provider.rating.toFixed(2)}) to hold the bag for ${est.spanDays} day(s) ` +
          `(cost ${est.costNano} nanoTON + ${est.amountNano - est.costNano} nanoTON deploy buffer). ` +
          'Durability depends on that provider continuing to renew/serve the contract — weaker than ' +
          "Arweave's one-time, network-guaranteed permanence (see docs/durability.md). " +
          (bountyFloorWarning ? `⚠ ${bountyFloorWarning}. ` : '') +
          (autoSigns
            ? 'CYPHER_BRAIN_TON_WALLET is configured — this push will auto-sign and broadcast the deploy itself, no human needed.'
            : 'This mode requires a human to sign a Tonkeeper deeplink at push time (set CYPHER_BRAIN_TON_WALLET to auto-sign instead).'),
      };
    } catch (e) {
      return {
        backend,
        size_bytes: sizeBytes,
        cost: null,
        note: `estimate unavailable (mytonprovider.org query failed: ${errMsg(e)})`,
      };
    }
  }

  if (backend === 'turbo') {
    let TurboFactory: typeof import('@ardrive/turbo-sdk').TurboFactory;
    try {
      ({ TurboFactory } = await importQuietly(() => import('@ardrive/turbo-sdk')));
    } catch (e) {
      const problem = sdkImportAdvice(e, '@ardrive/turbo-sdk');
      if (problem !== null) {
        return {
          backend,
          size_bytes: sizeBytes,
          cost: null,
          note: `estimate unavailable (optional dependency): ${problem.advice} Uploads <100KB are free; larger ones spend Turbo Credits.`,
        };
      }
      throw e;
    }
    try {
      const turbo = TurboFactory.unauthenticated();
      // Bounded the same way arUsdRate() below bounds its own Turbo SDK call: the SDK
      // exposes no timeout/AbortSignal option on getUploadCosts(), so an unresponsive
      // Turbo pricing endpoint would otherwise hang this call indefinitely — and, since
      // push() now calls estimateCost() BEFORE its --yes consent gate (#160), that hang
      // would block a `push` before the operator ever gets to answer --yes, not just a
      // read-only `estimate` invocation. A race against AR_HTTP_TIMEOUT_MS doesn't cancel
      // the underlying request (the SDK gives no cancellation hook either), only bounds
      // how long THIS call waits for it — the same trade-off arUsdRate() already makes.
      const timeout = new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), AR_HTTP_TIMEOUT_MS);
        if (typeof t.unref === 'function') t.unref();
      });
      // #791: price the ANS-104 SIGNED DATA ITEM Turbo actually bills for, not the raw
      // artifact — the same number backends/turbo.ts's own pre-flight quote and
      // CYPHER_BRAIN_MAX_SPEND check now use, so the figure shown before the --yes
      // consent gate (pushpull.ts) and the figure the cap is enforced against describe
      // the same bytes. Sized with ArweaveSigner's fixed lengths (the signer turbo.ts
      // always constructs): estimate runs without loading a wallet, so there is no live
      // signer here to ask.
      const billedBytes = signedDataItemSize(sizeBytes);
      const res = await Promise.race([turbo.getUploadCosts({ bytes: [billedBytes] }), timeout]);
      if (res === null) {
        return {
          backend,
          size_bytes: sizeBytes,
          cost: null,
          note: `estimate unavailable (Turbo pricing query timed out after ${AR_HTTP_TIMEOUT_MS}ms)`,
        };
      }
      const [{ winc }] = res;
      // usd_estimate is OPTIONAL: a rate-fetch failure must never fail the (still
      // useful) native estimate. Priced at Turbo's OWN credit rate, not AR spot (#343):
      // a turbo upload spends credits, and credits sell at Turbo's fiat price (fees
      // included) — pricing them at AR market value understated a real push's cost by
      // ~35%. AR spot remains only as a labeled fallback when the price sheet is down.
      const credit = await turboUsdRate();
      const spot = credit === null ? await arUsdRate() : null;
      const rate = credit?.ratePer1e12Winc ?? spot;
      return {
        backend,
        size_bytes: sizeBytes,
        cost: String(winc),
        unit: 'winc',
        approx_ar: Number(BigInt(winc)) / 1e12,
        ...(rate !== null ? { usd_estimate: Number(((Number(BigInt(winc)) / 1e12) * rate).toFixed(6)) } : {}),
        note:
          `Turbo upload cost estimate for ${billedBytes} billed bytes (the ${sizeBytes}-byte artifact plus ` +
          `${billedBytes - sizeBytes} bytes of ANS-104 data-item header Turbo also charges for; uploads <100KB are ` +
          'free). Paid with Turbo Credits (fundable via ETH/USDC/fiat).' +
          (credit !== null
            ? ` USD at Turbo's credit rate (~$${credit.usdPerGiB.toFixed(2)}/GiB, fees included) — what buying these credits with fiat costs, not the AR market value of the winc.`
            : spot !== null
              ? ' USD at AR SPOT (the credit price sheet was unavailable or unusable) — buying the credits with fiat typically costs more than this.'
              : ''),
      };
    } catch (e) {
      return {
        backend,
        size_bytes: sizeBytes,
        cost: null,
        note: `estimate unavailable (Turbo pricing query failed: ${errMsg(e)})`,
      };
    }
  }

  if (backend === 'arweave') {
    // the raw L1 backend: the gateway /price endpoint returns the network reward in
    // winston for a payload of this size — the same price createTransaction would
    // fetch at push time (src/lib/backends/arweave.ts's put()).
    try {
      const ctl = AbortSignal.timeout(AR_HTTP_TIMEOUT_MS);
      const res = await fetch(`${AR_PROTOCOL}://${AR_HOST}:${AR_PORT}/price/${sizeBytes}`, { signal: ctl });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const winston = (await res.text()).trim();
      if (!/^\d+$/.test(winston)) throw new Error(`unexpected price response: ${winston.slice(0, 80)}`);
      // Same optional usd_estimate as the turbo branch (winston and winc are both
      // 1e12-per-AR, so one USD/AR rate converts either); null rate → field omitted.
      const rate = await arUsdRate();
      return {
        backend,
        size_bytes: sizeBytes,
        cost: winston,
        unit: 'winston',
        approx_ar: Number(BigInt(winston)) / 1e12,
        ...(rate !== null ? { usd_estimate: Number(((Number(BigInt(winston)) / 1e12) * rate).toFixed(6)) } : {}),
        note: 'Arweave L1 network price (the reward createTransaction would set at push time). Paid in AR from the JWK wallet.',
      };
    } catch (e) {
      return {
        backend,
        size_bytes: sizeBytes,
        cost: null,
        note: `estimate unavailable (gateway price query failed: ${errMsg(e)})`,
      };
    }
  }

  // #435: same nearestName() "did you mean" idiom #425 wired into top-level commands/
  // flags — --backend is an enum-valued flag like --level/--chain, and this is the
  // "unknown backend" copy `estimate` actually hits (backends/index.ts's backendFor()
  // is a separate copy for push/pull, per this function's own header comment on #159).
  // #501: STORAGE_BACKEND_NAMES (types.ts) is the shared list, not a second hand-kept
  // copy — see that const's own comment for why this file can't just import
  // backends/index.ts's BACKEND_FACTORIES instead.
  // #779: UsageError — an enum-valued flag's bad value is a parser-level refusal
  // (exit 2), not the generic-failure 1.
  const suggestion = nearestName(backend, STORAGE_BACKEND_NAMES);
  throw new UsageError(
    `unknown backend: ${backend}${suggestion ? ` (${didYouMean(suggestion)})` : ''} — use ${STORAGE_BACKEND_NAMES.join('|')}`,
  );
}

// Render a CostEstimate as human-readable lines — SHARED by the CLI `estimate` command
// below (its whole stdout output) and push()'s pre-consent estimate display
// (src/lib/pushpull.ts, on stderr — push's stdout is reserved for the final locator
// only — #160): one formatting so the number a `push --backend arweave` operator sees
// before confirming --yes is presented identically to `cypher-brain estimate`'s report,
// not a second, divergent rendering.
export function formatEstimate(e: CostEstimate): string[] {
  const lines = [`backend: ${e.backend}`, `size: ${e.size_bytes} bytes (${fmtBytes(e.size_bytes)})`];
  if (e.cost === null) {
    lines.push('cost: unavailable');
  } else {
    lines.push(`cost: ${e.cost}${e.unit ? ` ${e.unit}` : ''}`);
    // `!= null` (loose, so it covers undefined too) since #268 made these
    // required-and-nullable: a hand-built CostEstimate from JS that still omits them
    // must not reach .toFixed() on undefined. The human-readable report omits the
    // line entirely when there is no number, exactly as it did when the key was
    // absent — this rendering is unchanged, byte for byte.
    if (e.approx_ar != null) lines.push(`approx: ~${e.approx_ar.toFixed(8)} AR`);
    if (e.usd_estimate != null) {
      lines.push(`approx: ~$${e.usd_estimate.toFixed(e.usd_estimate >= 0.01 ? 2 : 6)} USD`);
    }
  }
  lines.push(`note: ${e.note}`);
  return lines;
}

// CLI `estimate` command: size --in the same way push does (a real byte count off
// disk, not a guess) and print the SAME estimateCost() computation the MCP
// estimate_cost tool returns, as a human-readable report — WITHOUT uploading
// anything. `size_bytes` (the MCP tool's alternative to `file`) has no CLI
// equivalent — --in is always a real file on disk here.
// --json (#211) prints the SAME CostEstimate object estimateCost() returned, as one
// JSON line on stdout, instead of formatEstimate()'s human-readable lines — never a
// re-implementation, so it can never disagree with either the human-readable report
// or the MCP estimate_cost tool.
export async function estimate(o: CliOptions): Promise<void> {
  // #779: a required flag simply being absent is the same "command line itself was
  // malformed" class as an unrecognized command/enum value — UsageError, exit 2, not
  // the generic-failure 1 (matches this file's own unknown-backend refusal below).
  if (!o.in) throw new UsageError('--in <file.age> required');
  if (!o.backend) throw new UsageError(`--backend <${STORAGE_BACKEND_NAMES.join('|')}> required`);
  // #781 (multi-model review): an unknown --backend used to only be caught deep
  // inside estimateCostFor() below, AFTER requireFile()/stat() — so `estimate --in
  // <missing> --backend bogus` reported the missing file (a real, exit-1 failure)
  // instead of the unknown-backend usage error (exit 2), even though the command
  // line itself was already malformed before any I/O ran. Checked here, cheaply and
  // without touching the filesystem, so the usage error always wins when both are
  // wrong. estimateCostFor()'s own fallback stays as defensive belt-and-suspenders
  // for its OTHER callers (MCP's estimate_cost tool calls estimateCost() directly).
  if (!STORAGE_BACKEND_NAMES.includes(o.backend as (typeof STORAGE_BACKEND_NAMES)[number])) {
    const suggestion = nearestName(o.backend, STORAGE_BACKEND_NAMES);
    throw new UsageError(
      `unknown backend: ${o.backend}${suggestion ? ` (${didYouMean(suggestion)})` : ''} — use ${STORAGE_BACKEND_NAMES.join('|')}`,
    );
  }
  await requireFile(o.in); // #267: one shared check/wording across every command
  const st = await stat(o.in);
  if (!st.isFile())
    throw new Error(`${o.in} is not a regular file (cannot size a directory/special file for an estimate)`);
  const result = await estimateCost(o.backend, st.size);
  // --out <path.json> (#231): ALSO write a plan file pinning this estimate to the
  // exact artifact/backend/payer/remote it was computed against, for "push --plan
  // <path>" to re-validate later. Additive to the normal report below — --out never
  // suppresses it. A dynamic import for the payer-address lookup only, not the whole
  // module: see wallet.ts's payerAddressFor doc comment for why a static one here
  // would be circular (wallet.ts statically imports this module's own rate functions).
  //
  // #646: this whole block runs BEFORE the report is printed below (it used to run
  // after). estimate() prints result — a success-shaped CostEstimate — straight to
  // stdout; on --json that IS the one document a machine caller ever sees. Every
  // check in this block (no-clobber, --remote required for rclone, writePlanFile's
  // own exclusive-create race guard) can still throw, and main()'s top-level handler
  // only emits the documented {error, code, exit_code} JSON object when stdout has
  // NOT already had a document written to it (hasWrittenJson(), ui.ts) — printing
  // the cost estimate first and validating the plan write second meant a plan-write
  // failure exited 1 with a stdout that still read as a successful --json estimate,
  // and no error object at all. Doing every fallible step here FIRST, and printing
  // exactly once at the bottom only after all of them succeed, makes "a JSON document
  // reached stdout" and "the command actually succeeded" the same fact again.
  let planSavedLine: string | null = null;
  if (o.out) {
    // #470: same no-clobber posture as "snapshot --out" (CB-E009) — without this, a
    // second "estimate --out" at the same path silently discarded whatever plan a
    // prior run wrote there (and anything already relying on it via "push --plan"),
    // no warning, no error. --force overwrites anyway, the same escape hatch
    // push/pull/wallet create already use for this exact refusal. This check is a
    // fast, friendly pre-flight for the common case (same wording every other
    // no-clobber refusal in this codebase uses) — the REAL enforcement, including
    // against a concurrent "estimate --out" racing this one, is writePlanFile()
    // below's exclusive-create write (Codex review, #470 follow-up), the same
    // division of labor keygenAt()/wallet.ts's writeKeyFile callers already rely on.
    if (!o.force && (await exists(o.out))) {
      throw new Error(
        `${o.out} already exists — refusing to overwrite a prior plan (move it aside, choose a new --out, or pass --force)`,
      );
    }
    // #468: without --remote, an rclone plan would pin remote: null — and "push
    // --plan" always has a REAL --remote to compare against (rclone requires it,
    // src/lib/backends/rclone.ts's put()), so that plan can never validate; it fails
    // later, mid-push, with a "re-run estimate --out" suggestion the reader has no
    // way to act on since --help never documented this flag existed. Refuse HERE,
    // before doing any of the network-bound work below, so the mistake is caught at
    // the point it was made rather than surfacing as a confusing push-time error.
    if (o.backend === 'rclone' && !o.remote) {
      throw new Error(
        '--remote <name>:<path> required when --out is used with --backend rclone ' +
          '(the plan would otherwise pin remote: null, which "push --plan" can never validate against a real --remote)',
      );
    }
    const { payerAddressFor } = await import('./wallet.js');
    // Re-stat here (not the earlier `st` above) rather than reuse it: `st` was read
    // before estimateCost()'s network-bound price query, which can take real wall-clock
    // time — a file that changed during that query would otherwise pair a NOW-stale
    // size with a fresh sha256, describing two different file states in one plan
    // (Codex review). Re-statting immediately alongside the sha256 read narrows that
    // window to this Promise.all, not the whole preceding estimateCost() call — it does
    // not make the pairing atomic (two separate syscalls can still race with a
    // concurrent write), only meaningfully smaller.
    const [outStat, artifactSha256, recipientsFingerprint, payerAddress] = await Promise.all([
      stat(o.in),
      sha256(o.in),
      readRecipientsFingerprint(o.in),
      payerAddressFor(o.backend, o),
    ]);
    const plan = buildPlan({
      backend: o.backend,
      artifactSha256,
      sizeBytes: outStat.size,
      recipientsFingerprint,
      payerAddress,
      remote: o.remote ?? null,
      estimate: result,
    });
    await writePlanFile(o.out, plan, { force: !!o.force });
    // Deferred to stderr AFTER the report below, not printed here: nothing in this
    // function may write to a stream before every fallible step above has actually
    // succeeded (#646) — see the comment at the top of this block.
    planSavedLine = `plan saved -> ${o.out} (valid until ${plan.expires_at})`;
  }
  // Printed exactly once, and only once every above step (including the plan write)
  // has succeeded — see the #646 comment above.
  if (o.json) printJson(result);
  else for (const line of formatEstimate(result)) console.log(line);
  if (planSavedLine) console.error(planSavedLine);
}
