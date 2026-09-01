#!/usr/bin/env node
// Arweave backend parity proof (issue #9). Spins up a LOCAL arlocal gateway (no real
// AR, no network) and runs the cypher-brain pipeline against it:
//   snapshot -> push --backend arweave -> (mine) -> pull -> verify -> restore.
// It proves the StorageBackend abstraction holds for a backend whose locator (an
// Arweave tx id) is assigned AFTER upload and is NOT the ciphertext's content hash —
// the case file (a content-addressed locator) didn't exercise.
import Arweave from 'arweave';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { DEV_ARGS } from './dev-node-flags.mjs';

// A dynamically-picked free port, not a fixed 1984 (#351). Measured failure with the
// fixed port: a suite killed mid-run left its arlocal orphaned and listening; the next
// run's own server died instantly on EADDRINUSE — invisibly, stdio was ignored — while
// the /info readiness probe below got a 200 from the ORPHAN and reported "ready". The
// whole suite then ran against a dead run's server, and failed with a bare
// "fetch failed" pointing nowhere near the cause when the orphan later vanished
// mid-test. A fresh port per run makes the collision vanishingly unlikely — not
// impossible: the reservation closes before arlocal rebinds it (TOCTOU), so a loser of
// that tiny race still fails, but fails FAST through the readiness gate below instead
// of adopting a squatter. CB_ARLOCAL_PORT still pins a port when needed.
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
const PORT = Number(process.env.CB_ARLOCAL_PORT || (await freePort()));
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'cypher-brain.mjs');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const TX_RE = /^[A-Za-z0-9_-]{43}$/; // base64url Arweave tx id

const log = (m) => console.error(`· ${m}`);
// arlocal runs in a SEPARATE process (scripts/arlocal-server.mjs) so the cb()
// spawns below don't inherit its sockets and deadlock — see that file's header.
log(`starting arlocal on :${PORT}`);
// Readiness comes from OUR CHILD's own announcement, never from probing the port:
// arlocal-server.mjs prints "arlocal listening on <port>" only after its await
// arlocal.start() succeeds, so seeing that line guarantees the listener is ours. A
// port probe cannot — an orphaned arlocal from a killed previous run answers /info
// with the identical protocol, and it was measured winning the probe race (~1ms)
// against our own child's EADDRINUSE death (~300ms of node startup) — the
// adopt-the-orphan failure #351 documents. Racing the child's stderr line against the
// child's exit closes it by construction.
const arproc = spawn('node', [join(HERE, 'arlocal-server.mjs'), String(PORT)], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let arExit = null;
arproc.on('exit', (code, signal) => {
  arExit = { code, signal };
});
// A spawn-level failure (node binary missing, EAGAIN) emits 'error', not 'exit' —
// without a handler it would crash unhandled instead of resolving readiness as failed.
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
  // Settle exactly once, and detach everything that could fire again: the data
  // listener would otherwise keep accumulating the child's stderr for the whole run,
  // and a later exit would call a spent resolve (Codex review).
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
      ? `[FAIL] the arlocal server process exited before becoming ready (code ${arExit.code}, signal ${arExit.signal}) — ` +
          `port ${PORT} already taken (an orphaned previous run?), or arlocal failed to start`
      : arSpawnError !== null
        ? `[FAIL] could not spawn the arlocal server process: ${arSpawnError.message}`
        : '[FAIL] arlocal did not announce readiness within 20s',
  );
  process.exit(1);
}
log('arlocal ready (announced by our own server process)');
const ar = Arweave.init({ host: 'localhost', port: PORT, protocol: 'http' });
const tmp = await mkdtemp(join(tmpdir(), 'cb-arweave-'));
let failed = false;
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => {
  console.log(`[FAIL] ${m}`);
  failed = true;
};
// #360: a dropped connection to /mine was measured failing an otherwise-green run
// twice in a row (a bare "fetch failed" with the server still alive), then vanishing
// with no code change. A short, loud, bounded retry distinguishes "one dropped
// connection" (recovers, and says so) from "server gone" (every attempt fails and the
// catch at the bottom names the server's state). Loud on purpose: a retry that saves
// the run must be visible, or the flake just hides one layer deeper. The budget is
// RUN-WIDE, not per-call (Codex review): mine() is called several times, and a
// per-call budget would let a systematic every-first-request-drops regression burn a
// retry at every call site and still come out green — 2 rescues per run is flake
// territory, more is a real problem this test must fail on.
let mineRetriesLeft = 2;
const mine = async () => {
  for (;;) {
    try {
      return await fetch(`http://localhost:${PORT}/mine`).then((r) => r.text());
    } catch (e) {
      if (mineRetriesLeft <= 0) throw e;
      mineRetriesLeft--;
      log(
        `mine failed (${e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(e)}) — retrying in 500ms (${mineRetriesLeft} run-wide mine retries left)`,
      );
      await new Promise((r) => setTimeout(r, 500));
    }
  }
};

try {
  // a funded test wallet (arlocal mint — no real AR)
  const jwk = await ar.wallets.generate();
  const addr = await ar.wallets.jwkToAddress(jwk);
  const walletPath = join(tmp, 'wallet.json');
  await writeFile(walletPath, JSON.stringify(jwk), { mode: 0o600 }); // 0600: avoid the loose-perms warning (#35)
  await fetch(`http://localhost:${PORT}/mint/${addr}/100000000000000`);
  log('wallet funded');

  const env = {
    ...process.env,
    CYPHER_BRAIN_HOME: join(tmp, 'keys'),
    CYPHER_BRAIN_AR_HOST: 'localhost',
    CYPHER_BRAIN_AR_PORT: String(PORT),
    CYPHER_BRAIN_AR_PROTOCOL: 'http',
    CYPHER_BRAIN_AR_WALLET: walletPath,
    CYPHER_BRAIN_YES: '1', // arlocal (test) — no real funds; bypass the interactive --yes guard
    // $BIN (bin/cypher-brain.mjs) imports src/cli.ts directly (no build step); its
    // internal imports use the OUTPUT extension (`./lib/config.js`, #63), which plain
    // node needs help resolving back to the sibling .ts file — see
    // scripts/dev-ts-resolve-hook.mjs. DEV_ARGS (scripts/dev-node-flags.mjs) is passed
    // as literal argv elements on every spawnSync('node', [...DEV_ARGS, BIN, ...])
    // below — NEVER via env.NODE_OPTIONS, which is whitespace-split by node and would
    // break under a checkout path containing a space.
  };
  // AR_HOST=localhost is not the default arweave.net, so arGateways() yields only the
  // derived arlocal gateway (no public mirrors) — the test never egresses.
  const cb = (...args) => {
    const r = spawnSync('node', [...DEV_ARGS, BIN, ...args], { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cb ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  };

  // build a synthetic brain + snapshot it
  const src = join(tmp, 'brain');
  await mkdir(src, { recursive: true });
  const marker = `arweave-marker-${randomBytes(6).toString('hex')}`;
  await writeFile(join(src, 'note.txt'), `${marker}\n`);
  log('keygen');
  cb('keygen');
  log('snapshot');
  cb('snapshot', '--dir', src, '--out', join(tmp, 'snap.age'));
  const cipher = await readFile(join(tmp, 'snap.age'));
  const cipherSha = sha(cipher);

  // size guard (#37): the raw arweave backend posts one inline L1 tx; an oversized
  // artifact must be REJECTED up front with an actionable redirect to --backend turbo,
  // not buffered and 400'd. Force a tiny limit so the ~10 KB snapshot trips it.
  log('size guard: oversized L1 push is refused with a turbo redirect');
  const sg = spawnSync('node', [...DEV_ARGS, BIN, 'push', '--in', join(tmp, 'snap.age'), '--backend', 'arweave'], {
    env: { ...env, CYPHER_BRAIN_AR_L1_MAX: '1' },
    encoding: 'utf8',
  });
  sg.status !== 0 && /--backend turbo/.test(sg.stderr) && /exceeds/.test(sg.stderr)
    ? pass('size guard: oversized L1 push is refused with a turbo redirect')
    : fail(`size guard did not fire as expected: status=${sg.status} stderr=${(sg.stderr || '').slice(0, 160)}`);

  // spend cap (Codex review, #69 P1): the arweave backend must actually ENFORCE
  // CYPHER_BRAIN_MAX_SPEND before signing — not merely log that it "cannot pre-flight
  // the cost" and upload anyway. A `schedule install --backend arweave --max-spend n`
  // bakes CYPHER_BRAIN_YES=1 into the unattended runner, so this cap is the only thing
  // standing between an operator's requested budget and an uncapped nightly L1 spend.
  log('spend cap: a tiny CYPHER_BRAIN_MAX_SPEND aborts the L1 push before signing');
  const capFail = spawnSync('node', [...DEV_ARGS, BIN, 'push', '--in', join(tmp, 'snap.age'), '--backend', 'arweave'], {
    env: { ...env, CYPHER_BRAIN_MAX_SPEND: '1' },
    encoding: 'utf8',
  });
  capFail.status !== 0 &&
  /L1 cost estimate/.test(capFail.stderr) &&
  /exceeds CYPHER_BRAIN_MAX_SPEND/.test(capFail.stderr)
    ? pass('spend cap: a 1-winston cap aborts the upload with a real (not skipped) cost estimate')
    : fail(
        `spend cap did not abort as expected: status=${capFail.status} stderr=${(capFail.stderr || '').slice(0, 200)}`,
      );

  log('spend cap: a generous CYPHER_BRAIN_MAX_SPEND still lets the push through');
  const capOk = spawnSync('node', [...DEV_ARGS, BIN, 'push', '--in', join(tmp, 'snap.age'), '--backend', 'arweave'], {
    env: { ...env, CYPHER_BRAIN_MAX_SPEND: '100000000000000' },
    encoding: 'utf8',
  });
  capOk.status === 0 && TX_RE.test(capOk.stdout.trim())
    ? pass('spend cap: an under-cap CYPHER_BRAIN_MAX_SPEND still lets the push through')
    : fail(`under-cap push unexpectedly failed: status=${capOk.status} stderr=${(capOk.stderr || '').slice(0, 200)}`);

  // pre-upload balance check (#701): a wallet that was never funded/minted is now
  // refused UPFRONT — before ar.transactions.sign()/post() ever run — with an
  // actionable message naming the shortfall, instead of signing and broadcasting a
  // transaction that only fails afterward. This fixture used to exercise a DIFFERENT
  // thing (#165's describeArweavePostError() body-surfacing: arlocal's own HTTP 410
  // "You don't have enough tokens" reaching the thrown error, not just a bare status) —
  // #701 intentionally moves this exact scenario earlier, so an unfunded wallet no
  // longer reaches post() at all and can no longer exercise that specific 410 path.
  // describeArweavePostError() itself is unchanged; it stays responsible for surfacing
  // post()-level failures unrelated to balance (a genuinely malformed tx, a broadcast
  // rejected for some other reason) — this offline arlocal harness has no clean way to
  // construct one of those independent of a balance shortfall.
  log('pre-upload balance check refuses an unfunded wallet before signing/broadcasting');
  const brokeJwk = await ar.wallets.generate(); // never minted -> 0 balance
  const brokeWalletPath = join(tmp, 'broke-wallet.json');
  await writeFile(brokeWalletPath, JSON.stringify(brokeJwk), { mode: 0o600 });
  const brokePush = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'push', '--in', join(tmp, 'snap.age'), '--backend', 'arweave'],
    { env: { ...env, CYPHER_BRAIN_AR_WALLET: brokeWalletPath }, encoding: 'utf8' },
  );
  brokePush.status !== 0 &&
  /this upload needs/.test(brokePush.stderr) &&
  /only holds 0 winston/.test(brokePush.stderr) &&
  !/arweave post failed/.test(brokePush.stderr) // never reached the broadcast at all
    ? pass('an unfunded wallet is refused upfront by the balance check, before any broadcast attempt')
    : fail(
        `pre-upload balance check did not refuse as expected: status=${brokePush.status} stderr=${(brokePush.stderr || '').slice(0, 300)}`,
      );

  // push -> the locator is the Arweave tx id (assigned at upload, not the content hash)
  log('push --backend arweave');
  const loc = cb('push', '--in', join(tmp, 'snap.age'), '--backend', 'arweave');
  log(`pushed, tx=${loc}`);
  TX_RE.test(loc) ? pass(`push -> tx id ${loc} (43-char base64url)`) : fail(`locator is not a tx id: ${loc}`);
  loc !== cipherSha
    ? pass('locator is NOT the ciphertext content hash (post-assigned, not content-addressed)')
    : fail('locator equals the content hash — not the arweave case');

  log('mine');
  await mine(); // arlocal: confirm the pending tx

  // a fresh machine that only has the tx id (NO upload wallet) fetches the bytes back
  const pullEnv = { ...env };
  delete pullEnv.CYPHER_BRAIN_AR_WALLET;
  log('pull (no wallet)');
  const rp = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'pull', '--locator', loc, '--backend', 'arweave', '--out', join(tmp, 'got.age')],
    { env: pullEnv, encoding: 'utf8' },
  );
  rp.status === 0
    ? pass('pull works with only the tx id (no upload wallet needed)')
    : fail(`pull without wallet failed: ${rp.stderr}`);
  const got = await readFile(join(tmp, 'got.age'));
  sha(got) === cipherSha ? pass('pulled bytes == pushed ciphertext (byte-identical)') : fail('pulled bytes differ');

  // verify + decrypt the pulled ciphertext
  cb('verify', '--in', join(tmp, 'got.age')).includes('VERDICT: PASS')
    ? pass('verify VERDICT PASS on pulled')
    : fail('verify did not pass');
  cb('restore', '--in', join(tmp, 'got.age'), '--out-dir', join(tmp, 'out'));
  spawnSync('tar', ['-xzf', join(tmp, 'out', 'brain.tar.gz'), '-C', join(tmp, 'out')]);
  const restored = await readFile(join(tmp, 'out', 'brain', 'note.txt'), 'utf8');
  restored.includes(marker) ? pass('decrypt(pulled) == original plaintext') : fail('decrypted content mismatch');

  // #318: the SIGNED round trip, on this backend. push --sign parks a detached *.minisig
  // beside the ciphertext and records its locator in field 6 of the save-locator file;
  // pull is supposed to fetch it back so verify can check authenticity (#214). That was
  // only ever exercised on the `file` backend — every push in selftest-minisign.sh passes
  // --backend file — and on arweave it could not work at all: the gateway read promotes a
  // body only if it is age ciphertext, and a minisign sidecar is plaintext, so an intact
  // signature in storage was indistinguishable from a deleted one. The permanent,
  // un-deletable backend, where authenticity matters most, was the untested one.
  log('#318: push --sign parks a sidecar on arweave, and pull fetches it back');
  cb('keygen', '--sign');
  const signedSnap = join(tmp, 'signed.age');
  cb('snapshot', '--dir', src, '--out', signedSnap, '--sign');
  const signedLocFile = join(tmp, 'signed-loc.tsv');
  cb('push', '--in', signedSnap, '--backend', 'arweave', '--save-locator', signedLocFile);
  await mine();
  const signedFields = (await readFile(signedLocFile, 'utf8')).trim().split('\t');
  TX_RE.test(signedFields[5] ?? '')
    ? pass('push --sign recorded the sidecar locator (field 6) as its own tx id')
    : fail(`push --sign did not record a sidecar locator: ${JSON.stringify(signedFields)}`);

  const sigOut = join(tmp, 'signed-pulled.age');
  const sigPull = spawnSync('node', [...DEV_ARGS, BIN, 'pull', '--from-locator-file', signedLocFile, '--out', sigOut], {
    env: pullEnv,
    encoding: 'utf8',
  });
  sigPull.status === 0
    ? pass('pull --from-locator-file (signed) succeeded')
    : fail(`signed pull failed: ${sigPull.stderr}`);
  // The failure this test exists for: pull's sidecar step is best-effort, so before #318 it
  // WARNED and continued, leaving no .minisig and making verify report the artifact as
  // "unsigned (legacy)". A warning here means the sidecar still cannot be fetched.
  !/could not fetch the authenticity signature/.test(sigPull.stderr)
    ? pass('pull fetched the sidecar without falling back to its best-effort warning')
    : fail(`the sidecar still cannot be fetched from arweave: ${sigPull.stderr.slice(0, 300)}`);
  existsSync(`${sigOut}.minisig`)
    ? pass('the .minisig landed next to the pulled ciphertext')
    : fail('no .minisig on disk after a signed pull');
  const sigVerify = cb('verify', '--in', sigOut);
  /\[PASS\] minisign authenticity signature/.test(sigVerify)
    ? pass('verify CHECKED the authenticity signature on an arweave-pulled artifact')
    : fail(`verify did not check authenticity on the pulled artifact: ${sigVerify.slice(0, 400)}`);
  // The shape gate must still REFUSE a body that is neither. An unknown tx id would NOT
  // prove that — arlocal serves nothing for it, so the predicate never runs and deleting
  // isMinisig() entirely would still pass (multi-model review finding). Point the sidecar
  // locator at a REAL, mined tx whose body is junk, so the gateway answers HTTP 200 and the
  // predicate is what decides.
  const junkSidecarTx = await ar.createTransaction(
    { data: new TextEncoder().encode('not a minisign signature — issue #318 shape-gate test junk') },
    jwk,
  );
  await ar.transactions.sign(junkSidecarTx, jwk);
  await ar.transactions.post(junkSidecarTx);
  await mine();
  const fakeSidecar = [...signedFields];
  fakeSidecar[5] = junkSidecarTx.id;
  const fakeLocFile = join(tmp, 'fake-sidecar-loc.tsv');
  await writeFile(fakeLocFile, `${fakeSidecar.join('\t')}\n`);
  const fakeOut = join(tmp, 'fake-sidecar.age');
  const fakePull = spawnSync('node', [...DEV_ARGS, BIN, 'pull', '--from-locator-file', fakeLocFile, '--out', fakeOut], {
    env: pullEnv,
    encoding: 'utf8',
  });
  fakePull.status === 0 && !existsSync(`${fakeOut}.minisig`)
    ? pass('a served-but-wrong sidecar body is refused by the shape gate, and the pull still succeeds')
    : fail(`the shape gate did not refuse junk served as a sidecar: status=${fakePull.status}`);

  // The SAME must hold on the L1 chunk read, a second, separate call site for the
  // predicate: hard-coding isAgeCiphertext() there again would recreate the bug whenever
  // gateways are unavailable, and pass every assertion above (multi-model review finding).
  // Dead-end the gateway so only path 2 can serve.
  const l1SigOut = join(tmp, 'l1-signed.age');
  const l1Sig = spawnSync('node', [...DEV_ARGS, BIN, 'pull', '--from-locator-file', signedLocFile, '--out', l1SigOut], {
    env: { ...pullEnv, CYPHER_BRAIN_AR_GATEWAY: 'http://127.0.0.1:1' },
    encoding: 'utf8',
  });
  l1Sig.status === 0 && existsSync(`${l1SigOut}.minisig`)
    ? pass('L1 fallback: the sidecar is fetched through the chunk read too, not only the gateway')
    : fail(
        `the sidecar cannot be fetched via the L1 chunk read: status=${l1Sig.status} stderr=${(l1Sig.stderr || '').slice(0, 300)}`,
      );
  /\[PASS\] minisign authenticity signature/.test(cb('verify', '--in', l1SigOut))
    ? pass('L1 fallback: the chunk-read sidecar verifies against the signing key')
    : fail('the L1-fetched sidecar did not verify');

  // negative control: an unknown (but well-formed) tx id returns no bytes
  const badId = 'A'.repeat(43);
  const r = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'pull', '--locator', badId, '--backend', 'arweave', '--out', join(tmp, 'bad.age')],
    { env, encoding: 'utf8' },
  );
  r.status !== 0 ? pass('negative control: unknown tx id fails') : fail('unknown tx id unexpectedly succeeded');

  // guard: a malformed locator must be rejected BEFORE it is interpolated into the
  // gateway URL the get() HTTP read builds (path-traversal/SSRF guard)
  const bad2 = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'pull', '--locator', '../../etc/passwd', '--backend', 'arweave', '--out', join(tmp, 'bad2.age')],
    { env, encoding: 'utf8' },
  );
  bad2.status !== 0 && /invalid tx id/.test(bad2.stderr)
    ? pass('guard: malformed locator rejected (no SSRF/path-traversal)')
    : fail('malformed locator was not rejected by the id guard');

  // fallback coverage: point the gateway HTTP read (path 1) at a dead address and
  // assert the L1 chunk-read fallback (path 2 = getData) still serves the bytes.
  // Without this the fallback is never exercised — arlocal serves GET /{id}, so the
  // happy path above always wins on path 1.
  const fbEnv = { ...env, CYPHER_BRAIN_AR_GATEWAY: 'http://127.0.0.1:1' }; // connection refused → path 1 fails fast
  const fb = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'pull', '--locator', loc, '--backend', 'arweave', '--out', join(tmp, 'fb.age')],
    { env: fbEnv, encoding: 'utf8' },
  );
  fb.status === 0 && sha(await readFile(join(tmp, 'fb.age'))) === cipherSha
    ? pass('fallback: L1 chunk read serves when the gateway HTTP path is dead')
    : fail(`fallback path did not serve via getData: ${fb.stderr || 'bytes differ'}`);

  // L1 fallback safety (#115/#116/#117/#118): the chunk-read path (getData(), exercised
  // above via fbEnv) gets the SAME protections the gateway path already has — an
  // AGE_MAGIC gate, an atomic .part->rename (never a direct/truncating write to --out),
  // and a bounded timeout — plus a redirect-refusing fetch closing the SSRF gap that was
  // open only on this path. Each case dead-ends the gateway (path 1) via a
  // connection-refused address so ONLY the L1 chunk read (path 2) can be exercised.
  const l1Env = { ...env, CYPHER_BRAIN_AR_GATEWAY: 'http://127.0.0.1:1' };

  log('L1 fallback: AGE_MAGIC gate rejects non-ciphertext chunk data, preserving a prior --out');
  // a real, minable tx whose body is NOT age ciphertext — arlocal will genuinely serve
  // its chunks via getData(), so this exercises the AGE_MAGIC check itself, not "not found".
  const junkTx = await ar.createTransaction(
    { data: new TextEncoder().encode('not age ciphertext — issue #118 L1 test junk') },
    jwk,
  );
  await ar.transactions.sign(junkTx, jwk);
  await ar.transactions.post(junkTx);
  await mine();
  const l1AgeOut = join(tmp, 'l1-agemagic.age');
  const sentinel = `PRE-EXISTING-VALID-CONTENT-SENTINEL-${randomBytes(6).toString('hex')}`;
  await writeFile(l1AgeOut, sentinel); // a prior, valid --out that must survive a rejected L1 write
  const l1age = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'pull', '--locator', junkTx.id, '--backend', 'arweave', '--out', l1AgeOut],
    { env: l1Env, encoding: 'utf8' },
  );
  const l1AgeAfter = await readFile(l1AgeOut, 'utf8').catch(() => null);
  const l1AgePartLingers = await readFile(`${l1AgeOut}.part`, 'utf8')
    .then(() => true)
    .catch(() => false);
  l1age.status !== 0 && l1AgeAfter === sentinel && !l1AgePartLingers
    ? pass(
        'L1 fallback: non-ciphertext chunk data is rejected AND a pre-existing --out is left untouched (atomic .part->rename, no-clobber)',
      )
    : fail(
        `L1 AGE_MAGIC/atomic gate did not hold: status=${l1age.status} outUnchanged=${l1AgeAfter === sentinel} partLingers=${l1AgePartLingers} stderr=${(l1age.stderr || '').slice(0, 200)}`,
      );

  log('L1 fallback: a redirecting chunk-read host is refused, not silently followed (SSRF guard, #115)');
  const l1SsrfSrvFile = join(tmp, 'l1-ssrf-stub.mjs');
  await writeFile(
    l1SsrfSrvFile,
    "import {createServer} from 'node:http';\n" +
      "const s=createServer((_q,res)=>{res.writeHead(302,{location:'http://169.254.169.254/latest/meta-data/'});res.end();});\n" +
      "s.listen(0,'127.0.0.1',()=>console.log('READY:'+s.address().port));\n",
  );
  const l1SsrfSrv = spawn('node', [l1SsrfSrvFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  const l1SsrfPort = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('L1 ssrf stub did not start')), 8000);
    l1SsrfSrv.stdout.on('data', (d) => {
      const m = String(d).match(/READY:(\d+)/);
      if (m) {
        clearTimeout(to);
        res(m[1]);
      }
    });
  });
  const l1SsrfOut = join(tmp, 'l1-ssrf.age');
  const l1ssrf = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'pull', '--locator', loc, '--backend', 'arweave', '--out', l1SsrfOut],
    {
      env: {
        ...env,
        CYPHER_BRAIN_AR_GATEWAY: 'http://127.0.0.1:1',
        CYPHER_BRAIN_AR_HOST: '127.0.0.1',
        CYPHER_BRAIN_AR_PORT: l1SsrfPort,
        CYPHER_BRAIN_AR_PROTOCOL: 'http',
      },
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  let l1SsrfWrote = false;
  try {
    await readFile(l1SsrfOut);
    l1SsrfWrote = true;
  } catch {
    /* not written = good */
  }
  l1SsrfSrv.kill('SIGKILL');
  l1ssrf.status !== 0 && !l1SsrfWrote
    ? pass('L1 fallback: a redirect from the configured host is refused, never silently followed')
    : fail(`L1 SSRF redirect was not refused: status=${l1ssrf.status} wrote=${l1SsrfWrote}`);

  log('L1 fallback: a stalled chunk-read host is bounded by a timeout, not hung forever (#116)');
  const stallSrvFile = join(tmp, 'stall-stub.mjs');
  await writeFile(
    stallSrvFile,
    "import {createServer} from 'node:http';\n" +
      'const s=createServer((_q,_res)=>{ /* never respond — simulate a stalled L1 host */ });\n' +
      "s.listen(0,'127.0.0.1',()=>console.log('READY:'+s.address().port));\n",
  );
  const stallSrv = spawn('node', [stallSrvFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stallPort = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('stall stub did not start')), 8000);
    stallSrv.stdout.on('data', (d) => {
      const m = String(d).match(/READY:(\d+)/);
      if (m) {
        clearTimeout(to);
        res(m[1]);
      }
    });
  });
  const t0 = Date.now();
  const timeoutOut = join(tmp, 'l1-timeout.age');
  const l1to = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'pull', '--locator', loc, '--backend', 'arweave', '--out', timeoutOut],
    {
      env: {
        ...env,
        CYPHER_BRAIN_AR_GATEWAY: 'http://127.0.0.1:1',
        CYPHER_BRAIN_AR_HOST: '127.0.0.1',
        CYPHER_BRAIN_AR_PORT: stallPort,
        CYPHER_BRAIN_AR_PROTOCOL: 'http',
        CYPHER_BRAIN_AR_HTTP_TIMEOUT: '300', // short bound so the test stays fast
      },
      encoding: 'utf8',
      timeout: 15000, // hard safety net — must NOT be what actually stops this (that would mean the fix regressed)
    },
  );
  const elapsed = Date.now() - t0;
  stallSrv.kill('SIGKILL');
  l1to.status !== 0 && l1to.signal == null && elapsed < 8000
    ? pass(`L1 fallback: a stalled chunk-read host is bounded by the timeout, not a hang (${elapsed}ms)`)
    : fail(`L1 timeout did not bound the stall: status=${l1to.status} signal=${l1to.signal} elapsed=${elapsed}ms`);

  // --wait retry (#19): a not-yet-available id with a wait budget retries (then still
  // fails for a truly-missing id). A short retry interval keeps the test fast.
  const wEnv = { ...env, CYPHER_BRAIN_PULL_RETRY_MS: '150' };
  const w = spawnSync(
    'node',
    [
      ...DEV_ARGS,
      BIN,
      'pull',
      '--locator',
      'B'.repeat(43),
      '--backend',
      'arweave',
      '--out',
      join(tmp, 'w.age'),
      '--wait',
      '1',
    ],
    { env: wEnv, encoding: 'utf8' },
  );
  w.status !== 0 && /retrying/.test(w.stderr)
    ? pass('--wait retries while not retrievable, then fails for a truly-missing id')
    : fail(`--wait did not retry as expected: status=${w.status} stderr=${(w.stderr || '').slice(0, 160)}`);

  // CYPHER_BRAIN_PULL_RETRY_MS=0 (#108): a bare `Number(env) || 30000` treats the
  // numeric string "0" as falsy and silently substitutes the 30000ms default — the
  // regression this asserts against. With retryMs genuinely honored as 0, each retry's
  // naptime is `Math.min(0, remaining)` = 0, so a --wait budget fills with many attempts
  // back-to-back; with the bug, naptime is `Math.min(30000, remaining)` = remaining (the
  // whole budget), so only ONE retry ever fires. Count "pull attempt" lines in stderr —
  // far more than the ~2 the buggy 30000ms interval could produce in this budget proves
  // "0" was respected, not silently overridden.
  const zEnv = { ...env, CYPHER_BRAIN_PULL_RETRY_MS: '0' };
  const z = spawnSync(
    'node',
    [
      ...DEV_ARGS,
      BIN,
      'pull',
      '--locator',
      'D'.repeat(43),
      '--backend',
      'arweave',
      '--out',
      join(tmp, 'z.age'),
      '--wait',
      '3',
    ],
    { env: zEnv, encoding: 'utf8' },
  );
  const zAttempts = (z.stderr.match(/pull attempt/g) || []).length;
  z.status !== 0 && zAttempts >= 5
    ? pass(
        `CYPHER_BRAIN_PULL_RETRY_MS=0 is honored as an immediate retry (${zAttempts} attempts in a 3s --wait budget, not the ~2 a silently-defaulted 30000ms interval would allow)`,
      )
    : fail(
        `CYPHER_BRAIN_PULL_RETRY_MS=0 did not behave as an immediate retry: status=${z.status} attempts=${zAttempts} stderr=${(z.stderr || '').slice(0, 200)}`,
      );

  // multi-gateway (#21): the first gateway is dead, the second (arlocal) serves — the
  // read loop must move past the dead gateway to produce the bytes. AR_PORT=1 dead-ends
  // the L1 chunk fallback so ONLY gateway-2's HTTP read can satisfy this (otherwise the
  // chunk read would mask a loop that never advanced).
  const mgEnv = {
    ...env,
    CYPHER_BRAIN_AR_PORT: '1',
    CYPHER_BRAIN_AR_GATEWAYS: `http://127.0.0.1:1,http://localhost:${PORT}`,
  };
  const mg = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'pull', '--locator', loc, '--backend', 'arweave', '--out', join(tmp, 'mg.age')],
    { env: mgEnv, encoding: 'utf8' },
  );
  mg.status === 0 && sha(await readFile(join(tmp, 'mg.age'))) === cipherSha
    ? pass('multi-gateway: read falls through a dead gateway to a live one')
    : fail(`multi-gateway did not serve from the second gateway: ${mg.stderr || 'bytes differ'}`);

  // AGE_MAGIC gate (#29): a gateway that serves a non-ciphertext HTTP 200 (a soft-404
  // page / "tx pending" placeholder / CDN interstitial) must NOT be promoted to --out.
  // (1) bad-200 the ONLY gateway, L1 dead-ended (AR_PORT=1): pull must FAIL and leave
  //     no garbage at --out (the old code wrote the bad body and "succeeded").
  const badGw = createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>tx pending — not ciphertext</html>');
  });
  await new Promise((r) => badGw.listen(0, '127.0.0.1', r));
  const badPort = badGw.address().port;
  const bgOut = join(tmp, 'badgate.age');
  const bg = spawnSync('node', [...DEV_ARGS, BIN, 'pull', '--locator', loc, '--backend', 'arweave', '--out', bgOut], {
    env: { ...env, CYPHER_BRAIN_AR_PORT: '1', CYPHER_BRAIN_AR_GATEWAYS: `http://127.0.0.1:${badPort}` },
    encoding: 'utf8',
  });
  let bgWrote = false;
  try {
    await readFile(bgOut);
    bgWrote = true;
  } catch {
    /* not written = good */
  }
  bg.status !== 0 && !bgWrote
    ? pass('AGE_MAGIC gate: a non-ciphertext 200 is not promoted (pull fails, no garbage at --out)')
    : fail(`bad-200 body was promoted to --out (status=${bg.status}, wrote=${bgWrote})`);
  badGw.close();
  // (2) bad-200 first, healthy arlocal second: the read must FALL THROUGH to the good
  //     gateway and produce the real, byte-identical ciphertext.
  const badGw2 = createServer((_q, res) => {
    res.writeHead(200);
    res.end('not ciphertext');
  });
  await new Promise((r) => badGw2.listen(0, '127.0.0.1', r));
  const badPort2 = badGw2.address().port;
  const ft = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'pull', '--locator', loc, '--backend', 'arweave', '--out', join(tmp, 'ft.age')],
    {
      env: {
        ...env,
        CYPHER_BRAIN_AR_PORT: '1',
        CYPHER_BRAIN_AR_GATEWAYS: `http://127.0.0.1:${badPort2},http://localhost:${PORT}`,
      },
      encoding: 'utf8',
    },
  );
  ft.status === 0 && sha(await readFile(join(tmp, 'ft.age'))) === cipherSha
    ? pass('AGE_MAGIC gate: read falls through a non-ciphertext 200 to a healthy gateway')
    : fail(`did not fall through bad-200 to a healthy gateway: ${ft.stderr || 'bytes differ'}`);
  badGw2.close();

  // User-Agent header: arweave.net redirects a bundled-item read to a sandbox subdomain
  // that 403s a header-less request (node:http.get sends no default UA, unlike the fetch
  // this replaced — the real-world full-brain pull regressed silently). A SEPARATE-process
  // stub (spawnSync blocks an in-process server) serves the ciphertext ONLY when a
  // User-Agent is present, 403 otherwise; the pull must succeed → proves cypher-brain
  // sends a UA. (A header-less read would 403 → fail → no bytes.)
  const uaSrvFile = join(tmp, 'ua-stub.mjs');
  await writeFile(
    uaSrvFile,
    "import {createServer} from 'node:http'; import {readFileSync} from 'node:fs';\n" +
      'const f=process.argv[2];\n' +
      "const s=createServer((q,res)=>{ if(!q.headers['user-agent']){res.writeHead(403);res.end('<html>403</html>');return;} res.writeHead(200);res.end(readFileSync(f)); });\n" +
      "s.listen(0,'127.0.0.1',()=>console.log('READY:'+s.address().port));\n",
  );
  const uaSrv = spawn('node', [uaSrvFile, join(tmp, 'snap.age')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const uaPort = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('ua stub did not start')), 8000);
    uaSrv.stdout.on('data', (d) => {
      const m = String(d).match(/READY:(\d+)/);
      if (m) {
        clearTimeout(to);
        res(m[1]);
      }
    });
  });
  const ua = spawnSync(
    'node',
    [...DEV_ARGS, BIN, 'pull', '--locator', loc, '--backend', 'arweave', '--out', join(tmp, 'ua.age')],
    {
      env: { ...env, CYPHER_BRAIN_AR_PORT: '1', CYPHER_BRAIN_AR_GATEWAYS: `http://127.0.0.1:${uaPort}` },
      encoding: 'utf8',
    },
  );
  ua.status === 0 && sha(await readFile(join(tmp, 'ua.age'))) === cipherSha
    ? pass('User-Agent: the gateway read sends a UA (a UA-gated gateway serves the ciphertext)')
    : fail(
        `gateway read did not send a UA (UA-gated gateway 403'd): status=${ua.status} ${ua.stderr?.slice(0, 160) || 'bytes differ'}`,
      );
  uaSrv.kill('SIGKILL');

  // SSRF guard (#39): a gateway that 302-redirects to an internal/IMDS address must be
  // refused, not transparently followed. The stub runs in a SEPARATE process — the pull
  // below is spawnSync (blocking), so an in-process server could never answer it (the
  // same reason the nodeps mock is out-of-process). The redirect target comes from argv;
  // assert each pull (a) fails, (b) writes no --out, and (c) logs the SSRF refusal — i.e.
  // it never fetched the private/loopback target.
  const ssrfSrvFile = join(tmp, 'ssrf-stub.mjs');
  await writeFile(
    ssrfSrvFile,
    "import {createServer} from 'node:http';\n" +
      'const target=process.argv[2];\n' +
      'const s=createServer((q,res)=>{res.writeHead(302,{location:target});res.end();});\n' +
      "s.listen(0,'127.0.0.1',()=>console.log('READY:'+s.address().port));\n",
  );
  // Two redirect forms: the dotted IMDS literal, and the canonical HEX-QUAD IPv4-mapped
  // loopback `[::ffff:7f00:1]` (= 127.0.0.1) — the form that bypassed a dotted-only guard.
  const ssrfCases = [
    { target: 'http://169.254.169.254/latest/meta-data/', desc: 'a redirect to a link-local/IMDS address is refused' },
    {
      target: 'http://[::ffff:7f00:1]/latest/meta-data/',
      desc: 'a redirect to a hex-quad IPv4-mapped loopback ([::ffff:7f00:1]) is refused',
    },
  ];
  for (const c of ssrfCases) {
    const ssrfSrv = spawn('node', [ssrfSrvFile, c.target], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ssrfPort = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('ssrf stub did not start')), 8000);
      ssrfSrv.stdout.on('data', (d) => {
        const m = String(d).match(/READY:(\d+)/);
        if (m) {
          clearTimeout(to);
          res(m[1]);
        }
      });
    });
    const ssrfOut = join(tmp, `ssrf-${ssrfPort}.age`);
    const ss = spawnSync(
      'node',
      [...DEV_ARGS, BIN, 'pull', '--locator', loc, '--backend', 'arweave', '--out', ssrfOut],
      {
        env: { ...env, CYPHER_BRAIN_AR_PORT: '1', CYPHER_BRAIN_AR_GATEWAYS: `http://127.0.0.1:${ssrfPort}` },
        encoding: 'utf8',
      },
    );
    let ssrfWrote = false;
    try {
      await readFile(ssrfOut);
      ssrfWrote = true;
    } catch {
      /* not written = good */
    }
    ss.status !== 0 && !ssrfWrote && /SSRF guard|private\/loopback\/link-local/.test(ss.stderr)
      ? pass(`SSRF guard: ${c.desc}`)
      : fail(
          `SSRF redirect not refused (${c.target}; status=${ss.status}, wrote=${ssrfWrote}): ${(ss.stderr || '').slice(0, 200)}`,
        );
    ssrfSrv.kill('SIGKILL');
  }
} catch (e) {
  // Name the server's state in the failure: the #351 incident surfaced as a bare
  // "fetch failed" when the (orphaned) server vanished mid-test, and nothing said so.
  // #360 hardened this in three ways, each one a thing the measured transient failure
  // hid: (1) undici's "fetch failed" message is generic — the REAL network error
  // (ECONNREFUSED, ECONNRESET, a socket hangup) rides in e.cause, so print it;
  // (2) a not-exited server is now named explicitly, not left as the absence of the
  // exited-server suffix — a dead child and a transient socket error read identically
  // otherwise; (3) the stack goes to stderr, so WHICH fetch threw stops being an
  // inference from the last section banner. All e accesses are optional-chained: a
  // null/string throw must degrade the report, never replace it with a TypeError
  // (Codex review). The exited check consults arproc.exitCode/signalCode as well as
  // the 'exit' handler's arExit — a rejection can race the exit EVENT, and "had not
  // reported exit" is the honest claim, not "was still alive" (Codex review).
  const exited =
    arExit ??
    (arproc.exitCode !== null || arproc.signalCode !== null
      ? { code: arproc.exitCode, signal: arproc.signalCode }
      : null);
  const cause = e?.cause
    ? ` (cause: ${e.cause.code ? `${e.cause.code} — ` : ''}${e.cause.message ?? String(e.cause)})`
    : '';
  fail(
    `exception: ${e?.message ?? String(e)}${cause} (` +
      (exited !== null
        ? `the arlocal server process had exited before this exception was reported: code ${exited.code}, signal ${exited.signal}`
        : `the arlocal server process (pid ${arproc.pid}) had not reported exit when this exception was reported`) +
      ')',
  );
  console.error(e?.stack ?? String(e));
} finally {
  await rm(tmp, { recursive: true, force: true });
  arproc.kill('SIGTERM');
}

console.log('');
if (failed) {
  console.log('ARWEAVE ROUND-TRIP: FAIL');
  process.exit(1);
}
console.log('ARWEAVE ROUND-TRIP: PASS (abstraction holds for a post-assigned tx-id locator)');
