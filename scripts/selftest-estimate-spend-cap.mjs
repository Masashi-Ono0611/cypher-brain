#!/usr/bin/env node
// Proof for #927: `estimate` never cross-checked its computed cost against a configured
// cumulative spend cap (CYPHER_BRAIN_MAX_SPEND_DAILY/_MONTHLY) — an operator could only
// discover the eventual push-time refusal by actually attempting the push. estimate.ts's
// estimateCost() now calls spend-budget.ts's read-only getSpendUsage() (the SAME
// fold/date-window logic reserveSpendBudget() itself uses — see scripts/selftest-doctor.sh's
// (ad)-(ah) cases for the identical function exercised via `doctor`) and appends an
// INFORMATIONAL warning, both to `note`'s prose and to the machine-readable `warnings`
// array (#749's existing shape), when a fresh push would push cumulative spend over a
// configured cap. `estimate` must NEVER refuse — it is read-only/dry-run by design — so
// every case below also asserts the native cost/exit-0 success path is unaffected.
//
// Codex review caught a real bug in an earlier draft: this compares against the
// CONFIGURED SINGLE-PUSH CAP (CYPHER_BRAIN_MAX_SPEND), not this estimate's own displayed
// cost — reserveSpendBudget() reserves that whole per-push cap for a fresh push (its
// own comment: "the earlier display estimate can go stale ... this can conservatively
// refuse a cheaper upload"), so checking the displayed cost instead would systematically
// UNDER-warn whenever the configured cap exceeds this particular upload's real price
// (the common case). Case (3) below is the exact regression: cap(1200) > cost(1000)
// triggers the warning even though cost(1000) alone would NOT have.
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

// Same reasoning as selftest-spend-budget.mjs's own scenario env (Codex review): strip
// any CYPHER_BRAIN_*/CIPHER_BRAIN_* the runner's own shell happens to carry BEFORE
// building each case's env, so "no caps configured" and the daily/monthly isolation
// cases are never accidentally influenced by whoever/wherever this script is run from.
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(CYPHER|CIPHER)_BRAIN_/.test(key)),
);

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
// `cost: null` (with `unit` left as a normally-valid value) seeds an UNPRICEABLE receipt
// — receipt.ts's own reader normalizes a non-string cost to null rather than rejecting
// the line, so this reaches spend-budget.ts's pricedReceipt() (which then throws) rather
// than being silently dropped as an unreadable JSONL line.
async function seedReceipt(home, cost, { backend = 'arweave', unit = 'winston' } = {}) {
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
        ...BASE_ENV,
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

  // (2) a daily cap configured, a VALID per-push cap, well UNDER the daily threshold ->
  // no warning.
  {
    const home = join(tmp, 'daily-under');
    await mkdir(home);
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND: '500', CYPHER_BRAIN_MAX_SPEND_DAILY: '1000000' });
    if (r.code !== 0)
      fail(`(2) exited non-zero with a per-push cap well under the daily cap: ${r.stderr.slice(0, 300)}`);
    else if (r.stdout.includes('⚠')) fail(`(2) unexpectedly warned when the per-push cap is not exceeded: ${r.stdout}`);
    else pass('(2) a per-push cap (500) far under a 1000000 daily cap: no warning');
  }

  // (3) THE REGRESSION CASE: a per-push cap (1200) that EXCEEDS the daily threshold
  // (1000) even though this estimate's OWN cost (1000, from MOCK_WINSTON) does NOT
  // exceed it — proves the warning is keyed on the per-push CAP a real push would
  // reserve, not on the displayed cost.
  {
    const home = join(tmp, 'cap-exceeds-daily');
    await mkdir(home);
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND: '1200', CYPHER_BRAIN_MAX_SPEND_DAILY: '1000' });
    if (r.code !== 0) fail(`(3) estimate exited non-zero instead of warning: ${r.stderr.slice(0, 300)}`);
    else if (!r.stdout.includes(`cost: ${MOCK_WINSTON} winston`))
      fail(`(3) the native cost estimate broke when a cap is exceeded: ${r.stdout}`);
    else if (!r.stdout.includes('CYPHER_BRAIN_MAX_SPEND_DAILY=1000'))
      fail(`(3) note did not name the exceeded env var + its configured value: ${r.stdout}`);
    else if (!r.stdout.includes('⚠')) fail(`(3) note did not carry the ⚠ warning marker: ${r.stdout}`);
    else
      pass(
        "(3) a per-push cap (1200) exceeding the 1000 daily cap warns even though this estimate's own cost (1000) alone would not have — proves the fix compares against the CAP, not the displayed cost",
      );
  }

  // (4) accumulated: today's already-receipted spend (600) PLUS a per-push cap (500)
  // together exceed the daily cap (1000) -> warns.
  {
    const home = join(tmp, 'daily-accumulated');
    await mkdir(home);
    await seedReceipt(home, '600'); // 600 already spent today
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND: '500', CYPHER_BRAIN_MAX_SPEND_DAILY: '1000' }); // 600 + 500(cap) > 1000
    if (r.code !== 0) fail(`(4) estimate exited non-zero instead of warning: ${r.stderr.slice(0, 300)}`);
    else if (!r.stdout.includes('CYPHER_BRAIN_MAX_SPEND_DAILY=1000'))
      fail(`(4) note did not name the exceeded env var: ${r.stdout}`);
    else
      pass(
        "(4) today's already-receipted spend (600) plus a 500 per-push cap exceeds the 1000 daily cap: warning fires",
      );
  }

  // (5) the inverse of (4): today's already-receipted spend (600) plus a SMALL per-push
  // cap (100) still fits comfortably under the daily cap (1000) -> no warning (proves
  // the fixture from (4) is not just always-warn).
  {
    const home = join(tmp, 'daily-accumulated-under');
    await mkdir(home);
    await seedReceipt(home, '600');
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND: '100', CYPHER_BRAIN_MAX_SPEND_DAILY: '1000' });
    if (r.code !== 0) fail(`(5) exited non-zero: ${r.stderr.slice(0, 300)}`);
    else if (r.stdout.includes('⚠'))
      fail(`(5) unexpectedly warned when the accumulated total is still under the cap: ${r.stdout}`);
    else pass('(5) accumulated spend (600) + a 100 per-push cap still under a 1000 daily cap: no warning');
  }

  // (6) a MONTHLY cap below the per-push cap -> warning names CYPHER_BRAIN_MAX_SPEND_MONTHLY,
  // not the daily var (proves the two windows are not conflated).
  {
    const home = join(tmp, 'monthly-exceeded');
    await mkdir(home);
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND: '600', CYPHER_BRAIN_MAX_SPEND_MONTHLY: '500' });
    if (r.code !== 0) fail(`(6) estimate exited non-zero instead of warning: ${r.stderr.slice(0, 300)}`);
    else if (!r.stdout.includes('CYPHER_BRAIN_MAX_SPEND_MONTHLY=500'))
      fail(`(6) note did not name the exceeded monthly env var: ${r.stdout}`);
    else if (r.stdout.includes('CYPHER_BRAIN_MAX_SPEND_DAILY='))
      fail(`(6) note incorrectly also named the (unconfigured) daily var: ${r.stdout}`);
    else pass('(6) a 600 per-push cap exceeding a 500 monthly cap: warning names the MONTHLY var only');
  }

  // (7) --json shape: `warnings` carries the SAME message as a machine-readable array
  // entry (#749's existing contract), and every other documented key is still present.
  {
    const home = join(tmp, 'json-shape');
    await mkdir(home);
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND: '1200', CYPHER_BRAIN_MAX_SPEND_DAILY: '1000' }, true);
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
        else if (!obj.warnings.some((w) => typeof w === 'string' && w.includes('CYPHER_BRAIN_MAX_SPEND_DAILY=1000')))
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

  // (9) #926 sibling: CYPHER_BRAIN_MAX_SPEND_DAILY set WITHOUT the required
  // CYPHER_BRAIN_MAX_SPEND — a real push would refuse outright (a DIFFERENT error than
  // "cap exceeded") before ever reaching a cost check. estimate warns about this too,
  // in the same words `doctor`'s spend-budget-cap-config check uses, rather than saying
  // nothing (the pre-fix behavior — and the literal #927 issue repro).
  {
    const home = join(tmp, 'missing-per-push-cap');
    await mkdir(home);
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND_DAILY: '1000' }); // no CYPHER_BRAIN_MAX_SPEND
    if (r.code !== 0) fail(`(9) estimate exited non-zero instead of warning: ${r.stderr.slice(0, 300)}`);
    else if (!r.stdout.includes('CYPHER_BRAIN_MAX_SPEND_DAILY'))
      fail(`(9) note did not name the daily var: ${r.stdout}`);
    else if (!r.stdout.includes('CYPHER_BRAIN_MAX_SPEND is not'))
      fail(`(9) note did not name the missing required per-push cap: ${r.stdout}`);
    else
      pass(
        '(9) CYPHER_BRAIN_MAX_SPEND_DAILY set without the required CYPHER_BRAIN_MAX_SPEND: estimate warns about the misconfiguration (a real push would refuse outright), never silently says nothing',
      );
  }

  // (10) degraded data: an unpriceable receipt (cost: null) in today's window, with a
  // per-push cap/daily cap chosen so the "exceeded" check on its own would NOT fire —
  // isolates the degraded-data warning from the exceeded-cap warning.
  {
    const home = join(tmp, 'degraded');
    await mkdir(home);
    await seedReceipt(home, null); // unpriceable — reaches pricedReceipt(), which throws
    const r = await runEstimate(home, { CYPHER_BRAIN_MAX_SPEND: '100000', CYPHER_BRAIN_MAX_SPEND_DAILY: '100000000' });
    if (r.code !== 0) fail(`(10) estimate exited non-zero instead of warning: ${r.stderr.slice(0, 300)}`);
    else if (!/UNDERCOUNT/.test(r.stdout)) fail(`(10) note did not warn about the undercount risk: ${r.stdout}`);
    else if (r.stdout.includes('would be refused'))
      fail(
        `(10) the exceeded-cap warning ALSO fired — the fixture did not isolate the degraded-only case: ${r.stdout}`,
      );
    else
      pass(
        '(10) an unpriceable receipt degrades the spend-budget read: estimate warns about the possible undercount, isolated from the exceeded-cap warning',
      );
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
  'ESTIMATE SPEND CAP: PASS (#927 — estimate warns, never refuses, when a fresh push would exceed a configured cumulative spend cap, is missing the cap it depends on, or has degraded spend-budget data)',
);
