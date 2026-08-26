#!/usr/bin/env node
// Proof for #344: a lazy SDK-import failure produces advice that actually helps, by
// CLASS of failure — because "run: npm install @ardrive/turbo-sdk" was measured to be
// exactly the wrong advice for two of the three classes, on a real monthly push:
//
//   1. SDK absent entirely            -> npm install IS the fix (message unchanged).
//   2. SDK present, transitive dep    -> npm install had already "succeeded" (it printed
//      missing (turbo-sdk->x402->viem)   "added 575 packages" and viem was still gone);
//                                        repeating it changes nothing. The fix is the
//                                        isolated-dir pattern the runbook documents.
//   3. ERR_PACKAGE_PATH_NOT_EXPORTED  -> a version clash with the host tree
//      (@noble/hashes './sha3')          (same isolated-dir remedy). Previously this
//                                        code was not even caught — a raw stack trace.
//
// Classes 2 and 3 are CONSTRUCTED here, not simulated: a fake @ardrive/turbo-sdk whose
// entry imports a genuinely-missing package (2), or a subpath its neighbour's `exports`
// does not expose (3), installed into an isolated dir where the real SDK is absent —
// same isolation trick as selftest-usd-rate.mjs (#170).
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
let failed = false;
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => {
  console.log(`[FAIL] ${m}`);
  failed = true;
};

const tmp = await mkdtemp(join(tmpdir(), 'cb-sdkadvice-'));
try {
  const isoDir = join(tmp, 'iso');
  await mkdir(isoDir, { recursive: true });
  const isoBin = join(isoDir, 'cli.mjs');
  await copyFile(join(ROOT, 'dist', 'cli.mjs'), isoBin).catch(() => {
    throw new Error('dist/cli.mjs not found — run `npm run build` first');
  });
  const payload = join(tmp, 'payload.bin');
  await writeFile(payload, Buffer.alloc(2048, 1));

  const sdkDir = join(isoDir, 'node_modules', '@ardrive', 'turbo-sdk');

  const runEstimate = () =>
    spawnSync('node', [isoBin, 'estimate', '--in', payload, '--backend', 'turbo'], {
      cwd: isoDir,
      encoding: 'utf8',
      timeout: 30000,
    });

  // class 1 (control): SDK absent — the classic message, unchanged in spirit.
  let r = runEstimate();
  if (r.status !== 0) fail(`class 1 exited ${r.status}: ${r.stderr.slice(0, 200)}`);
  else if (!/not installed — run: npm install @ardrive\/turbo-sdk/.test(r.stdout))
    fail(`class 1 (absent SDK) lost its install advice: ${r.stdout}`);
  else if (/isolated directory/.test(r.stdout))
    fail(`class 1 wrongly recommends the isolated-dir pattern when npm install IS the fix: ${r.stdout}`);
  else pass('class 1: an absent SDK still says "run: npm install @ardrive/turbo-sdk" (and only that)');

  // class 2: SDK present, its transitive dep missing — the real #344 incident shape.
  await mkdir(sdkDir, { recursive: true });
  await writeFile(join(sdkDir, 'package.json'), JSON.stringify({ name: '@ardrive/turbo-sdk', main: 'index.mjs' }));
  await writeFile(join(sdkDir, 'index.mjs'), "import 'viem';\nexport const TurboFactory = {};\n");
  r = runEstimate();
  if (r.status !== 0) fail(`class 2 exited ${r.status}: ${r.stderr.slice(0, 200)}`);
  else if (/not installed — run: npm install/.test(r.stdout))
    fail(`class 2 (transitive dep missing) still gives the advice measured NOT to work: ${r.stdout}`);
  else if (!/'viem' cannot be resolved/.test(r.stdout) || !/isolated directory/.test(r.stdout))
    fail(`class 2 does not name the missing dep and the isolated-dir remedy: ${r.stdout}`);
  else pass("class 2: a missing transitive dep names 'viem' and points at the isolated-dir pattern, not npm install");

  // class 3: ERR_PACKAGE_PATH_NOT_EXPORTED — the version-clash shape. Previously
  // uncaught: the raw exception escaped instead of any advice at all.
  const clashDir = join(isoDir, 'node_modules', 'clashpkg');
  await mkdir(clashDir, { recursive: true });
  await writeFile(join(clashDir, 'package.json'), JSON.stringify({ name: 'clashpkg', exports: { '.': './i.mjs' } }));
  await writeFile(join(clashDir, 'i.mjs'), 'export default 1;\n');
  await writeFile(join(sdkDir, 'index.mjs'), "import 'clashpkg/sha3';\nexport const TurboFactory = {};\n");
  r = runEstimate();
  if (r.status !== 0) fail(`class 3 exited ${r.status}: ${r.stderr.slice(0, 200)}`);
  else if (!/exports do not match/.test(r.stdout) || !/isolated directory/.test(r.stdout))
    fail(`class 3 (exports mismatch) is not caught with the isolated-dir remedy: ${r.stdout}`);
  else pass('class 3: an exports mismatch (the observed clash class) is caught and explained, not a raw stack trace');

  // class 2b: a missing SUBPATH of the SDK itself is a BROKEN install, not an absent
  // one — "reinstall the SDK" was measured not to help there, so it must get the
  // isolated-dir advice, not the npm-install advice (Codex review: an earlier draft
  // classified this exactly backwards).
  await writeFile(
    join(sdkDir, 'index.mjs'),
    "import '@ardrive/turbo-sdk/dist/nope.js';\nexport const TurboFactory = {};\n",
  );
  r = runEstimate();
  if (r.status !== 0) fail(`class 2b exited ${r.status}: ${r.stderr.slice(0, 200)}`);
  else if (/not installed — run: npm install/.test(r.stdout))
    fail(`class 2b (SDK subpath missing) was misclassified as an absent SDK: ${r.stdout}`);
  else if (!/isolated directory/.test(r.stdout)) fail(`class 2b did not get the isolated-dir remedy: ${r.stdout}`);
  else pass('class 2b: a missing subpath of the installed SDK is classified broken, not absent');
  await writeFile(join(sdkDir, 'index.mjs'), "import 'clashpkg/sha3';\nexport const TurboFactory = {};\n");

  // the push path gives the same classified advice. push's age-ciphertext header gate
  // runs before the SDK import, so the payload must LOOK like age ciphertext to reach
  // the import at all (it never gets uploaded — the import fails first).
  const fakeAge = join(tmp, 'fake.age');
  await writeFile(fakeAge, `age-encryption.org/v1\n-> X25519 fake\nfakebody\n`);
  r = spawnSync('node', [isoBin, 'push', '--in', fakeAge, '--backend', 'turbo', '--yes'], {
    cwd: isoDir,
    encoding: 'utf8',
    timeout: 30000,
    // CYPHER_BRAIN_HOME isolation (#226): this push always fails at the SDK-import
    // stage (before ever reaching a real upload), but push() ALSO records an audit-
    // trail entry (src/lib/audit.ts) on that failure — without an isolated HOME here,
    // that entry landed in the operator's REAL $CYPHER_BRAIN_HOME/audit-log.jsonl
    // (caught via a leaked file found outside any test tmp dir, the same class of bug
    // #232's own selftest-receipt.mjs header comment documents hitting once already).
    env: { ...process.env, CYPHER_BRAIN_HOME: join(tmp, 'home') },
  });
  if (r.status === 0) fail('push with a broken SDK exited 0');
  else if (!/exports do not match/.test(r.stderr) || !/isolated directory/.test(r.stderr))
    fail(`push did not carry the classified advice: ${r.stderr.slice(0, 300)}`);
  else pass('push: the same classified advice reaches the push error path');

  // a NON-import error must pass through UNTOUCHED and OBSERVED (negative control): a
  // fake SDK whose entry throws a plain error is not an install problem. The original
  // message must be visible in the output — "no advice appeared" alone would also pass
  // if the command failed for an unrelated reason (Codex review).
  await writeFile(join(sdkDir, 'index.mjs'), "throw new Error('kaboom at import time');\n");
  r = runEstimate();
  const all = r.stdout + r.stderr;
  if (!/kaboom at import time/.test(all))
    fail(`the original non-import error did not surface at all: ${all.slice(0, 300)}`);
  else if (/(npm install|isolated directory)/.test(all))
    fail(`a non-import error was given install advice: ${all.slice(0, 300)}`);
  else pass('a non-import failure surfaces its own message and is not dressed up as an install problem');

  // the wallet site (arweave package): absent -> the classic npm-install advice; broken
  // -> the isolated-dir advice as a HARD error. The kind split matters most on the
  // arweave chunk-fallback (SdkMissingError = "optional, skip"), which only 'absent'
  // may trigger — enforced by construction in the call sites, exercised here at the
  // wallet surface where both classes are cheaply constructible.
  const walletJson = join(tmp, 'wallet.json');
  await writeFile(walletJson, JSON.stringify({ kty: 'RSA', n: 'x', e: 'AQAB' }));
  const runWallet = () =>
    spawnSync('node', [isoBin, 'wallet', 'address', '--wallet', walletJson], {
      cwd: isoDir,
      encoding: 'utf8',
      timeout: 30000,
    });
  r = runWallet();
  if (r.status === 0) fail('wallet address with no arweave package exited 0');
  else if (!/not installed — run: npm install arweave/.test(r.stderr))
    fail(`wallet (absent arweave) lost its install advice: ${r.stderr.slice(0, 300)}`);
  else pass('wallet: an absent arweave package keeps the plain npm-install advice');

  const arDir = join(isoDir, 'node_modules', 'arweave');
  await mkdir(arDir, { recursive: true });
  await writeFile(join(arDir, 'package.json'), JSON.stringify({ name: 'arweave', main: 'index.mjs' }));
  await writeFile(join(arDir, 'index.mjs'), "import 'missing-transitive-dep';\nexport default { init() {} };\n");
  r = runWallet();
  if (r.status === 0) fail('wallet address with a broken arweave package exited 0');
  else if (!/'missing-transitive-dep' cannot be resolved/.test(r.stderr) || !/isolated directory/.test(r.stderr))
    fail(`wallet (broken arweave) not classified broken with the remedy: ${r.stderr.slice(0, 300)}`);
  else pass('wallet: a broken arweave install is a loud, classified error — not "missing", not skippable');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(failed ? 'SDK ADVICE SELFTEST: FAIL' : 'SDK ADVICE SELFTEST: PASS');
process.exit(failed ? 1 : 0);
