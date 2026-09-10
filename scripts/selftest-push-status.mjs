#!/usr/bin/env node
// Offline proof for #905: real CLI/error handling with only fetch replaced. The
// bundled CLI is copied outside node_modules to exercise the no-SDK/no-wallet path.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const ID = 'a'.repeat(43);
const BASE = 'https://status-fixture.invalid/custom/tx';
const CONFIRMED = {
  status: 'CONFIRMED',
  bundleId: 'fixture-bundle',
  startOffsetInRootBundle: 42,
  payloadContentType: 'application/octet-stream',
  payloadDataStart: 50,
  info: 'fixture',
  winc: '123',
  extra: { preserved: true },
};

if (process.env.CB_PUSH_STATUS_FIXTURE) {
  // This file doubles as a --import preloader for each isolated CLI process.
  const fixture = JSON.parse(process.env.CB_PUSH_STATUS_FIXTURE);
  let calls = 0;
  const waitForAbort = (signal) =>
    new Promise((_resolve, reject) => {
      // AbortSignal.timeout is unref'd. Keep the mock I/O alive until it aborts,
      // just as an actual outstanding fetch would keep the process alive.
      const keepAlive = setInterval(() => {}, 1000);
      const abort = () => {
        clearInterval(keepAlive);
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), `${BASE}/${encodeURIComponent(fixture.locator ?? ID)}/status`);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers, undefined, 'public lookup must send no credentials');
    if (fixture.kind === 'network') throw new TypeError('fixture network unavailable');
    if (fixture.kind === 'timeout') return waitForAbort(options.signal);
    if (fixture.kind === 'body-timeout') {
      return { ok: true, status: 200, json: () => waitForAbort(options.signal) };
    }
    return new Response(fixture.body ?? JSON.stringify(CONFIRMED), {
      status: fixture.http ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  process.on('exit', () => assert.equal(calls, fixture.calls ?? 1, 'exactly one lookup; no polling or retries'));
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'cb-push-status-'));
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    try {
      fn();
      passed++;
      console.log(`[PASS] ${name}`);
    } catch (e) {
      failed++;
      console.error(`[FAIL] ${name}: ${e.message}`);
    }
  };
  try {
    const cli = join(scratch, 'cli.mjs');
    await copyFile(join(ROOT, 'dist/cli.mjs'), cli);
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(CYPHER|CIPHER)_BRAIN_|^OTEL_|^NODE_OPTIONS$|^CB_PUSH_STATUS_FIXTURE$/.test(key),
      ),
    );
    const run = (fixture = {}, args = ['--locator', ID, '--json'], library = false) => {
      const command = library
        ? [
            '--experimental-strip-types',
            '--import',
            join(ROOT, 'scripts/dev-cli-loader.mjs'),
            '--input-type=module',
            '-e',
            `const { checkTurboUploadStatus } = await import(${JSON.stringify(new URL('../src/lib/backends/turbo.ts', import.meta.url).href)}); console.log(JSON.stringify(await checkTurboUploadStatus(${JSON.stringify(fixture.locator ?? ID)})));`,
          ]
        : [cli, 'push-status', ...args];
      const result = spawnSync(process.execPath, ['--import', SELF, ...command], {
        cwd: scratch,
        env: {
          ...cleanEnv,
          CYPHER_BRAIN_HOME: join(scratch, 'unused-home'),
          CYPHER_BRAIN_NO_CONFIG_FILE: '1',
          CYPHER_BRAIN_TURBO_STATUS_URL: `${BASE}///`,
          CYPHER_BRAIN_AR_HTTP_TIMEOUT: '30',
          CB_PUSH_STATUS_FIXTURE: JSON.stringify(fixture),
        },
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      return result;
    };
    const success = (fixture, expected, library = false) => {
      const r = run(fixture, undefined, library);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), expected);
    };
    check('exported helper preserves the complete CONFIRMED response', () =>
      success({}, { found: true, status: 'CONFIRMED', raw: CONFIRMED }, true),
    );
    check('CLI --json exact success shape, without wallet or SDK', () =>
      success({}, { found: true, status: 'CONFIRMED', raw: CONFIRMED }),
    );
    check('unknown future status is preserved verbatim', () => {
      const raw = { status: ' Future_Status ', extra: [1, 2] };
      success({ body: JSON.stringify(raw) }, { found: true, status: raw.status, raw });
    });
    for (const library of [false, true]) {
      check(`${library ? 'helper' : 'CLI'} genuine 404 is only found:false, exit 0`, () =>
        success({ http: 404, body: JSON.stringify({ error: "TX doesn't exist" }) }, { found: false }, library),
      );
    }
    check('human output prints raw status and honest caveat', () => {
      const r = run({}, ['--locator', ID]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        r.stdout,
        "Turbo upload status: CONFIRMED\nThis is Turbo's own self-reported status, not independent Arweave-network confirmation.\n",
      );
    });
    check('another backend locator is tried as one encoded segment and can be not found', () => {
      const locator = 'remote:folder/item?x#y';
      const r = run({ locator, http: 404, body: JSON.stringify({ error: "TX doesn't exist" }) }, [
        '--locator',
        locator,
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /not found \(not found yet, or wrong id\)/);
      assert.match(r.stdout, /self-reported status, not independent Arweave-network confirmation/);
    });
    const failures = [
      ['network failure', { kind: 'network' }, /fixture network unavailable/],
      ['request timeout', { kind: 'timeout' }, /timeout/i],
      ['body timeout', { kind: 'body-timeout' }, /timeout/i],
      ['non-JSON body', { body: '<html>bad gateway</html>' }, /JSON/],
      ['truncated JSON', { body: '{"status":' }, /JSON/],
      ['null body', { body: 'null' }, /expected a JSON object/],
      ['array body', { body: '[]' }, /expected a JSON object/],
      ['missing status', { body: '{}' }, /status string/],
      ['numeric status', { body: '{"status":42}' }, /status string/],
      ['empty status', { body: '{"status":" "}' }, /status string/],
      ['unrelated JSON 404', { http: 404, body: '{"error":"route missing"}' }, /unexpected HTTP 404/],
      ['malformed error 404', { http: 404, body: '{"error":{"message":"TX doesn\'t exist"}}' }, /unexpected HTTP 404/],
      ['non-JSON 404', { http: 404, body: 'not found' }, /JSON/],
      ['rate limit', { http: 429 }, /HTTP 429/],
      ['server error', { http: 503 }, /HTTP 503/],
    ];
    for (const [name, fixture, message] of failures) {
      check(`${name} exits 1 with unknown/error, never found:false`, () => {
        const r = run(fixture);
        assert.equal(r.status, 1, r.stderr);
        const body = JSON.parse(r.stdout);
        assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'exit_code']);
        assert.equal(body.exit_code, 1);
        assert.match(body.error, /Turbo upload status lookup failed; status unknown:/);
        assert.match(body.error, message);
        assert.match(r.stderr, /^error: /);
        assert.doesNotMatch(r.stderr, /\n\s+at /);
      });
    }
    check('human lookup failure exits 1 without success output or stack trace', () => {
      const r = run({ kind: 'network' }, ['--locator', ID]);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /lookup failed; status unknown/);
      assert.doesNotMatch(r.stderr, /\n\s+at /);
    });
    for (const args of [
      ['--json'],
      ['--json', '--locator'],
      ['--json', '--locator', ''],
      ['--json', '--locator', '   '],
      ['--json', '--locator', '..'],
      ['--json', '--locator', ID, 'extra'],
      ['--json', '--locator', ID, '--backend', 'file'],
    ]) {
      check(`invalid invocation ${JSON.stringify(args)} exits 2 before fetch`, () => {
        const r = run({ calls: 0 }, args);
        assert.equal(r.status, 2, r.stderr);
        assert.equal(JSON.parse(r.stdout).exit_code, 2);
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`PUSH STATUS SELFTEST: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
