#!/usr/bin/env node
// Receipt-callback partial-success guard (arweave.ts's onReceipt call sites,
// backends/turbo.ts's own mirror of the same guard) — the fix for the finding left
// open by PR #847: "receipt-callback errors can lose a confirmed-upload locator".
//
// backend.put()'s `onReceipt` callback runs AFTER the paid upload is already
// irreversible (the tx is signed and the gateway accepted it). pushpull.ts's own
// persistReceipt() (the ONLY real caller today) never throws — it catches its own
// failure internally and warn()s (see its own header comment: "a receipt-write failure
// must NEVER retroactively fail an already-irreversible spend") — so a receipt-callback
// failure cannot be reached through the CLI (`push`) at all today. But that safety
// lived entirely in the caller: before this fix, a backend that called `onReceipt`
// unguarded would let a DIFFERENT/future caller's throwing callback turn a
// definitely-successful, already-paid-for upload into what put() throws as an ordinary,
// unclassified Error — discarding the confirmed locator and reporting the whole push as
// having failed. This script proves that no longer happens, by calling the backend's
// own put() directly (bypassing pushpull.ts) with a deliberately-throwing onReceipt,
// against a LOCAL arlocal gateway (no real AR, no network).
import Arweave from 'arweave';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const TX_RE = /^[A-Za-z0-9_-]{43}$/; // base64url Arweave tx id

let failed = false;
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => {
  console.log(`[FAIL] ${m}`);
  failed = true;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// A dynamically-picked free port (#351's lesson, same as arweave-roundtrip.mjs):
// a fixed port risks adopting an orphaned arlocal from a previously-killed run.
const PORT = Number(process.env.CB_ARLOCAL_PORT || (await freePort()));

// arlocal runs in a SEPARATE process (scripts/arlocal-server.mjs), same rationale as
// arweave-roundtrip.mjs's own header comment: this script's own `import()`s below could
// otherwise inherit its listening socket.
const arproc = spawn('node', [join(HERE, 'arlocal-server.mjs'), String(PORT)], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let arExit = null;
arproc.on('exit', (code, signal) => {
  arExit = { code, signal };
});
let arSpawnError = null;
arproc.on('error', (e) => {
  arSpawnError = e;
});
arproc.stderr.setEncoding('utf8');
const arReady = await new Promise((resolve) => {
  let buf = '';
  let settled = false;
  const onData = (d) => {
    buf += d;
    if (buf.includes(`arlocal listening on ${PORT}`)) done(true);
  };
  const onDeath = () => done(false);
  const done = (v) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    arproc.stderr.removeListener('data', onData);
    arproc.removeListener('exit', onDeath);
    arproc.removeListener('error', onDeath);
    resolve(v);
  };
  const timer = setTimeout(() => done(false), 20_000);
  arproc.stderr.on('data', onData);
  arproc.on('exit', onDeath);
  arproc.on('error', onDeath);
});
if (!arReady) {
  arproc.kill('SIGKILL');
  console.log(
    arExit !== null
      ? `[FAIL] the arlocal server process exited before becoming ready (code ${arExit.code}, signal ${arExit.signal})`
      : arSpawnError !== null
        ? `[FAIL] could not spawn the arlocal server process: ${arSpawnError.message}`
        : '[FAIL] arlocal did not announce readiness within 20s',
  );
  process.exit(1);
}

const tmp = await mkdtemp(join(tmpdir(), 'cb-onreceipt-'));
try {
  const ar = Arweave.init({ host: 'localhost', port: PORT, protocol: 'http' });
  const jwk = await ar.wallets.generate();
  const addr = await ar.wallets.jwkToAddress(jwk);
  const walletPath = join(tmp, 'wallet.json');
  await writeFile(walletPath, JSON.stringify(jwk), { mode: 0o600 }); // 0600: avoid the loose-perms warning (#35)
  await fetch(`http://localhost:${PORT}/mint/${addr}/100000000000000`);

  // Set env BEFORE importing arweave.ts/config.ts: AR_HOST/AR_PORT/AR_PROTOCOL/AR_WALLET
  // are plain top-level `const`s computed once at module-load time (config.ts), so a
  // static `import` at the top of this file would already have baked in the real
  // arweave.net default — a dynamic import here, after the env is set, is what makes
  // this test hit the local arlocal gateway instead.
  process.env.CYPHER_BRAIN_AR_HOST = 'localhost';
  process.env.CYPHER_BRAIN_AR_PORT = String(PORT);
  process.env.CYPHER_BRAIN_AR_PROTOCOL = 'http';
  process.env.CYPHER_BRAIN_AR_WALLET = walletPath;
  const { arweaveBackend } = await import('../src/lib/backends/arweave.ts');
  const { drainWarnings } = await import('../src/lib/warn.ts');
  drainWarnings(); // discard anything recorded before this test (module-load side effects, if any)

  const inFile = join(tmp, 'artifact.age');
  await writeFile(inFile, Buffer.from('age-encryption.org/v1\nfake ciphertext body for onReceipt guard test\n'));

  let receiptCalled = false;
  let receiptSawLocator = null;
  const throwingOnReceipt = async (event) => {
    receiptCalled = true;
    receiptSawLocator = event?.locator ?? null;
    throw new Error('simulated receipt-ledger write failure (disk full)');
  };

  const backend = await arweaveBackend();
  let locator;
  let thrown = null;
  try {
    locator = await backend.put(inFile, { yes: true, onReceipt: throwingOnReceipt });
  } catch (e) {
    thrown = e;
  }

  if (thrown) {
    fail(
      `backend.put() should NOT throw when onReceipt fails on an already-confirmed upload, but it threw: ${thrown?.message ?? thrown}`,
    );
  } else {
    pass('backend.put() did not throw despite the onReceipt callback failing');
  }
  if (receiptCalled) pass('onReceipt was actually invoked (test setup control)');
  else fail('onReceipt was never called — test setup is broken, this proves nothing');
  if (typeof locator === 'string' && TX_RE.test(locator)) {
    pass(`backend.put() still returned the confirmed tx id (${locator}) despite the failing receipt callback`);
  } else {
    fail(`backend.put() did not return a valid tx id: ${JSON.stringify(locator)}`);
  }
  if (typeof receiptSawLocator === 'string' && receiptSawLocator === locator) {
    pass("onReceipt's own event carried the SAME locator put() went on to return");
  } else {
    fail(
      `onReceipt's event.locator (${JSON.stringify(receiptSawLocator)}) did not match put()'s return (${JSON.stringify(locator)})`,
    );
  }
  const warnings = drainWarnings();
  if (
    warnings.some(
      (w) => w.includes('onReceipt callback failed') && w.includes('simulated receipt-ledger write failure'),
    )
  ) {
    pass('the receipt-callback failure was surfaced via warn(), not silently dropped');
  } else {
    fail(`no recorded warning mentioned the onReceipt callback failure (recorded: ${JSON.stringify(warnings)})`);
  }
} catch (e) {
  fail(`unexpected error: ${e?.stack ?? e}`);
} finally {
  arproc.kill('SIGKILL');
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? '\nONRECEIPT GUARD SELFTEST: FAIL' : '\nONRECEIPT GUARD SELFTEST: PASS');
process.exit(failed ? 1 : 0);
