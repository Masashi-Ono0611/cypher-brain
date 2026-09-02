#!/usr/bin/env node
// #791: what Turbo BILLS for is the ANS-104 signed data item `uploadFile()` builds, not
// the file handed to it. backends/turbo.ts prices the raw ciphertext, so its winc quote,
// its CYPHER_BRAIN_MAX_SPEND comparison and its receipt all described ~1.1 KB fewer bytes
// than were charged — under-enforcing the cap at a price boundary and, at the 100 KB
// free-upload threshold, quoting a paid upload as free.
//
// src/lib/backends/ans104.ts computes that size without the SDK, because the SDK's own
// calculator is private and only reachable by actually signing the item (minutes of work
// on a brain-sized file, thrown away for a number). A reimplementation is only safe if it
// is pinned to the thing it reimplements — so this checks it against the SDK's OWN public
// signer: TurboNodeSigner.signDataItem() returns the exact dataItemSizeFactory() the
// upload path then uses. If ArweaveSigner's key sizes, the tag encoding or the ANS-104
// header layout ever move, this fails instead of the price silently drifting.
//
// No network and no wallet: signing is local crypto over a few bytes.
import Arweave from 'arweave';
import { Readable } from 'node:stream';
import { ArweaveSigner, TurboNodeSigner } from '@ardrive/turbo-sdk';
import {
  CYPHER_BRAIN_DATA_ITEM_TAGS,
  dataItemOverheadBytes,
  serializedTagsSize,
  signedDataItemSize,
  signerLengthsOrDefaults,
} from '../src/lib/backends/ans104.ts';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`[PASS] ${name}`);
  else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const ar = Arweave.init({ host: 'localhost', port: 1, protocol: 'http' }); // key generation only, never contacted
const jwk = await ar.wallets.generate();
const signer = new ArweaveSigner(jwk);
const turboSigner = new TurboNodeSigner({ signer, token: 'arweave' });

// --- the reimplementation, pinned to the SDK's own answer ---------------------------
// Three shapes: the tags this project actually uploads, a bare item, and a tag set whose
// lengths cross a varint boundary (>127-byte value) so a wrong length-prefix assumption
// cannot hide behind small strings.
const CASES = [
  { name: "the project's own tags", tags: [...CYPHER_BRAIN_DATA_ITEM_TAGS], dataSize: 4096 },
  { name: 'no tags at all', tags: [], dataSize: 1 },
  { name: 'a tag value past the 1-byte varint boundary', tags: [{ name: 'X', value: 'y'.repeat(200) }], dataSize: 0 },
  { name: 'multi-byte UTF-8 in both name and value', tags: [{ name: 'é'.repeat(40), value: '日本語' }], dataSize: 97 },
];
for (const { name, tags, dataSize } of CASES) {
  const data = Buffer.alloc(dataSize, 0x61);
  const { dataItemSizeFactory } = await turboSigner.signDataItem({
    fileStreamFactory: () => Readable.from(data),
    fileSizeFactory: () => dataSize,
    dataItemOpts: tags.length > 0 ? { tags } : {},
  });
  const sdkSize = dataItemSizeFactory();
  const { ownerLength, signatureLength } = signerLengthsOrDefaults(signer);
  const ours = signedDataItemSize(dataSize, tags, ownerLength, signatureLength);
  check(`signed data-item size matches the SDK: ${name}`, ours === sdkSize, `ours=${ours} sdk=${sdkSize}`);
}

// --- the overhead is real and non-trivial -------------------------------------------
// The number that made this a money bug rather than a rounding nit: an ArweaveSigner item
// carrying this project's tags costs 1106 bytes more than the ciphertext inside it. Pinned
// as a literal so a silent change to the constants shows up here as well as against the
// SDK above.
const overhead = dataItemOverheadBytes([...CYPHER_BRAIN_DATA_ITEM_TAGS]);
check("the project's own data item adds 1106 bytes over the ciphertext", overhead === 1106, `overhead=${overhead}`);
check(
  'the free-upload threshold moves with it: a 102300-byte ciphertext bills as 103406 bytes',
  signedDataItemSize(102300) === 103406,
  String(signedDataItemSize(102300)),
);

// --- the tag serializer's own edges --------------------------------------------------
check('an empty tag list serializes to nothing', serializedTagsSize([]) === 0);
check(
  'tag size counts UTF-8 bytes, not code points',
  serializedTagsSize([{ name: 'é', value: 'a' }]) > serializedTagsSize([{ name: 'e', value: 'a' }]),
);

// --- the signer-length fallback ------------------------------------------------------
// signerLengthsOrDefaults exists so an SDK that stopped exposing these cannot produce a
// NaN size that sails through every `>` comparison in the cap check.
const live = signerLengthsOrDefaults(signer);
check(
  'a live ArweaveSigner reports the 512/512 lengths the defaults assume',
  live.ownerLength === 512 && live.signatureLength === 512,
  JSON.stringify(live),
);
for (const bad of [null, undefined, {}, { ownerLength: 'x', signatureLength: 0 }, { ownerLength: -1 }]) {
  const got = signerLengthsOrDefaults(bad);
  check(
    `an unusable signer (${JSON.stringify(bad)}) falls back to the ArweaveSigner constants`,
    got.ownerLength === 512 && got.signatureLength === 512,
    JSON.stringify(got),
  );
}

console.log('');
if (failed) {
  console.log(`ANS-104 SIZING: FAIL (${failed})`);
  process.exit(1);
}
console.log('ANS-104 SIZING: PASS (the priced size is the size Turbo bills for)');
