// minisign — Ed25519 detached-signature AUTHENTICITY layer (#214), wire-compatible
// with the reference `minisign` CLI (https://jedisct1.github.io/minisign/, by Frank
// Denis) and the byte layout its SIGNATURE.md/source describe — WITHOUT depending on
// the `minisign` npm package (chm-diederichs' implementation, which wraps
// `sodium-native`, a native binding). That would be the first native-compiled
// dependency in a codebase that has otherwise stayed pure JS/WASM (age-encryption is
// typage — FiloSottile's pure-TS/WASM age — and `ignore` is pure JS); see #214 and the
// PR body for the fuller rationale.
//
// Instead: actual signing/verification is Node's OWN built-in `crypto` Ed25519
// (`crypto.sign`/`crypto.verify(null, data, key)` — RFC 8032 PureEdDSA, OpenSSL-backed,
// audited, zero new dependencies). What THIS module adds is purely the known wire
// SERIALIZATION — SIGALG tags, the 8-byte key id, the base64 line framing, and the
// "sign the trusted comment too" scheme minisign uses for its second (comment)
// signature. That is a known-format encode/decode, not a new cryptographic primitive,
// so it does not fall under CONTRIBUTING.md's "do not roll your own crypto" (which
// governs primitives/KDFs/wrapping schemes, not re-serializing an existing one) — see
// #214's discussion for the maintainer's own framing of this distinction.
//
// Verified byte-for-byte interoperable with the reference `minisign` binary in BOTH
// directions (a signature cypher-brain writes verifies with the real binary, AND a
// signature the real binary writes verifies here) — see scripts/selftest-minisign.sh,
// which runs that round trip for real when `minisign` is on PATH (SKIPs otherwise,
// same posture as scripts/selftest-interop.sh's `age` binary check).
//
// Deliberately does NOT reimplement minisign's own secret-key-at-rest encryption
// (SeckeyStruct's kdf_alg/kdf_salt/opslimit/memlimit/XOR-keystream dance) — that
// machinery has no interop requirement (only cypher-brain ever reads its own signing
// identity file) and hand-rolling a KDF + stream cipher box is exactly the kind of new
// crypto CONTRIBUTING.md warns against. The signing identity instead reuses this
// project's EXISTING, already-reviewed age-based wrap (wrapIdentity()/unwrapTextFile()
// from crypt.ts) for passphrase protection at rest — the same mechanism identity.age
// already uses; only the wire-visible PUBLIC key and SIGNATURE files need to match
// minisign's own format, since those are the ones a real `minisign` binary — or a
// human — might read.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, chmod, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { unwrapTextFile, wrapIdentity, askNewPassphrase } from './crypt.js';
import { writeKeyFile } from './keys.js';
import { exists, errMsg, warnIfLooseKeyPerms } from './util.js';

// ---------- wire format constants (src/minisign.c: SIGALG / SIGALG_HASHED / KEYNUMBYTES
// / COMMENT_PREFIX / TRUSTED_COMMENT_PREFIX — verified against the 0.12 binary) ----------

const SIGALG_PUBKEY = 'Ed'; // a PUBLIC key blob's sig_alg tag is always "Ed" regardless of hashed/legacy signing mode
const SIGALG_HASHED = 'ED'; // a SIGNATURE blob's sig_alg tag for the modern (BLAKE2b-512 pre-hashed) mode — the ONLY mode this module emits or accepts; minisign's legacy un-hashed "Ed" mode is intentionally not supported (new implementations are told to use hashed-only — SIGNATURE.md)
const KEY_ID_BYTES = 8;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const PUBKEY_BLOB_BYTES = 2 + KEY_ID_BYTES + PUBLIC_KEY_BYTES; // 42
const SIG_BLOB_BYTES = 2 + KEY_ID_BYTES + SIGNATURE_BYTES; // 74
const COMMENT_PREFIX = 'untrusted comment: ';
const TRUSTED_COMMENT_PREFIX = 'trusted comment: ';
const DEFAULT_SIG_COMMENT = 'signature from cypher-brain (minisign-compatible, #214)';

// ---------- keypair generation ----------

export interface SignKeypair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: Buffer; // 8 random bytes, generated ONCE per keypair and reused by every signature it makes (mirrors minisign's own randombytes_buf(keynum), NOT derived from the pubkey)
}

export function generateSignKeypair(): SignKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, keyId: randomBytes(KEY_ID_BYTES) };
}

// Raw 32-byte Ed25519 public key, via JWK export (RFC 8037 OKP — `x` is the raw point,
// base64url) — Node has no direct "raw bytes" export for Ed25519 KeyObjects as of the
// Node versions this project supports (engines: >=22.6.0; a `raw-public`/`raw-seed`
// export format exists in newer @types/node but is NOT yet implemented at runtime as of
// Node 24 — confirmed by hand), so JWK is the portable path.
function pubkeyRawBytes(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('minisign: could not export the Ed25519 public key (JWK "x" missing)');
  return Buffer.from(jwk.x, 'base64url');
}

// minisign's write_pk_file() prints the key id as `le64_load(keynum)` formatted
// "%016PRIX64" — i.e. the 8 raw bytes read as a little-endian uint64 and printed in
// (big-endian) hex, which is the BYTE-REVERSED hex of the raw bytes. Purely cosmetic:
// this comment line is untrusted/free text (a verifier never parses it back into the
// key id — only the base64 blob's embedded 8 bytes are ever compared), but matching it
// means a cypher-brain-generated pubkey file reads identically to a real minisign one.
function keyIdCommentHex(keyId: Buffer): string {
  return Buffer.from(keyId).reverse().toString('hex').toUpperCase();
}

// The minisign public-key file: line 1 an (untrusted) comment naming the key id, line 2
// base64(sig_alg "Ed" + key_id + raw pubkey). Byte-identical to what `minisign -G`
// writes — usable directly as `minisign -V -p <this file>` (verified in
// scripts/selftest-minisign.sh).
export function pubkeyFileText(publicKey: KeyObject, keyId: Buffer): string {
  const blob = Buffer.concat([Buffer.from(SIGALG_PUBKEY, 'latin1'), keyId, pubkeyRawBytes(publicKey)]);
  return `${COMMENT_PREFIX}minisign public key ${keyIdCommentHex(keyId)}\n${blob.toString('base64')}\n`;
}

export interface ParsedPubkey {
  keyId: Buffer;
  publicKey: KeyObject;
}

// Parse a minisign public-key file (ours or a real minisign-generated one — the format
// is identical either way). The comment line's exact wording is never trusted, only its
// PREFIX (the same untrusted-comment framing minisign itself uses); the second
// non-blank line is decoded as the 42-byte blob.
export function parsePubkeyFile(text: string): ParsedPubkey {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2)
    throw new Error('minisign: malformed public key file (expected an untrusted-comment line + a base64 line)');
  if (!lines[0].startsWith(COMMENT_PREFIX)) {
    throw new Error(`minisign: public key file line 1 must start with ${JSON.stringify(COMMENT_PREFIX)}`);
  }
  const blob = b64decode(lines[1], 'public key');
  if (blob.length !== PUBKEY_BLOB_BYTES) {
    throw new Error(`minisign: public key blob is ${blob.length} bytes, expected ${PUBKEY_BLOB_BYTES}`);
  }
  const sigAlg = blob.subarray(0, 2).toString('latin1');
  if (sigAlg !== SIGALG_PUBKEY)
    throw new Error(`minisign: public key blob has an unrecognized sig_alg ${JSON.stringify(sigAlg)}`);
  const keyId = blob.subarray(2, 2 + KEY_ID_BYTES);
  const pk = blob.subarray(2 + KEY_ID_BYTES, PUBKEY_BLOB_BYTES);
  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: pk.toString('base64url') },
    format: 'jwk',
  });
  return { keyId: Buffer.from(keyId), publicKey };
}

function b64decode(line: string, what: string): Buffer {
  const trimmed = line.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new Error(`minisign: ${what} line is not valid base64`);
  return Buffer.from(trimmed, 'base64');
}

// ---------- sign / verify ----------

// Streamed BLAKE2b-512 (unkeyed, 64-byte digest) of a file — matches minisign's own
// message_load_hashed() (crypto_generichash init/update/final at
// crypto_generichash_BYTES_MAX = 64) byte-for-byte; confirmed by cross-verifying with
// the real `minisign` binary both ways. Streamed (not readFile'd whole) so signing/
// verifying a multi-GB snapshot stays bounded-memory, mirroring util.ts's sha256().
function blake2b512(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const h = createHash('blake2b512');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest()))
      .on('error', reject);
  });
}

export interface SignOpts {
  comment?: string; // untrusted comment (line 1) — free text, defaults to DEFAULT_SIG_COMMENT
  trustedComment?: string; // trusted comment (line 3) — signed alongside the message signature; defaults to minisign's own "timestamp:<epoch>\tfile:<basename>\thashed" convention
}

// Produce a full *.minisig text: BLAKE2b-512-hash `filePath`, Ed25519-sign the hash
// (the "ED" hashed mode — the only mode this module supports), then sign a SECOND time
// over (that signature || the trusted comment's raw bytes) so the trusted comment
// itself can't be tampered with independently of the message signature (minisign's own
// scheme, reproduced exactly — see the module doc comment above).
export async function signDetached(
  privateKey: KeyObject,
  keyId: Buffer,
  filePath: string,
  opts: SignOpts = {},
): Promise<string> {
  const hash = await blake2b512(filePath);
  const signature = sign(null, hash, privateKey); // 64 bytes, deterministic RFC 8032 PureEdDSA — byte-identical to libsodium's crypto_sign_detached over the same seed+message (cross-verified against the reference binary)
  const sigBlob = Buffer.concat([Buffer.from(SIGALG_HASHED, 'latin1'), keyId, signature]);
  const trustedComment =
    opts.trustedComment ?? `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${basename(filePath)}\thashed`;
  const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]), privateKey);
  const comment = opts.comment ?? DEFAULT_SIG_COMMENT;
  return (
    `${COMMENT_PREFIX}${comment}\n` +
    `${sigBlob.toString('base64')}\n` +
    `${TRUSTED_COMMENT_PREFIX}${trustedComment}\n` +
    `${globalSignature.toString('base64')}\n`
  );
}

interface ParsedMinisig {
  sigAlg: string;
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

// A *.minisig file is exactly 4 meaningful lines, in order: untrusted comment, the
// signature blob (base64), the trusted comment, the global signature (base64) — see
// the module doc comment. Parsed positionally (matching minisign's own writer), not by
// scanning for a recognizable line, since the untrusted comment's CONTENT is free text
// and could otherwise be confused with the trusted-comment line.
function parseMinisigText(text: string): ParsedMinisig {
  const lines = text.split('\n');
  if (lines.length < 4) {
    throw new Error(
      'minisign: malformed .minisig (expected 4 lines: untrusted comment, signature, trusted comment, global signature)',
    );
  }
  if (!lines[0].startsWith(COMMENT_PREFIX))
    throw new Error(`minisign: .minisig line 1 must start with ${JSON.stringify(COMMENT_PREFIX)}`);
  const sigBlob = b64decode(lines[1], 'signature');
  if (sigBlob.length !== SIG_BLOB_BYTES)
    throw new Error(`minisign: signature blob is ${sigBlob.length} bytes, expected ${SIG_BLOB_BYTES}`);
  const sigAlg = sigBlob.subarray(0, 2).toString('latin1');
  const keyId = sigBlob.subarray(2, 2 + KEY_ID_BYTES);
  const signature = sigBlob.subarray(2 + KEY_ID_BYTES, SIG_BLOB_BYTES);
  if (!lines[2].startsWith(TRUSTED_COMMENT_PREFIX))
    throw new Error(`minisign: .minisig line 3 must start with ${JSON.stringify(TRUSTED_COMMENT_PREFIX)}`);
  const trustedComment = lines[2].slice(TRUSTED_COMMENT_PREFIX.length);
  const globalSignature = b64decode(lines[3], 'global signature');
  if (globalSignature.length !== SIGNATURE_BYTES) {
    throw new Error(`minisign: global signature is ${globalSignature.length} bytes, expected ${SIGNATURE_BYTES}`);
  }
  return { sigAlg, keyId: Buffer.from(keyId), signature: Buffer.from(signature), trustedComment, globalSignature };
}

// The key id a detached signature CLAIMS it was made with, as lowercase hex (issue
// #250) — the unverified 8 bytes in the *.minisig packet, not proof of who signed
// it. Read out of the sidecar itself rather than off the local signing key, so it
// describes the ARTIFACT that was (or is about to be) pushed, not whatever key
// happens to sit in $CYPHER_BRAIN_HOME right now. push --skip-unchanged records it
// alongside the locator and compares it on the next run, so enabling signing, or
// rotating the signing key, is a change that forces a re-push even when the
// plaintext and recipients are identical.
//
// This makes NO authenticity claim: an attacker who forges a .minisig controls the
// key id in it too. It is a change detector for the operator's own local state, in
// the same spirit as the content digest and the recipients fingerprint — the actual
// authenticity check is verifyDetached() above, against a pinned public key.
// Rejects a malformed sidecar by throwing, same as every other parse here.
export async function signatureKeyIdHex(sigPath: string): Promise<string> {
  const { keyId } = parseMinisigText(await readFile(sigPath, 'utf8'));
  // Byte order matches the identity file's "# key id: <hex>" comment (raw order),
  // not the pubkey file's comment (which reverses it, mirroring minisign's own CLI).
  return keyId.toString('hex');
}

export interface VerifyResult {
  valid: boolean;
  reason?: string; // present when valid === false
  trustedComment?: string; // present when valid === true
}

// Verify a *.minisig against `filePath`, using `publicKey`/`expectedKeyId` (from
// parsePubkeyFile). Cheapest/most-tamper-revealing checks first — malformed framing,
// then the key id pin, then the GLOBAL signature (authenticates the trusted comment
// text itself) — before the file's own BLAKE2b-512 hash is computed, mirroring
// restore.ts's own "check cheap things first" discipline for its header/negative-
// control checks. Never throws for an ordinary verification failure (tampered/wrong
// key/wrong file) — those come back as `{ valid: false, reason }`; only a caller-side
// problem (the file itself unreadable) rejects.
export async function verifyDetached(
  publicKey: KeyObject,
  expectedKeyId: Buffer,
  filePath: string,
  minisigText: string,
): Promise<VerifyResult> {
  let parsed: ParsedMinisig;
  try {
    parsed = parseMinisigText(minisigText);
  } catch (e) {
    return { valid: false, reason: errMsg(e) };
  }
  if (parsed.sigAlg !== SIGALG_HASHED) {
    return {
      valid: false,
      reason: `unsupported signature algorithm ${JSON.stringify(parsed.sigAlg)} (only the modern hashed "ED" format is supported)`,
    };
  }
  if (!parsed.keyId.equals(expectedKeyId)) {
    return { valid: false, reason: 'signature key id does not match the pinned signing public key' };
  }
  const globalOk = verify(
    null,
    Buffer.concat([parsed.signature, Buffer.from(parsed.trustedComment, 'utf8')]),
    publicKey,
    parsed.globalSignature,
  );
  if (!globalOk)
    return {
      valid: false,
      reason: 'global signature (over the trusted comment) does not verify — the .minisig may be tampered or forged',
    };
  const hash = await blake2b512(filePath);
  const sigOk = verify(null, hash, publicKey, parsed.signature);
  if (!sigOk)
    return {
      valid: false,
      reason: 'signature does not verify against the file content — the file may be tampered or the signature forged',
    };
  return { valid: true, trustedComment: parsed.trustedComment };
}

// ---------- signing identity file (private key at rest) ----------
//
// Format: a few "# " comment lines (created timestamp, the minisign public-key blob
// line for human cross-reference, and "# key id: <hex>" — the ONE comment this loader
// actually parses back, since the 8-byte key id must be reused for every signature this
// identity ever makes) followed by a standard PKCS#8 PEM block. Optionally wrapped at
// rest with crypt.ts's EXISTING age-based passphrase wrap (wrapIdentity/
// unwrapTextFile) — the same mechanism identity.age already uses; see the module doc
// comment for why this does NOT reimplement minisign's own secret-key encryption.

const KEY_ID_COMMENT_PREFIX = '# key id: ';

function signIdentityFileText(privateKeyPem: string, keyId: Buffer, pubkeyLine: string): string {
  return (
    `# cypher-brain minisign-compatible Ed25519 signing key (#214)\n` +
    `# created: ${new Date().toISOString()}\n` +
    `# public key (minisign wire format): ${pubkeyLine}\n` +
    `${KEY_ID_COMMENT_PREFIX}${keyId.toString('hex')}\n` +
    `${privateKeyPem}`
  );
}

export interface KeygenSignAtOpts {
  home: string;
  identityPath: string;
  recipientPath: string;
  passphrase?: boolean;
  force?: boolean;
}

export interface KeygenSignAtResult {
  wrapped: boolean;
  pubkeyText: string;
}

// Mirrors keys.ts's keygenAt(): same no-clobber-unless---force precondition (checked
// BEFORE anything is generated), same 0700 home dir, same writeKeyFile atomic-write
// discipline for both the private and public outputs.
export async function keygenSignAt(opts: KeygenSignAtOpts): Promise<KeygenSignAtResult> {
  await mkdir(opts.home, { recursive: true, mode: 0o700 });
  await chmod(opts.home, 0o700);
  if ((await exists(opts.identityPath)) && !opts.force) {
    throw new Error(
      `signing identity already exists at ${opts.identityPath} (refusing to overwrite — a new keypair would invalidate ` +
        `restore's ability to verify signatures made with the OLD key; existing *.minisig files stay verifiable against ` +
        `whichever public key you keep). Pass --force only if you are certain.`,
    );
  }
  if ((await exists(opts.recipientPath)) && !opts.force) {
    throw new Error(
      `signing public key already exists at ${opts.recipientPath} (refusing to overwrite). Pass --force only if you are certain.`,
    );
  }
  const { privateKey, publicKey, keyId } = generateSignKeypair();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubkeyText = pubkeyFileText(publicKey, keyId);
  const pubkeyLine = pubkeyText.split('\n')[1];
  const identityText = signIdentityFileText(privateKeyPem, keyId, pubkeyLine);
  let payload: string | Uint8Array = identityText;
  let wrapped = false;
  if (opts.passphrase) {
    console.log(
      'Set a passphrase to protect the signing identity at rest (you will enter it whenever cypher-brain signs a snapshot):',
    );
    payload = await wrapIdentity(identityText, await askNewPassphrase());
    wrapped = true;
  }
  await writeKeyFile(opts.identityPath, payload, 0o600, !!opts.force);
  await writeKeyFile(opts.recipientPath, pubkeyText, 0o644, !!opts.force);
  return { wrapped, pubkeyText };
}

export interface LoadedSignIdentity {
  privateKey: KeyObject;
  keyId: Buffer;
}

// Load + (if wrapped) unwrap the signing identity file, returning a ready-to-use
// KeyObject and its key id. Reuses crypt.ts's unwrapTextFile() for the passphrase-wrap/
// armor detection — see this module's doc comment for why that reuse matters.
export async function loadSignIdentity(path: string): Promise<LoadedSignIdentity> {
  await warnIfLooseKeyPerms(path, 'minisign identity (private key)');
  const text = await unwrapTextFile(path);
  const keyIdLine = text.split('\n').find((l) => l.startsWith(KEY_ID_COMMENT_PREFIX));
  if (!keyIdLine)
    throw new Error(
      `${path}: missing ${JSON.stringify(KEY_ID_COMMENT_PREFIX)} header — not a cypher-brain signing identity file`,
    );
  const keyIdHex = keyIdLine.slice(KEY_ID_COMMENT_PREFIX.length).trim();
  if (!/^[0-9a-f]{16}$/i.test(keyIdHex))
    throw new Error(`${path}: malformed key id (expected ${KEY_ID_BYTES} bytes as hex)`);
  const keyId = Buffer.from(keyIdHex, 'hex');
  const pemStart = text.indexOf('-----BEGIN PRIVATE KEY-----');
  if (pemStart === -1) throw new Error(`${path}: no PKCS#8 PEM private key block found`);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(text.slice(pemStart));
  } catch (e) {
    // #615: every OTHER failure mode in this function is wrapped with the same
    // "${path}: ..." prefix — a truncated/corrupt PEM body (marker present, bytes
    // broken) must not fall through to a raw, file-path-less Node/OpenSSL error
    // (e.g. an opaque DECODER-routines message) that breaks that pattern.
    throw new Error(`${path}: malformed PKCS#8 PEM private key block: ${errMsg(e)}`);
  }
  return { privateKey, keyId };
}

// ---------- the higher-level "does this artifact's signature check out?" call restore/verify make ----------

export type SignatureStatus = 'verified' | 'no_signature' | 'no_pubkey' | 'invalid';

export interface SignatureCheck {
  status: SignatureStatus;
  reason?: string; // human-readable detail — always present except for 'verified'
}

// The one call restore.ts/pushpull.ts actually need: given the ciphertext path and the
// configured signing public key path, report whether `<inPath>.minisig` (if any)
// checks out. Distinguishes "no signature to check" / "no public key to check it with"
// (both non-fatal — an unsigned/legacy artifact, or a public-key-only box that hasn't
// been given the signing public key) from "invalid" (a tampered/forged signature —
// the ONLY status callers should treat as fatal). Never throws for a file-shape
// problem — that becomes 'invalid' with a reason, same as a bad signature; only a
// missing/unreadable pubkey path itself is reported as 'no_pubkey', not raised.
export async function checkArtifactSignature(inPath: string, signRecipientPath: string): Promise<SignatureCheck> {
  const sigPath = `${inPath}.minisig`;
  if (!(await exists(sigPath))) {
    return {
      status: 'no_signature',
      reason: `no ${sigPath} found — unsigned (legacy) artifact, authenticity not checked`,
    };
  }
  if (!(await exists(signRecipientPath))) {
    return {
      status: 'no_pubkey',
      reason: `${sigPath} is present but no signing public key at ${signRecipientPath} — cannot verify authenticity on this machine`,
    };
  }
  let parsedPub: ParsedPubkey;
  try {
    parsedPub = parsePubkeyFile(await readFile(signRecipientPath, 'utf8'));
  } catch (e) {
    return { status: 'invalid', reason: `could not read signing public key at ${signRecipientPath}: ${errMsg(e)}` };
  }
  let sigText: string;
  try {
    sigText = await readFile(sigPath, 'utf8');
  } catch (e) {
    return { status: 'invalid', reason: `could not read ${sigPath}: ${errMsg(e)}` };
  }
  const result = await verifyDetached(parsedPub.publicKey, parsedPub.keyId, inPath, sigText);
  if (!result.valid) return { status: 'invalid', reason: `signature verification failed: ${result.reason}` };
  return { status: 'verified' };
}
