// sss — Shamir's Secret Sharing for the age identity (#207). Splits an identity
// string into N textual "share" files, any M of which reconstruct it byte-for-byte.
// This is an ADDITIVE disaster-recovery mechanism alongside the normal identity.age
// (see keys.ts's keygenAt) — not a replacement for it, and orthogonal to both
// multi-recipient backup keys (#99, independent keypairs) and PQ hybrid identities
// (#205, which this module never branches on: an identity is split as opaque UTF-8
// bytes, so AGE-SECRET-KEY-1… and AGE-SECRET-KEY-PQ-1… round-trip identically).
//
// Uses `shamir-secret-sharing` (privy-io, Apache-2.0, zero runtime dependencies,
// independently audited by Cure53 + Zellic — both audit reports were fetched and
// confirmed to resolve, not taken from the library's own README on faith). That
// library documents two properties this module is built around:
//   1. combine() does NOT verify its result — corrupt/mismatched shares silently
//      produce wrong bytes. Every combineShares() call below re-derives the
//      recipient from the reconstructed identity and compares it against the
//      recipient recorded (in plaintext — recipients are public) on every share,
//      refusing hard on any mismatch instead of returning a plausible-looking
//      wrong identity.
//   2. Inputs should be uniformly random, or encrypted first. An age identity's
//      key material is CSPRNG-generated (generateIdentity()/generateHybridIdentity()
//      in crypt.ts), so this is already satisfied without an extra wrapping step.
import { identityToRecipient } from 'age-encryption';
import { split as sssSplit, combine as sssCombine } from 'shamir-secret-sharing';
import { errMsg } from './util.js';

// This file's StrykerJS mutation run (part of crypt.ts's own scoped `npm run
// mutation-test`, stryker.conf.json's `mutate` array) is deliberately narrowed, with
// the ignore-comment markers below, to ONLY splitIdentity() and combineShares() — the
// functions scripts/selftest-properties.mjs's SSS roundtrip + corruption-detection
// properties actually exercise (see stryker.conf.json's own header comment for the
// full scope statement). parseSssPolicy()/parseShare()/shareField() have no fast
// in-process property oracle here — mutating them would only produce "survived"
// noise, not a security signal.
// Stryker disable all

export interface SssPolicy {
  readonly threshold: number; // M — shares required to reconstruct
  readonly shares: number; // N — total shares generated
}

// "2-of-3" -> {threshold: 2, shares: 3}. Deliberately no default policy anywhere in
// this module or its callers (mirrors CYPHER_BRAIN_PIN_RECIPIENTS/
// CYPHER_BRAIN_MCP_SOURCE_ROOTS's "no default that lets security-relevant policy
// through silently" convention) — a caller must always say what they mean. Bounds
// match shamir-secret-sharing's own (split()/combine() both accept 2..255).
export function parseSssPolicy(spec: string): SssPolicy {
  const m = /^(\d{1,3})-of-(\d{1,3})$/.exec(spec.trim());
  if (!m) throw new Error(`invalid --sss value "${spec}" — expected "<m>-of-<n>", e.g. "--sss 2-of-3"`);
  const threshold = Number(m[1]);
  const shares = Number(m[2]);
  if (!(threshold >= 2 && threshold <= 255))
    throw new Error(`--sss threshold (m) must be between 2 and 255, got ${threshold}`);
  if (!(shares >= 2 && shares <= 255))
    throw new Error(`--sss total shares (n) must be between 2 and 255, got ${shares}`);
  if (threshold > shares) throw new Error(`--sss threshold (m=${threshold}) cannot exceed total shares (n=${shares})`);
  return { threshold, shares };
}

const SHARE_MAGIC = '# cypher-brain SSS share';

// One share's on-disk text: a small comment-header envelope (mirrors
// identityFileText()'s "comments + one key line" house style in crypt.ts) around the
// base64 share bytes. `recipient` is public and embedded in EVERY share — it is what
// lets combineShares() below detect corruption and mismatched-split mixing before
// trusting a reconstruction.
// Stryker restore all
export async function splitIdentity(identity: string, recipient: string, policy: SssPolicy): Promise<string[]> {
  const secret = new TextEncoder().encode(identity);
  const rawShares = await sssSplit(secret, policy.shares, policy.threshold);
  return rawShares.map((raw, i) =>
    [
      SHARE_MAGIC,
      `# threshold: ${policy.threshold}`,
      `# shares: ${policy.shares}`,
      `# label: ${i + 1} of ${policy.shares}`,
      `# recipient: ${recipient}`,
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
  body: Uint8Array;
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
  const thresholdStr = shareField(lines, 'threshold', sourceLabel);
  const sharesStr = shareField(lines, 'shares', sourceLabel);
  const recipient = shareField(lines, 'recipient', sourceLabel);
  const threshold = Number(thresholdStr);
  const shares = Number(sharesStr);
  if (!Number.isInteger(threshold) || !Number.isInteger(shares))
    throw new Error(`${sourceLabel} has a malformed threshold/shares header — corrupt or truncated share file`);
  const bodyLine = lines.find((l) => l.length > 0 && !l.startsWith('#'));
  if (!bodyLine) throw new Error(`${sourceLabel} has no share data (empty body) — corrupt or truncated share file`);
  let body: Uint8Array;
  try {
    // shamir-secret-sharing's combine() checks `share.constructor !== Uint8Array`
    // (strict, not `instanceof`) — a Node Buffer fails that even though it IS a
    // Uint8Array subclass, so this copies into a genuine plain Uint8Array rather
    // than passing the Buffer straight through.
    body = new Uint8Array(Buffer.from(bodyLine, 'base64'));
  } catch (e) {
    throw new Error(`${sourceLabel}'s share data is not valid base64: ${errMsg(e)}`);
  }
  if (body.length === 0)
    throw new Error(`${sourceLabel}'s share data decoded to zero bytes — corrupt or truncated share file`);
  return { threshold, shares, recipient, body };
}

export interface ShareInput {
  readonly text: string;
  readonly sourceLabel: string; // the file path, for actionable error messages
}

// Reconstructs the identity from >= threshold shares of the SAME split. Refuses
// (never returns a wrong-but-plausible identity) when: fewer than 2 shares are
// given, the shares disagree on recipient/threshold/shares (mixed splits), fewer
// shares are given than the declared threshold, the reconstructed bytes are not
// valid UTF-8, or the reconstructed identity's derived recipient does not match the
// recipient recorded on the shares.
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
    if (p.share.recipient !== first.share.recipient)
      throw new Error(
        `${p.sourceLabel} is from a different split than ${first.sourceLabel} ` +
          `(recipient mismatch) — do not mix shares from different "keygen --sss" runs`,
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
  let combined: Uint8Array;
  try {
    combined = await sssCombine(parsed.map((p) => p.share.body));
  } catch (e) {
    throw new Error(`share reconstruction failed: ${errMsg(e)} — one or more shares may be corrupt`);
  }
  let identity: string;
  try {
    // fatal: true — the DEFAULT TextDecoder silently replaces invalid byte
    // sequences with U+FFFD instead of throwing, which would let a corrupt
    // reconstruction masquerade as a plausible (garbage) identity string all the
    // way to the recipient check below instead of failing here, immediately.
    identity = new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch {
    throw new Error(
      'reconstructed data is not valid UTF-8 text — one or more shares are corrupt, or shares from different splits were mixed',
    );
  }
  let recipient: string;
  try {
    recipient = await identityToRecipient(identity);
  } catch (e) {
    throw new Error(`reconstructed data is not a valid age identity: ${errMsg(e)} — one or more shares are corrupt`);
  }
  if (recipient !== first.share.recipient)
    throw new Error(
      "reconstruction failed its integrity check — the recovered key's public recipient does not match " +
        'the recipient recorded on the shares. One or more shares are corrupt, or do not actually belong together.',
    );
  return { identity, recipient };
}
// Stryker disable all
