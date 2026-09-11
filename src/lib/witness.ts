// Independent evidence lives in signed entries on Arweave. The append-only local
// hint file is ONLY a convenience cache, never proof: losing or compromising this
// machine loses/rewrites the cache too. Keep recovery anchors and public keys off-box.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { HOME, SIGN_IDENTITY, SIGN_RECIPIENT } from './config.js';
import { errMsg, exists, readJsonlLog, syncDirectoryChain } from './util.js';
import { loadSignIdentity, parsePubkeyFile, signDetached, verifyDetached } from './minisign.js';
import type { LoadedSignIdentity, ParsedPubkey } from './minisign.js';
import type { CliOptions, PutOpts, StorageBackend } from './types.js';
import { installStageSignalGuard, addActiveWitnessDir, removeActiveWitnessDir } from './signal-guard.js';
import { UsageError, WitnessAuthenticityError } from './errors.js';
import { printJson } from './ui.js';
import { warn } from './warn.js';

export const WITNESS_CATALOG_VERSION = 1;
export const WITNESS_HINT_FILE = join(HOME, 'witness-catalog.local.jsonl');
export interface WitnessEntry {
  cypher_brain_witness_version: 1;
  sequence: number;
  prev_entry_hash: string | null;
  timestamp: string;
  backend: string;
  locator: string;
  sig_locator: string | null;
  snapshot_sha256: string;
  signing_key_fingerprint: string;
}
export interface WitnessHint {
  sequence: number;
  entry_hash: string;
  entry_locator: string;
  sig_locator: string;
  updated_at?: string;
  backend?: string;
  snapshot_locator?: string;
  snapshot_sha256?: string;
}
const hashPattern = /^[0-9a-f]{64}$/;
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const sequenceValid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// All v1 values are scalar. Explicitly sort keys and serialize each key/value;
// object insertion order (or a caller's serializer) cannot change the hash.
export function canonicalWitnessJson(entry: WitnessEntry): string {
  return `{${Object.keys(entry)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(entry[key as keyof WitnessEntry])}`)
    .join(',')}}`;
}
export function witnessEntryHash(entry: WitnessEntry): string {
  return createHash('sha256').update(canonicalWitnessJson(entry)).digest('hex');
}
function parseEntry(text: string): WitnessEntry {
  const p = JSON.parse(text) as WitnessEntry;
  if (
    !p ||
    typeof p !== 'object' ||
    Object.keys(p).length !== 9 ||
    p.cypher_brain_witness_version !== 1 ||
    !sequenceValid(p.sequence) ||
    !nonempty(p.timestamp) ||
    !Number.isFinite(Date.parse(p.timestamp)) ||
    !nonempty(p.backend) ||
    !nonempty(p.locator) ||
    !(p.sig_locator === null || nonempty(p.sig_locator)) ||
    !nonempty(p.snapshot_sha256) ||
    !hashPattern.test(p.snapshot_sha256) ||
    !nonempty(p.signing_key_fingerprint) ||
    !/^[0-9a-f]{16}$/.test(p.signing_key_fingerprint) ||
    !(p.sequence === 0
      ? p.prev_entry_hash === null
      : nonempty(p.prev_entry_hash) && hashPattern.test(p.prev_entry_hash))
  ) {
    throw new Error('witness: malformed v1 entry');
  }
  if (canonicalWitnessJson(p) !== text) throw new Error('witness: entry is not canonical JSON');
  return p;
}

export async function readWitnessHints(path = WITNESS_HINT_FILE): Promise<{
  hints: WitnessHint[];
  bySequence: Map<number, WitnessHint[]>;
  skippedLines: number;
}> {
  const { items, skippedLines } = await readJsonlLog<WitnessHint>(path, 'witness hints', (value) => {
    const p = value as WitnessHint | null;
    if (
      !p ||
      !sequenceValid(p.sequence) ||
      !nonempty(p.entry_hash) ||
      !hashPattern.test(p.entry_hash) ||
      !nonempty(p.entry_locator) ||
      !nonempty(p.sig_locator) ||
      (p.updated_at !== undefined && (!nonempty(p.updated_at) || !Number.isFinite(Date.parse(p.updated_at)))) ||
      (p.backend !== undefined && !nonempty(p.backend)) ||
      (p.snapshot_locator !== undefined && !nonempty(p.snapshot_locator)) ||
      (p.snapshot_sha256 !== undefined && (!nonempty(p.snapshot_sha256) || !hashPattern.test(p.snapshot_sha256)))
    )
      return null;
    return p;
  });
  // Fold exact repeats, but NEVER let last-write-wins erase a competing entry at
  // the same sequence. Both candidates must be fetched and signature-checked.
  const bySequence = new Map<number, WitnessHint[]>();
  for (const hint of items) {
    const candidates = bySequence.get(hint.sequence) ?? [];
    const i = candidates.findIndex(
      (h) =>
        h.entry_locator === hint.entry_locator &&
        h.sig_locator === hint.sig_locator &&
        h.entry_hash === hint.entry_hash,
    );
    if (i < 0) candidates.push(hint);
    else candidates[i] = hint;
    bySequence.set(hint.sequence, candidates);
  }
  return { hints: [...bySequence.values()].flat().sort((a, b) => a.sequence - b.sequence), bySequence, skippedLines };
}
export async function appendWitnessHint(hint: WitnessHint, path = WITNESS_HINT_FILE): Promise<void> {
  const dir = dirname(path);
  const firstCreated = await mkdir(dir, { recursive: true, mode: 0o700 });
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, 'ax', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    fh = await open(path, 'a');
  }
  try {
    await fh.writeFile(`${JSON.stringify(hint)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await syncDirectoryChain(dir, firstCreated);
}
export async function latestWitnessHint(path = WITNESS_HINT_FILE): Promise<WitnessHint | undefined> {
  const { hints, bySequence, skippedLines } = await readWitnessHints(path);
  if (skippedLines || [...bySequence.values()].some((hs) => new Set(hs.map((h) => h.entry_hash)).size > 1)) {
    throw new Error('witness: local hints contain unreadable or competing entries; inspect before continuing');
  }
  return hints.at(-1);
}
export async function buildWitnessEntry(
  fields: Omit<WitnessEntry, 'cypher_brain_witness_version' | 'sequence' | 'prev_entry_hash' | 'timestamp'>,
  hintPath = WITNESS_HINT_FILE,
): Promise<WitnessEntry> {
  const prev = await latestWitnessHint(hintPath);
  const entry: WitnessEntry = {
    ...fields,
    cypher_brain_witness_version: 1,
    sequence: prev ? prev.sequence + 1 : 0,
    prev_entry_hash: prev?.entry_hash ?? null,
    timestamp: new Date().toISOString(),
  };
  return parseEntry(canonicalWitnessJson(entry));
}
export async function loadWitnessIdentity(o: CliOptions): Promise<LoadedSignIdentity | undefined> {
  if (!o.witness) return undefined;
  const path = o.sign_identity || SIGN_IDENTITY;
  // #932: both preconditions below are pure usage mistakes — decidable from local
  // flags/state alone, no I/O needed to know they're wrong — so both throw
  // UsageError for the SAME exit-code class. This one used to throw a plain Error
  // (exit 1) while the very next check threw UsageError (exit 2): equally
  // usage-mistake-shaped checks producing different exit codes.
  if (!(await exists(path)))
    throw new UsageError(
      `--witness requires a signing identity at ${path}; run keygen --sign or pass --sign-identity <path>`,
    );
  // Turbo also publishes on Arweave. file is solely an offline test/demonstration store.
  if (!['arweave', 'turbo', 'file'].includes(o.backend ?? ''))
    throw new UsageError('--witness requires --backend arweave or turbo (file is available for offline tests only)');
  return loadSignIdentity(path);
}
function makeWitnessDir(): string {
  installStageSignalGuard();
  const dir = mkdtempSync(join(tmpdir(), 'cypher-brain-witness-'));
  addActiveWitnessDir(dir);
  return dir;
}
async function discardWitnessDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  removeActiveWitnessDir(dir);
}
export interface WitnessPublicationProgress {
  entryLocator?: string;
  sigLocator?: string;
}
export async function publishWitnessEntry(
  entry: WitnessEntry,
  identity: LoadedSignIdentity,
  backend: Pick<StorageBackend, 'put'>,
  opts: PutOpts = {},
  hintPath = WITNESS_HINT_FILE,
  progress: WitnessPublicationProgress = {},
): Promise<WitnessHint> {
  if (entry.signing_key_fingerprint !== identity.keyId.toString('hex'))
    throw new Error('witness: signing key fingerprint mismatch');
  const bytes = canonicalWitnessJson(entry);
  parseEntry(bytes);
  const dir = makeWitnessDir();
  let entryLocator: string | undefined;
  let sigLocator: string | undefined;
  try {
    const file = join(dir, 'entry.json');
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(`${file}.minisig`, await signDetached(identity.privateKey, identity.keyId, file), {
      flag: 'wx',
      mode: 0o600,
    });
    entryLocator = await backend.put(file, opts);
    progress.entryLocator = entryLocator;
    console.error(`witness entry sequence ${entry.sequence}: ${entryLocator}`);
    sigLocator = await backend.put(`${file}.minisig`, opts);
    progress.sigLocator = sigLocator;
    console.error(`witness signature: ${sigLocator}`);
    const hint: WitnessHint = {
      sequence: entry.sequence,
      entry_hash: witnessEntryHash(entry),
      entry_locator: entryLocator,
      sig_locator: sigLocator,
      updated_at: new Date().toISOString(),
      backend: entry.backend,
      snapshot_locator: entry.locator,
      snapshot_sha256: entry.snapshot_sha256,
    };
    await appendWitnessHint(hint, hintPath);
    return hint;
  } catch (e) {
    // Print known paid locators even when the next upload or durable hint append fails.
    warn(`witness publication incomplete: entry=${entryLocator ?? 'unknown'}, signature=${sigLocator ?? 'unknown'}`);
    throw e;
  } finally {
    // Codex review: a `finally` that itself throws REPLACES whatever the try/catch
    // above was about to propagate — including a PushUncertainSpendError from
    // backend.put(), which pushpull.ts's caller specifically pattern-matches to
    // preserve permanent-retention/no-retry semantics for an ambiguous paid spend.
    // Losing that classification behind an unrelated scratch-dir cleanup failure
    // would misclassify a real uncertain-spend as an ordinary PushWitnessUploadError.
    // Best-effort cleanup here; a failure is reported but must never mask the
    // original outcome.
    try {
      await discardWitnessDir(dir);
    } catch (cleanupErr) {
      warn(`witness: could not clean up scratch dir ${dir} (${errMsg(cleanupErr)})`);
    }
  }
}
export interface WitnessVerifyResult {
  outcome: 'confirmed' | 'conflicting' | 'freshness-unknown';
  checked: number;
  latest_known: false;
  reason: string;
  conflicts?: { sequence: number; locators: string[] };
}
export interface WitnessVerifyOptions {
  locator: string;
  sigLocator?: string;
  trustedKey: ParsedPubkey;
  trustedFingerprint: string;
  hintPath?: string;
  // Explicit bounded request, not a claim that the starting locator is globally latest.
  toSequence?: number;
  anchor?: { sequence: number; entry_hash: string };
}
export async function verifyWitnessChain(
  backend: StorageBackend,
  o: WitnessVerifyOptions,
): Promise<WitnessVerifyResult> {
  if (o.trustedFingerprint !== o.trustedKey.keyId.toString('hex'))
    throw new Error('witness: fingerprint does not match trusted public key');
  if (o.toSequence !== undefined && !sequenceValid(o.toSequence))
    throw new UsageError('witness: --to-sequence must be a non-negative safe integer');
  const { hints, skippedLines } = await readWitnessHints(o.hintPath);
  const dir = makeWitnessDir();
  let checked = 0;
  const unknown = (reason: string): WitnessVerifyResult => ({
    outcome: 'freshness-unknown',
    checked,
    latest_known: false,
    reason,
  });
  try {
    type FetchedOk = { entry: WitnessEntry; hash: string; locator: string };
    const verified = new Map<string, FetchedOk>();
    // #941: the entry LOCATOR under which each distinct, authenticated entry hash was
    // FIRST observed in THIS verify run. A backend cannot forge a new valid signature,
    // but a malicious or compromised one CAN answer a request for one locator by
    // replaying a different, genuinely-signed entry's own bytes (e.g. an earlier entry
    // E2's real locator+signature, served back in place of a competing fork F2's) — that
    // replayed signature checks out fine (it genuinely IS E2's own valid signature over
    // E2's own bytes), so authenticity alone cannot catch this: fetchEntry used to accept
    // any validly-signed response regardless of whether it corresponded to the LOCATOR
    // that was actually requested, letting a real fork get folded together with the
    // honest entry it was replayed as (reported `confirmed` instead of `conflicting`).
    // Arweave/Turbo locators are NOT content hashes of the uploaded bytes — they are
    // tx/data-item ids assigned by the network from the signed transaction/data-item
    // structure (see pushpull.ts's own "arweave/turbo (locator != content hash)"
    // --sha256 comment), so this can't be closed by recomputing a hash from the locator
    // string itself. It IS closed by noticing that two DIFFERENT locators legitimately
    // resolving to byte-identical (hash-identical) entry content is not an expected
    // outcome of normal operation — nothing in this codebase's publish path ever
    // re-uploads the exact same already-built entry object (each timestamp is fresh) —
    // so it is treated as evidence of substitution, not coincidence.
    // Deliberately NOT keyed off any local hint-file field (entry_hash, sequence, ...):
    // the hint file is an untrusted convenience cache an attacker with local write
    // access could rewrite freely (see this file's header comment), so trusting one of
    // ITS fields as the "expected" hash here would both be circular and would let
    // fabricated hint metadata manufacture a false failure on its own — exactly the
    // property the fork-with-poisoned-hint/hint-forgery scenarios below already require
    // OTHER fields (sequence, entry_hash) not to have. This map instead compares only
    // what was independently fetched AND authenticated (valid signature, correct
    // fingerprint) for each locator actually asked of the backend.
    const hashLocators = new Map<string, string>();
    // Codex review: fetchEntry used to THROW on an invalid signature/fingerprint,
    // which aborted verifyWitnessChain entirely — before the fork-detection loop
    // below ever ran. That let ONE poisoned/malformed hint suppress a genuine
    // `conflicting` result for two OTHER, actually-signed forked entries the loop
    // had already (or would have) authenticated. An invalid candidate is now a
    // return value like `unavailable`, not a thrown exception: it never joins
    // `bySequence` (so it can never itself manufacture a fake conflict or a fake
    // confirmation), but every OTHER candidate is still authenticated and grouped,
    // so a real fork among the genuine entries is still reported. It also still
    // forces `incomplete` (never `confirmed`) — an unverifiable candidate must
    // never be silently dropped as if it had simply been absent.
    const fetchEntry = async (
      locator: string,
      sig: string,
    ): Promise<FetchedOk | { unavailable: string } | { invalid: string }> => {
      const cacheKey = JSON.stringify([locator, sig]);
      const cached = verified.get(cacheKey);
      if (cached) return cached;
      const file = join(dir, 'fetched.json');
      // prev_entry_hash is NOT a locator. This version can resolve predecessors and
      // detached signatures only from local hints (or an explicit starting signature).
      // An old locator alone cannot discover newer entries, nor recover lost mappings.
      try {
        await backend.get(locator, file, 'witness');
        await backend.get(sig, `${file}.minisig`, 'minisig');
      } catch (e) {
        return { unavailable: errMsg(e) };
      }
      const bytes = await readFile(file);
      const signature = await readFile(`${file}.minisig`, 'utf8');
      const result = await verifyDetached(
        o.trustedKey.publicKey,
        o.trustedKey.keyId,
        async () => createHash('blake2b512').update(bytes).digest(),
        signature,
      );
      if (!result.valid) return { invalid: `signature verification failed at ${locator}: ${result.reason}` };
      const entry = parseEntry(bytes.toString('utf8'));
      if (entry.signing_key_fingerprint !== o.trustedFingerprint)
        return { invalid: 'entry signing fingerprint differs from trusted key' };
      const hash = witnessEntryHash(entry);
      // #941: authenticity (a valid signature by the trusted key) proves the bytes are
      // GENUINELY signed; it does not prove they are the bytes THIS locator was actually
      // supposed to resolve to. See the header comment on `hashLocators` above.
      const priorLocator = hashLocators.get(hash);
      if (priorLocator !== undefined && priorLocator !== locator) {
        return {
          invalid:
            `entry hash ${hash} was returned by the backend for two different locators ` +
            `(${priorLocator} and ${locator}) — a backend cannot forge a new signature, but it can ` +
            `replay one genuinely-signed entry's bytes in place of another's; treated as a possible ` +
            `fork-hiding substitution, not a coincidence`,
        };
      }
      hashLocators.set(hash, locator);
      const value = { entry, hash, locator };
      verified.set(cacheKey, value);
      checked++;
      return value;
    };
    const startSig = o.sigLocator ?? hints.find((h) => h.entry_locator === o.locator)?.sig_locator;
    if (!startSig) return unknown('No signature locator is known; supply --sig-locator from the recovery kit.');
    const start = await fetchEntry(o.locator, startSig);
    if ('unavailable' in start) return unknown(`Starting entry/signature unavailable: ${start.unavailable}`);
    // The caller-supplied STARTING point failing authentication is not "one bad
    // hint among many" — the operator handed us a specific locator/signature pair
    // and it does not check out, which is a hard refusal, not a soft incomplete.
    // #930: a GENUINE authenticity failure (signature verification failed, or a
    // signing-key fingerprint mismatch) — distinct from the benign freshness-
    // unknown/conflicting OUTCOMES below, which are return values, never thrown.
    if ('invalid' in start) throw new WitnessAuthenticityError(`witness: ${start.invalid}`);
    const bySequence = new Map<number, FetchedOk[]>();
    const add = (value: FetchedOk) => {
      const group = bySequence.get(value.entry.sequence) ?? [];
      if (!group.some((v) => v.hash === value.hash)) group.push(value);
      bySequence.set(value.entry.sequence, group);
    };
    add(start);
    let incomplete = skippedLines > 0;
    // Check every known candidate, even if a hint lies about its sequence/hash or
    // points beyond the supplied head. Only authenticated entry fields group forks.
    for (const hint of hints) {
      const value = await fetchEntry(hint.entry_locator, hint.sig_locator);
      if ('unavailable' in value || 'invalid' in value) {
        incomplete = true;
        continue;
      }
      add(value);
    }
    for (const [sequence, group] of bySequence) {
      if (group.length > 1)
        return {
          outcome: 'conflicting',
          checked,
          latest_known: false,
          reason: `CONFLICT: different signed entries claim sequence ${sequence} under ${o.trustedFingerprint}`,
          conflicts: { sequence, locators: group.map((v) => v.locator) },
        };
    }
    const target = o.toSequence ?? o.anchor?.sequence ?? 0;
    if (target > start.entry.sequence) throw new UsageError('witness: requested range begins after the supplied entry');
    let current = start;
    while (current.entry.sequence > target) {
      const previous = bySequence.get(current.entry.sequence - 1)?.[0];
      if (!previous)
        return unknown(
          `Cannot resolve predecessor sequence ${current.entry.sequence - 1}; local locator mapping is incomplete.`,
        );
      // #930: a broken hash link is the other half of --help's "invalid signatures
      // or hash links are errors" — a genuine authenticity/integrity failure, not
      // a benign freshness-unknown/conflicting outcome.
      if (current.entry.prev_entry_hash !== previous.hash)
        throw new WitnessAuthenticityError(`witness: hash link mismatch at sequence ${current.entry.sequence}`);
      current = previous;
    }
    if (o.anchor && (current.entry.sequence !== o.anchor.sequence || current.hash !== o.anchor.entry_hash))
      throw new WitnessAuthenticityError('witness: pinned anchor mismatch');
    if (incomplete) return unknown('Some known candidates could not be checked; discovery/coverage is incomplete.');
    if (o.toSequence !== undefined || o.anchor)
      return {
        outcome: 'confirmed',
        checked,
        latest_known: false,
        reason: `Requested segment ${target}..${start.entry.sequence} verified; newer entries may exist (global freshness not established).`,
      };
    return unknown(
      'Signed history is internally consistent, but no independent discovery proves this locator is the latest.',
    );
  } finally {
    await discardWitnessDir(dir);
  }
}
export async function witnessVerify(o: CliOptions): Promise<void> {
  if (o._ !== 'verify') throw new UsageError('use witness verify --locator <entry-locator> [--pubkey <path>]');
  if (!o.locator) throw new UsageError('witness verify requires --locator <entry-locator>');
  if (o.backend && !['arweave', 'turbo', 'file'].includes(o.backend))
    throw new UsageError('witness verify supports Arweave only (or file for offline tests)');
  if (o.to_sequence !== undefined && !/^\d+$/.test(o.to_sequence))
    throw new UsageError('--to-sequence must be a non-negative integer');
  const key = parsePubkeyFile(await readFile(o.pubkey || SIGN_RECIPIENT, 'utf8'));
  const { backendFor } = await import('./backends/index.js');
  const result = await verifyWitnessChain(await backendFor(o.backend || 'arweave'), {
    locator: o.locator,
    sigLocator: o.sig_locator,
    trustedKey: key,
    trustedFingerprint: key.keyId.toString('hex'),
    toSequence: o.to_sequence === undefined ? undefined : Number(o.to_sequence),
  });
  if (o.json) printJson(result);
  else console.log(`${result.outcome}: ${result.reason}`);
  if (result.outcome !== 'confirmed') process.exitCode = 1;
}
