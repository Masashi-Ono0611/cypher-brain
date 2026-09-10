// sss — Shamir's Secret Sharing for the age identity (#207). Splits a random
// wrapping KEY (never the identity string itself — see the design note below) into N
// textual "share" files, any M of which reconstruct the identity byte-for-byte. This
// is an ADDITIVE disaster-recovery mechanism alongside the normal identity.age (see
// keys.ts's keygenAt) — not a replacement for it, and orthogonal to both
// multi-recipient backup keys (#99, independent keypairs) and PQ hybrid identities
// (#205, which this module never branches on: an identity is encrypted as opaque
// UTF-8 bytes, so AGE-SECRET-KEY-1… and AGE-SECRET-KEY-PQ-1… are handled identically).
//
// Uses `shamir-secret-sharing` (privy-io, Apache-2.0, zero runtime dependencies,
// independently audited by Cure53 + Zellic — both audit reports were fetched and
// confirmed to resolve, not taken from the library's own README on faith). That
// library documents two properties this module's design is built around:
//
//   1. Inputs should be uniformly random, or the caller should encrypt first and
//      split the encryption key instead (the library's own README, verbatim). An age
//      identity STRING is NOT uniformly random bytes — it has a fixed ASCII prefix
//      identical for every user ("AGE-SECRET-KEY-1…"), every character is drawn from
//      bech32's restricted ~32-symbol alphabet (not the full 256-value byte range),
//      and its trailing characters are a checksum DERIVED from the preceding ones —
//      splitting that string directly would violate the library's stated precondition
//      (multi-model review finding). So this module follows the library's own advice
//      literally: generate a fresh random 32-byte key, AES-256-GCM-encrypt the
//      identity with it, and split the KEY (genuinely uniform) — never the identity.
//   2. combine() does NOT verify its result — corrupt/mismatched shares silently
//      produce wrong bytes. Two independent checks close that gap here: AES-GCM's own
//      authentication tag (a real cryptographic MAC — decryption fails hard on any
//      tampering of the ciphertext OR a wrong reconstructed key, which also closes a
//      subtler gap a coordinated multi-share polynomial-degree attack could otherwise
//      exploit against a bare Shamir reconstruction with no MAC backstop) as the
//      PRIMARY defense, and a secondary re-derivation of the recipient from the
//      decrypted identity, compared against the recipient recorded (in plaintext —
//      recipients are public) on every share — this second check exists specifically
//      to catch a forged `# recipient:` header on an otherwise-genuine, correctly-
//      decrypting share set (AES-GCM alone would not catch that, since the header
//      isn't part of the authenticated ciphertext).
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { identityToRecipient } from 'age-encryption';
import { split as sssSplit, combine as sssCombine } from 'shamir-secret-sharing';

export interface SssPolicy {
  readonly threshold: number; // M — shares required to reconstruct
  readonly shares: number; // N — total shares generated
}

// This file's StrykerJS mutation run (part of crypt.ts's own scoped `npm run
// mutation-test`, stryker.conf.json's `mutate` array) is deliberately narrowed, with
// the ignore-comment markers below, to ONLY validateSssBounds()/splitIdentity()/
// combineShares() — the functions scripts/selftest-properties.mjs's SSS roundtrip +
// corruption-detection properties actually exercise (see stryker.conf.json's own
// header comment for the full scope statement). parseSssPolicy()/parseShare()/
// shareField() have no fast in-process property oracle here — mutating them would
// only produce "survived" noise, not a security signal.
// Stryker disable all

// Shared by parseSssPolicy() (validating a fresh --sss <m>-of-<n> at split time) AND
// parseShare() (validating the threshold/shares a share FILE claims at combine time —
// multi-model review finding: the file-parsing path had no bounds check of its own,
// so a forged/corrupted share claiming e.g. "threshold: 0" reached the reconstruction
// logic unvalidated). One rule, enforced identically on both inputs.
// Stryker restore all
function validateSssBounds(threshold: number, shares: number, context: string): void {
  if (!(Number.isInteger(threshold) && threshold >= 2 && threshold <= 255))
    throw new Error(`${context}: threshold (m) must be an integer between 2 and 255, got ${threshold}`);
  if (!(Number.isInteger(shares) && shares >= 2 && shares <= 255))
    throw new Error(`${context}: total shares (n) must be an integer between 2 and 255, got ${shares}`);
  if (threshold > shares)
    throw new Error(`${context}: threshold (m=${threshold}) cannot exceed total shares (n=${shares})`);
}
// Stryker disable all

// "2-of-3" -> {threshold: 2, shares: 3}. Deliberately no default policy anywhere in
// this module or its callers (mirrors CYPHER_BRAIN_PIN_RECIPIENTS/
// CYPHER_BRAIN_MCP_SOURCE_ROOTS's "no default that lets security-relevant policy
// through silently" convention) — a caller must always say what they mean.
export function parseSssPolicy(spec: string): SssPolicy {
  const m = /^(\d{1,3})-of-(\d{1,3})$/.exec(spec.trim());
  if (!m) throw new Error(`invalid --sss value "${spec}" — expected "<m>-of-<n>", e.g. "--sss 2-of-3"`);
  const threshold = Number(m[1]);
  const shares = Number(m[2]);
  validateSssBounds(threshold, shares, '--sss');
  return { threshold, shares };
}

const SHARE_MAGIC = '# cypher-brain SSS share';
const GCM_IV_LEN = 12; // bytes — the standard/recommended nonce size for AES-GCM
const GCM_TAG_LEN = 16; // bytes — AES-GCM's default authentication tag size
const KEY_LEN = 32; // bytes — AES-256

// Strict base64 (standard alphabet + optional padding, no embedded whitespace or
// other characters) — Buffer.from(str, 'base64') is LENIENT and silently DROPS any
// character outside the base64 alphabet instead of rejecting the input (multi-model
// review finding, confirmed: `Buffer.from('AB@#CD==', 'base64')` decodes without
// error). A share file with stray/corrupted bytes in a base64 field must be refused
// as malformed, not silently decoded from whatever characters happen to survive.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function decodeStrictBase64(value: string, what: string, sourceLabel: string): Buffer {
  if (!BASE64_RE.test(value))
    throw new Error(`${sourceLabel}'s ${what} is not valid base64 — corrupt or truncated share file`);
  return Buffer.from(value, 'base64');
}

// One share's on-disk text: a small comment-header envelope (mirrors
// identityFileText()'s "comments + one key line" house style in crypt.ts). `recipient`
// and `blob` (the AES-GCM-encrypted identity — safe to be public; it reveals nothing
// without the key) are identical across every share and embedded in EVERY share in
// plaintext — this is what lets combineShares() below detect corruption and
// mismatched-split mixing before trusting a reconstruction. The final body line is
// THIS share's own fragment of the random wrapping key (never the identity).
// Stryker restore all
export async function splitIdentity(identity: string, recipient: string, policy: SssPolicy): Promise<string[]> {
  const key = randomBytes(KEY_LEN); // the ACTUAL Shamir secret — genuinely uniform, per the library's own precondition
  const iv = randomBytes(GCM_IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(identity, 'utf8'), cipher.final()]);
  const blob = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  // shamir-secret-sharing's split() checks `secret.constructor !== Uint8Array`
  // (strict, not `instanceof`) — randomBytes() returns a Node Buffer, which fails
  // that even though it IS a Uint8Array subclass (same pitfall as parseShare()'s
  // decodeStrictBase64() output below), so this copies into a genuine plain
  // Uint8Array rather than passing the Buffer straight through.
  const rawShares = await sssSplit(new Uint8Array(key), policy.shares, policy.threshold);
  return rawShares.map((raw, i) =>
    [
      SHARE_MAGIC,
      '# Keep every line of this file unchanged, including lines starting with #; they contain required recovery data.',
      '# Recover: cypher-brain sss-combine --share <share-1.txt> --share <share-2.txt> ... --out <identity.age>',
      `# Supply at least ${policy.threshold} distinct shares from this split.`,
      `# threshold: ${policy.threshold}`,
      `# shares: ${policy.shares}`,
      `# label: ${i + 1} of ${policy.shares}`,
      `# recipient: ${recipient}`,
      `# blob: ${blob}`,
      Buffer.from(raw).toString('base64'),
      '',
    ].join('\n'),
  );
}
// Stryker disable all

interface ParsedShare {
  threshold: number;
  shares: number;
  recipient: string;
  blob: string; // still base64 here — decoded once, after the cross-share agreement check below
  keyFragment: Uint8Array;
}

function shareField(lines: string[], name: string, sourceLabel: string): string {
  const prefix = `# ${name}: `;
  const line = lines.find((l) => l.startsWith(prefix));
  if (!line)
    throw new Error(`${sourceLabel} is missing the "${prefix.trimEnd()}" header — corrupt or truncated share file`);
  return line.slice(prefix.length).trim();
}

function parseShare(text: string, sourceLabel: string): ParsedShare {
  const lines = text.split('\n').map((l) => l.trimEnd());
  if (lines[0]?.trim() !== SHARE_MAGIC)
    throw new Error(`${sourceLabel} is not a cypher-brain SSS share file (missing "${SHARE_MAGIC}" header)`);
  const threshold = Number(shareField(lines, 'threshold', sourceLabel));
  const shares = Number(shareField(lines, 'shares', sourceLabel));
  if (!Number.isInteger(threshold) || !Number.isInteger(shares))
    throw new Error(`${sourceLabel} has a malformed threshold/shares header — corrupt or truncated share file`);
  validateSssBounds(threshold, shares, `${sourceLabel}'s threshold/shares header`);
  const recipient = shareField(lines, 'recipient', sourceLabel);
  const blob = shareField(lines, 'blob', sourceLabel);
  // Multi-model review finding: a forged/corrupted file with EXTRA non-comment lines
  // used to have its surplus silently ignored (only the first was read) — every
  // non-blank, non-comment line beyond the ONE expected body line is now refused
  // outright, matching this codebase's "fail fast on anything unexpected" posture
  // rather than quietly dropping data nobody asked to drop.
  const bodyLines = lines.filter((l) => l.length > 0 && !l.startsWith('#'));
  if (bodyLines.length === 0)
    throw new Error(`${sourceLabel} has no share data (empty body) — corrupt or truncated share file`);
  if (bodyLines.length > 1)
    throw new Error(
      `${sourceLabel} has ${bodyLines.length} data lines where exactly 1 is expected — corrupt or tampered share file`,
    );
  const keyFragment = new Uint8Array(decodeStrictBase64(bodyLines[0], 'share data', sourceLabel));
  if (keyFragment.length === 0)
    throw new Error(`${sourceLabel}'s share data decoded to zero bytes — corrupt or truncated share file`);
  return { threshold, shares, recipient, blob, keyFragment };
}

export interface ShareInput {
  readonly text: string;
  readonly sourceLabel: string; // the file path, for actionable error messages
}

// Reconstructs the identity from >= threshold shares of the SAME split. Refuses
// (never returns a wrong-but-plausible identity) when: fewer than 2 shares are given;
// the shares disagree on recipient/threshold/shares/blob (mixed splits); fewer shares
// are given than the declared threshold; the reconstructed key fails to
// AES-GCM-authenticate the shared blob (corrupt/mismatched key shares, or a tampered
// blob — a real cryptographic MAC, not a heuristic); or the decrypted identity's
// derived recipient does not match the recipient recorded on the shares (a forged
// header on an otherwise-genuine, correctly-decrypting set).
// Stryker restore all
export async function combineShares(inputs: readonly ShareInput[]): Promise<{ identity: string; recipient: string }> {
  if (inputs.length < 2) throw new Error(`sss-combine needs at least 2 shares, got ${inputs.length}`);
  // Zipped from the start (rather than two parallel arrays indexed by the same `i`)
  // so every entry always carries its own sourceLabel for error messages, with no
  // out-of-bounds case to reason about.
  const parsed = inputs.map(({ text, sourceLabel }) => ({ sourceLabel, share: parseShare(text, sourceLabel) }));
  const [first, ...rest] = parsed;
  if (!first) throw new Error(`sss-combine needs at least 2 shares, got ${inputs.length}`); // unreachable: length checked above
  for (const p of rest) {
    if (p.share.recipient !== first.share.recipient || p.share.blob !== first.share.blob)
      throw new Error(
        `${p.sourceLabel} is from a different split than ${first.sourceLabel} ` +
          `(recipient/blob mismatch) — do not mix shares from different "keygen --sss" runs`,
      );
    if (p.share.threshold !== first.share.threshold || p.share.shares !== first.share.shares)
      throw new Error(
        `${p.sourceLabel} is from a different split than ${first.sourceLabel} ` +
          `(expected ${first.share.threshold}-of-${first.share.shares}, got ${p.share.threshold}-of-${p.share.shares}) — ` +
          `do not mix shares from different "keygen --sss" runs`,
      );
  }
  if (parsed.length < first.share.threshold)
    throw new Error(
      `need ${first.share.threshold} shares to reconstruct this ${first.share.threshold}-of-${first.share.shares} identity, got ${parsed.length}`,
    );
  let key: Uint8Array;
  try {
    key = await sssCombine(parsed.map((p) => p.share.keyFragment));
  } catch (e) {
    // Classify only the known structural duplicate error. Both messages stay fixed:
    // never forward a library error that could contain secret share material.
    if (e instanceof Error && e.message.includes('duplicate'))
      throw new Error('the same share was supplied more than once — provide distinct shares from the same split');
    throw new Error('key reconstruction failed — one or more shares may be corrupt');
  }
  const blob = decodeStrictBase64(first.share.blob, 'blob', first.sourceLabel);
  if (blob.length < GCM_IV_LEN + GCM_TAG_LEN)
    throw new Error(`${first.sourceLabel}'s blob is too short to be a valid encrypted identity — corrupt share file`);
  const iv = blob.subarray(0, GCM_IV_LEN);
  const authTag = blob.subarray(GCM_IV_LEN, GCM_IV_LEN + GCM_TAG_LEN);
  const ciphertext = blob.subarray(GCM_IV_LEN + GCM_TAG_LEN);
  let identity: string;
  try {
    if (key.length !== KEY_LEN) throw new Error('wrong key length'); // caught immediately below, same fixed message either way
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    // AES-GCM authenticates on decrypt: final() throws if the ciphertext (or the key)
    // does not match the recorded tag — this is the PRIMARY integrity check, a real
    // cryptographic MAC rather than a plausibility heuristic.
    identity = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Fixed message — deliberately never includes the underlying crypto error, which
    // could in principle echo attacker-influenced input. Nothing here can leak the
    // reconstructed identity either, since decryption did not succeed.
    throw new Error(
      'reconstruction failed its integrity check (AES-GCM authentication) — one or more shares are corrupt, ' +
        'or do not actually belong together',
    );
  }
  let recipient: string;
  try {
    recipient = await identityToRecipient(identity);
  } catch {
    // Fixed message (multi-model review finding): the underlying age-encryption
    // library's parse errors can embed the offending string VERBATIM (observed:
    // "Invalid checksum in <the-full-corrupted-identity>: expected \"...\""), which
    // would leak reconstructed private-key material into a log/CI transcript/bug
    // report. This path is only reachable at all if GCM authentication above already
    // passed, so this specific error can currently only fire on ITS OWN bug (a
    // successfully-decrypted-and-authenticated payload that is nonetheless not a
    // valid age identity) rather than tampering — the fixed message is kept as
    // defense-in-depth regardless.
    throw new Error(
      'decrypted data is not a valid age identity — this indicates a bug, not tampering (GCM already authenticated it)',
    );
  }
  if (recipient !== first.share.recipient)
    throw new Error(
      "reconstruction failed its integrity check — the recovered key's public recipient does not match " +
        'the recipient recorded on the shares. The shares decrypted correctly but the header was forged, ' +
        'or does not actually belong together with them.',
    );
  return { identity, recipient };
}
// Stryker disable all
