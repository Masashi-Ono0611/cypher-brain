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
//
// Later checks are regression tests for three follow-up dogfooding issues found
// after this feature first shipped (#420):
//   - check 2 / check 2b (#476): the exported span's resource.service.name must
//     default to 'cypher-brain', and OTEL_SERVICE_NAME must override it — both
//     verified against the ACTUAL received OTLP/JSON payload, not just that a
//     request arrived (checks the exporter defaults to JSON serialization,
//     asserted directly rather than assumed).
//   - check 3 / check 3b (#474): an unreachable collector must not just avoid
//     GATING the command (already covered by check 3's original deadline) but
//     must also leave a stderr diagnostic — before the fix, the exact same
//     scenario completed with byte-identical output to a healthy run, silently
//     eating ~20x the latency with no way to tell why. check 3b additionally
//     covers the connection-REFUSED case from the issue's own repro (nothing
//     listening at all), distinct from check 3's accepts-but-never-responds
//     case — the exporter's retry/backoff path only engages for the former.
//   - check 4 (#473): the advisory printed when the OTel packages are absent
//     must name the package that ACTUALLY failed to resolve (`@opentelemetry/api`,
//     the first import attempted) — before the fix, the advisory always claimed
//     `@opentelemetry/sdk-trace-node` was installed (a hardcoded package name),
//     which was false and pointed at the wrong remediation doc section.
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
//
// Base env deliberately DROPS this runner's own OTEL_EXPORTER_OTLP_ENDPOINT (Codex
// review, #226 part 3): a naive `{...process.env, ...env}` would let check 1's `{}`
// silently inherit whatever ambient value happens to be set (an operator's own shell,
// a CI runner with org-wide tracing exported) and stop testing the unset/default-off
// path at all — passing for the wrong reason. Callers that DO want it set pass it
// explicitly via `env`, which still wins (spread order).
function runDoctor(env, timeoutMs) {
  const home = isoHome();
  const { OTEL_EXPORTER_OTLP_ENDPOINT: _unused, ...baseEnv } = process.env;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('node', [...DEV_ARGS, BIN, 'doctor'], {
      cwd: ROOT,
      env: { ...baseEnv, CYPHER_BRAIN_HOME: home, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    // 'close', not 'exit' (Codex review, #226 part 3): 'exit' can fire before the
    // stdio pipes finish draining, so `stderr`/`stdout` above could still be missing
    // trailing data (e.g. check 4's warning line) at the moment this resolves — 'close'
    // fires only once every stdio stream is fully done.
    child.on('close', (code) => {
      clearTimeout(killer);
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - t0 });
    });
    // A failure to spawn `node` at all (e.g. PATH corruption) would otherwise leave this
    // Promise pending until `killer` fires (SIGKILL on a process that was never running,
    // a no-op), reporting a misleading "gating"/timeout failure instead of the real cause.
    child.on('error', (err) => {
      clearTimeout(killer);
      rmSync(home, { recursive: true, force: true });
      resolve({ code: 'SPAWN_ERROR', stdout, stderr: String(err), elapsedMs: Date.now() - t0 });
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
//
// OTEL_EXPORTER_OTLP_ENDPOINT is set to the BASE endpoint (no /v1/traces suffix)
// DELIBERATELY, not as a simplification — per the OTel spec this var is a base
// endpoint, and the exporter itself appends the per-signal path ('v1/traces')
// automatically. otel.ts's exporter construction passes no `url` option so that
// SDK-native env resolution does this (Codex review, #226 part 3: the first draft
// passed `url: endpoint` directly, which bypasses that resolution and would have
// posted to the wrong path for any base-endpoint value like this one — the original
// version of THIS test masked that bug by including /v1/traces in the env var
// itself). The receiver asserting exactly `/v1/traces` below is what actually proves
// the auto-append happened, not just that some request arrived.
// Starts a receiver that decodes each POST /v1/traces body as OTLP/JSON (the
// exporter's default serialization — asserted, not assumed: check 2 below fails
// loudly if a request arrives with a body that is not valid JSON) and hands each
// parsed payload to `onPayload`. Returns { server, port, requests, getPayloads }.
function startTraceReceiver(onPayload) {
  const payloads = [];
  let requests = 0;
  let parseError = null;
  const server = createServer((req, res) => {
    if (req.url !== '/v1/traces') {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(404);
        res.end();
      });
      return;
    }
    requests++;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        payloads.push(payload);
        onPayload?.(payload);
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e);
      }
      res.writeHead(200);
      res.end();
    });
  });
  return {
    server,
    getRequests: () => requests,
    getPayloads: () => payloads,
    getParseError: () => parseError,
  };
}

// Digs the resource attribute value keyed `key` out of an OTLP/JSON export
// payload's FIRST resourceSpans entry (this project only ever exports one
// resource per process — see otel.ts's single memoized provider).
function resourceAttr(payload, key) {
  const attrs = payload?.resourceSpans?.[0]?.resource?.attributes ?? [];
  return attrs.find((a) => a.key === key)?.value?.stringValue;
}

// check 2: endpoint set + reachable — the span must actually be exported, not merely
// constructed. A real local OTLP/HTTP receiver counts the requests it gets AND decodes
// the payload, so this also covers #476: the exported resource's service.name must
// default to 'cypher-brain' (measured pre-fix: 'unknown_service:bun', since otel.ts
// passed no `resource` at all and NodeTracerProvider's own fallback derives it from the
// running binary).
//
// OTEL_EXPORTER_OTLP_ENDPOINT is set to the BASE endpoint (no /v1/traces suffix)
// DELIBERATELY, not as a simplification — per the OTel spec this var is a base
// endpoint, and the exporter itself appends the per-signal path ('v1/traces')
// automatically. otel.ts's exporter construction passes no `url` option so that
// SDK-native env resolution does this (Codex review, #226 part 3: the first draft
// passed `url: endpoint` directly, which bypasses that resolution and would have
// posted to the wrong path for any base-endpoint value like this one — the original
// version of THIS test masked that bug by including /v1/traces in the env var
// itself). The receiver asserting exactly `/v1/traces` below is what actually proves
// the auto-append happened, not just that some request arrived.
{
  const receiver = startTraceReceiver();
  await new Promise((resolve) => receiver.server.listen(0, '127.0.0.1', resolve));
  const port = receiver.server.address().port;
  const r = await runDoctor({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` }, 15000);
  receiver.server.close();
  const serviceName = resourceAttr(receiver.getPayloads()[0], 'service.name');
  if (r.code !== 0) fail(`check 2 (reachable endpoint): doctor exited ${r.code}: ${r.stderr.slice(0, 300)}`);
  else if (receiver.getRequests() !== 1)
    fail(
      `check 2 (reachable endpoint): receiver got ${receiver.getRequests()} request(s) to exactly /v1/traces (auto-appended from a base endpoint), expected exactly 1`,
    );
  else if (receiver.getParseError())
    fail(`check 2 (reachable endpoint): request body was not valid OTLP/JSON: ${receiver.getParseError()}`);
  else if (serviceName !== 'cypher-brain')
    fail(
      `check 2 (reachable endpoint, #476): resource.attributes['service.name'] was ${JSON.stringify(serviceName)}, expected 'cypher-brain'`,
    );
  else
    pass(
      `check 2: a reachable base OTEL_EXPORTER_OTLP_ENDPOINT gets the /v1/traces path auto-appended, the span is received before the process exits, and its resource service.name defaults to 'cypher-brain'`,
    );
}

// check 2b (#476): OTEL_SERVICE_NAME, when set, overrides the 'cypher-brain' default —
// the SDK's own standard env-based resource detection, honored the same way any other
// OTel tool honors it (measured pre-fix: setting it made NO difference, resource
// attributes were byte-identical to check 2's — otel.ts wired no resource detection at
// all, so the env var was silently never read for this purpose).
{
  const receiver = startTraceReceiver();
  await new Promise((resolve) => receiver.server.listen(0, '127.0.0.1', resolve));
  const port = receiver.server.address().port;
  const r = await runDoctor(
    { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`, OTEL_SERVICE_NAME: 'cypher-brain-selftest' },
    15000,
  );
  receiver.server.close();
  const serviceName = resourceAttr(receiver.getPayloads()[0], 'service.name');
  if (r.code !== 0) fail(`check 2b (OTEL_SERVICE_NAME override): doctor exited ${r.code}: ${r.stderr.slice(0, 300)}`);
  else if (serviceName !== 'cypher-brain-selftest')
    fail(
      `check 2b (OTEL_SERVICE_NAME override, #476): resource.attributes['service.name'] was ${JSON.stringify(serviceName)}, expected the env var's value 'cypher-brain-selftest'`,
    );
  else pass(`check 2b: OTEL_SERVICE_NAME overrides the default resource service.name`);
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
  const r = await runDoctor({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` }, 8000);
  server.close();
  const DIAGNOSTIC = /exporting a span did not complete within/;
  if (r.code === null)
    fail(`check 3 (unreachable endpoint): doctor did not exit within 8000ms — tracing is gating the command`);
  else if (r.code !== 0) fail(`check 3 (unreachable endpoint): doctor exited ${r.code}: ${r.stderr.slice(0, 300)}`);
  else if (r.elapsedMs > 6000)
    fail(
      `check 3 (unreachable endpoint): took ${r.elapsedMs}ms — should be bounded near FLUSH_TIMEOUT_MS (3000ms), not the SDK's own longer defaults`,
    );
  else if (!DIAGNOSTIC.test(r.stderr))
    fail(
      `check 3 (unreachable endpoint, #474): completed within bound but printed no stderr diagnostic — a real ` +
        `dogfooding session would see this run mysteriously take ${r.elapsedMs}ms with no clue why: ${r.stderr.slice(0, 300)}`,
    );
  else
    pass(
      `check 3: an unreachable OTEL_EXPORTER_OTLP_ENDPOINT never gates the command (${r.elapsedMs}ms, bounded) and prints a stderr diagnostic`,
    );
}

// check 3b (#474 exact repro): endpoint set but NOTHING is listening (connection
// REFUSED immediately, distinct from check 3's accept-but-never-respond case) — the
// issue's own repro (`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319`, port closed).
// ECONNREFUSED is one of the exporter transport's own RETRYABLE network error codes
// (measured against this checkout's installed otlp-exporter-base), so this exercises
// the retry/backoff path check 3 does not: without otel.ts's timeoutMillis bound, the
// retrying transport's own defaults (5 attempts, up to 5000ms backoff each) could run
// well past a single command's normal lifetime. Grabbing then releasing a port is a
// best-effort way to get a "nothing listening" port cheaply (a TOCTOU window exists in
// principle, but 127.0.0.1-only + immediate reuse makes it fine for a Node.js port).
{
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const r = await runDoctor({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` }, 8000);
  const DIAGNOSTIC = /exporting a span did not complete within/;
  if (r.code === null)
    fail(`check 3b (connection refused): doctor did not exit within 8000ms — tracing is gating the command`);
  else if (r.code !== 0) fail(`check 3b (connection refused): doctor exited ${r.code}: ${r.stderr.slice(0, 300)}`);
  else if (r.elapsedMs > 6000)
    fail(
      `check 3b (connection refused): took ${r.elapsedMs}ms — should be bounded near FLUSH_TIMEOUT_MS (3000ms) ` +
        `even with the exporter's own ECONNREFUSED retry/backoff engaged`,
    );
  else if (!DIAGNOSTIC.test(r.stderr))
    fail(
      `check 3b (connection refused, #474): completed within bound but printed no stderr diagnostic: ${r.stderr.slice(0, 300)}`,
    );
  else
    pass(
      `check 3b: a refused connection (nothing listening, the issue's exact repro) never gates the command ` +
        `(${r.elapsedMs}ms, bounded) and prints a stderr diagnostic`,
    );
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
      // 'close', not 'exit' — see the comment on runDoctor()'s own child.on('close', ...)
      // above; this is the exact scenario it protects against (this check's whole
      // assertion is a stderr warning line, so a stderr race here is not hypothetical).
      child.on('close', (code) => {
        clearTimeout(killer);
        rmSync(home, { recursive: true, force: true });
        resolve({ code, stdout, stderr, elapsedMs: Date.now() - t0 });
      });
      child.on('error', (err) => {
        clearTimeout(killer);
        rmSync(home, { recursive: true, force: true });
        resolve({ code: 'SPAWN_ERROR', stdout, stderr: String(err), elapsedMs: Date.now() - t0 });
      });
    });
    // Asserts otel.ts's OWN wrapper message + fallback behavior, not sdkImportAdvice()'s
    // absent-vs-broken classification (that helper is general-purpose and already has
    // its own coverage — selftest-sdk-advice.mjs). Which of the two classifications
    // this machine's residual module resolution lands on is not the invariant under
    // test here: whichever it is, the command must still complete normally with a
    // clear advisory, never crash or hang.
    //
    // #473 regression check: this isolated dir has NO node_modules at all, so
    // '@opentelemetry/api' — the FIRST of the four imports getTracer() attempts — is
    // the one that actually fails to resolve. Before the fix, otel.ts always passed a
    // hardcoded '@opentelemetry/sdk-trace-node' to sdkImportAdvice() regardless of
    // which import threw, so this exact scenario produced the WRONG advisory (falsely
    // claiming sdk-trace-node was installed, sending an operator down the "broken
    // install" remediation instead of the simple "npm install @opentelemetry/api" the
    // situation actually calls for). The assertions below fail on either symptom of
    // that bug: the wrong package named, or the "installed but ... cannot be resolved"
    // phrasing sdkImportAdvice() only uses for its 'broken' (not 'absent') classification.
    if (r.code !== 0) fail(`check 4 (packages absent): doctor exited ${r.code}: ${r.stderr.slice(0, 300)}`);
    else if (!/OTEL_EXPORTER_OTLP_ENDPOINT is set but the OpenTelemetry packages are not available/.test(r.stderr))
      fail(`check 4 (packages absent): missing the expected advisory on stderr: ${r.stderr.slice(0, 300)}`);
    else if (!/tracing disabled for this run, everything else proceeds normally/.test(r.stderr))
      fail(
        `check 4 (packages absent): advisory present but missing the "proceeds normally" reassurance: ${r.stderr.slice(0, 300)}`,
      );
    else if (!/`@opentelemetry\/api` package is not installed — run: npm install @opentelemetry\/api/.test(r.stderr))
      fail(
        `check 4 (packages absent, #473 regression): advisory did not correctly name '@opentelemetry/api' as ` +
          `the absent package (the one that actually failed to import first) — this is exactly the pre-#473 ` +
          `misattribution bug if it recurs: ${r.stderr.slice(0, 400)}`,
      );
    else if (/sdk-trace-node/.test(r.stderr))
      fail(
        `check 4 (packages absent, #473 regression): advisory mentions 'sdk-trace-node' — this scenario's ` +
          `failing import is '@opentelemetry/api', so any mention of sdk-trace-node here means the old ` +
          `hardcoded-package-name bug is back: ${r.stderr.slice(0, 400)}`,
      );
    else
      pass(
        'check 4: packages unavailable warns once, correctly names @opentelemetry/api as the absent package, and still completes the command',
      );
  } catch (e) {
    if (!(e instanceof Error && e.message === 'skip'))
      fail(`check 4 (packages absent): ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
