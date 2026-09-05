// wallet — generate/inspect the Arweave JWK signer CYPHER_BRAIN_AR_WALLET points at
// (issue #158). A JWK is the only credential the arweave/turbo backends need to spend
// (L1 AR or Turbo Credits) from an address; until this subcommand existed, getting one
// meant reaching for an external tool (arweave-js, a browser wallet, …) with no
// guarantee the result matched what CYPHER_BRAIN_AR_WALLET expects, and no bridge from
// "here is the JWK cypher-brain will use" to "here is the address to fund" —
// docs/arweave-upload-runbook.md funds via a DIFFERENT, browser-based wallet
// (app.ardrive.io) with nothing tying the two together.
//
// `create` reuses keys.ts's writeKeyFile — the same fail-closed, no-clobber-unless
// --force, exclusive-create-then-atomic-rename write the age identity already gets
// (#91/#122) — so the JWK gets identical hardening instead of a hand-rolled second
// write path. `address` (and `create`'s own derivation) is pure offline crypto (no
// network call), so both only ever need the `arweave` package installed, same as the
// arweave/turbo backends that consume the resulting file.
import { mkdir, chmod, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HOME, AR_WALLET, AR_PAID_BY, TON_WALLET, TON_TONAPI_URL, TON_PROVIDER_OWNER } from './config.js';
import { writeKeyFile } from './keys.js';
import { exists, errMsg, warnIfLooseKeyPerms, isWalletAddress, sameWalletAddress, throwForSdkImport } from './util.js';
import { fetchBalance, type CreditApproval } from './balance.js';
import { warn } from './warn.js';
import { arUsdRate, turboUsdRate, usdApprox, tonUsdRate } from './estimate.js';
import { printJson } from './ui.js';
import { didYouMean, nearestName } from './suggest.js';
import { UsageError } from './errors.js';
import type { CliOptions } from './types.js';
import type { WalletContractV4 as TonWalletContractV4 } from '@ton/ton';

// Minimal shape actually used here — hand-rolled rather than statically importing the
// `arweave` package's own types, mirroring backends/arweave.ts's ArweaveClient: the SDK
// stays a LAZY, optional import (it is only a peerDependency) so a machine without it
// installed only fails at the call site that actually needs it, never at module load.
interface ArweaveWalletClient {
  wallets: {
    generate(): Promise<unknown>;
    jwkToAddress(jwk: unknown): Promise<string>;
  };
}

async function getArweave(): Promise<ArweaveWalletClient> {
  let ArweaveCtor: { init(opts: Record<string, unknown>): ArweaveWalletClient };
  try {
    ArweaveCtor = (await import('arweave')).default as unknown as typeof ArweaveCtor;
  } catch (e) {
    // 'absent' keeps SdkMissingError (its semantics everywhere are "the OPTIONAL thing
    // is not installed"); 'broken' must NOT — an installed-but-unusable package is a
    // real failure, and dressing it as "missing" invites skip-it handling (Codex
    // review, Critical on the arweave chunk-fallback path). See throwForSdkImport()
    // (util.ts, #500) for the shared classify-and-throw logic.
    throwForSdkImport(e, 'arweave', 'wallet');
  }
  // No host/port/protocol needed: wallets.generate()/jwkToAddress() are local RSA
  // keypair generation + a hash of the public modulus — neither ever calls the network.
  return ArweaveCtor.init({});
}

// The default path `wallet create` writes to when --out is omitted. Pulled out to a
// module-level constant (rather than inlined at each call site) so `walletAddress`'s
// fallback below reuses the exact same path `walletCreate` just wrote to (#164) instead
// of re-deriving it and risking the two drifting apart. Exported so `doctor` (#201) can
// check the SAME default path's permissions rather than re-deriving it a third time.
export const WALLET_DEFAULT_PATH = join(HOME, 'wallet.json');

// ---------- TON wallet (issue #396 PR2: local auto-signing for ton-provider) ----------
// `wallet create --chain ton` generates a locally-held TON wallet (WalletContractV4 —
// not W5/V5R1: this wallet is entirely cypher-brain-managed, never opened in Tonkeeper
// itself, so matching a real Tonkeeper wallet's default version buys nothing). Its
// mnemonic is what ton-provider.ts's put() uses to sign+broadcast a StorageV1 deploy
// itself instead of printing a Tonkeeper deeplink for a human — see that file's
// autoSignAndBroadcastDeploy(). Deliberately a SEPARATE credential type from the
// Arweave JWK above (`wallet.json`) — TON's is a BIP39 mnemonic, not a JSON keypair —
// so this gets its own file, its own lazy SDK loader, and its own functions, mirroring
// getArweave()'s shape rather than trying to force one generic "wallet" abstraction
// over two unrelated credential formats.
interface TonSigningModule {
  mnemonicNew(wordCount?: number): Promise<string[]>;
  mnemonicToPrivateKey(mnemonic: string[]): Promise<{ publicKey: Buffer; secretKey: Buffer }>;
  mnemonicValidate(mnemonic: string[]): Promise<boolean>;
  WalletContractV4: {
    create(args: { workchain: number; publicKey: Buffer }): TonWalletContractV4;
  };
}

async function getTonSigning(): Promise<TonSigningModule> {
  let crypto: {
    mnemonicNew: TonSigningModule['mnemonicNew'];
    mnemonicToPrivateKey: TonSigningModule['mnemonicToPrivateKey'];
    mnemonicValidate: TonSigningModule['mnemonicValidate'];
  };
  let ton: { WalletContractV4: TonSigningModule['WalletContractV4'] };
  try {
    crypto = await import('@ton/crypto');
  } catch (e) {
    throwForSdkImport(e, '@ton/crypto', 'wallet');
  }
  try {
    ton = await import('@ton/ton');
  } catch (e) {
    throwForSdkImport(e, '@ton/ton', 'wallet');
  }
  return {
    mnemonicNew: crypto.mnemonicNew,
    mnemonicToPrivateKey: crypto.mnemonicToPrivateKey,
    mnemonicValidate: crypto.mnemonicValidate,
    WalletContractV4: ton.WalletContractV4,
  };
}

// Mirrors WALLET_DEFAULT_PATH exactly (same rationale: `tonWalletAddress`'s fallback
// below and ton-provider.ts's own read must never drift apart on which path they mean).
export const TON_WALLET_DEFAULT_PATH = join(HOME, 'ton-wallet.json');

// Mirrors walletConfigured() above — the SAME "presence-checkable capability" question,
// answered for the TON credential instead of the Arweave one. Reused by ton-provider.ts
// (does this push get to auto-sign?) and by mcp.ts/schedule.ts (does this backend get
// listed as available at all for an unattended/AI-driven caller?).
export async function tonWalletConfigured(walletPath: string = TON_WALLET): Promise<boolean> {
  return !!walletPath && (await exists(walletPath));
}

interface TonMnemonicFile {
  mnemonic: string[];
}

// Shared exists/mkdir/chmod/writeKeyFile skeleton behind `tonWalletCreate`/`walletCreate`
// below (issue #506): mkdir the containing dir at 0700, re-chmod it too on the DEFAULT
// path (same fail-closed posture keygenAt() uses for #119 — a pre-existing dir is left
// at whatever mode it already had, EXCEPT on the default path this tool owns), then
// writeKeyFile the already-serialized payload. Deliberately does NOT also fold in the
// exists()+force no-clobber check: the wording differs per credential, and — per the
// comments at each call site — that check must run BEFORE the credential's keygen work,
// not after it alongside this write step. The credential-type-specific generation (JWK
// vs mnemonic) stays at each call site too, untouched — this only extracts the part that
// was byte-for-byte identical, matching the deliberate choice already made (see file
// header) not to unify wallet.ts's two credential formats into one abstraction.
async function createKeyFile(
  outPath: string,
  usingDefaultPath: boolean,
  force: boolean,
  payload: string,
): Promise<void> {
  const dir = dirname(outPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (usingDefaultPath) await chmod(dir, 0o700);
  await writeKeyFile(outPath, payload, 0o600, force);
}

async function tonWalletCreate(o: CliOptions): Promise<void> {
  const usingDefaultPath = !o.out;
  const outPath = o.out || TON_WALLET_DEFAULT_PATH;
  // Same no-clobber posture as walletCreate above, checked before any keygen work.
  if ((await exists(outPath)) && !o.force) {
    throw new Error(
      `TON wallet already exists at ${outPath} (refusing to overwrite — losing it = losing spend authority ` +
        `and control over any StorageV1 contracts it owns). Pass --force only if you are certain.`,
    );
  }
  const ton = await getTonSigning();
  const mnemonic = await ton.mnemonicNew(24);
  const keyPair = await ton.mnemonicToPrivateKey(mnemonic);
  const walletContract = ton.WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const address = walletContract.address.toString({ bounceable: true });
  const payload: TonMnemonicFile = { mnemonic };
  await createKeyFile(outPath, usingDefaultPath, !!o.force, JSON.stringify(payload));
  console.log(`TON wallet (PRIVATE, keep offline): ${outPath}`);
  console.log(`address (PUBLIC, safe to share — fund THIS address): ${address}`);
  // #483: this is the bounceable (EQ...) encoding of the address; other TON tooling
  // may render the SAME account as its non-bounceable (UQ...) counterpart. Both refer
  // to the same address — first-time TON users otherwise have no way to know that.
  console.log('  (this is the bounceable "EQ..." encoding; some wallets/explorers may show the same account as');
  console.log('  "UQ..." instead — both refer to the same address)');
  // #725: the 24-word mnemonic is never printed to the terminal (it lives ONLY inside
  // outPath's JSON, same posture as the age identity/Arweave JWK below — this codebase
  // never echoes raw key material to a screen/log that might be captured). The old
  // wording ("back up the mnemonic now") told the operator to back up something they
  // were never shown, with no hint that the words are the `mnemonic` array inside the
  // file printed above. Mirrors the Arweave wallet's own "back up the wallet FILE"
  // phrasing just below, which never made that same false promise.
  console.log(
    `\n⚠  Back up the wallet file now. Fund the address above with TON, then set CYPHER_BRAIN_TON_WALLET=${outPath} ` +
      'so ton-provider push auto-signs deploys with it instead of printing a Tonkeeper deeplink.',
  );
}

// Loads the mnemonic file and derives the wallet contract + signing keypair — the one
// place both `tonWalletAddress`/`tonWalletBalance` here AND ton-provider.ts's
// autoSignAndBroadcastDeploy() need, so the derivation logic (workchain 0, V4) lives
// exactly once. `what` names the caller in the error, matching addressFromWallet's
// precedent above.
export async function loadTonWallet(
  walletPath: string,
  what: string,
): Promise<{ wallet: TonWalletContractV4; secretKey: Buffer }> {
  await warnIfLooseKeyPerms(walletPath, 'TON wallet mnemonic');
  let parsed: TonMnemonicFile;
  try {
    parsed = JSON.parse(await readFile(walletPath, 'utf8'));
  } catch (e) {
    // ENOENT specifically means "not created yet" — the same fact doctor's SKIP
    // message already handles gracefully (#437) — so name the fix ('wallet create
    // --chain ton') instead of surfacing a raw errno string.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`${what}: no TON wallet at ${walletPath} — run 'cypher-brain wallet create --chain ton' first`);
    }
    if (e instanceof SyntaxError) {
      // Elevated-caution review: a JSON.parse failure's OWN message can echo a
      // fragment of the file's actual bytes back (e.g. a snippet of the surrounding
      // text around the failure position) — this file holds a secret mnemonic, and
      // that fragment must never end up quoted into a log/terminal a caller wasn't
      // expecting it to appear in. Report only that the JSON was malformed, never
      // the parser's own message.
      throw new Error(`${what}: ${walletPath} does not contain valid JSON`);
    }
    // Any OTHER failure (EACCES, a directory sitting where the file should be, …) is
    // a genuine I/O problem the operator needs the real error to debug — that keeps
    // the raw errMsg(e) detail untouched; it cannot echo file CONTENT the way a
    // JSON.parse SyntaxError can.
    throw new Error(`${what}: cannot read TON wallet at ${walletPath}: ${errMsg(e)}`);
  }
  if (!Array.isArray(parsed.mnemonic) || parsed.mnemonic.length === 0) {
    throw new Error(`${what}: TON wallet at ${walletPath} has no mnemonic array`);
  }
  const ton = await getTonSigning();
  // #<elevated-caution review>: without this, a malformed/typo'd mnemonic (a hand-
  // edited file, a corrupted backup restore, a bit flip) silently derives a
  // DIFFERENT, still-valid-LOOKING wallet — mnemonicToPrivateKey() never rejects an
  // input that merely fails TON's own checksum, it just deterministically produces
  // whatever keypair those (wrong) words happen to hash to. That wallet's address is
  // fully guessable by anyone who can brute-force the same near-miss mnemonic, and
  // ton-provider.ts's autoSignAndBroadcastDeploy() would go on to sign/broadcast
  // spends from it with no warning that the "wallet" it just loaded is not the one
  // the operator actually backed up. mnemonicValidate() runs the SAME checksum TON's
  // own tooling (and mnemonicNew()'s own generation) enforces, so a malformed
  // mnemonic is rejected here instead of quietly resolving to a different account.
  if (!(await ton.mnemonicValidate(parsed.mnemonic))) {
    throw new Error(
      `${what}: TON wallet mnemonic at ${walletPath} failed validation (wrong word, wrong order, or a corrupted ` +
        'file) — refusing to derive a wallet from it, since a malformed mnemonic silently derives a DIFFERENT, ' +
        'guessable wallet rather than erroring. Restore the mnemonic from a trusted backup.',
    );
  }
  const keyPair = await ton.mnemonicToPrivateKey(parsed.mnemonic);
  const wallet = ton.WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  return { wallet, secretKey: keyPair.secretKey };
}

async function addressFromTonWallet(o: CliOptions, what: string): Promise<string> {
  const walletPath = o.wallet || TON_WALLET || TON_WALLET_DEFAULT_PATH;
  const { wallet } = await loadTonWallet(walletPath, what);
  return wallet.address.toString({ bounceable: true });
}

async function tonWalletAddress(o: CliOptions): Promise<void> {
  console.log(await addressFromTonWallet(o, 'wallet address'));
}

async function tonWalletBalance(o: CliOptions): Promise<void> {
  // --address queries any address WITHOUT a key — same rationale as walletBalance above:
  // the address that just got funded from an exchange/another wallet is precisely the
  // one this machine may not hold a mnemonic for.
  const address = o.address ?? (await addressFromTonWallet(o, 'wallet balance'));
  // Deliberately the PLAIN /v2/accounts endpoint, not /v2/blockchain/accounts (which
  // ton-provider.ts's fetchAccountState() uses for its own purposes) — the blockchain-
  // prefixed one 404s for any address that has never sent/received a transaction, which
  // is exactly the state a freshly generated, never-funded wallet is in and precisely
  // the case --help documents as the primary use case ("no funds needed"). /v2/accounts
  // returns 200 with {"balance":0,"status":"nonexist",...} for that same identical
  // address instead (confirmed directly against tonapi.io for both a never-active and an
  // already-active address — issue #479).
  const url = `${TON_TONAPI_URL}/v2/accounts/${address}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`wallet balance: GET ${url} -> HTTP ${res.status}`);
  const body = (await res.json()) as { balance?: unknown; status?: unknown };
  const balanceNano = typeof body.balance === 'number' ? body.balance : 0;
  if (o.json) return printJson({ address, balance_nanoton: balanceNano, status: body.status ?? 'unknown' });
  const rate = await tonUsdRate();
  console.log(`address : ${address}`);
  console.log(`status  : ${body.status ?? 'unknown'}`);
  console.log(
    `balance : ${balanceNano} nanoTON (~${(balanceNano / 1e9).toFixed(9)} TON)` +
      (rate !== null ? ` = ~$${((balanceNano / 1e9) * rate).toFixed(balanceNano > 0 ? 2 : 6)} USD` : ''),
  );
}

async function walletCreate(o: CliOptions): Promise<void> {
  const usingDefaultPath = !o.out;
  const outPath = o.out || WALLET_DEFAULT_PATH;
  // No-clobber by default (same posture as keygen's --force precedent), checked BEFORE
  // the JWK is generated so a refusal never even spends the RSA keygen work.
  if ((await exists(outPath)) && !o.force) {
    throw new Error(
      `wallet already exists at ${outPath} (refusing to overwrite — losing it = losing spend authority over any AR/Turbo Credits already sent to its address). Pass --force only if you are certain.`,
    );
  }
  const ar = await getArweave();
  const jwk = await ar.wallets.generate();
  const address = await ar.wallets.jwkToAddress(jwk);
  // mkdir + conditional re-chmod (default path only) + writeKeyFile — see createKeyFile
  // above for the rationale (#119).
  await createKeyFile(outPath, usingDefaultPath, !!o.force, JSON.stringify(jwk));
  console.log(`wallet (PRIVATE, keep offline): ${outPath}`);
  console.log(`address (PUBLIC, safe to share — fund THIS address): ${address}`);
  // #472: CYPHER_BRAIN_AR_WALLET is NOT actually required for push/estimate/wallet
  // address/balance to find this file — every one of them falls back to
  // WALLET_DEFAULT_PATH (payerAddressFor/addressFromWallet above) when it is unset.
  // The old wording ("... then set CYPHER_BRAIN_AR_WALLET=...") implied it always
  // was, unconditionally, which overstated what a default-path `wallet create` needs.
  // It is genuinely needed only when --out moved the file somewhere else.
  console.log(
    usingDefaultPath
      ? `\n⚠  Back up the wallet file now. Fund the address above (app.ardrive.io / turbo.ar.io — crypto or a card). ` +
          `push/estimate and 'wallet address'/'balance' already find it here by default — CYPHER_BRAIN_AR_WALLET is only needed if you move it.`
      : `\n⚠  Back up the wallet file now. Fund the address above (app.ardrive.io / turbo.ar.io — crypto or a card), ` +
          `then set CYPHER_BRAIN_AR_WALLET=${outPath} (a non-default --out path is not found automatically).`,
  );
}

// Shared "is there a usable wallet?" check — reused by wizard.ts's paid-backend
// pre-check (issue #161) so it can steer a user away from the "spends real funds"
// consent prompt BEFORE CYPHER_BRAIN_AR_WALLET is even set, rather than letting the
// wizard discover the same problem deep inside push() and roll everything back
// (issue #161's motivation). Mirrors exactly what backends/arweave.ts's/turbo.ts's own
// put() already require (set AND present on disk) — this does not read/parse the file
// (that stays at the real call sites: walletAddress above, the two backends' put()),
// it only answers the yes/no question those sites would otherwise fail deep inside.
export async function walletConfigured(walletPath: string = AR_WALLET): Promise<boolean> {
  return !!walletPath && (await exists(walletPath));
}

// Derive the address a JWK spends from. Shared by `address` and `balance` so the two
// can never disagree about WHICH wallet they are talking about — the exact confusion
// #164 fixed for the default-path fallback, now that a second subcommand asks the same
// question. `what` names the caller in the error, since "cannot read JWK wallet" is far
// more useful when it says which command wanted it.
async function addressFromWallet(o: CliOptions, what: string): Promise<string> {
  // Falls back to the same default `wallet create` writes to when neither --wallet nor
  // CYPHER_BRAIN_AR_WALLET is set, so `wallet create` (no --out) followed by `wallet
  // address` (no --wallet) just works (#164) instead of erroring out. If nothing exists
  // there, readFile below still fails closed with a clear "cannot read" error.
  const walletPath = o.wallet || AR_WALLET || WALLET_DEFAULT_PATH;
  await warnIfLooseKeyPerms(walletPath, 'arweave JWK wallet');
  let jwk: unknown;
  try {
    jwk = JSON.parse(await readFile(walletPath, 'utf8'));
  } catch (e) {
    // ENOENT specifically means "not created yet" — the same fact doctor's SKIP
    // message already handles gracefully (#437) — so name the fix ('wallet create')
    // instead of surfacing a raw errno string.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`${what}: no wallet at ${walletPath} — run 'cypher-brain wallet create' first`);
    }
    if (e instanceof SyntaxError) {
      // Elevated-caution review: a JSON.parse failure's OWN message can echo a
      // fragment of the file's actual bytes back — this file holds a spend-capable
      // JWK, and that fragment must never end up quoted into a log/terminal a caller
      // wasn't expecting it to appear in. Report only that the JSON was malformed,
      // never the parser's own message.
      throw new Error(`${what}: ${walletPath} does not contain valid JSON`);
    }
    // Any OTHER failure (EACCES, a directory sitting where the file should be, …) is
    // a genuine I/O problem the operator needs the real error to debug — that keeps
    // the raw errMsg(e) detail untouched; it cannot echo file CONTENT the way a
    // JSON.parse SyntaxError can.
    throw new Error(`${what}: cannot read JWK wallet at ${walletPath}: ${errMsg(e)}`);
  }
  // A syntactically-valid-JSON file that isn't shaped like a JWK (`{}`, a JSON blob that
  // isn't a wallet at all — plausible after a bad edit or a wrong CYPHER_BRAIN_AR_WALLET
  // pointer) parsed cleanly above, so it never hit the catch's error treatment. Without
  // this check it would sail straight into jwkToAddress() and surface whatever raw,
  // unprefixed error arweave-js happens to throw internally instead of this function's
  // own "cannot read JWK wallet" treatment (#497). Checked field-by-field against
  // arweave-js's own JWKPublicInterface (kty/e/n — the fields jwkToAddress actually
  // reads) rather than trusting the parsed value's shape.
  if (
    jwk === null ||
    typeof jwk !== 'object' ||
    typeof (jwk as { kty?: unknown }).kty !== 'string' ||
    typeof (jwk as { e?: unknown }).e !== 'string' ||
    typeof (jwk as { n?: unknown }).n !== 'string'
  ) {
    throw new Error(`${what}: ${walletPath} does not look like a JWK wallet (missing kty/e/n fields)`);
  }
  const ar = await getArweave();
  try {
    return await ar.wallets.jwkToAddress(jwk);
  } catch (e) {
    throw new Error(`${what}: cannot read JWK wallet at ${walletPath}: ${errMsg(e)}`);
  }
}

async function walletAddress(o: CliOptions): Promise<void> {
  console.log(await addressFromWallet(o, 'wallet address'));
}

// Best-effort payer address for a backend — used by the plan/apply flow (#231, plan.ts)
// to bind a plan to the identity that will actually spend, so a payer swap between
// `estimate --out` and `push --plan` is caught rather than silently paid from a
// different wallet than what was reviewed. Returns null (never throws) when nothing is
// configured or the configured credential cannot be read: a plan can still be built
// and applied without a payer bound (e.g. planning before a wallet is funded), it
// just cannot detect a payer swap in that case. estimate.ts's `estimate()` reaches
// this via a DYNAMIC import specifically — this module statically imports estimate.ts's
// rate functions, so a static import back from estimate.ts would be circular (the same
// reason estimate.ts already inlines tonWalletConfigured() rather than importing it).
// pushpull.ts has no such cycle (it does not export anything wallet.ts imports), so it
// imports payerAddressFor statically like any other function here.
export async function payerAddressFor(backend: string, o: CliOptions): Promise<string | null> {
  if (backend === 'arweave' || backend === 'turbo') {
    const walletPath = o.wallet || AR_WALLET || WALLET_DEFAULT_PATH;
    if (!(await walletConfigured(walletPath))) return null;
    try {
      return await addressFromWallet(o, 'estimate --out');
    } catch {
      return null;
    }
  }
  if (backend === 'ton-provider') {
    if (TON_WALLET) {
      try {
        return await addressFromTonWallet(o, 'estimate --out');
      } catch {
        return null;
      }
    }
    return TON_PROVIDER_OWNER || null;
  }
  return null; // file/rclone/ton: no payer concept
}

// "expires 2026-08-11T14:05:07Z (in 6 days)" — the relative part is the one that
// actually answers "do I need to redo this before my next push?", which an ISO timestamp
// alone does not at a glance.
function fmtExpiry(a: CreditApproval): string {
  if (a.expires_at === null) return 'no expiry';
  // Shown as UNKNOWN rather than quietly printed as if it were a date: this is the one
  // line telling the operator whether the approval will still be there at push time.
  if (!a.expiry_known) return `expiry UNKNOWN (unreadable: ${a.expires_at})`;
  if (a.expired) return `EXPIRED ${a.expires_at}`;
  const days = (Date.parse(a.expires_at) - Date.now()) / 86_400_000;
  const rel = days >= 1 ? `in ${Math.floor(days)} day(s)` : `in under a day`;
  return `expires ${a.expires_at} (${rel})`;
}

function printApprovals(list: CreditApproval[], heading: string, peerLabel: (a: CreditApproval) => string): void {
  if (list.length === 0) return;
  console.log(`\n${heading}`);
  for (const a of list) {
    console.log(`  ${peerLabel(a)}`);
    console.log(`    remaining ${a.remaining} winc (of ${a.approved} approved, ${a.used} used) — ${fmtExpiry(a)}`);
  }
}

async function walletBalance(o: CliOptions): Promise<void> {
  // --address queries any address WITHOUT a key — the payment service serves balances by
  // public address. That is the whole point for the funding flow: the wallet holding the
  // credits you just bought (a browser/MetaMask wallet) is precisely the one whose JWK
  // this machine does not have, so requiring a signer would put the most important
  // address of the top-up out of reach. It also means this path needs neither the
  // `arweave` package nor a wallet file.
  const address = o.address ?? (await addressFromWallet(o, 'wallet balance'));
  // Validated HERE, before any network call, even though fetchBalance re-checks: input we
  // are about to reject should not first send a request anywhere (Codex review). The
  // check inside fetchBalance stays — it guards the function itself, not just this path.
  if (!isWalletAddress(address))
    throw new Error(`wallet balance: not a wallet address (Arweave/Ethereum/Solana): ${JSON.stringify(address)}`);
  // Fetched once and passed in, rather than let fetchBalance reach for it, so the JSON
  // and human paths price the same numbers off the same rate. Null (rate unavailable)
  // degrades to omitting USD, never to failing the balance — same posture as the cost
  // estimate's USD line (#170). Turbo's credit rate, not AR spot (#343): these ARE turbo
  // credits, and their honest USD value is what replacing them with fiat costs; AR spot
  // is only the fallback when the price sheet is down.
  // Provenance is kept, not just the number (Codex review): a USD figure that might be
  // the credit price or might be the visibly-lower AR spot must say which it is, or the
  // fallback silently changes the meaning of the line.
  const credit = await turboUsdRate();
  const spot = credit === null ? await arUsdRate() : null;
  const pricing =
    credit !== null
      ? { rate: credit.ratePer1e12Winc, source: 'turbo-credit' as const }
      : spot !== null
        ? { rate: spot, source: 'ar-spot' as const }
        : null;
  const rateLabel = credit !== null ? 'Turbo credit rate' : 'AR spot — credit price sheet unavailable';
  const bal = await fetchBalance(address, pricing);
  if (o.json) return printJson(bal);

  const ar = (w: string) => `${w} winc (~${(Number(w) / 1e12).toFixed(8)} AR)`;
  console.log(`address           : ${bal.address}`);
  console.log(`own balance       : ${ar(bal.own)}`);
  console.log(
    `spendable balance : ${ar(bal.effective)}${pricing !== null ? ` = ${usdApprox(BigInt(bal.effective), pricing.rate)} (${rateLabel})` : ''}`,
  );
  printApprovals(
    bal.received_approvals,
    'received credit share approvals (this address can spend these):',
    (a) => `from ${a.payer}`,
  );
  printApprovals(
    bal.given_approvals,
    'given credit share approvals (delegated away to others):',
    (a) => `to ${a.recipient}`,
  );
  // The gap #341 is about: an approval is only reachable at push time when
  // CYPHER_BRAIN_AR_PAID_BY names its payer, so a balance that LOOKS spendable here can
  // still fail an upload. Say so at the one moment the operator is looking at both.
  // "Usable" means a push could actually draw on it: a known, unexpired deadline AND winc
  // left. An exhausted or unevaluatable approval is the trap this whole command exists to
  // expose — pointing at one and saying "set PAID_BY to spend this" is exactly the false
  // green light #341 is about (Codex review). It also must not satisfy the PAID_BY-match
  // check below, or such an approval would silence the warning that names the problem.
  const usable = bal.received_approvals.filter((a) => a.expiry_known && !a.expired && BigInt(a.remaining) > 0n);
  if (usable.length > 0 && !AR_PAID_BY) {
    warn(
      `${usable.length} received approval(s) above are NOT reachable by a push yet: set ` +
        `CYPHER_BRAIN_AR_PAID_BY=<payer address> so the upload draws from one (see docs/arweave-upload-runbook.md).`,
    );
  } else if (AR_PAID_BY && !usable.some((a) => sameWalletAddress(a.payer, AR_PAID_BY))) {
    warn(
      `CYPHER_BRAIN_AR_PAID_BY=${AR_PAID_BY} matches no live approval to this address — ` +
        `a push using it will fall back to the own balance above.`,
    );
  }
}

// #435: same nearestName() "did you mean" idiom #425 wired into top-level commands/
// flags, reused here for wallet's OWN sub-verb (`wallet adress` used to get only the
// generic "expected create | address | balance" listing). Shared by both the ton and
// arweave branches below — their sub-verb set is identical, so a single helper keeps
// the two switches from drifting on this message the way #300's header warns against.
const WALLET_SUBCOMMANDS = ['create', 'address', 'balance'];
// #779: UsageError — a mistyped sub-verb is a parser-level refusal (exit 2 via
// cli.ts's main().catch(), not the generic-failure 1).
function unknownWalletSubcommand(got: string | undefined): UsageError {
  const suggestion = got ? nearestName(got, WALLET_SUBCOMMANDS) : undefined;
  return new UsageError(
    `wallet: expected create | address | balance, got: ${got || '(nothing)'}${suggestion ? ` (${didYouMean(suggestion)})` : ''}`,
  );
}

export async function wallet(o: CliOptions): Promise<void> {
  const chain = o.chain || 'arweave';
  if (chain !== 'arweave' && chain !== 'ton') {
    // #435: --chain is itself an enum-valued flag, same class as --level/--backend below.
    // #779: UsageError, same reasoning as unknownWalletSubcommand() above.
    const suggestion = nearestName(chain, ['arweave', 'ton']);
    throw new UsageError(
      `wallet: --chain must be arweave or ton, got: ${JSON.stringify(chain)}${suggestion ? ` (${didYouMean(suggestion)})` : ''}`,
    );
  }
  if (chain === 'ton') {
    switch (o._) {
      case 'create':
        return tonWalletCreate(o);
      case 'address':
        return tonWalletAddress(o);
      case 'balance':
        return tonWalletBalance(o);
      default:
        throw unknownWalletSubcommand(o._);
    }
  }
  switch (o._) {
    case 'create':
      return walletCreate(o);
    case 'address':
      return walletAddress(o);
    case 'balance':
      return walletBalance(o);
    default:
      throw unknownWalletSubcommand(o._);
  }
}
