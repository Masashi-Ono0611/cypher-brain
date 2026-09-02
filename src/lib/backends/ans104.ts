// ANS-104 data-item sizing — what a bundler (ArDrive Turbo) actually bills for.
//
// `turbo.uploadFile()` does not upload the file it is handed: it wraps it in an ANS-104
// signed data item (signature + owner + tags + a few length prefixes) and uploads THAT.
// Pricing the raw file therefore quotes for fewer bytes than are billed, which matters in
// three places that must all agree: `getUploadCosts()`, the CYPHER_BRAIN_MAX_SPEND cap
// check, and the receipt written to the ledger.
//
// The SDK knows this size — `TurboNodeSigner.calculateSignedDataHeadersSize()` — but the
// method is private and only reachable by actually signing the item, which for a
// brain-sized ciphertext is minutes of work we would then throw away just to get a
// number. The formula it uses is reproduced here instead (the field layout is the ANS-104
// spec's, https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md#13-dataitem-format).
//
// Reproducing rather than importing is deliberate and narrow: the serializer lives in
// `@dha-team/arbundles`, a transitive dependency of an OPTIONAL dependency — importing it
// directly would make this file depend on a package this project does not declare and
// cannot guarantee is installed. Only the SIZE is computed here; nothing is encoded. The
// result is checked against the SDK's own public signer in
// `scripts/selftest-turbo-dep.mjs`, so a future change to either side fails a test rather
// than silently drifting the price.

export interface DataItemTag {
  name: string;
  value: string;
}

// The tags every data item this project uploads carries. Shared by turbo.ts (which
// attaches them) and estimate.ts (which has no signer and must still price the same
// item), so the two can never disagree about what is being priced.
export const CYPHER_BRAIN_DATA_ITEM_TAGS: readonly DataItemTag[] = [
  { name: 'App-Name', value: 'cypher-brain' },
  { name: 'Content-Type', value: 'application/octet-stream' },
];

// ArweaveSigner's fixed RSA-PSS 4096 sizes. Used as the DEFAULT when no live signer is
// available (estimate.ts prices without loading a wallet); turbo.ts passes the real
// signer's own `ownerLength`/`signatureLength` so a different signer type would still be
// sized correctly.
export const ARWEAVE_SIGNER_OWNER_LENGTH = 512;
export const ARWEAVE_SIGNER_SIGNATURE_LENGTH = 512;

// Byte length of an Avro zigzag-encoded long — the length prefix in front of every
// string and of the array's block count.
function zigzagVarintLength(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`ans104: cannot size a non-negative integer: ${value}`);
  let encoded = value * 2; // zigzag for a non-negative value
  let bytes = 1;
  while (encoded >= 128) {
    encoded = Math.floor(encoded / 128);
    bytes++;
  }
  return bytes;
}

// Serialized length of an ANS-104 tag list. arbundles encodes it as an Avro
// `array<record { name: string, value: string }>`: one block-count long, each item's two
// length-prefixed UTF-8 strings, then a zero long terminating the array. An empty list
// serializes to nothing at all (the caller omits the field entirely), matching the SDK's
// own `tags && tags.length > 0 ? serializeTags(tags) : null`.
export function serializedTagsSize(tags: readonly DataItemTag[]): number {
  if (tags.length === 0) return 0;
  let total = zigzagVarintLength(tags.length);
  for (const tag of tags) {
    const nameBytes = Buffer.byteLength(tag.name, 'utf8');
    const valueBytes = Buffer.byteLength(tag.value, 'utf8');
    total += zigzagVarintLength(nameBytes) + nameBytes + zigzagVarintLength(valueBytes) + valueBytes;
  }
  return total + 1; // terminating zero-length block
}

// Bytes of ANS-104 framing added around `dataSize`. Kept separate from
// signedDataItemSize() so callers can report the overhead on its own — an operator
// looking at "N bytes of ciphertext" and "N + 1106 bytes billed" deserves to see where
// the difference comes from.
export function dataItemOverheadBytes(
  tags: readonly DataItemTag[],
  ownerLength: number = ARWEAVE_SIGNER_OWNER_LENGTH,
  signatureLength: number = ARWEAVE_SIGNER_SIGNATURE_LENGTH,
): number {
  const anchorLength = 1; // one length byte; this project never sets an anchor
  const targetLength = 1; // likewise, never a target
  const tagsLength = 16 + serializedTagsSize(tags); // two 8-byte counts + the serialized bytes
  const signatureTypeLength = 2;
  return anchorLength + targetLength + tagsLength + signatureLength + ownerLength + signatureTypeLength;
}

// Total on-the-wire size of the signed data item Turbo receives and bills for.
export function signedDataItemSize(
  dataSize: number,
  tags: readonly DataItemTag[] = CYPHER_BRAIN_DATA_ITEM_TAGS,
  ownerLength: number = ARWEAVE_SIGNER_OWNER_LENGTH,
  signatureLength: number = ARWEAVE_SIGNER_SIGNATURE_LENGTH,
): number {
  if (!Number.isInteger(dataSize) || dataSize < 0) {
    throw new Error(`ans104: data size must be a non-negative integer, got ${dataSize}`);
  }
  return dataSize + dataItemOverheadBytes(tags, ownerLength, signatureLength);
}

// A signer's declared lengths, used only when they are genuinely usable numbers — an SDK
// that ever stopped exposing them must fall back to the ArweaveSigner constants above
// rather than produce a NaN size that would sail through every comparison below.
export function signerLengthsOrDefaults(signer: unknown): { ownerLength: number; signatureLength: number } {
  const usable = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
  const s = signer as { ownerLength?: unknown; signatureLength?: unknown } | null;
  return {
    ownerLength: usable(s?.ownerLength) ? s.ownerLength : ARWEAVE_SIGNER_OWNER_LENGTH,
    signatureLength: usable(s?.signatureLength) ? s.signatureLength : ARWEAVE_SIGNER_SIGNATURE_LENGTH,
  };
}
