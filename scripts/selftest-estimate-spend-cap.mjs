#!/usr/bin/env node
// Proof for #927: `estimate` never cross-checked its computed cost against a configured
// cumulative spend cap (CYPHER_BRAIN_MAX_SPEND_DAILY/_MONTHLY) — an operator could only
// discover the eventual push-time refusal by actually attempting the push. estimate.ts's
// estimateCost() now calls spend-budget.ts's read-only getSpendUsage() (the SAME
// aggregation reserveSpendBudget() itself folds from — see scripts/selftest-doctor.sh's
// (ad)-(ah) cases for the identical function exercised via `doctor`) and appends an
// INFORMATIONAL warning, both to `note`'s prose and to the machine-readable `warnings`
// array (#749's existing shape), when this upload would push cumulative spend over a
// configured cap. `estimate` must NEVER refuse — it is read-only/dry-run by design — so
// every case below also asserts the native cost/exit-0 success path is unaffected.
//
// Runs against the bundled dist/cli.mjs (matching selftest-usd-rate.mjs's technique)
// with --backend arweave and a mocked gateway /price endpoint (CYPHER_BRAIN_AR_HOST/
// PORT/PROTOCOL) — arweave and turbo share ONE admission-control family ('ar' in
// spend-budget.ts's familyFor()), so exercising the warning through the arweave price
// path proves the exact same code path a turbo estimate would take, without needing a
// live network call to Turbo's own pricing service.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist', 'cli.mjs');
let failed = false;
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => {
  console.log(`[FAIL] ${m}`);
  failed = true;
};

const tmp = await mkdtemp(join(tmpdir(), 'cb-estimate-spend-cap-'));
const sizedFile = join(tmp, 'payload.bin');
await writeFile(sizedFile, Buffer.alloc(1024, 1));

const MOCK_WINSTON = '1000'; // fixed, priced cost this whole file reasons about

const openedServers = [];
const startServer = (handler) =>
  new Promise((resolve, reject) => {
    const s = createServer(handler);
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      openedServers.push(s);
      resolve(s);
    });
  });

const priceServer = await startServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(MOCK_WINSTON);
});

// A receipt-ledger.jsonl fixture, written directly in the exact shape receipt.ts's
// appendReceipt() writes (ReceiptEntry) — this script runs the bundled CLI as a
// subprocess, so writing the file by hand (rather than importing receipt.ts, which would
// need the TS dev-loader) is the simplest way to seed "already spent X today" state.
async function seedReceipt(home, cost, backend = 'arweave', unit = 'winston') {
  const line = JSON.stringify({
    cypher_brain_receipt_version: 1,
    timestamp: new Date().toISOString(),
    backend,
    locator: `fixture-${backend}-${cost}`,
    artifact_sha256: 'a'.repeat(64),
    size_bytes: 100,
    payer_address: null,
    cost,
    unit,
    raw: {},
  });
  await writeFile(join(home, 'receipt-ledger.jsonl'), `${line}\n`);
}

function runEstimate(home, extraEnv, jsonMode) {
  return new Promise((resolve, reject) => {
    const args = ['estimate', '--in', sizedFile, '--backend', 'arweave'];
    if (jsonMode) args.push('--json');
    const child = spawn('node', [DIST, ...args], {
      env: {
        ...process.env,
        CYPHER_BRAIN_HOME: home,
        CYPHER_BRAIN_NO_CONFIG_FILE: '1',
        CYPHER_BRAIN_AR_HOST: '127.0.0.1',
        CYPHER_BRAIN_AR_PORT: String(priceServer.address().port),
        CYPHER_BRAIN_AR_PROTOCOL: 'http',
        CYPHER_BRAIN_AR_USD_RATE_URL: 'http://127.0.0.1:1', // connection-refused: no USD line, keeps output focused on cost/note/warnings
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const to = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('estimate timed out'));
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(to);
      resolve({ code, stdout, stderr });
    });
    child.on('error', reject);
  });
}

try {
  // (1) no caps configured at all -> no warning, plain text.
  {
    const home = join(tmp, 'no-caps');
    await mkdir(home);
    const r = await runEstimate(home, {});
    if (r.code !== 0) fail(`(1) exited non-zero with no caps configured: ${r.stderr.slice(0, 300)}`);
    else if (!r.stdout.includes(`cost: ${MOCK_WINSTON} winston`)) fail(`(1) missing the native cost line: ${r.stdout}`);
    else if (r.stdout.includes('⚠')) fail(`(1) unexpectedly warned with no caps configured: ${r.stdout}`);
    else pass('(1) no CYPHER_BRAIN_MAX_SPEND_DAILY/_MONTHLY configured: no warning, native cost estimate unaffected');
  }

  // (2) a daily cap configured but NOT exceeded (cap well above the cost) -> no warning.
  {
    const home = join(tmp, 'daily-under');
    await mkdir(home);
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND_DAILY: '1000000' });
    if (r.code !== 0) fail(`(2) exited non-zero with a daily cap well above cost: ${r.stderr.slice(0, 300)}`);
    else if (r.stdout.includes('⚠')) fail(`(2) unexpectedly warned when the daily cap is not exceeded: ${r.stdout}`);
    else pass('(2) a daily cap configured but far from exceeded: no warning');
  }

  // (3) a daily cap BELOW this upload's own cost -> warning appears, naming the exact
  // env var + configured value, in BOTH the human-readable note AND the exit code stays
  // 0 (estimate never refuses).
  {
    const home = join(tmp, 'daily-exceeded');
    await mkdir(home);
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND_DAILY: '500' });
    if (r.code !== 0) fail(`(3) estimate exited non-zero instead of warning: ${r.stderr.slice(0, 300)}`);
    else if (!r.stdout.includes(`cost: ${MOCK_WINSTON} winston`))
      fail(`(3) the native cost estimate broke when a cap is exceeded: ${r.stdout}`);
    else if (!r.stdout.includes('CYPHER_BRAIN_MAX_SPEND_DAILY=500'))
      fail(`(3) note did not name the exceeded env var + its configured value: ${r.stdout}`);
    else if (!r.stdout.includes('⚠')) fail(`(3) note did not carry the ⚠ warning marker: ${r.stdout}`);
    else
      pass(
        '(3) CYPHER_BRAIN_MAX_SPEND_DAILY=500 below the 1000-winston cost: note warns naming the exact env var + value, exit 0',
      );
  }

  // (4) same as (3), but the daily budget is ALREADY partly used by a prior receipt —
  // the warning must fire even though THIS upload alone would fit under the cap, since
  // spend-budget.ts's own admission check adds today's already-receipted spend first.
  {
    const home = join(tmp, 'daily-accumulated');
    await mkdir(home);
    await seedReceipt(home, '600'); // 600 already spent today
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND_DAILY: '1000' }); // 600 + 1000(this upload) > 1000 cap
    if (r.code !== 0) fail(`(4) estimate exited non-zero instead of warning: ${r.stderr.slice(0, 300)}`);
    else if (!r.stdout.includes('CYPHER_BRAIN_MAX_SPEND_DAILY=1000'))
      fail(`(4) note did not name the exceeded env var: ${r.stdout}`);
    else
      pass(
        "(4) today's already-receipted spend (600) plus this estimate (1000) exceeds the 1000 daily cap: warning fires",
      );
  }

  // (5) the inverse of (4): today's already-receipted spend alone is small enough that
  // 600(spent) + 1000(this upload) still fits comfortably UNDER a generous cap -> no
  // warning (proves the fixture from (4) is not just always-warn).
  {
    const home = join(tmp, 'daily-accumulated-under');
    await mkdir(home);
    await seedReceipt(home, '600');
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND_DAILY: '5000' });
    if (r.code !== 0) fail(`(5) exited non-zero: ${r.stderr.slice(0, 300)}`);
    else if (r.stdout.includes('⚠'))
      fail(`(5) unexpectedly warned when the accumulated total is still under the cap: ${r.stdout}`);
    else pass('(5) accumulated spend (600) + this estimate (1000) still under a 5000 daily cap: no warning');
  }

  // (6) a MONTHLY cap below cost -> warning names CYPHER_BRAIN_MAX_SPEND_MONTHLY, not
  // the daily var (proves the two windows are not conflated).
  {
    const home = join(tmp, 'monthly-exceeded');
    await mkdir(home);
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND_MONTHLY: '500' });
    if (r.code !== 0) fail(`(6) estimate exited non-zero instead of warning: ${r.stderr.slice(0, 300)}`);
    else if (!r.stdout.includes('CYPHER_BRAIN_MAX_SPEND_MONTHLY=500'))
      fail(`(6) note did not name the exceeded monthly env var: ${r.stdout}`);
    else if (r.stdout.includes('CYPHER_BRAIN_MAX_SPEND_DAILY='))
      fail(`(6) note incorrectly also named the (unconfigured) daily var: ${r.stdout}`);
    else pass('(6) CYPHER_BRAIN_MAX_SPEND_MONTHLY=500 below cost: warning names the MONTHLY var only');
  }

  // (7) --json shape: `warnings` carries the SAME message as a machine-readable array
  // entry (#749's existing contract), and every other documented key is still present.
  {
    const home = join(tmp, 'json-shape');
    await mkdir(home);
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND_DAILY: '500' }, true);
    if (r.code !== 0) {
      fail(`(7) --json estimate exited non-zero: ${r.stderr.slice(0, 300)}`);
    } else {
      let obj;
      try {
        obj = JSON.parse(r.stdout);
      } catch (e) {
        fail(`(7) --json output did not parse: ${e.message}: ${r.stdout}`);
        obj = null;
      }
      if (obj) {
        const want = ['backend', 'size_bytes', 'cost', 'unit', 'approx_ar', 'usd_estimate', 'note', 'warnings'];
        const missing = want.filter((k) => !(k in obj));
        if (missing.length) fail(`(7) --json is missing documented key(s): ${missing.join(',')}`);
        else if (!Array.isArray(obj.warnings))
          fail(`(7) --json warnings is not an array: ${JSON.stringify(obj.warnings)}`);
        else if (!obj.warnings.some((w) => typeof w === 'string' && w.includes('CYPHER_BRAIN_MAX_SPEND_DAILY=500')))
          fail(
            `(7) --json warnings does not carry the machine-readable spend-cap warning: ${JSON.stringify(obj.warnings)}`,
          );
        else if (!obj.note.includes('⚠'))
          fail(`(7) --json note did not also carry the same warning as human-readable prose: ${obj.note}`);
        else
          pass(
            '(7) --json: warnings carries the spend-cap warning as a machine-readable string, all documented keys present',
          );
      }
    }
  }

  // (8) --json, no caps configured -> warnings is an EMPTY array (not absent, not
  // containing a stray warning) — mirrors #749's own "warnings: [] when nothing to warn
  // about" contract for the pre-existing ton-provider bounty-floor warning.
  {
    const home = join(tmp, 'json-no-caps');
    await mkdir(home);
    const r = await runEstimate(home, {}, true);
    if (r.code !== 0) {
      fail(`(8) --json estimate exited non-zero: ${r.stderr.slice(0, 300)}`);
    } else {
      const obj = JSON.parse(r.stdout);
      if (!Array.isArray(obj.warnings) || obj.warnings.length !== 0)
        fail(`(8) expected an empty warnings array with no caps configured, got ${JSON.stringify(obj.warnings)}`);
      else pass('(8) --json: warnings is an empty array when no cumulative spend caps are configured');
    }
  }
} finally {
  priceServer.close();
  for (const s of openedServers) s.close();
  try {
    await rm(tmp, { recursive: true, force: true });
  } catch {}
}

console.log('');
if (failed) {
  console.log('ESTIMATE SPEND CAP: FAIL');
  process.exit(1);
}
console.log(
  'ESTIMATE SPEND CAP: PASS (#927 — estimate warns, never refuses, when a configured cumulative spend cap would be exceeded)',
);
