// arweave backend: stores the ciphertext as an Arweave transaction (plus the shared
// gateway-read helpers the turbo backend reuses).
import { mkdir, writeFile, rm, stat, readFile, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import {
  AGE_MAGIC,
  MINISIG_MAGIC,
  AR_HOST,
  AR_PORT,
  AR_PROTOCOL,
  AR_WALLET,
  AR_DEFAULT_EXTRA_GATEWAYS,
  AR_HTTP_TIMEOUT_MS,
  AR_MAX_SPEND,
  AR_L1_MAX_BYTES,
  PIPE_TIMEOUT_MS,
  readEnv,
} from '../config.js';
import {
  warnIfLooseKeyPerms,
  readHead,
  fmtBytes,
  errMsg,
  RetryableError,
  SdkMissingError,
  throwForSdkImport,
} from '../util.js';
import { arUsdRate, usdApprox } from '../estimate.js';
import { progressReporter } from '../progress.js';
import type { StorageBackend, PutOpts, FetchShape } from '../types.js';

// The public gateways to try (in order) for the HTTP read, before the L1 chunk
// fallback (#21). Override the whole list with CYPHER_BRAIN_AR_GATEWAYS (comma-
// separated), or pin a single one with CYPHER_BRAIN_AR_GATEWAY; otherwise the derived
// host (CYPHER_BRAIN_AR_HOST/PORT/PROTOCOL — arweave.net, or arlocal in tests) is tried
// first, then the extra public mirrors.
function arGateways(): string[] {
  const listed = readEnv('CYPHER_BRAIN_AR_GATEWAYS');
  if (listed) {
    const list = listed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) return list; // ignore an all-blank override → fall through to the default
  }
  const pinned = readEnv('CYPHER_BRAIN_AR_GATEWAY');
  if (pinned) return [pinned];
  // the derived host first, plus the public mirrors ONLY when the host is the default
  // arweave.net — a custom CYPHER_BRAIN_AR_HOST must not silently egress to them.
  const derived = `${AR_PROTOCOL}://${AR_HOST}:${AR_PORT}`;
  return [derived, ...(AR_HOST === 'arweave.net' ? AR_DEFAULT_EXTRA_GATEWAYS : [])];
}

// SSRF guard for redirect targets (#13/#39). A loopback / link-local / private address
// must never be the target of a gateway redirect — otherwise a compromised public mirror
// could 3xx a public-IP host into GETting an internal/IMDS endpoint (169.254.169.254,
// RFC1918, ::1). IPv4 + IPv6 (incl. IPv4-mapped). The INITIAL gateway URL is operator-
// configured and trusted (it may legitimately be 127.0.0.1 in tests); only redirect
// TARGETS — attacker-controlled — are screened here.
function isPrivateAddr(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
    if (a === 169 && b === 254) return true; // link-local (AWS/GCP IMDS)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598) — carrier/cloud internal
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  const low = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (low === '::1' || low === '::') return true; // loopback / unspecified
  if (/^fe[89ab]/.test(low)) return true; // link-local fe80::/10 (fe80–febf)
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local
  // IPv4-mapped ::ffff:a.b.c.d — dotted form, OR the canonical hex-quad form
  // ::ffff:7f00:1 (which isIP() reports as v6, so it must be normalised here or a
  // hex-encoded loopback/IMDS literal would slip past the v4 checks above).
  const mDot = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mDot) return isPrivateAddr(mDot[1]);
  const mHex = low.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mHex) {
    const n = ((parseInt(mHex[1], 16) << 16) | parseInt(mHex[2], 16)) >>> 0;
    return isPrivateAddr([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.'));
  }
  return false;
}

interface ScreenedTarget {
  address: string;
  family: number;
}

// Reject a redirect target that is non-http(s) or resolves to a private/loopback/
// link-local address. Throws on refusal. On success returns the SCREENED address +
// family so the caller can PIN the connection to exactly the vetted IP — closing the
// DNS-rebinding TOCTOU where a low-TTL host returns a public IP for this check and a
// private one for the actual connect.
async function assertPublicRedirectTarget(u: string): Promise<ScreenedTarget> {
  const parsed = new URL(u);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing non-http(s) redirect to ${u}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const fam = isIP(host);
  const addrs = fam ? [{ address: host, family: fam }] : await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isPrivateAddr(address)) {
      throw new Error(`redirect to ${parsed.hostname} resolves to a private/loopback/link-local address (${address})`);
    }
  }
  return { address: addrs[0].address, family: addrs[0].family || isIP(addrs[0].address) };
}

// One GET over node:http(s), resolving with the IncomingMessage so the caller can read
// statusCode/headers AND stream the body. We use node:http instead of fetch because the
// Fetch standard's `redirect:'manual'` returns an opaque response (status 0, no Location),
// so manual SSRF-screened redirect following (#39) is impossible with fetch.
// `pin` (optional) is a {address, family} from assertPublicRedirectTarget: when set, the
// connection is pinned to that exact IP via a custom lookup, so the bytes come from the
// SAME address we screened (no DNS-rebinding between the check and the connect). The URL's
// hostname still drives the Host header / TLS SNI, so cert validation is unaffected.
function gatewayGet(url: string, signal: AbortSignal, pin: ScreenedTarget | null): Promise<IncomingMessage> {
  return new Promise((res, rej) => {
    const lib = url.startsWith('https:') ? https : http;
    // autoSelectFamily: match fetch/undici's happy-eyeballs so a dual-stack host
    // (e.g. `localhost` → ::1 then 127.0.0.1) connects to whichever family answers,
    // instead of failing on the first AAAA when the server is IPv4-only.
    // Send a User-Agent (and Accept): arweave.net 302-redirects a bundled-item read
    // to a sandbox subdomain (euzcbl….arweave.net) that returns 403 to a header-less
    // request — node:http.get sends NO default headers, unlike the fetch() this replaced
    // in #39, which silently regressed the real-world full-brain (Turbo/bundled) pull.
    // autoSelectFamily is a real node:net socket-connect option node:http forwards at
    // runtime, but @types/node's http.RequestOptions (ClientRequestArgs) doesn't
    // declare it — widen locally rather than losing the rest of the type's checking.
    const opts: http.RequestOptions & { autoSelectFamily?: boolean } = {
      signal,
      autoSelectFamily: true,
      headers: { 'user-agent': 'cypher-brain', accept: '*/*' },
    };
    if (pin) {
      // node:http's `lookup` option accepts either the `(err, address, family)` or
      // `(err, [{address, family}])` callback shape depending on whether the caller
      // asked for `all` — @types/node's LookupFunction union covers both; pin BOTH
      // outputs to the one screened address, closing the DNS-rebinding TOCTOU.
      opts.lookup = ((_hostname: string, options: unknown, callback: unknown) => {
        const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
        const cb = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
        return wantsAll ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family);
      }) as http.RequestOptions['lookup'];
    }
    const req = lib.get(url, opts, (resp) => res(resp));
    req.on('error', rej);
  });
}

// Non-empty AND starts with AGE_MAGIC — the CIPHERTEXT objects are age ciphertext (push
// enforces the same header), so anything else (a soft-404 page, a "tx pending"
// placeholder, a CDN interstitial, an unrelated tx's bytes) must never be promoted to
// the final output path. Shared by BOTH read paths (#118) so neither the gateway stream
// nor the L1 chunk fallback can silently promote something that isn't actually the
// pulled artifact.
async function isAgeCiphertext(part: string): Promise<boolean> {
  return (await stat(part)).size > 0 && (await readHead(part, 64)).startsWith(AGE_MAGIC);
}

// The same guard for the OTHER kind of object this backend stores. #214 started pushing a
// detached minisign signature beside each ciphertext, which invalidated the comment above's
// premise that "every stored object is age ciphertext" — and since the gate below only ever
// asked isAgeCiphertext, a sidecar sitting intact in storage could never be promoted, so
// `push --sign` + `pull` could not round-trip on arweave/turbo at all (#318). The fix is a
// predicate per shape, not the removal of the predicate: a gateway serving a soft-404 page
// must still be refused for a sidecar exactly as it is for a ciphertext.
//
// minisign's own writer emits "untrusted comment: " as line 1 (src/lib/minisign.ts's
// COMMENT_PREFIX, and the format's own spec), so the first bytes identify the format the
// same way AGE_MAGIC does — deliberately a HEAD check, not a full parse: this decides
// "is this the object or the gateway's apology", and whether the signature actually
// verifies is minisign.ts's job on a file that has already been promoted.
async function isMinisig(part: string): Promise<boolean> {
  return (await stat(part)).size > 0 && (await readHead(part, 64)).startsWith(MINISIG_MAGIC);
}

const SHAPE_CHECK: Record<FetchShape, (part: string) => Promise<boolean>> = {
  age: isAgeCiphertext,
  minisig: isMinisig,
};

// Stream an Arweave gateway GET to `part`; resolve true iff it produced a non-empty
// file (the caller then promotes it to `out`). A STALL timeout (reset per chunk) bounds
// a stalled gateway WITHOUT capping a large but progressing transfer (#17). Accept ONLY
// HTTP 200 (a 202 "pending" / soft-404 means "not here, try the next gateway"). Redirects
// are followed MANUALLY (#39) so each hop's target is SSRF-screened before we fetch it.
//
// The per-chunk stall timeout alone does NOT bound a malicious/compromised gateway that
// keeps SOME bytes flowing without ever actually stalling: `arm()` below resets on every
// received chunk, so a drip-fed 200 response could otherwise stream forever and grow
// `part` until local disk is exhausted (#641) — neither Content-Length, received byte
// count, nor total elapsed time was bounded. `totalTimer` below closes that gap with an
// ABSOLUTE, wall-clock timer on this one gateway attempt (redirects included), armed once
// and never reset — deliberately NOT implemented as a per-chunk deadline check, since that
// would only ever be re-evaluated when another chunk arrives: a gateway that sends bytes
// right up to (but not past) the cap and then goes silent would keep the stall timer
// (reset by that same last chunk) as the only thing standing between it and
// AR_HTTP_TIMEOUT_MS, which can be configured LARGER than this cap (Codex review). A real
// timer fires regardless of chunk activity, including while still waiting on
// headers/redirects before any body byte has arrived at all.
async function streamArweaveGateway(
  url: string,
  part: string,
  timeoutMs: number,
  expect: FetchShape,
): Promise<boolean> {
  const ctl = new AbortController();
  let stall: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(stall);
    stall = setTimeout(() => ctl.abort(), timeoutMs);
  };
  // PIPE_TIMEOUT_MS is the same "overall wall-clock cap for one long-running operation"
  // budget ton.ts's p2pFetchInto() already applies to its P2P download loop (see its
  // `now - started > PIPE_TIMEOUT_MS` check) — reused here rather than adding a new env
  // var. Generous default (1h): a real transfer completes in seconds to minutes and never
  // trips this; only a transfer that never actually finishes does. Armed exactly once,
  // for the whole function — NOT reset by arm() — and always cleared in the `finally`
  // below regardless of which path this function returns through.
  const totalTimer = setTimeout(() => {
    console.error(
      `arweave: gateway attempt exceeded ${PIPE_TIMEOUT_MS}ms total — a stalled/malicious gateway can keep resetting the per-chunk timeout by trickling bytes, so this bounds total attempt time independently; skipping gateway`,
    );
    ctl.abort();
  }, PIPE_TIMEOUT_MS);
  // Kept as a fast-path, defense-in-depth check alongside the real timer above: if a
  // chunk happens to arrive right around the deadline, this notices it synchronously
  // (with a more specific, byte-count-bearing message) rather than waiting for the timer
  // callback's own tick — but `totalTimer` above is what actually GUARANTEES the bound.
  const deadline = Date.now() + PIPE_TIMEOUT_MS;
  try {
    let current = url;
    let pin: ScreenedTarget | null = null; // screened for the NEXT request — pins out DNS-rebinding
    let resp: IncomingMessage;
    for (let hop = 0; ; hop++) {
      arm();
      resp = await gatewayGet(current, ctl.signal, pin);
      const sc = resp.statusCode ?? 0;
      if (sc >= 300 && sc < 400 && resp.headers.location) {
        resp.resume(); // drain & discard the redirect body so the socket frees
        if (hop >= 3) {
          console.error(`arweave: too many redirects from ${url} — skipping gateway`);
          clearTimeout(stall);
          await rm(part, { force: true });
          return false;
        }
        const next = new URL(resp.headers.location, current).href;
        try {
          pin = await assertPublicRedirectTarget(next);
        } catch (e) {
          console.error(`arweave: ${errMsg(e)} — refusing redirect, skipping gateway (SSRF guard)`);
          clearTimeout(stall);
          await rm(part, { force: true });
          return false;
        }
        current = next;
        continue;
      }
      break; // not a redirect (or a 3xx with no Location) → handle the response below
    }
    if (resp.statusCode === 200) {
      // The stall tap is already counting every chunk, so progress (#283) costs one
      // addition here rather than a second pass over the stream. A gateway that omits
      // content-length just reports bytes without a percentage — the reporter handles a
      // zero total, and "how much has arrived" is still the answer to "is it moving?".
      // This is the download half of the same problem: a restore is precisely when you
      // least want to wonder whether a transfer is alive.
      const total = Number(resp.headers['content-length'] ?? 0) || 0;
      const progress = progressReporter('arweave pull');
      let received = 0;
      const tap = new Transform({
        transform(c, _e, cb) {
          // Checked BEFORE arm()/resetting the stall timer: a gateway that keeps
          // resetting the stall deadline by trickling bytes must still hit this total
          // cap eventually (#641) — the two timers are deliberately independent.
          if (Date.now() > deadline) {
            clearTimeout(stall);
            ctl.abort();
            cb(
              new Error(
                `arweave: gateway transfer exceeded ${PIPE_TIMEOUT_MS}ms total (received ${received} bytes) — a stalled/malicious gateway can keep resetting the per-chunk timeout, so this bounds total transfer time independently; skipping gateway`,
              ),
            );
            return;
          }
          arm();
          received += c.length;
          progress.report(received, total);
          cb(null, c);
        },
      }); // each chunk resets the stall deadline (but not the total-duration deadline above)
      await pipeline(resp, tap, createWriteStream(part));
      clearTimeout(stall);
      // Accept the body only if it is actually age ciphertext (every stored object
      // is — push enforces the same header). A gateway that serves a non-ciphertext
      // HTTP 200 (a soft-404 page, a "tx pending" placeholder, a CDN interstitial)
      // must NOT be promoted: returning false here falls through to the next gateway,
      // then the L1 chunk read, then the retryable error that drives `pull --wait`,
      // instead of writing garbage to --out during the propagation window.
      if (await SHAPE_CHECK[expect](part)) return true;
    } else {
      resp.resume(); // drain a non-200 (202 pending / 404) so the socket frees
    }
  } catch {
    /* stall / network / mid-stream error — try the next gateway */
  } finally {
    clearTimeout(stall);
    clearTimeout(totalTimer);
  }
  await rm(part, { force: true });
  return false;
}

// arweave-js's minimal shape (the `arweave` npm package) that this backend actually uses —
// kept local + narrow rather than depending on the package's full type surface, since it is
// imported lazily and only optionally installed (a fresh machine's gateway-only pull needs
// none of this).
interface ArweaveClient {
  transactions: {
    getPrice(byteLength: number): Promise<string>;
    sign(tx: ArweaveTransaction, jwk: unknown): Promise<void>;
    post(tx: ArweaveTransaction): Promise<{ status: number; data?: unknown }>;
    getData(id: string, opts?: { decode?: boolean }): Promise<Uint8Array | string>;
  };
  createTransaction(attrs: { data: Uint8Array; reward?: string }, jwk: unknown): Promise<ArweaveTransaction>;
}
interface ArweaveTransaction {
  id: string;
  reward: string; // winston, the actual fee this tx was signed for — arweave-js always
  // populates it (fetched internally when createTransaction was not given one), a tx
  // cannot be validly signed without a reward. Read only for the receipt (#232).
  addTag(name: string, value: string): void;
}

// arweave-js's Api.request() (node_modules/arweave/node/lib/api.js) already buffers the
// POST response body into `res.data` — parsed as JSON when the body is a valid JSON
// object, otherwise the raw decoded text — so surfacing it here costs no extra network
// read. A real gateway's 400/410/etc body is far more actionable than the bare status
// (#165 — an unfunded wallet's push used to surface an opaque "HTTP 400" indistinguishable
// from any other 400 cause; issue #37's oversized-tx guard is a separate, already-handled
// 400 case). Bounded to ~200 chars — the same excerpt-length turbo.ts's own upload-response
// error already uses (`JSON.stringify(res).slice(0, 200)`). Never throws: a malformed/
// unexpected `data` shape falls through to the bare `HTTP ${status}` message rather than
// masking the real failure with a body-parsing error.
function describeArweavePostError(status: number, data: unknown): string {
  try {
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      const reason = obj.error ?? obj.message;
      if (typeof reason === 'string' && reason.trim()) {
        return `arweave post failed: HTTP ${status} — ${reason.trim().slice(0, 200)}`;
      }
      // no recognizable error/message field — fall back to the raw (stringified) body,
      // same as the "otherwise the raw text" behavior for a non-JSON body below.
      const raw = JSON.stringify(data);
      if (raw && raw !== '{}') return `arweave post failed: HTTP ${status} — ${raw.slice(0, 200)}`;
    } else if (typeof data === 'string' && data.trim()) {
      return `arweave post failed: HTTP ${status} — ${data.trim().slice(0, 200)}`;
    }
  } catch {
    /* fall through to the bare status message below */
  }
  return `arweave post failed: HTTP ${status}`;
}

// arweave-js's HTTP client (`Api.request()`, node_modules/arweave/node/lib/api.js) — used
// by BOTH `ar.transactions.getData()`'s chunk reads AND its own "gateway cache" fallback —
// calls plain fetch() with no AbortSignal, and its ApiConfig.timeout is stored but never
// wired into the fetch call (a dead option in this SDK version): nothing bounds a stalled
// connection (#116). It also auto-follows any redirect the configured AR_HOST (or a
// MITM/compromised CDN in front of it) returns, with NO host/IP screening — the SDK
// exposes no fetch/redirect/AbortSignal injection point through its own public call sites
// (Chunks.getTransactionOffset/getChunk call `this.api.get(endpoint)` with no init at all)
// to fix this the way streamArweaveGateway() does for path 1 (#115). We can't even
// validate-then-follow the redirect the way streamArweaveGateway() does: Node's fetch
// (undici) returns an opaque, Location-less response for redirect:'manual' per the Fetch
// spec — the same limitation documented on gatewayGet() above, which is why THAT path uses
// node:http instead of fetch in the first place.
//
// Both gaps are closed together by wrapping the GLOBAL fetch for the lifetime of this one
// SDK call: every request it issues is forced through redirect:'error' (a redirect makes
// fetch() reject outright instead of being silently followed — strictly narrower than
// streamArweaveGateway()'s validate-then-follow, but sufficient here: this is a
// last-resort fallback, so a redirecting host just makes THIS read "not available", same
// as any other chunk-read failure) and an AbortSignal from a STALL timer reset on every
// individual fetch() call — mirrors streamArweaveGateway()'s per-chunk arm(), so a call
// that keeps making forward progress across many small chunk requests isn't killed by one
// flat deadline, but a genuinely stalled one aborts within `timeoutMs` instead of hanging
// `pull` forever. The patch is restored only once the SDK's OWN promise truly settles (not
// merely when our stall timer gives up on it) — an abandoned, still-running request could
// otherwise receive and silently follow a redirect with the real fetch after we've already
// moved on to the next gateway/attempt.
// NOT reentrant: this mutates the process-global `fetch` for the duration of one call.
// Safe today because `get()` is only ever awaited sequentially (one backend.get() per CLI
// process, itself one `pull` command) — a future concurrent caller would need its own
// dispatcher-scoped fix instead of overlapping calls to this function.
function l1ChunkRead(ar: ArweaveClient, locator: string, timeoutMs: number): Promise<Uint8Array | string> {
  const realFetch = globalThis.fetch;
  const ctl = new AbortController();
  let stall: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(stall);
    stall = setTimeout(() => ctl.abort(), timeoutMs);
  };
  arm();
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    arm(); // a new request = forward progress; reset the stall deadline
    return realFetch(input, { ...init, redirect: 'error', signal: ctl.signal });
  }) as typeof fetch;
  const p = ar.transactions.getData(locator, { decode: true });
  // Restore the moment `p` settles, and swallow this settle-tracking chain's own
  // rejection (`p`'s real rejection is separately handled by the caller's own
  // try/catch around `l1ChunkRead(...)` — this `.catch` exists only so THIS derived
  // promise doesn't itself surface as an unhandled rejection).
  p.finally(() => {
    clearTimeout(stall);
    globalThis.fetch = realFetch;
  }).catch(() => {});
  return p;
}

// arweave backend: stores the ciphertext as an Arweave transaction. The locator is
// the tx id — assigned AFTER upload, NOT a content hash — which is exactly the case
// the StorageBackend interface must handle (vs file's pre-known content id).
// The `arweave` SDK is imported LAZILY and only where it is actually needed — uploads
// (put) and the rare L1 chunk fallback. The primary READ path (gateway HTTP, path 1
// below) is pure native fetch, so a fresh machine recovers a bundled/Turbo brain from
// just the tx id with NO npm dependency — keeping the documented "tx id is all you need"
// recovery true (a missing `arweave` install no longer fails a gateway pull at construction).
export async function arweaveBackend(): Promise<StorageBackend> {
  let _ar: ArweaveClient | null = null;
  const getAr = async (): Promise<ArweaveClient> => {
    if (_ar) return _ar;
    let ArweaveCtor: { init(opts: { host: string; port: number; protocol: string }): ArweaveClient };
    try {
      ArweaveCtor = (await import('arweave')).default as unknown as typeof ArweaveCtor;
    } catch (e) {
      // The L1 chunk-fallback treats SdkMissingError as "optional path, skip it" — that
      // is only true for a genuinely ABSENT package. An installed-but-broken one
      // (transitive dep missing, exports clash) silently skipped would make the
      // fallback look like a feature that never fires; it throws plainly instead
      // (Codex review, Critical). See throwForSdkImport() (util.ts, #500) for the
      // shared classify-and-throw logic.
      throwForSdkImport(e, 'arweave', 'arweave backend');
    }
    _ar = ArweaveCtor.init({ host: AR_HOST, port: AR_PORT, protocol: AR_PROTOCOL });
    return _ar;
  };
  const loadWallet = async (): Promise<unknown> => {
    if (!AR_WALLET) throw new Error('arweave put needs CYPHER_BRAIN_AR_WALLET (path to a JWK key file)');
    await warnIfLooseKeyPerms(AR_WALLET, 'arweave JWK wallet');
    try {
      return JSON.parse(await readFile(AR_WALLET, 'utf8'));
    } catch (e) {
      // ENOENT specifically means "not created yet" — give the same friendly nudge
      // wallet.ts's addressFromWallet() already gives `wallet address`/`wallet balance`
      // (#164), instead of a raw ENOENT with no next action (#600). Any OTHER failure
      // (EACCES, corrupt/non-JSON file, …) is a genuine problem the operator needs the
      // real error to debug, so that keeps the raw errMsg(e) detail untouched.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(`arweave: no wallet at ${AR_WALLET} — run 'cypher-brain wallet create' first`);
      }
      throw new Error(`arweave: cannot read JWK wallet at ${AR_WALLET}: ${errMsg(e)}`);
    }
  };
  return {
    async put(file: string, opts: PutOpts = {}): Promise<string> {
      // Fast size guard BEFORE buffering: the raw arweave backend posts the whole
      // artifact inline in ONE signed tx, and gateways reject single-tx bodies past
      // ~12 MiB — a brain-sized snapshot would buffer the lot and then fail with a bare
      // "HTTP 400". Redirect to the turbo backend (streams + ANS-104 bundles) instead.
      const { size: l1Size } = await stat(resolve(file));
      if (l1Size > AR_L1_MAX_BYTES) {
        throw new Error(
          `arweave: ${l1Size} bytes exceeds the ~${(AR_L1_MAX_BYTES / 1048576).toFixed(0)} MiB single-tx limit of the raw arweave backend — use --backend turbo (it streams + bundles large uploads). Override the limit with CYPHER_BRAIN_AR_L1_MAX if you really mean to post one large L1 tx.`,
        );
      }
      const ar = await getAr(); // uploads genuinely need the SDK (createTransaction/sign/post)
      const jwk = await loadWallet(); // only uploads need a wallet/signature
      const data = await readFile(file); // small ciphertext fits one tx (guarded above); large blobs go via --backend turbo
      // inform before signing — the --yes guard in push() already confirmed intent;
      // this surfaces the size so the operator knows what they're committing to.
      process.stderr.write(`arweave: L1 upload — ${data.length} bytes, wallet ${AR_WALLET}\n`);
      // Cost estimate + cap BEFORE signing (mirrors turbo.ts): `ar.transactions.getPrice()`
      // is the SAME call ar.createTransaction() makes internally when `reward` is omitted
      // (see arweave-js common.js createTransaction), so pre-flighting it here is not an
      // EXTRA round-trip — we just make it early enough to enforce CYPHER_BRAIN_MAX_SPEND,
      // then hand the already-fetched reward back to createTransaction so it doesn't fetch
      // it again. A schedule-installed runner bakes CYPHER_BRAIN_YES=1 for unattended paid
      // pushes, so this cap is the ONLY thing standing between an install-time --max-spend
      // and an uncapped nightly L1 spend — it must actually gate the upload, not just log.
      let reward: bigint | undefined;
      try {
        reward = BigInt(await ar.transactions.getPrice(data.length));
        process.stderr.write(`arweave: L1 cost estimate: ${reward} winston\n`);
        // Human-readable USD approximation next to the native estimate, the same way
        // turbo.ts's put() already does (#159 — the CLI push path for arweave used to
        // show winston only). arUsdRate never throws (null on any failure), so a dead
        // pricing endpoint can neither block the push nor skip the CYPHER_BRAIN_MAX_SPEND
        // cap check below.
        const rate = await arUsdRate();
        if (rate !== null) {
          process.stderr.write(
            `arweave: approx cost: ${fmtBytes(data.length)} -> ${usdApprox(reward, rate)} (at ~$${rate.toFixed(2)}/AR; rate-dependent estimate, not a quote)\n`,
          );
        }
      } catch (e) {
        if (AR_MAX_SPEND > 0n) {
          throw new Error(
            `arweave: could not verify CYPHER_BRAIN_MAX_SPEND=${AR_MAX_SPEND} (price estimate failed: ${errMsg(e)}) — aborting to protect your wallet`,
          );
        }
        process.stderr.write(`arweave: could not estimate L1 cost (${errMsg(e)}); proceeding\n`);
      }
      if (reward !== undefined && AR_MAX_SPEND > 0n && reward > AR_MAX_SPEND) {
        throw new Error(
          `arweave: L1 upload cost ${reward} winston exceeds CYPHER_BRAIN_MAX_SPEND=${AR_MAX_SPEND} — aborting to protect your wallet`,
        );
      }
      const tx = await ar.createTransaction(reward !== undefined ? { data, reward: String(reward) } : { data }, jwk);
      tx.addTag('App-Name', 'cypher-brain');
      tx.addTag('Content-Type', 'application/octet-stream');
      await ar.transactions.sign(tx, jwk);
      const res = await ar.transactions.post(tx);
      if (res.status !== 200 && res.status !== 208) throw new Error(describeArweavePostError(res.status, res.data));
      // #232: tx.reward is the AUTHORITATIVE actual cost — set either from the pre-flight
      // `reward` above (passed into createTransaction) or, if that estimate failed,
      // fetched internally by createTransaction itself (arweave-js always populates it;
      // a tx cannot be validly signed without one). Never the pre-flight estimate
      // variable directly: if that fetch failed, `reward` is undefined here, but tx.reward
      // is still the real, signed figure either way.
      opts.onReceipt?.(
        { tx_id: tx.id, reward: tx.reward, post_status: res.status },
        { amount: tx.reward, unit: 'winston' },
      );
      return tx.id; // 43-char base64url tx id
    },
    async get(locator: string, out: string, expect: FetchShape = 'age'): Promise<void> {
      // reads are unauthenticated — a fresh machine needs only the tx id, no wallet.
      // The locator is interpolated into a gateway URL below, so validate it is a
      // clean Arweave tx id first (this also closes a path-traversal/SSRF foot-gun).
      if (!/^[A-Za-z0-9_-]{43}$/.test(locator)) {
        throw new Error(`arweave: invalid tx id (expected 43-char base64url): ${locator}`);
      }
      await mkdir(dirname(resolve(out)), { recursive: true });
      const part = `${out}.part`;
      // 1) try each public gateway's HTTP endpoint in turn (#21). It serves ANS-104
      //    *bundled* data items (Turbo/Irys — the pay-with-ETH/USDC path), which the
      //    chunk read below cannot fetch. The body is STREAMED to disk (#17), so a
      //    multi-hundred-MB brain never loads into memory; .part is promoted only on a
      //    clean, non-empty download that is actually age ciphertext — a 202 / soft-404
      //    / non-ciphertext 200 error page is rejected by streamArweaveGateway's
      //    AGE_MAGIC check and falls through to the next gateway (then the chunk read).
      for (const gw of arGateways()) {
        if (await streamArweaveGateway(`${gw.replace(/\/+$/, '')}/${locator}`, part, AR_HTTP_TIMEOUT_MS, expect)) {
          await rename(part, out);
          return;
        }
      }
      // 2) arweave-js chunk read — robust for L1 txs even when every gateway HTTP front
      //    is flaky (they can 5xx for L1 ids whose chunks the node still serves). This
      //    buffers in arweave-js, but it is the rare L1 fallback; a bundled brain takes
      //    the streamed path above. Needs the SDK: if `arweave` isn't installed, SKIP
      //    this fallback (the gateway path serves bundled items anyway) and let the
      //    retryable error below keep `--wait` polling — so a no-SDK machine still pulls.
      //    l1ChunkRead() wraps the SDK call with the same two protections path 1 gets
      //    for free from gatewayGet()/streamArweaveGateway(): a redirect-refusing,
      //    SSRF-safe fetch (#115) and a stall-bounded timeout (#116) — see its header
      //    comment for why a global fetch patch, not SDK config, is how this is done.
      let ar: ArweaveClient | null = null;
      try {
        ar = await getAr();
      } catch (e) {
        if (!(e instanceof SdkMissingError)) throw e; /* no SDK → skip L1 fallback */
      }
      if (ar) {
        let d: Uint8Array | string | null = null;
        try {
          d = await l1ChunkRead(ar, locator, AR_HTTP_TIMEOUT_MS);
        } catch {
          /* not found / chunk error / redirect refused (SSRF guard, #115) / stalled (#116) → not (yet) available */
        }
        // Same promote-only-if-ciphertext gate as the gateway path (#118): a non-empty
        // result here is not automatically trustworthy — it could be an unrelated tx's
        // bytes, an error/placeholder page the SDK's "gateway cache" fallback served, or
        // a typo'd-but-real tx id. Stage to `part`, validate, THEN atomically rename onto
        // --out (#117) — never write (or truncate) --out directly, so an interrupted
        // write can neither corrupt --out nor destroy a pre-existing valid one.
        if (d?.length) {
          await writeFile(part, Buffer.from(d as Uint8Array));
          if (await SHAPE_CHECK[expect](part)) {
            await rename(part, out);
            return;
          }
          console.error(
            `arweave: L1 chunk read for tx ${locator} returned non-ciphertext data — discarding (not promoted to --out)`,
          );
          await rm(part, { force: true });
        }
      }
      // a fresh upload may simply be propagating — mark this retryable so `pull --wait`
      // keeps trying (fatal errors like an invalid locator are NOT tagged, so they
      // fail fast even under --wait).
      throw new RetryableError(`arweave: no data for tx ${locator} (not mined / not found / not yet seeded)`);
    },
  };
}
