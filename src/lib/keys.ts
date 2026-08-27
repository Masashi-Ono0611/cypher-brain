// keygen + identity/recipient helpers.
import { mkdir, writeFile, rm, rename, chmod, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  HOME,
  IDENTITY,
  RECIPIENT,
  SIGN_IDENTITY,
  SIGN_RECIPIENT,
  AGE_PUBKEY_RE,
  AGE_MAGIC,
  AGE_ARMOR_HEADER,
} from './config.js';
import { generateKeypair, identityFileText, askNewPassphrase, wrapIdentity } from './crypt.js';
import { keygenSignAt } from './minisign.js';
import { exists } from './util.js';
import type { CliOptions } from './types.js';

// Core of keygen(), parameterized over WHERE to write (home dir + identity/recipient
// paths) instead of the global HOME/IDENTITY/RECIPIENT constants — extracted so a
// second caller (the `init` wizard, src/lib/wizard.ts) can generate a keypair at a
// wizard-chosen path (e.g. an offline backup keypair under `<HOME>-backup`) using the
// EXACT SAME generation logic keygen() uses, instead of a duplicated hand-roll. This
// refactor changes NO observable behavior of keygen() itself (same checks, same
// writes, same exclusive-create semantics) — keygen() below is now a thin wrapper
// that calls this with the module's global paths and prints its existing messages.
export interface KeygenAtOpts {
  home: string;
  identityPath: string;
  recipientPath: string;
  passphrase?: boolean;
  force?: boolean;
  pq?: boolean; // post-quantum HYBRID keypair (ML-KEM-768 + X25519, #205) instead of plain X25519
}

export interface KeygenAtResult {
  recipient: string;
  wrapped: boolean;
}

// Elide a long recipient string for terminal display (issue #424): a --pq hybrid
// recipient is ~1960 bytes, so printed in full it dominates the terminal output for
// dozens of wrapped rows. Show first+last 20 chars instead — mirrors how git shows
// abbreviated commit hashes. Display-only: the caller is expected to have already
// written the FULL value to recipient.txt before calling this.
function elideRecipient(recipient: string): string {
  const HEAD = 20;
  const TAIL = 20;
  if (recipient.length <= HEAD + TAIL + '…'.length) return recipient;
  return `${recipient.slice(0, HEAD)}…${recipient.slice(-TAIL)} (${recipient.length} bytes, full value written to recipient.txt)`;
}

// Write `payload` to `path`, choosing an ordering that never destroys an existing
// file before its replacement is fully durable on disk (#122):
//  - !force: exclusive create ('wx') directly at `path` — the OS itself refuses if
//    something is already there. This also catches a concurrent keygen that raced
//    past keygenAt()'s own pre-flight exists() check below (the same TOCTOU guard
//    the original identity write already relied on).
//  - force: `path` may legitimately hold the file being REPLACED. The new payload
//    is written to a freshly, exclusively-created sibling temp file FIRST, and only
//    THEN rename()'d over `path` — an atomic swap (same technique wizard.ts's own
//    recovery-kit write and snapshot.ts's promoteSnapshot() already use). `path`'s
//    old content is only ever touched by the rename succeeding, i.e. once the new
//    payload already sits fully-written on disk — so a failure BEFORE this point
//    (e.g. a mistyped passphrase confirmation, Ctrl-C) can never delete anything.
// Exported so wallet.ts (`cypher-brain wallet create`, #158) can give the Arweave JWK
// the SAME fail-closed, no-clobber-unless-force write this module already gives the
// age identity, instead of a hand-rolled second write path with its own TOCTOU/partial-
// write behavior to keep in sync.
export async function writeKeyFile(
  path: string,
  payload: string | Uint8Array,
  mode: number,
  force: boolean,
): Promise<void> {
  if (!force) {
    await writeFile(path, payload, { mode, flag: 'wx' });
    return;
  }
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, payload, { mode, flag: 'wx' });
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function keygenAt(opts: KeygenAtOpts): Promise<KeygenAtResult> {
  // 0700: the home dir holds the private identity (and often the JWK wallet) — it must
  // not be world/group-listable. chmod too, in case it pre-existed with a looser mode.
  // Fail closed (#119): if this chmod fails (owner mismatch from an earlier sudo/root
  // creation, a read-only mount, an immutable attribute, ...) do NOT silently proceed
  // to write a secret identity into a directory whose permissions could not be
  // verified/corrected — propagate the error instead of swallowing it.
  await mkdir(opts.home, { recursive: true, mode: 0o700 });
  await chmod(opts.home, 0o700);

  // Both targets are checked BEFORE anything is generated or written (#121):
  // recipient.txt now gets the SAME no-clobber protection identity.age already had,
  // instead of the plain writeFile() the code below used to fall through to, which
  // silently truncated/replaced an existing recipient.txt with no --force gate at
  // all — letting whoever can trigger a keygen re-key every FUTURE snapshot a
  // pinned recipient.txt was meant to protect against. Checked identity-first so the
  // (unchanged) identity refusal still wins when BOTH already exist.
  if ((await exists(opts.identityPath)) && !opts.force) {
    throw new Error(
      `identity already exists at ${opts.identityPath} (refusing to overwrite — losing it = losing the brain). Pass --force only if you are certain.`,
    );
  }
  if ((await exists(opts.recipientPath)) && !opts.force) {
    throw new Error(
      `recipient already exists at ${opts.recipientPath} (refusing to overwrite — a silently re-keyed recipient.txt would re-key every FUTURE snapshot). Pass --force only if you are certain.`,
    );
  }
  // The key is generated in-process (typage) and — on the passphrase path — wrapped
  // in memory too (#36): unlike the old external `age -p` flow there is no unwrapped
  // temp file on disk, so nothing can linger even on Ctrl-C at the prompt.
  const { identity, recipient } = await generateKeypair({ pq: opts.pq });
  const text = identityFileText(identity, recipient); // the standard age-keygen file layout
  let payload: string | Uint8Array = text;
  let wrapped = false;
  if (opts.passphrase) {
    console.log('Set a passphrase to protect the identity at rest (you will enter it on restore/verify):');
    payload = await wrapIdentity(text, await askNewPassphrase()); // scrypt, same format `age -p` writes
    wrapped = true;
  }
  // Both the new identity and the new recipient are fully prepared by this point —
  // only from here on is an existing file (--force) ever touched, and even then via
  // write-new-then-rename, never delete-then-write (#122; see writeKeyFile above).
  await writeKeyFile(opts.identityPath, payload, 0o600, !!opts.force);
  await writeKeyFile(opts.recipientPath, `${recipient}\n`, 0o644, !!opts.force);
  return { recipient, wrapped };
}

// Passphrase-wrap an ALREADY-EXISTING identity file in place (#110): unlike `keygen
// --force`, which unconditionally calls generateKeypair() above and so DISCARDS the
// old keypair for a brand-new one, this keeps the exact same X25519 keypair and only
// changes its on-disk encoding — every snapshot already encrypted to it stays
// restorable. Reuses the same wrapIdentity()/askNewPassphrase() pair the `init`
// wizard's own Step 3 (wizard.ts) already calls for this identical in-place wrap;
// exposed here as `keygen --wrap-in-place` so someone who skipped that step (or ran a
// bare `keygen`) can still protect the identity later without re-running the whole
// wizard (which refuses once an identity exists) or losing it via --force.
async function wrapInPlace(identityPath: string): Promise<void> {
  if (!(await exists(identityPath))) {
    throw new Error(`no identity found at ${identityPath} — nothing to wrap. Run "cypher-brain keygen" first.`);
  }
  const raw = await readFile(identityPath);
  const rawText = raw.toString('utf8');
  // Same two "already wrapped" shapes loadIdentities() (crypt.ts) checks for: raw age
  // ciphertext (the magic bytes), OR that same ciphertext ASCII-armored (`age -p -a`,
  // or an identity re-typed from a printed recovery note — #87's motivating case).
  // Either form must be refused here, not treated as plaintext: wrapIdentity() below
  // would otherwise double-wrap the ciphertext/armor text as if it were the real
  // secret key, corrupting it rather than protecting it.
  const alreadyWrapped =
    raw.subarray(0, AGE_MAGIC.length).toString('latin1') === AGE_MAGIC ||
    rawText.trimStart().startsWith(AGE_ARMOR_HEADER);
  if (alreadyWrapped) {
    throw new Error(`${identityPath} is already passphrase-wrapped (age ciphertext) — nothing to do.`);
  }
  console.log('Set a passphrase to protect the identity at rest (you will enter it on restore/verify):');
  const payload = await wrapIdentity(rawText, await askNewPassphrase());
  // Atomic temp-then-rename (writeKeyFile's force=true path, same helper keygenAt's
  // own --force replace uses above) rather than a plain writeFile: the pre-existing
  // identityPath is only ever replaced once the new payload is fully written, so a
  // crash/Ctrl-C mid-write can't leave a truncated, unusable identity file behind.
  await writeKeyFile(identityPath, payload, 0o600, true);
  console.log(`identity re-written, passphrase-wrapped: ${identityPath}`);
}

// keygen --sign (#214): generates a minisign-compatible Ed25519 SIGNING keypair —
// entirely independent of the age identity/recipient above (a separate credential,
// same as `wallet create`'s Arweave JWK is). Deliberately its OWN mode (like
// --wrap-in-place above), not combined with the age-specific flags (--pq/--passphrase
// still apply to it for at-rest wrapping, but there is no age keypair generated or
// touched by this branch) — keeps `keygen --sign` usable to ADD signing to an existing
// setup without re-running (or being blocked by) the age identity's own no-clobber
// check.
async function keygenSign(o: CliOptions): Promise<void> {
  const identityPath = o.sign_identity || SIGN_IDENTITY;
  const recipientPath = o.sign_recipient || SIGN_RECIPIENT;
  const { wrapped, pubkeyText } = await keygenSignAt({
    home: HOME,
    identityPath,
    recipientPath,
    passphrase: o.passphrase,
    force: o.force,
  });
  // The two labels differ in width (41 vs 42 chars), so the shorter one gets an
  // extra space to keep both paths starting in the same column (issue #263).
  console.log(`signing identity (PRIVATE, keep offline):  ${identityPath}${wrapped ? ' (passphrase-wrapped)' : ''}`);
  console.log(`signing public key (PUBLIC, safe to copy): ${recipientPath}`);
  console.log(pubkeyText.trimEnd());
  console.log(
    '\n⚠  Back up the signing identity now. Losing it means future snapshots can no longer be signed ' +
      '(existing *.minisig files stay verifiable against the public key above regardless).',
  );
}

export async function keygen(o: CliOptions): Promise<void> {
  if (o.sign) {
    // Same "fail loud instead of silently no-op-ing one of the two" discipline as the
    // --pq + --wrap-in-place guard below: --wrap-in-place only re-wraps the EXISTING
    // age identity, and has no meaning for the (independent) signing keypair --sign
    // generates.
    if (o.wrap_in_place)
      throw new Error(
        '--sign has no effect with --wrap-in-place (which only re-wraps the age identity). Run "keygen --sign" on its own.',
      );
    // --pq generates a post-quantum HYBRID AGE identity — meaningless for a minisign
    // signing keypair, which is Ed25519 only (there is no post-quantum minisign mode).
    // Same "fail loud instead of silently no-op-ing" discipline as --wrap-in-place
    // above: silently ignoring --pq here would leave the operator believing they got
    // a post-quantum signing key when they did not.
    if (o.pq)
      throw new Error(
        '--pq has no effect with --sign (the signing keypair is always Ed25519). Run "keygen --sign" on its own.',
      );
    return keygenSign(o);
  }
  if (o.wrap_in_place) {
    // --wrap-in-place only re-wraps the EXISTING identity file's text with a
    // passphrase — it never touches the keypair itself (see wrapInPlace() above).
    // --pq generates a NEW keypair, which --wrap-in-place explicitly does not do —
    // so combining them would silently no-op --pq, giving a false impression that
    // the identity got rotated to post-quantum when nothing changed. Fail loud
    // instead (reviewer-flagged, #205).
    if (o.pq)
      throw new Error(
        '--pq has no effect with --wrap-in-place (which only passphrase-wraps the EXISTING identity — it does not generate a new keypair). Run a fresh "keygen --pq --force" to rotate to a post-quantum keypair (this makes prior snapshots unrecoverable unless also encrypted to another key).',
      );
    return wrapInPlace(IDENTITY);
  }
  const { recipient, wrapped } = await keygenAt({
    home: HOME,
    identityPath: IDENTITY,
    recipientPath: RECIPIENT,
    passphrase: o.passphrase,
    force: o.force,
    pq: o.pq,
  });
  // Both labels are the same width (33 chars), so a single space after each
  // colon is what actually lines the two paths up (issue #263).
  console.log(`identity (PRIVATE, keep offline): ${IDENTITY}${wrapped ? ' (passphrase-wrapped)' : ''}`);
  console.log(`recipient (PUBLIC, safe to copy): ${RECIPIENT}`);
  // --pq's hybrid recipient is ~1960 bytes — printed in full it line-wraps across
  // the entire terminal for dozens of rows and drowns out every other line above
  // (issue #424). recipient.txt (written above, in full, by keygenAt()) is what's
  // actually used for encryption, so eliding stdout here is display-only and safe;
  // the plain X25519 case (~62 bytes) is already compact and stays untouched.
  console.log(`recipient = ${o.pq ? elideRecipient(recipient) : recipient}`);
  if (o.pq)
    console.log(
      '(post-quantum HYBRID keypair: ML-KEM-768 + X25519 — the recipient/ciphertext are much bigger than plain X25519, see README Threat model)',
    );
  console.log('\n⚠  Back up the identity file now. If you lose it, the snapshots are unrecoverable.');
}

// Return EVERY recipient entry a value feeds to the encrypter: an existing path is
// read as a recipients file and split into its non-blank, non-comment lines;
// anything else is treated as one literal (typically `age1…`) entry. File-existence
// is checked FIRST (#120) — the same precedence resolvePinnedRecipients() below
// deliberately uses — so a recipients FILE whose name happens to start with `age1`
// (e.g. `age1-backup-keys.txt`) is read as a file, not mistaken for an inline
// literal. We must enumerate whole LINES, not just age1… tokens — a non-age1 line
// (e.g. an injected `ssh-ed25519 …`) in a tampered recipient.txt would slip past an
// age1-only scan. The pin enforces the INPUTS, since age ciphertext never exposes
// its recipient pubkeys. (typage itself also rejects non-native recipients —
// defense in depth.)
export async function recipientEntries(rec: string): Promise<string[]> {
  if (!(await exists(rec))) return [rec.trim()];
  const text = await readFile(rec, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// Resolve CYPHER_BRAIN_PIN_RECIPIENTS to a set of allowed pubkeys. File-first: if the
// value names an existing file, read it (so a path that happens to contain "age1",
// e.g. age1-pins.txt, is not mistaken for an inline list); otherwise treat the value
// itself as an inline list of age1… keys. Parsed line-by-line, SKIPPING comment lines
// (mirrors recipientEntries) — a key left commented-out (e.g. a rotated/revoked one)
// must NOT count as allowed, or the pin could be defeated by a stale comment.
export async function resolvePinnedRecipients(val: string): Promise<Set<string>> {
  const text = (await exists(val)) ? await readFile(val, 'utf8') : val;
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    for (const m of l.matchAll(AGE_PUBKEY_RE)) keys.add(m[0]);
  }
  return keys;
}
