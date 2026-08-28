#!/usr/bin/env node
// Proof for #641: a malicious/compromised Arweave gateway that keeps SOME bytes
// flowing — resetting the per-chunk stall timeout on every chunk, but never actually
// stalling — must still be bounded by a TOTAL transfer-duration cap, independent of
// that stall timer, so it cannot grow the pulled .part file (and consume local disk)
// forever.
//
// Two scenarios against a real HTTP server (no network, no real Arweave gateway):
//
//   1. A "drip" gateway: HTTP 200, starts with AGE_MAGIC (so it LOOKS like a real
//      object beginning), then writes a small chunk every 100ms forever, never
//      finishing. The per-chunk stall timeout is set LARGER than the total-duration
//      cap under test, so if the fix regresses (the cap stops being enforced, or gets
//      wired to the wrong timer), this test would hang until the stall timeout instead
//      — bounded externally by this script's own watchdog, and distinguished by
//      asserting the elapsed time is close to the CAP, not close to the (much larger)
//      stall timeout.
//   2. A normal, fast, well-behaved gateway: HTTP 200 with a complete small age
//      ciphertext body, closed immediately. Regression/negative-control check that the
//      new total-duration cap does not affect (or even measurably slow down) an
//      ordinary successful pull.
//   3. A "silent after a few chunks" gateway: sends a handful of chunks quickly (well
//      inside the cap), then stops writing ANYTHING and leaves the connection open. A
//      per-chunk-only deadline check (re-evaluated only when a new chunk arrives) would
//      never fire again once the chunks stop — the connection would then live until the
//      independent, much-larger stall timeout instead of the cap (this exact gap was
//      caught in Codex review before this fix reached the ABSOLUTE-timer form it has
//      now). This scenario is the regression test for that specific failure mode.
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const AGE_MAGIC = 'age-encryption.org/v1'; // mirrors src/lib/config.ts's own constant — kept local so this script has no import-order dependency on config.ts

// A free, guaranteed-CLOSED TCP port (bound then immediately released) so the L1
// arweave-js chunk-read fallback (which arweaveBackend().get() also attempts) fails
// FAST with ECONNREFUSED rather than either reaching the real network or hanging.
async function freeClosedPort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

function startDripGateway() {
  let chunksSent = 0;
  let clientAborted = false;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(AGE_MAGIC); // looks like the start of a real object
    chunksSent++;
    const iv = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`chunk-${chunksSent}-`.padEnd(64, 'x'));
      chunksSent++;
    }, 100);
    res.on('close', () => {
      clientAborted = true;
      clearInterval(iv);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, stats: () => ({ chunksSent, clientAborted }) }),
    );
    server.on('error', reject);
  });
}

function startSilentAfterChunksGateway() {
  let chunksSent = 0;
  let clientAborted = false;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(AGE_MAGIC);
    chunksSent++;
    // Two more chunks, quickly, well inside the cap — then NOTHING ever again. The
    // socket is left open (no res.end()), exactly like the drip gateway, but with no
    // further chunk to re-trigger a per-chunk-only deadline check.
    setTimeout(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write('second-chunk'.padEnd(32, 'y'));
        chunksSent++;
      }
    }, 50);
    res.on('close', () => {
      clientAborted = true;
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, stats: () => ({ chunksSent, clientAborted }) }),
    );
    server.on('error', reject);
  });
}

function startFastGateway(body) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

const tmp = await mkdtemp(join(tmpdir(), 'cb-arweave-cap-'));
try {
  const closedPort = await freeClosedPort();
  const CAP_MS = 1000; // the total-duration cap under test (CYPHER_BRAIN_PIPE_TIMEOUT)
  const STALL_MS = 8000; // deliberately >> CAP_MS: must NOT be what stops the drip scenario

  // Set BEFORE any dynamic import of arweave.ts/config.ts — both PIPE_TIMEOUT_MS and
  // AR_HTTP_TIMEOUT_MS are computed as module-level consts at first import (same
  // import-hoisting hazard documented in scripts/selftest-receipt.mjs).
  process.env.CYPHER_BRAIN_HOME = tmp;
  process.env.CYPHER_BRAIN_PIPE_TIMEOUT = String(CAP_MS);
  process.env.CYPHER_BRAIN_AR_HTTP_TIMEOUT = String(STALL_MS);
  // Route the L1 chunk-read SDK fallback at a closed port so it fails fast instead of
  // reaching the real network or hanging for its own timeout.
  process.env.CYPHER_BRAIN_AR_HOST = '127.0.0.1';
  process.env.CYPHER_BRAIN_AR_PORT = String(closedPort);
  process.env.CYPHER_BRAIN_AR_PROTOCOL = 'http';

  const { arweaveBackend } = await import('../src/lib/backends/arweave.ts');
  const backend = await arweaveBackend();
  const FAKE_TX_ID = 'A'.repeat(43); // passes the 43-char base64url shape check; never resolved against a real network here

  // ---------------------------------------------------------------------------
  // Scenario 1: the drip gateway — must be aborted by the TOTAL duration cap, not
  // (only) by the per-chunk stall timeout, since the stall timer keeps getting reset.
  // ---------------------------------------------------------------------------
  {
    const { server, port, stats } = await startDripGateway();
    process.env.CYPHER_BRAIN_AR_GATEWAY = `http://127.0.0.1:${port}`;
    const out = join(tmp, 'drip-out.age');
    const startedAt = Date.now();
    // External watchdog: if the fix regressed and the process actually waits for the
    // (much larger) stall timeout — or hangs entirely — fail this test explicitly and
    // promptly instead of hanging CI.
    const watchdogMs = STALL_MS + 5000;
    let outcome, _err;
    try {
      await Promise.race([
        backend.get(FAKE_TX_ID, out).then(() => (outcome = 'resolved')),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`watchdog: get() did not settle within ${watchdogMs}ms`)), watchdogMs),
        ),
      ]);
    } catch (e) {
      outcome = 'threw';
      _err = e;
    }
    const elapsed = Date.now() - startedAt;
    server.close();
    const { chunksSent, clientAborted } = stats();

    check('drip gateway: get() rejects rather than hanging or succeeding', outcome === 'threw', `outcome=${outcome}`);
    check(
      'drip gateway: elapsed time is close to the total-duration cap, not near-instant (proves the stall timer alone did not kill it early)',
      elapsed >= CAP_MS - 100,
      `elapsed=${elapsed}ms CAP_MS=${CAP_MS}`,
    );
    check(
      'drip gateway: elapsed time is well under the (much larger) per-chunk stall timeout (proves the TOTAL cap fired, not the stall timer)',
      elapsed < STALL_MS,
      `elapsed=${elapsed}ms STALL_MS=${STALL_MS}`,
    );
    check(
      'drip gateway: multiple chunks were actually received before the abort (each one would have reset the stall timer)',
      chunksSent >= 3,
      `chunksSent=${chunksSent}`,
    );
    check(
      'drip gateway: the mock server observed the client disconnect (the pull actually aborted the connection)',
      clientAborted,
    );
    const partExists = await stat(`${out}.part`).then(
      () => true,
      () => false,
    );
    check('drip gateway: no leftover .part file after the abort (no disk leak)', !partExists);
    const outExists = await stat(out).then(
      () => true,
      () => false,
    );
    check('drip gateway: --out was never created (nothing was promoted)', !outExists);
  }

  // ---------------------------------------------------------------------------
  // Scenario 2: a gateway that sends a couple of chunks quickly and then goes silent
  // forever, connection left open — the specific failure mode a per-chunk-only deadline
  // check cannot catch (Codex review).
  // ---------------------------------------------------------------------------
  {
    const { server, port, stats } = await startSilentAfterChunksGateway();
    process.env.CYPHER_BRAIN_AR_GATEWAY = `http://127.0.0.1:${port}`;
    const out = join(tmp, 'silent-out.age');
    const startedAt = Date.now();
    const watchdogMs = STALL_MS + 5000;
    let outcome;
    try {
      await Promise.race([
        backend.get(FAKE_TX_ID, out).then(() => (outcome = 'resolved')),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`watchdog: get() did not settle within ${watchdogMs}ms`)), watchdogMs),
        ),
      ]);
    } catch {
      outcome = 'threw';
    }
    const elapsed = Date.now() - startedAt;
    server.close();
    const { chunksSent } = stats();

    check(
      'silent-after-chunks gateway: get() rejects rather than hanging or succeeding',
      outcome === 'threw',
      `outcome=${outcome}`,
    );
    check(
      'silent-after-chunks gateway: only ever received the couple of early chunks (nothing after that could reset a per-chunk check)',
      chunksSent === 2,
      `chunksSent=${chunksSent}`,
    );
    check(
      'silent-after-chunks gateway: STILL aborted close to the total-duration cap, not left waiting for the (much larger) stall timeout — this is what a per-chunk-only deadline check would fail',
      elapsed >= CAP_MS - 100 && elapsed < STALL_MS,
      `elapsed=${elapsed}ms CAP_MS=${CAP_MS} STALL_MS=${STALL_MS}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Scenario 3: a normal, fast, complete gateway response — regression check that the
  // new total-duration cap does not interfere with an ordinary successful pull.
  // ---------------------------------------------------------------------------
  {
    const body = Buffer.from(`${AGE_MAGIC}\nordinary-fast-payload`);
    const { server, port } = await startFastGateway(body);
    process.env.CYPHER_BRAIN_AR_GATEWAY = `http://127.0.0.1:${port}`;
    const out = join(tmp, 'fast-out.age');
    const startedAt = Date.now();
    let ok = false;
    let err;
    try {
      await backend.get(FAKE_TX_ID, out);
      ok = true;
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - startedAt;
    server.close();
    check('fast gateway: an ordinary pull still succeeds', ok, err ? err.message : undefined);
    check(
      'fast gateway: an ordinary pull is not slowed down anywhere near the new cap',
      elapsed < CAP_MS / 2,
      `elapsed=${elapsed}ms`,
    );
    if (ok) {
      const gotBuf = await readFile(out);
      check('fast gateway: the pulled bytes match exactly what the gateway served', gotBuf.equals(body));
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nARWEAVE GATEWAY TOTAL-DURATION-CAP SELFTEST FAIL (${failed})`);
  process.exit(1);
}
console.log('\nARWEAVE GATEWAY TOTAL-DURATION-CAP SELFTEST PASS');
