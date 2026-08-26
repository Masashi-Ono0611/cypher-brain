#!/usr/bin/env node
// OTel-lite opt-in (#226 part 3, src/lib/otel.ts) — positive controls proving the
// feature actually does what its own header comment claims, not just that it
// typechecks. Two things measured here were WRONG in the first draft and only
// surfaced by actually running two real processes against each other (a single
// spawnSync-based probe cannot catch either — spawnSync blocks the driver's own
// event loop for the child's whole lifetime, so a same-process HTTP receiver
// never gets to service a request until the child has already exited):
//
//   1. Without an explicit forceFlush() after each span, the CLI (a one-shot
//      process) exited before BatchSpanProcessor's own scheduled export timer
//      (5000ms, `.unref()`d by design so it never itself keeps a CLI process
//      alive) ever fired — spans were silently dropped 100% of the time. Fixed
//      by flushing after every span (src/lib/otel.ts's boundedFlush()).
//   2. Bounding that flush with an OUTSIDE `Promise.race` (withSpan() itself
//      returning early) did NOT bound the actual process lifetime: the SDK's
//      own internal request/export timers (10s / 30s defaults) are not
//      cancelled by losing a race external to them, and Node does not exit
//      while a referenced (non-`.unref()`d) timer/socket they own is still
//      pending. Fixed by passing the same short bound to the SDK's OWN
//      timeoutMillis/exportTimeoutMillis options instead, so it is the SDK's
//      own timer that fires early.
//
// check 3 (below) is the regression test for #2 specifically: a receiver that
// accepts the connection but never responds, run with a generous outer
// deadline — if otel.ts's own bound regresses back to an external-only race,
// this reintroduces the ~10s hang and the check's deadline catches it.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_ARGS } from './dev-node-flags.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'bin', 'cypher-brain.mjs');

let failed = false;
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => {
  console.log(`[FAIL] ${m}`);
  failed = true;
};

function isoHome() {
  return mkdtempSync(join(tmpdir(), 'cb-otel-selftest-'));
}

// Runs `cypher-brain doctor` (read-only, no setup required) as a real child process —
// spawn(), never spawnSync(): the receiver below lives in THIS process, and spawnSync
// would block this process's event loop for the child's entire lifetime, starving the
// receiver of the chance to service any request until after the child already exited
// (see header comment — the exact mistake the first draft of this test made).
function runDoctor(env, timeoutMs) {
  const home = isoHome();
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('node', [...DEV_ARGS, BIN, 'doctor'], {
      cwd: ROOT,
      env: { ...process.env, CYPHER_BRAIN_HOME: home, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(killer);
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - t0 });
    });
  });
}

// check 1: default off — no OTEL_EXPORTER_OTLP_ENDPOINT set. Must succeed exactly as
// it would with the feature absent entirely (this is the existing selftest suite's
// implicit coverage too — every OTHER selftest runs with this var unset — but an
// explicit, fast, isolated check here documents the contract directly).
{
  const r = await runDoctor({}, 15000);
  if (r.code !== 0) fail(`check 1 (default off): doctor exited ${r.code}: ${r.stderr.slice(0, 300)}`);
  else if (r.elapsedMs > 5000)
    fail(`check 1 (default off): took ${r.elapsedMs}ms — passthrough should be near-instant`);
  else pass(`check 1: OTEL_EXPORTER_OTLP_ENDPOINT unset is a fast passthrough (${r.elapsedMs}ms)`);
}

// check 2: endpoint set + reachable — the span must actually be exported, not merely
// constructed. A real local OTLP/HTTP receiver counts the requests it gets.
{
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/traces') requests++;
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const r = await runDoctor({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}/v1/traces` }, 15000);
  server.close();
  if (r.code !== 0) fail(`check 2 (reachable endpoint): doctor exited ${r.code}: ${r.stderr.slice(0, 300)}`);
  else if (requests !== 1)
    fail(`check 2 (reachable endpoint): receiver got ${requests} POST(s) to /v1/traces, expected exactly 1`);
  else pass(`check 2: a reachable OTEL_EXPORTER_OTLP_ENDPOINT actually receives the span before the process exits`);
}

// check 3: endpoint set + unreachable (accepts the connection, never responds) — must
// NOT hang. This is the regression test for the external-race mistake in the header
// comment: that version passed check 2 but took ~10s here (the exporter's own default
// request timeout), not the ~3s src/lib/otel.ts's FLUSH_TIMEOUT_MS documents. The
// 8000ms outer deadline is comfortably above FLUSH_TIMEOUT_MS (a fixed process-startup
// overhead + margin) and comfortably below the ~10s a regression would take.
{
  const server = createServer(() => {
    /* accept the connection, never write a response */
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const r = await runDoctor({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}/v1/traces` }, 8000);
  server.close();
  if (r.code === null)
    fail(`check 3 (unreachable endpoint): doctor did not exit within 8000ms — tracing is gating the command`);
  else if (r.code !== 0) fail(`check 3 (unreachable endpoint): doctor exited ${r.code}: ${r.stderr.slice(0, 300)}`);
  else if (r.elapsedMs > 6000)
    fail(
      `check 3 (unreachable endpoint): took ${r.elapsedMs}ms — should be bounded near FLUSH_TIMEOUT_MS (3000ms), not the SDK's own longer defaults`,
    );
  else pass(`check 3: an unreachable OTEL_EXPORTER_OTLP_ENDPOINT never gates the command (${r.elapsedMs}ms, bounded)`);
}

// check 4: endpoint set but the OpenTelemetry packages are absent — must warn once and
// fall back to a passthrough, exactly like a missing optional backend SDK elsewhere in
// this codebase (sdkImportAdvice(), reused as-is by otel.ts). Simulated the same way
// selftest-sdk-advice.mjs does: dist/cli.mjs is bundled with @opentelemetry/* left
// EXTERNAL (package.json optionalDependencies feeds scripts/build.ts's externals list
// generically — no otel-specific build change was needed), so copying just that one
// file into a directory with no node_modules at all reproduces "package genuinely not
// installed" without touching this checkout's own node_modules.
{
  const tmp = mkdtempSync(join(tmpdir(), 'cb-otel-selftest-nosdk-'));
  try {
    const isoBin = join(tmp, 'cli.mjs');
    const { copyFileSync } = await import('node:fs');
    const distCli = join(ROOT, 'dist', 'cli.mjs');
    try {
      copyFileSync(distCli, isoBin);
    } catch {
      fail('check 4 (packages absent): dist/cli.mjs not found — run `npm run build` first');
      throw new Error('skip');
    }
    const home = isoHome();
    const r = await new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn('node', [isoBin, 'doctor'], {
        cwd: tmp,
        env: { ...process.env, CYPHER_BRAIN_HOME: home, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/v1/traces' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c.toString()));
      child.stderr.on('data', (c) => (stderr += c.toString()));
      const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.on('exit', (code) => {
        clearTimeout(killer);
        rmSync(home, { recursive: true, force: true });
        resolve({ code, stdout, stderr, elapsedMs: Date.now() - t0 });
      });
    });
    // Asserts otel.ts's OWN wrapper message + fallback behavior, not sdkImportAdvice()'s
    // absent-vs-broken classification (that helper is general-purpose and already has
    // its own coverage — selftest-sdk-advice.mjs). Which of the two classifications
    // this machine's residual module resolution lands on is not the invariant under
    // test here: whichever it is, the command must still complete normally with a
    // clear advisory, never crash or hang.
    if (r.code !== 0) fail(`check 4 (packages absent): doctor exited ${r.code}: ${r.stderr.slice(0, 300)}`);
    else if (!/OTEL_EXPORTER_OTLP_ENDPOINT is set but the OpenTelemetry packages are not available/.test(r.stderr))
      fail(`check 4 (packages absent): missing the expected advisory on stderr: ${r.stderr.slice(0, 300)}`);
    else if (!/tracing disabled for this run, everything else proceeds normally/.test(r.stderr))
      fail(
        `check 4 (packages absent): advisory present but missing the "proceeds normally" reassurance: ${r.stderr.slice(0, 300)}`,
      );
    else pass('check 4: packages unavailable warns once with advice and still completes the command');
  } catch (e) {
    if (!(e instanceof Error && e.message === 'skip'))
      fail(`check 4 (packages absent): ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
