// crypt — the age encryption layer, in-process via typage (npm `age-encryption`,
// FiloSottile's official TypeScript implementation of age). This replaces the
// external `age` / `age-keygen` binaries (#64): the on-disk formats are IDENTICAL
// (age-encryption.org/v1 ciphertext, the standard identity text file, scrypt
// passphrase wrapping), so pre-existing snapshots and identities keep working and
// the reference `age` binary can still read everything we write — both directions
// are asserted in CI by scripts/selftest-interop.sh.
//
// The two pipeline helpers keep the old tar|age / age|tar process-pipe semantics:
// a whole-pipeline timeout, SIGTERM→SIGKILL escalation for the tar child, and
// reject-only-after-the-child-is-dead so a caller's cleanup (rm of .part / stage /
// out-dir) can never race a still-running process that would recreate the files.
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn, type ChildProcess, type StdioNull, type StdioPipe } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import {
  Encrypter,
  Decrypter,
  generateIdentity,
  generateHybridIdentity,
  identityToRecipient,
  armor,
} from 'age-encryption';
import type { PinnedReadable } from './artifact.js';
import { AGE_MAGIC, AGE_ARMOR_HEADER, readEnv } from './config.js';
import { ACTIVE_CHILDREN } from './proc.js';
import { installEpipeGuard } from './ui.js';
import { installStageSignalGuard, setActiveRawInputRestore } from './signal-guard.js';
import { errMsg, warnIfLooseKeyPerms } from './util.js';

// #228: this file's StrykerJS mutation run (`npm run mutation-test`) is deliberately
// scoped, with the ignore-comment markers below, to ONLY generateKeypair(),
// newEncrypter(), and newDecrypter() — the encrypt/decrypt/keygen core
// scripts/selftest-properties.mjs's roundtrip property test exercises. The streaming
// pipeline helpers (encryptToFile/decryptToChild) and passphrase-prompting code below
// have no fast in-process test oracle for Stryker to run per mutant — mutating them
// would only produce "survived" noise, not a security signal. See
// stryker.conf.json's own header comment for the full scope statement.
// Stryker disable all

// ---------- keys ----------

export interface Keypair {
  identity: string;
  recipient: string;
}

// pq=true (#205) generates a post-quantum HYBRID identity (ML-KEM-768 + X25519,
// AGE-SECRET-KEY-PQ-1… / age1pq1… recipient) via typage's generateHybridIdentity()
// instead of plain X25519 — typage's own Encrypter/Decrypter already dispatch on
// the identity/recipient string's prefix, so every downstream consumer (newEncrypter,
// newDecrypter, loadIdentities, recipientEntries) needs no hybrid-specific branch;
// verified by a round-trip in scripts/selftest-pq.sh. Guards against
// "harvest now, decrypt later" (README Threat model) at the cost of a MUCH bigger
// identity/recipient/ciphertext (recipient ~1.9KB vs ~62 bytes, a fixed ~1.4KB
// per-recipient ciphertext overhead vs X25519 — negligible next to a real snapshot,
// but visible on tiny payloads).
// Stryker restore all
export async function generateKeypair(opts: { pq?: boolean } = {}): Promise<Keypair> {
  const identity = opts.pq ? await generateHybridIdentity() : await generateIdentity(); // AGE-SECRET-KEY-PQ-1… or AGE-SECRET-KEY-1…
  const recipient = await identityToRecipient(identity);
  return { identity, recipient };
}
// Stryker disable all

// The standard age-keygen file layout (comments + the secret key line), so the
// identity stays drop-in usable with `age -d -i` and any other age tooling.
export function identityFileText(identity: string, recipient: string): string {
  return `# created: ${new Date().toISOString()}\n# public key: ${recipient}\n${identity}\n`;
}

// A rejected recipient is described only by STRUCTURE (its length, and a short, fixed
// prefix), never verbatim (elevated-caution review): a caller who mixes up flags — or
// hands a recipients file that accidentally contains a private identity line — can pass
// a SECRET key here instead of a public recipient. Embedding the raw rejected value in
// the thrown error (as this used to do) meant a full secret key could end up echoed
// into whatever reads that error — a log, a CI transcript, a bug report — which is
// exactly the leak this codebase's own secret-handling discipline elsewhere (util.ts's
// redactPgConn, restore.ts's various "never print the secret itself" comments) exists
// to prevent. The prefix is capped at a small, FIXED length regardless of the value's
// own length — long enough to recognize a class of mistake (a truncated age1…
// recipient, an accidentally-pasted "AGE-SECRET-KEY-1…" identity, a stray ssh key,
// plain garbage) without exposing enough of an actual secret's bytes to narrow it down.
const REJECTED_RECIPIENT_PREFIX_CHARS = 12;
function describeRejectedRecipient(r: string): string {
  const prefix = r.slice(0, REJECTED_RECIPIENT_PREFIX_CHARS);
  const more = r.length > REJECTED_RECIPIENT_PREFIX_CHARS ? '…' : '';
  return `${r.length} char(s), starting ${JSON.stringify(prefix)}${more}`;
}

// Stryker restore all
export function newEncrypter(recipients: string[]): Encrypter {
  const e = new Encrypter();
  for (const r of recipients) {
    try {
      e.addRecipient(r);
    } catch (err) {
      // Note this is STRICTER than `age -R`, which also accepted ssh-* recipient
      // lines — typage takes native age recipients only, so a stray ssh key in a
      // recipients file is now rejected here even without the recipient pin.
      // errMsg(err) itself is safe to include verbatim: typage's own rejection
      // (age-encryption's recipients.js) is always the fixed string "invalid
      // recipient", never the value being rejected.
      throw new Error(`invalid recipient (${describeRejectedRecipient(r)}): ${errMsg(err)}`);
    }
  }
  return e;
}

export function newDecrypter(identities: string[]): Decrypter {
  const d = new Decrypter();
  for (const i of identities) d.addIdentity(i);
  return d;
}
// Stryker disable all

// scrypt-wrap an identity file's text at rest (keygen --passphrase). Same format
// `age -p` produces, so either implementation can unwrap the other's file.
export function wrapIdentity(text: string, passphrase: string): Promise<Uint8Array> {
  const e = new Encrypter();
  e.setPassphrase(passphrase);
  return e.encrypt(text);
}

// Read an identity file and return its identity lines. A passphrase-wrapped file
// (it IS age ciphertext, so it starts with the age magic) is unwrapped first —
// prompting on the TTY, or taking CYPHER_BRAIN_PASSPHRASE for automation. A
// passphrase-wrapped identity can ALSO be ASCII-armored (the reference `age -p -a`,
// or an identity copied as printable text into a recovery note) — dearmor it back
// to the raw ciphertext bytes before the magic check below, so both forms unwrap
// identically (#87: armored identities used to fall through to "plaintext identity
// lines", which is why armor text lines fed straight into addIdentity() and blew up
// with "unrecognized identity type" instead of ever prompting for a passphrase).
export async function loadIdentities(path: string): Promise<string[]> {
  await warnIfLooseKeyPerms(path, 'age identity (private key)');
  const text = await unwrapTextFile(path);
  const ids = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (ids.length === 0) throw new Error(`no identities found in ${path}`);
  return ids;
}

// Read `path`, transparently reversing whatever at-rest wrapping it carries: ASCII-
// armor (`age -p -a`, or a recovery note it was pasted from) is de-armored first, then
// age-ciphertext bytes (the scrypt passphrase wrap — `keygen --passphrase` / `age -p`)
// are unwrapped by prompting on the TTY (or CYPHER_BRAIN_PASSPHRASE for automation);
// anything else is returned as plain UTF-8 text unchanged. Extracted out of
// loadIdentities() (#214) so a second caller with its own file shape — the minisign
// signing identity (src/lib/minisign.ts), which reuses this SAME age-based wrap rather
// than inventing its own key-encryption scheme — gets the exact same detection/
// unwrap logic instead of a second, subtly-different copy of it. loadIdentities()'s
// OWN job (splitting the result into non-comment identity lines) stays there; this
// only ever returns the plaintext file body.
export async function unwrapTextFile(path: string): Promise<string> {
  let raw = await readFile(path);
  const rawText = raw.toString('utf8');
  // trimStart, not a byte-0 match: a copy-pasted-into-a-note identity routinely picks
  // up a leading blank line / BOM, and armor.decode() itself trims before parsing —
  // matching that here means a padded paste doesn't silently fall through to the
  // plaintext branch below (the same failure shape #87 was filed for).
  if (rawText.trimStart().startsWith(AGE_ARMOR_HEADER)) {
    try {
      raw = Buffer.from(armor.decode(rawText));
    } catch (e) {
      throw new Error(`could not dearmor ${path}: ${errMsg(e)}`);
    }
  }
  if (raw.subarray(0, AGE_MAGIC.length).toString('latin1') === AGE_MAGIC) {
    const pass = await askPassphrase(`Enter passphrase for ${path}: `);
    try {
      return await unwrap(raw, pass);
    } catch (e) {
      throw new Error(`could not unwrap ${path} (wrong passphrase?): ${errMsg(e)}`);
    }
  }
  return raw.toString('utf8');
}

// Classify an identity file's AT-REST shape WITHOUT unwrapping it (no passphrase
// touched) — for callers that must decide what a file IS before embedding it
// somewhere (recovery-kit, #364). Reuses unwrapTextFile's exact detection order
// (dearmor first, then the age magic) so the two can never disagree, and adds
// the one check unwrap-time code never needed: whether the ciphertext's header
// carries an scrypt stanza (a passphrase wrap) or a recipient stanza (ordinary
// ciphertext that merely LOOKS like a wrapped identity — e.g. an armored
// snapshot pasted to the wrong path). `bytes` is the dearmored ciphertext (or
// the raw file when not armored) so a caller can re-armor without re-reading.
export interface IdentityAtRest {
  kind: 'plaintext' | 'wrapped' | 'ciphertext-not-passphrase' | 'unrecognized';
  armored: boolean;
  bytes: Buffer;
  text: string;
}
export async function classifyIdentityFileAtRest(path: string): Promise<IdentityAtRest> {
  const raw = await readFile(path);
  const text = raw.toString('utf8');
  let bytes = raw;
  let armored = false;
  if (text.trimStart().startsWith(AGE_ARMOR_HEADER)) {
    try {
      bytes = Buffer.from(armor.decode(text));
    } catch (e) {
      throw new Error(`could not dearmor ${path}: ${errMsg(e)}`);
    }
    armored = true;
  }
  if (bytes.subarray(0, AGE_MAGIC.length).toString('latin1') === AGE_MAGIC) {
    // The age header is plain text: "age-encryption.org/v1\n-> <stanza> …". A passphrase
    // wrap (age -p / keygen --passphrase) always has scrypt as its FIRST stanza, so the
    // check is ANCHORED right after the version line — a substring scan over the first N
    // bytes would also match an "-> scrypt " sequence sitting in a later stanza or in
    // ciphertext payload, classifying recipient ciphertext as a passphrase wrap (Codex
    // round-2 finding, demonstrated with a forged file).
    const prefix = `${AGE_MAGIC}\n-> scrypt `;
    const scrypt = bytes.subarray(0, prefix.length).toString('latin1') === prefix;
    return { kind: scrypt ? 'wrapped' : 'ciphertext-not-passphrase', armored, bytes, text };
  }
  if (armored) return { kind: 'unrecognized', armored, bytes, text };
  // A plaintext identity file always carries an AGE-SECRET-KEY-… line — the
  // generic prefix, NOT the X25519-only "AGE-SECRET-KEY-1": PQ hybrid identities
  // (#PQ support) use AGE-SECRET-KEY-PQ-1… and must classify identically.
  const hasSecret = text.split('\n').some((l) => l.trim().startsWith('AGE-SECRET-KEY-'));
  return { kind: hasSecret ? 'plaintext' : 'unrecognized', armored, bytes, text };
}

/** ASCII-armor age ciphertext bytes (the `age -p -a` encoding) — for embedding a
 *  binary wrap into a printable document (recovery-kit, #364). */
export function armorCiphertext(bytes: Uint8Array): string {
  return armor.encode(bytes);
}

async function unwrap(raw: Buffer, pass: string): Promise<string> {
  const d = new Decrypter();
  d.addPassphrase(pass);
  return d.decrypt(new Uint8Array(raw), 'text');
}

// ---------- passphrase prompting ----------

// CYPHER_BRAIN_PASSPHRASE (env) skips the prompt — for unattended restore/verify
// and the CI interop test. Otherwise read hidden from the TTY (like `age -p`).
export async function askPassphrase(question: string): Promise<string> {
  const env = readEnv('CYPHER_BRAIN_PASSPHRASE');
  if (env) return env;
  return promptHidden(question);
}

export async function askNewPassphrase(): Promise<string> {
  const env = readEnv('CYPHER_BRAIN_PASSPHRASE');
  if (env) return env;
  const a = await promptHidden('Enter passphrase: ');
  if (!a) throw new Error('empty passphrase — refusing to wrap the identity with nothing');
  const b = await promptHidden('Confirm passphrase: ');
  if (a !== b) throw new Error('passphrases do not match');
  return a;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // The prompt and the trailing newline in cleanup() below both write raw stderr —
    // guard before either can fire (same hazard ui.ts's printMascot()/warn.ts's
    // warn() guard against: a downstream reader that closes its pipe early turns an
    // uncaught EPIPE into a process crash mid-prompt).
    installEpipeGuard();
    const { stdin } = process;
    // #739: the prompt itself renders on stderr (see the write just below), not
    // stdin — a caller with an interactive stdin TTY but a redirected/piped stderr
    // (e.g. `keygen --passphrase 2>setup.log`) would otherwise pass this check,
    // enter raw mode, and sit there waiting on input the user can never see (the
    // command just looks hung). Require BOTH streams to be a TTY before ever
    // writing the prompt or touching raw mode.
    if (!stdin.isTTY || !process.stderr.isTTY) {
      return reject(
        new Error(
          'a passphrase prompt requires both stdin and stderr to be a TTY (the prompt renders on stderr) — set CYPHER_BRAIN_PASSPHRASE for non-interactive use',
        ),
      );
    }
    process.stderr.write(question); // prompt on stderr so stdout stays machine-readable
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    let settled = false;
    // #738: a SIGTERM/SIGHUP mid-prompt (a service supervisor stopping the process,
    // or a hung-up controlling terminal) previously tore the process down without
    // ever reaching cleanup() below — restoration was reachable only from the
    // Enter/Ctrl-C data branches. Register a restore callback with the shared
    // signal-guard (installStageSignalGuard is idempotent, and this is the SAME
    // SIGINT/SIGTERM/SIGHUP handler every other "must restore state before this
    // process dies" resource in the CLI already uses) for the exact span this
    // raw-mode read is pending, cleared the instant cleanup() runs the normal way.
    // stdin ending/closing/erroring (the other end of the tty going away) is the
    // non-signal half of the same hazard, handled below via onStreamEnd/
    // onStreamError instead of the signal guard.
    installStageSignalGuard();
    setActiveRawInputRestore(() => {
      try {
        stdin.setRawMode(wasRaw);
      } catch {}
    });
    const cleanup = () => {
      if (settled) return;
      settled = true;
      stdin.off('data', onData);
      stdin.off('end', onStreamEnd);
      stdin.off('close', onStreamEnd);
      stdin.off('error', onStreamError);
      setActiveRawInputRestore(null);
      // Codex review: guard, don't let this throw skip pause()/the trailing newline
      // (and, via onStreamError/onStreamEnd, the reject() right after this call) — the
      // exact broken-stdin conditions those two handlers exist for are also the ones
      // where the native setRawMode() binding can itself throw (e.g. the fd is no
      // longer a valid tty).
      try {
        stdin.setRawMode(wasRaw);
      } catch {}
      stdin.pause();
      process.stderr.write('\n');
    };
    // #<elevated-caution review>: a STATEFUL decoder, not d.toString('utf8') per chunk
    // — a raw-mode TTY delivers 'data' events per read() syscall, which can split a
    // multibyte UTF-8 character (e.g. one of a Japanese passphrase's characters, 3
    // bytes) across two separate chunks. Decoding each chunk independently turns the
    // truncated lead bytes into a U+FFFD replacement character in the FIRST chunk and
    // garbles the leftover continuation bytes in the SECOND — silently corrupting the
    // passphrase in a way that only surfaces LATER, when the operator tries to unwrap
    // an identity with the passphrase they actually typed and it no longer matches.
    // node:string_decoder's StringDecoder buffers any incomplete trailing byte
    // sequence and prepends it to the next .write() call, so a character split across
    // chunk boundaries decodes correctly either way.
    const decoder = new StringDecoder('utf8');
    const onData = (d: Buffer) => {
      for (const ch of decoder.write(d)) {
        if (ch === '') {
          cleanup();
          return reject(new Error('interrupted'));
        } // Ctrl-C (raw mode eats the signal)
        if (ch === '\r' || ch === '\n') {
          cleanup();
          return resolve(buf);
        }
        if (ch === '' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    const onStreamEnd = () => {
      cleanup();
      reject(new Error('stdin closed while waiting for a passphrase'));
    };
    const onStreamError = (e: Error) => {
      cleanup();
      reject(e);
    };
    stdin.on('data', onData);
    stdin.on('end', onStreamEnd);
    stdin.on('close', onStreamEnd);
    stdin.on('error', onStreamError);
  });
}

// ---------- streaming pipelines ----------

export interface PipelineOpts {
  timeoutMs?: number;
}

// #613: shared by encryptToFile/decryptToChild below (tar->age vs age->tar — the same
// pipeline in opposite directions), each of which used to hand-roll its own copy of
// this exact state machine: ACTIVE_CHILDREN registration, a settled/pipelineDone/
// childClosed flag trio, a fail() that does SIGTERM-then-SIGKILL escalation and only
// rejects after childExit(), a maybeDone() gate, and timeout wiring. `child` must
// already be spawned with whatever stdio the direction needs; `runStreamPipeline` is
// the direction-specific stream wiring (prod.stdout -> encrypt -> outFile, or inFile ->
// decrypt -> cons.stdin); `onFailCleanup` destroys whatever OTHER stream (the output
// file, or the input file) that pipeline touches, so a failure never leaves it half-
// written or dangling; `resolveValue` computes what the returned promise resolves with
// once BOTH the pipeline and the child have finished cleanly (encryptToFile has
// nothing to return; decryptToChild optionally returns the child's captured stdout).
// Rejecting ONLY after the child is dead is the one property that matters most: the
// caller's catch/finally (rm of .part / stage) must never race a still-running process
// that would recreate the files (same discipline the old pipe2() had; the signal guard
// covers signals in the meantime).
function runChildPipeline<T>(opts: {
  child: ChildProcess;
  cmdLabel: string; // the direction's own child command, for exit/timeout error text
  timeoutMs?: number;
  timeoutMessage: () => string;
  pipelineErrorLabel: string; // "age encrypt" / "age decrypt", for the pipeline-rejection message
  runStreamPipeline: () => Promise<void>;
  onFailCleanup: () => void;
  resolveValue: () => T;
}): Promise<T> {
  const {
    child,
    cmdLabel,
    timeoutMs,
    timeoutMessage,
    pipelineErrorLabel,
    runStreamPipeline,
    onFailCleanup,
    resolveValue,
  } = opts;
  return new Promise((resolve, reject) => {
    ACTIVE_CHILDREN.add(child);
    let stderrText = '',
      settled = false,
      pipelineDone = false,
      childClosed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const childExit = () =>
      new Promise<void>((r) => {
        if (child.exitCode !== null || child.signalCode !== null) return r();
        child.once('close', () => r());
      });
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {}
      // escalate: a SIGTERM-ignoring child must not linger holding the pipeline open
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 2000);
      killTimer.unref?.();
      onFailCleanup();
      // Reject ONLY after the child is dead — the caller's catch/finally (rm of
      // .part / stage) must never race a still-running process that would recreate
      // the files (same discipline the old pipe2() had; the signal guard covers
      // signals in the meantime).
      childExit().then(() => {
        clearTimeout(killTimer);
        ACTIVE_CHILDREN.delete(child);
        reject(e);
      });
    };
    const maybeDone = () => {
      if (settled || !pipelineDone || !childClosed) return;
      settled = true;
      clearTimeout(timer);
      ACTIVE_CHILDREN.delete(child);
      resolve(resolveValue());
    };
    if (timeoutMs) timer = setTimeout(() => fail(new Error(timeoutMessage())), timeoutMs);
    child.stderr?.on('data', (d) => (stderrText += d));
    child.on('error', fail);
    child.on('close', (code, signal) => {
      childClosed = true;
      if (code !== 0)
        return fail(new Error(`${cmdLabel} exited ${signal ? `on ${signal}` : code}: ${stderrText.trim()}`));
      maybeDone();
    });
    runStreamPipeline().then(
      () => {
        pipelineDone = true;
        maybeDone();
      },
      (e: unknown) => fail(new Error(`${pipelineErrorLabel} failed: ${errMsg(e)}`)),
    );
  });
}

// tar(child) stdout → typage encrypt (WebStream) → outPath, all streaming (bounded
// RSS regardless of snapshot size). Success requires BOTH the encrypted stream to be
// fully written AND the producer to exit 0: a tar that dies mid-way merely EOFs its
// stdout, which the encrypter would happily finalize into VALID ciphertext of a
// truncated archive — gating on the exit code turns that into a hard failure (the
// caller then removes the .part).
export function encryptToFile(
  encrypter: Encrypter,
  prodCmd: string,
  prodArgs: string[],
  outPath: string,
  { timeoutMs }: PipelineOpts = {},
): Promise<void> {
  const prod = spawn(prodCmd, prodArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = createWriteStream(outPath);
  return runChildPipeline({
    child: prod,
    cmdLabel: prodCmd,
    timeoutMs,
    timeoutMessage: () => `${prodCmd}|age pipeline timed out after ${timeoutMs}ms`,
    pipelineErrorLabel: 'age encrypt',
    onFailCleanup: () => {
      prod.stdout?.destroy(); // unblock the encrypt reader so its promise settles too
      out.destroy();
    },
    runStreamPipeline: async () => {
      if (!prod.stdout) throw new Error(`${prodCmd}: no stdout stream`);
      const ct = await encrypter.encrypt(Readable.toWeb(prod.stdout) as ReadableStream<Uint8Array>);
      await pipeline(Readable.fromWeb(ct as never), out);
    },
    resolveValue: () => undefined,
  });
}

/**
 * How a decrypt gets at its ciphertext (#785). A FACTORY, not a path and not a single
 * stream: the caller decides where the bytes come from, and every call gets its own
 * fresh stream so a retried or concurrent phase never inherits a half-consumed one.
 * restore/verify hand over `() => artifact.createReadStream()` from the ONE descriptor
 * they opened `--in` on, which is what stops a phase from silently reading a different
 * file than the phase before it did.
 */
export type CiphertextSource = () => PinnedReadable;

export interface DecryptToChildResult {
  /** The consumer's captured stdout TEXT — present only when `consStdout: 'pipe'`. */
  stdout?: string;
  /**
   * sha256 (lowercase hex) of every ciphertext byte this call actually streamed — NOT a
   * second read, and not a second hash either: the pinned stream keeps a running digest
   * as it delivers, and this is that value, read once the pipeline has finished with it.
   * restore.ts compares it against the baseline hash taken before verification, which is
   * what turns "these bytes were checked" into "these bytes were the ones extracted"
   * (#785, CB-E026). `undefined` only if the source is not a pinned stream.
   */
  ciphertextSha256: string | undefined;
}

// source() → typage decrypt (WebStream) → child (tar) stdin, all streaming. A wrong
// key / foreign ciphertext throws at the header, BEFORE the consumer sees a byte; a
// truncated or corrupt payload errors mid-stream and the whole call rejects even if
// tar exited 0 on the resulting EOF — a partial extraction must never look like
// success. Success = decrypt stream fully delivered AND the consumer exited 0.
//
// Resolves with the consumer's captured stdout TEXT when `consStdout: 'pipe'` — added
// for restore.ts's pre-extraction inspection phase (#218), which needs `tar -tf`/
// `tar -tv`'s entry listing back as a string, not merely a "did it succeed" signal —
// alongside the digest of the ciphertext it just streamed (#785).
export function decryptToChild(
  decrypter: Decrypter,
  source: CiphertextSource,
  consCmd: string,
  consArgs: string[],
  { consStdout = 'inherit', timeoutMs }: PipelineOpts & { consStdout?: StdioNull | StdioPipe } = {},
): Promise<DecryptToChildResult> {
  const cons = spawn(consCmd, consArgs, { stdio: ['pipe', consStdout, 'pipe'] });
  // The source hashes as it delivers (src/lib/artifact.ts), so `src.digest` below
  // describes exactly the bytes this decrypt consumed — the claim #785 needs — without
  // this function making a pass of its own. It used to tap the stream through a
  // Transform here; that hashed every byte twice and roughly doubled restore's wall
  // clock on a 1.2 GiB artifact, since the two inspection passes and the extraction all
  // stream the whole file.
  const src = source();
  let cOut = '';
  // Only accumulated when the caller actually asked for it ('pipe') — every other
  // mode ('inherit'/'ignore') never attaches a 'data' listener, so cons.stdout (which
  // is null under those modes anyway) costs this function nothing when unused.
  if (consStdout === 'pipe') cons.stdout?.on('data', (d) => (cOut += d));
  // EPIPE when the consumer dies early — swallow on the pipe end so the real failure
  // surfaces via the close handler instead of an uncaught crash.
  cons.stdin?.on('error', () => {});
  return runChildPipeline({
    child: cons,
    cmdLabel: consCmd,
    timeoutMs,
    timeoutMessage: () => `age|${consCmd} pipeline timed out after ${timeoutMs}ms`,
    pipelineErrorLabel: 'age decrypt',
    onFailCleanup: () => src.destroy(),
    runStreamPipeline: async () => {
      try {
        const pt = await decrypter.decrypt(Readable.toWeb(src) as ReadableStream<Uint8Array>);
        if (!cons.stdin) throw new Error(`${consCmd}: no stdin stream`);
        await pipeline(Readable.fromWeb(pt as never), cons.stdin);
      } catch (e) {
        src.destroy(); // the decrypter may have abandoned its reader without cancelling it
        throw e;
      }
    },
    // Reached only once the plaintext pipeline above resolved, which age cannot do
    // before the ciphertext source hits EOF (typage rejects trailing bytes outright) —
    // so the source's running digest is complete and `digest` is set by then.
    resolveValue: () => ({
      ...(consStdout === 'pipe' ? { stdout: cOut } : {}),
      ciphertextSha256: src.digest,
    }),
  });
}

// verify's negative control: a freshly generated (wrong) key must NOT open the
// artifact. The header check needs no payload read, so this is fast on any size.
export async function wrongKeyRejects(source: CiphertextSource): Promise<boolean> {
  const d = newDecrypter([await generateIdentity()]);
  const src = source();
  try {
    const pt = await d.decrypt(Readable.toWeb(src) as ReadableStream<Uint8Array>);
    await pt.cancel(); // should be unreachable — but never read a payload we didn't ask for
    return false;
  } catch {
    return true;
  } finally {
    src.destroy();
  }
}
