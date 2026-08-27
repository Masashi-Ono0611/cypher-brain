#!/usr/bin/env node
// Property-based tests (#228), using fast-check (the de facto standard for JS/TS —
// CONTRIBUTING.md's "prefer an existing implementation" applies here just as much as it
// does to age/rclone/gitleaks: this project does not roll its own input generator/shrinker).
//
// Every existing selftest*.{sh,mjs} in this repo is example-based: a handful of
// hand-picked inputs, run once. That catches regressions in cases someone already
// thought of. It does NOT answer "does this invariant hold for inputs nobody thought
// to write by hand" — which is exactly the gap PR #198's review finding fell into: a
// forged manifest `name` like "../../../etc/cron.d/evil.tar.gz" is one hand-picked
// string, but the actual security claim ("no name a manifest can contain ever escapes
// --out-dir") is a claim about ALL strings. fast-check generates hundreds of inputs
// per run (including its own library of known-nasty edge cases: empty strings, lone
// surrogates, control characters, very long strings) and shrinks any failure to a
// minimal counterexample.
//
// Scope, stated narrowly on purpose (same discipline as selftest-error-codes.mjs's own
// header): this file property-tests FOUR specific, already-identified invariants — the
// two manifest-field guards in src/lib/restore.ts (#198's vulnerability class), the
// expanded/ directory-name uniqueness invariant those guards' numeric-index prefix relies
// on (#181/#423), and the age encrypt/decrypt roundtrip in src/lib/crypt.ts. It does not
// attempt to fuzz the whole CLI surface, and it is not a substitute for
// scripts/selftest-cctv-age.mjs (which checks typage's CONFORMANCE to the age spec using
// upstream's own vectors — a different question from "does OUR code's usage of typage
// roundtrip correctly").
import fc from 'fast-check';
import { join, resolve, sep } from 'node:path';
import { isSafeComponentName, shortSourceLabel, SHORT_LABEL_MAX } from '../src/lib/restore.ts';
import { generateKeypair, newEncrypter, newDecrypter } from '../src/lib/crypt.ts';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// Runs an fc property and reports it the same way every other check() in this file
// does — fc.assert() throws on the first (already-shrunk) counterexample, so a plain
// try/catch is all the translation needed.
async function property(name, prop, params) {
  try {
    await fc.assert(prop, { numRuns: 200, ...params });
    check(name, true);
  } catch (e) {
    check(name, false, e.message.split('\n')[0]);
  }
}

// ---- restore.ts: isSafeComponentName (#198's vulnerability class) ----
//
// `unit: 'binary'` (not fc.string()'s default `unit: 'grapheme-ascii'`) generates raw
// UTF-16 code units -- control characters, lone surrogates, and the full Unicode range,
// not just printable ASCII. A manifest's `source`/component-name fields are attacker-
// controlled bytes, not necessarily well-formed text, so the property below needs to
// see those shapes to actually test what its own name promises ("for any input").
const wideString = (opts) => fc.string({ unit: 'binary', ...opts });

// A dedicated arbitrary for path-traversal-SHAPED strings, alongside generic wideString()
// — plain random unicode rarely happens to contain "..", so without this the property
// would spend almost all its budget on inputs that were never going to be interesting.
// `fc.oneof` weights both, so the suite still gets broad coverage AND concentrated
// coverage of the actual attack shape.
const pathSegment = fc.oneof(
  fc.constant('..'),
  fc.constant('.'),
  wideString({ minLength: 0, maxLength: 8 }).filter((s) => !s.includes('/') && !s.includes('\\')),
);
const traversalLike = fc
  .tuple(
    fc.array(pathSegment, { minLength: 1, maxLength: 6 }),
    fc.constantFrom('/', '\\'),
    fc.boolean(), // leading separator, e.g. "/etc/passwd"
  )
  .map(([segs, s, leading]) => (leading ? s : '') + segs.join(s));
const nameArb = fc.oneof(wideString(), traversalLike);

await property(
  'isSafeComponentName: an accepted name never resolves outside outDir',
  (() => {
    const outDir = join(sep, 'restore', 'out-dir'); // a fixed, fake absolute root — no real I/O
    const rootResolved = resolve(outDir);
    return fc.property(nameArb, (name) => {
      if (!isSafeComponentName(name)) return true; // rejected — nothing to check here
      const joined = resolve(join(outDir, name));
      // Either it landed EXACTLY on outDir (only possible for a name that resolves to
      // "", which isSafeComponentName already refuses via its length check — kept as a
      // belt-and-suspenders equality check, not an escape hatch) or strictly inside it.
      return joined === rootResolved || joined.startsWith(rootResolved + sep);
    });
  })(),
);

// The property above proves accepted names are SAFE — it says nothing about whether
// isSafeComponentName is too eager to reject (a function that always returns false
// would trivially satisfy it too: nothing is ever accepted, so nothing is ever checked).
// This second property closes that gap by pinning the other half of the same contract
// its own doc comment states ("a bare filename directly under --out-dir: no directory
// separator, no dot-segment") — every ordinary, non-adversarial filename must still be
// ACCEPTED, and every string containing a separator or a bare dot-segment must still be
// REJECTED. Together the two properties fully specify the function's truth table.
await property(
  'isSafeComponentName: accepts exactly the bare, non-dot-segment filenames its doc comment promises',
  fc.property(nameArb, (name) => {
    const structurallySafe =
      name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';
    return isSafeComponentName(name) === structurallySafe;
  }),
);

// Pin the exact exploit string the code comment above isSafeComponentName documents —
// an example-based regression alongside the properties above, the same "both together"
// posture CONTRIBUTING.md's own quality bar expects (a property proves the invariant in
// general; this pins the one concrete case a reviewer will recognize on sight).
check(
  'isSafeComponentName: rejects the #198 example verbatim',
  isSafeComponentName('../../../etc/cron.d/evil.tar.gz') === false,
);

// ---- restore.ts: shortSourceLabel (the `source` field's directory-name guard) ----
//
// #423: renamed/simplified from encodeSourcePath(), which used to flatten the ENTIRE
// absolute source path (every separator replaced, truncated-and-hashed past 160 chars)
// into the directory name itself. shortSourceLabel() instead only takes the source's
// basename — expandComponents() (restore.ts) relies ENTIRELY on the numeric index it
// prefixes onto this label for directory-name uniqueness (see the third property below),
// not on this function. The two threat-model properties this guard still needs to satisfy
// are unchanged: shortSourceLabel()'s output is used as ONE path segment (prefixed with
// that numeric index) — it must never smuggle a '/' or '\\' through, regardless of what a
// forged manifest's `source` field contains, and must stay bounded in length.
// Boundary-exact lengths around SHORT_LABEL_MAX (64): random sampling alone rarely lands
// on the EXACT length the truncate-vs-passthrough branch flips on, no matter how many
// runs -- these constants guarantee the mutation-testing kill oracle actually sees the
// boundary (off-by-one <= vs < mutants, "always truncate"/"never truncate" mutants).
const boundaryLengthArb = fc.oneof(
  fc.constant('a'.repeat(63)),
  fc.constant('a'.repeat(64)),
  fc.constant('a'.repeat(65)),
);
const sourceArb = fc.oneof(
  wideString(),
  wideString({ minLength: 200, maxLength: 500 }),
  traversalLike,
  boundaryLengthArb,
);
// numRuns raised for these: wideString()'s full binary-code-unit domain is vastly larger
// than the old ASCII-only default, so the mutation-testing kill oracle (a mutant that
// misbehaves only on specific narrow inputs, e.g. one particular character class in
// shortSourceLabel's own replace regex) needs more samples to stay as likely to land on a
// triggering input as it was against the smaller domain -- 200 runs alone let real
// mutation-score coverage regress after the string arbitrary was widened.
await property(
  'shortSourceLabel: never emits a path separator, for any input',
  fc.property(sourceArb, (source) => {
    const label = shortSourceLabel(source);
    return !label.includes('/') && !label.includes('\\');
  }),
  { numRuns: 1000 },
);

// The per-component directory name is `<3-digit index>-<label>` (restore.ts) — this
// pins shortSourceLabel()'s own documented contribution to that budget: comfortably
// under common 255-byte filename limits regardless of how long/deeply-nested the
// forged `source` string is.
await property(
  'shortSourceLabel: output length never exceeds SHORT_LABEL_MAX, for any input',
  fc.property(sourceArb, (source) => shortSourceLabel(source).length <= SHORT_LABEL_MAX),
  { numRuns: 1000 },
);

// #423/#181: shortSourceLabel() is deliberately NOT collision-resistant by itself — two
// different --dir sources sharing a basename (e.g. many `~/.claude/projects/*/memory/`
// dirs — the exact case #181 introduced this whole expanded/ scheme to disambiguate)
// produce the IDENTICAL label. expandComponents() instead relies entirely on prefixing
// each directory name with the component's own 1-based sequence number to guarantee no
// two components ever land in the same directory. This property pins exactly that
// invariant at the level restore.ts actually builds the directory name (see its
// `${String(i + 1).padStart(3, '0')}-${shortSourceLabel(c.source)}` expression): for ANY
// two DISTINCT indices, even with the SAME source string fed to both (the worst case —
// identical basenames), the resulting directory names never collide.
await property(
  'expanded/ directory names: distinct component index alone guarantees distinct directory names, even for identical sources (#181)',
  fc.property(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 1, max: 999 }), sourceArb, (i1, i2, source) => {
    if (i1 === i2) return true; // same index is not the case under test
    const dirName1 = `${String(i1).padStart(3, '0')}-${shortSourceLabel(source)}`;
    const dirName2 = `${String(i2).padStart(3, '0')}-${shortSourceLabel(source)}`;
    return dirName1 !== dirName2;
  }),
  { numRuns: 1000 },
);

// ---- crypt.ts: generateKeypair / newEncrypter / newDecrypter roundtrip ----
//
// Through this repo's OWN wrapper functions (not age-encryption's Encrypter/Decrypter
// directly — those are already exercised for spec conformance by
// scripts/selftest-cctv-age.mjs; the point here is this repo's usage of them).
// The existing selftest*.sh suite already exercises this end-to-end via the real CLI
// (spawning tar, real files) — this property test complements it in-process (no
// subprocess, no disk I/O) across randomized plaintext SIZE, randomized RECIPIENT
// COUNT/CHOICE, and both the plain-X25519 and post-quantum-hybrid (#205) keypair
// kinds — dimensions the hand-written selftests each fix to one or two values.
await property(
  "keypair roundtrip: any plaintext, any recipient count/kind, decrypts byte-identical for any recipient's identity",
  fc.asyncProperty(
    fc.uint8Array({ minLength: 0, maxLength: 4096 }),
    fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }), // one bool per recipient: pq or plain X25519
    async (plaintext, pqFlags) => {
      const keypairs = await Promise.all(pqFlags.map((pq) => generateKeypair({ pq })));
      const encrypter = newEncrypter(keypairs.map((k) => k.recipient));
      const ciphertext = await encrypter.encrypt(plaintext);

      // Every recipient's identity must decrypt it, not just the first — an encrypt
      // call for N recipients that only the first can actually read would be a much
      // worse bug than any single test picking one identity at random could ever catch.
      for (const { identity } of keypairs) {
        const decrypter = newDecrypter([identity]);
        const decrypted = await decrypter.decrypt(ciphertext);
        if (Buffer.compare(Buffer.from(decrypted), Buffer.from(plaintext)) !== 0) return false;
      }
      return true;
    },
  ),
  { numRuns: 100 },
);

// newEncrypter()'s error path (an invalid recipient string) — the roundtrip property
// above only ever feeds it recipients generateKeypair() itself just produced, so it
// never exercises the reject-and-rewrap-the-error branch at all. `age1` is the native
// recipient prefix (see crypt.ts's own comment on this function); excluding it keeps
// this property from accidentally generating something that happens to parse.
await property(
  "newEncrypter: rejects a non-age recipient with an error naming it, doesn't just crash opaquely",
  fc.property(
    wideString().filter((s) => !s.startsWith('age1')),
    (bogus) => {
      try {
        newEncrypter([bogus]);
        return false; // must not have been accepted as a recipient
      } catch (e) {
        // crypt.ts's rejection throws `invalid recipient ${JSON.stringify(r)}: ...` --
        // check the REJECTED VALUE actually appears (JSON.stringify'd, so control
        // characters/quotes in `bogus` are escaped the same way), not just the generic
        // phrase every rejection shares. A prior version of this test only checked the
        // phrase, which would still pass if the value were silently dropped.
        return (
          e instanceof Error && e.message.includes('invalid recipient') && e.message.includes(JSON.stringify(bogus))
        );
      }
    },
  ),
);

if (failed > 0) {
  console.error(`\n${failed} propert${failed === 1 ? 'y' : 'ies'} failed`);
  process.exit(1);
}
console.log('\nall properties held');
