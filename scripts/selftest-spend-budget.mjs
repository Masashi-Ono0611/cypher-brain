#!/usr/bin/env node
// Offline admission proof (#907). Real push(), config, receipts, reservations and
// locking; only backend transport, display estimates and wallet lookup are mocked.
// Fresh processes isolate config. IPC barriers release two independent reservation
// callers together against ONE ledger; successful workers leave their intents open.
// The test is also run unchanged with the production cap comparison bypassed to
// prove both the fixture-cap refusals and the actual concurrent race detect it.
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const FLAGS = [
  '--experimental-strip-types',
  '--experimental-test-module-mocks',
  '--import',
  join(ROOT, 'scripts/dev-cli-loader.mjs'),
];
const scenario = process.env.CB_BUDGET_SCENARIO;

function child(env) {
  const proc = fork(SELF, [], { execArgv: FLAGS, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  proc.stdout.on('data', (data) => {
    output += data;
  });
  proc.stderr.on('data', (data) => {
    output += data;
  });
  const done = new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
  return { proc, done };
}

if (!scenario) {
  const scratch = await mkdtemp(join(tmpdir(), 'cb-spend-budget-'));
  let passed = 0;
  let failed = 0;
  const scenarios = [
    'daily-reached',
    'monthly-reached',
    'under-cap',
    'shared-ar',
    'separate-ton',
    'ton-cap',
    'zero-caps',
    'unset-caps',
    'unpriced-receipt',
    'malformed-log',
    'malformed-receipt',
    'past-receipts',
    'uncertain',
    'preflight-failure',
    'receipt-failure',
    'sidecar',
    'same-process-race',
    'cross-process-race',
    'crash-retention',
    'missing-upper-bound',
    'invalid-cap',
    'ton-no-spend',
    // #928: MONTHLY < DAILY must be refused — checked directly against config.ts's
    // own exports (see the 'order-' branch below), not through push(), since this
    // check gates cli.ts's main() dispatch rather than spend-budget.ts's admission.
    // Named so the scenario itself ends in '-refused' or '-ok' (matched below).
    'order-ar-refused',
    'order-ar-ok',
    'order-ar-daily-zero-skipped-ok',
    'order-ton-refused',
    'order-ton-ok',
  ];
  try {
    for (const name of scenarios) {
      const home = join(scratch, name);
      await mkdir(home);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(CYPHER|CIPHER)_BRAIN_/.test(key)),
      );
      Object.assign(env, {
        CB_BUDGET_SCENARIO: name,
        CYPHER_BRAIN_HOME: home,
        CYPHER_BRAIN_NO_CONFIG_FILE: '1',
        CYPHER_BRAIN_RECEIPT_LEDGER: join(home, 'receipts.jsonl'),
        CYPHER_BRAIN_MAX_SPEND: '60',
        CYPHER_BRAIN_MAX_SPEND_DAILY: '100',
        CYPHER_BRAIN_MAX_SPEND_MONTHLY: '1000',
        CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND: '60',
        CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND_DAILY: '100',
      });
      const result = await child(env).done;
      if (result.code === 0) {
        passed++;
        console.log(`[PASS] ${name}`);
      } else {
        failed++;
        console.log(`[FAIL] ${name}\n${result.output}`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  // #928: a malformed CYPHER_BRAIN_MAX_SPEND_DAILY must NOT block --help/--version
  // themselves (cli.ts's isHelpOrVersionRequest gate) — while a REAL command with
  // the same malformed value must still be refused, so this is a gate, not a
  // blanket skip of the validation. Drives the real CLI entry point
  // (bin/cypher-brain.mjs against source, the same dev-mode invocation
  // scripts/check-help-docs.mjs uses) rather than importing spend-budget.ts
  // directly, since the bug lives in cli.ts's main(), before dispatch.
  {
    const BIN = join(ROOT, 'bin', 'cypher-brain.mjs');
    const helpScratch = await mkdtemp(join(tmpdir(), 'cb-spend-budget-help-'));
    try {
      const home = join(helpScratch, 'home');
      await mkdir(home);
      const baseEnv = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CYPHER|CIPHER)_BRAIN_/.test(key))),
        CYPHER_BRAIN_HOME: home,
        CYPHER_BRAIN_NO_CONFIG_FILE: '1',
        CYPHER_BRAIN_MAX_SPEND_DAILY: 'abc', // malformed — must not parse as an integer
      };
      const runCli = (args) => spawnSync('node', [...FLAGS, BIN, ...args], { env: baseEnv, encoding: 'utf8' });
      const check = (name, ok, detail) => {
        if (ok) {
          passed++;
          console.log(`[PASS] ${name}`);
        } else {
          failed++;
          console.log(`[FAIL] ${name}${detail ? `\n${detail}` : ''}`);
        }
      };
      const bareHelp = runCli(['--help']);
      check(
        'order-help-not-blocked (bare --help)',
        bareHelp.status === 0 && bareHelp.stdout.includes('cypher-brain — encrypt a gbrain snapshot'),
        `status=${bareHelp.status}\nstdout=${bareHelp.stdout}\nstderr=${bareHelp.stderr}`,
      );
      const shortHelp = runCli(['-h']);
      check(
        'order-help-not-blocked (bare -h)',
        shortHelp.status === 0 && shortHelp.stdout.includes('cypher-brain — encrypt a gbrain snapshot'),
        `status=${shortHelp.status}\nstdout=${shortHelp.stdout}\nstderr=${shortHelp.stderr}`,
      );
      const subHelp = runCli(['push', '--help']);
      check(
        'order-help-not-blocked (push --help)',
        subHelp.status === 0 && subHelp.stdout.includes('cypher-brain push'),
        `status=${subHelp.status}\nstdout=${subHelp.stdout}\nstderr=${subHelp.stderr}`,
      );
      const version = runCli(['--version']);
      check(
        'order-help-not-blocked (--version)',
        version.status === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()),
        `status=${version.status}\nstdout=${version.stdout}\nstderr=${version.stderr}`,
      );
      const shortVersion = runCli(['-V']);
      check(
        'order-help-not-blocked (-V)',
        shortVersion.status === 0 && /^\d+\.\d+\.\d+/.test(shortVersion.stdout.trim()),
        `status=${shortVersion.status}\nstdout=${shortVersion.stdout}\nstderr=${shortVersion.stderr}`,
      );
      // Sanity: the SAME malformed value must still refuse a real command — this is
      // a gate on help/version specifically, not a blanket skip of the validation.
      const realCmd = runCli(['doctor']);
      check(
        'order-help-not-blocked (doctor still refused)',
        realCmd.status !== 0 && /CYPHER_BRAIN_MAX_SPEND_DAILY must be an integer/.test(realCmd.stderr),
        `status=${realCmd.status}\nstdout=${realCmd.stdout}\nstderr=${realCmd.stderr}`,
      );
    } finally {
      await rm(helpScratch, { recursive: true, force: true });
    }
  }

  console.log(`SPEND BUDGET SELFTEST: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} else {
  const ledger = process.env.CYPHER_BRAIN_RECEIPT_LEDGER;
  if (scenario === 'monthly-reached') {
    process.env.CYPHER_BRAIN_MAX_SPEND_DAILY = '0';
    process.env.CYPHER_BRAIN_MAX_SPEND_MONTHLY = '100';
  }
  if (scenario === 'zero-caps' || scenario === 'unset-caps') {
    for (const key of ['CYPHER_BRAIN_MAX_SPEND_DAILY', 'CYPHER_BRAIN_MAX_SPEND_MONTHLY']) {
      if (scenario === 'zero-caps') process.env[key] = '0';
      else delete process.env[key];
    }
    process.env.CYPHER_BRAIN_MAX_SPEND = '0';
  }
  if (scenario === 'missing-upper-bound') process.env.CYPHER_BRAIN_MAX_SPEND = '0';
  if (scenario === 'invalid-cap') process.env.CYPHER_BRAIN_MAX_SPEND_DAILY = '-1';
  // #928: the parent sets CYPHER_BRAIN_MAX_SPEND_DAILY=100 / _MONTHLY=1000 and
  // CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND_DAILY=100 (no TON _MONTHLY) for every
  // scenario; override MONTHLY (and DAILY, where the scenario needs it disabled)
  // per order- scenario so each exercises one specific point on the ordering check.
  if (scenario === 'order-ar-refused') process.env.CYPHER_BRAIN_MAX_SPEND_MONTHLY = '50'; // < DAILY=100
  if (scenario === 'order-ar-ok') process.env.CYPHER_BRAIN_MAX_SPEND_MONTHLY = '100'; // == DAILY=100, boundary must pass
  if (scenario === 'order-ar-daily-zero-skipped-ok') {
    process.env.CYPHER_BRAIN_MAX_SPEND_DAILY = '0'; // disabled side — not an ordering claim
    process.env.CYPHER_BRAIN_MAX_SPEND_MONTHLY = '1';
  }
  if (scenario === 'order-ton-refused') process.env.CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND_MONTHLY = '50'; // < DAILY=100
  if (scenario === 'order-ton-ok') process.env.CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND_MONTHLY = '200'; // > DAILY=100

  const budget = await import('../src/lib/spend-budget.ts');
  if (scenario.startsWith('order-')) {
    // Checked directly against config.ts's own exports rather than through push():
    // this ordering check gates cli.ts's main() dispatch (see cli.ts's
    // isHelpOrVersionRequest gate), it is not part of spend-budget.ts's admission
    // logic at all, so no backend/push mocking is needed here.
    const config = await import('../src/lib/config.ts');
    const err = scenario.includes('-ton') ? config.TON_PROVIDER_MAX_SPEND_ORDER_ERROR : config.AR_MAX_SPEND_ORDER_ERROR;
    if (scenario.endsWith('-refused')) {
      assert.ok(err, `${scenario}: expected an order error, got null`);
      assert.match(err.message, /is smaller than/);
    } else {
      assert.equal(err, null, `${scenario}: expected no order error, got: ${err?.message}`);
    }
  } else if (scenario === 'race-worker' || scenario === 'crash-worker') {
    if (scenario === 'race-worker') {
      const go = new Promise((resolve) => process.once('message', resolve));
      process.send({ ready: true });
      await go;
    }
    try {
      const reservation = await budget.reserveSpendBudget('turbo', 0n);
      process.send({ admitted: true, id: reservation.reservation_id });
    } catch (e) {
      process.send({ admitted: false, error: e.message });
    }
    process.disconnect();
  } else {
    const { mock } = await import('node:test');
    const { appendReceipt, readReceipts } = await import('../src/lib/receipt.ts');
    const { PushUncertainSpendError } = await import('../src/lib/push-uncertain-spend.ts');
    const { chargeSpendTracker } = await import('../src/lib/spend-tracker.ts');
    const home = process.env.CYPHER_BRAIN_HOME;
    const input = join(home, 'input.age');
    await writeFile(input, 'age-encryption.org/v1\nfixture ciphertext\n');
    const now = new Date();
    const old = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString();
    const fixture = async (cost, backend = 'turbo', timestamp = now.toISOString(), unit) =>
      appendReceipt({
        timestamp,
        backend,
        locator: `fixture-${backend}`,
        artifact_sha256: '',
        size_bytes: 1,
        payer_address: null,
        cost,
        unit: unit ?? (backend === 'arweave' ? 'winston' : backend === 'turbo' ? 'winc' : 'nanoTON'),
        raw: {},
      });
    if (['daily-reached', 'monthly-reached'].includes(scenario)) await fixture('100');
    if (scenario === 'under-cap') await fixture('10');
    if (scenario === 'shared-ar') await fixture('100', 'arweave');
    if (scenario === 'separate-ton') await fixture('10000', 'ton-provider');
    if (scenario === 'ton-cap') await fixture('100', 'ton-provider', now.toISOString(), 'nanoton');
    if (['zero-caps', 'unset-caps'].includes(scenario)) await fixture('100000');
    if (scenario === 'past-receipts') await fixture('100000', 'turbo', old);
    if (scenario === 'unpriced-receipt') await fixture(null);
    if (scenario === 'malformed-receipt') await writeFile(ledger, '{broken\n');
    if (scenario === 'malformed-log') await writeFile(budget.SPEND_BUDGET_LOG, '{broken\n');
    if (scenario === 'sidecar') await writeFile(`${input}.minisig`, 'fixture signature');

    let puts = 0;
    let entered;
    let unblock;
    const firstEntered = new Promise((r) => {
      entered = r;
    });
    const hold = new Promise((r) => {
      unblock = r;
    });
    const backendName = ['ton-cap', 'ton-no-spend'].includes(scenario) ? 'ton-provider' : 'turbo';
    const backend = {
      async put(_path, opts) {
        puts++;
        if (scenario === 'preflight-failure') throw new Error('fixture preflight refusal');
        if (scenario === 'ton-no-spend') return 'already-active';
        chargeSpendTracker(opts.spendTracker, 20n);
        if (scenario === 'uncertain')
          throw new PushUncertainSpendError({
            backend: 'turbo',
            checkKind: 'turbo_wallet_address',
            checkIdentifier: 'fixture-wallet',
            detail: 'response lost',
          });
        if (scenario === 'same-process-race' && puts === 1) {
          entered();
          await hold;
        }
        if (scenario === 'receipt-failure') await mkdir(ledger); // appendReceipt must fail after the paid action
        await opts.onReceipt({ locator: `uploaded-${puts}`, cost: { amount: '20', unit: 'winc' }, raw: {} });
        return `uploaded-${puts}`;
      },
    };
    // Mock only network/identity boundaries before importing real pushpull.ts.
    mock.module(new URL('../src/lib/backends/index.ts', import.meta.url).href, {
      namedExports: { backendFor: async () => backend },
    });
    const estimate = await import('../src/lib/estimate.ts');
    mock.module(new URL('../src/lib/estimate.ts', import.meta.url).href, {
      namedExports: {
        ...estimate,
        estimateCost: async () => ({ cost: '20', unit: 'winc' }),
        formatEstimate: () => ['fixture price'],
      },
    });
    const wallet = await import('../src/lib/wallet.ts');
    mock.module(new URL('../src/lib/wallet.ts', import.meta.url).href, {
      namedExports: { ...wallet, payerAddressFor: async () => null },
    });
    // Any accidental fetch is a test failure, never a real network call.
    globalThis.fetch = async () => {
      throw new Error('selftest forbids network');
    };
    const { push } = await import('../src/lib/pushpull.ts');
    const pushOnce = () => push({ in: input, backend: backendName, yes: true, dirs: [], tables: [], recipients: [] });
    const openReservations = async () =>
      (await budget.readBudgetReservations()).reservations.filter((r) => r.state === 'open');
    const refusals = {
      'daily-reached': /exceeds CYPHER_BRAIN_MAX_SPEND_DAILY=100/,
      'monthly-reached': /exceeds CYPHER_BRAIN_MAX_SPEND_MONTHLY=100/,
      'shared-ar': /exceeds CYPHER_BRAIN_MAX_SPEND_DAILY=100/,
      'ton-cap': /exceeds CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND_DAILY=100/,
      'unpriced-receipt': /cannot price receipt/,
      'malformed-log': /unreadable receipt\/reservation/,
      'malformed-receipt': /unreadable receipt\/reservation/,
      'missing-upper-bound': /requires a positive CYPHER_BRAIN_MAX_SPEND/,
      'invalid-cap': /must be a non-negative integer/,
    };
    if (refusals[scenario]) {
      await assert.rejects(pushOnce, refusals[scenario]);
      assert.equal(puts, 0, 'admission refusal must occur BEFORE backend.put');
    } else if (scenario === 'same-process-race') {
      const first = pushOnce();
      await firstEntered; // the real first reservation is durable, but no receipt exists
      try {
        await assert.rejects(pushOnce, /exceeds CYPHER_BRAIN_MAX_SPEND_DAILY=100/);
        assert.equal(puts, 1, 'only the winner can enter backend.put');
      } finally {
        unblock();
        await first;
      }
    } else if (scenario === 'cross-process-race' || scenario === 'crash-retention') {
      const workers = Array.from({ length: scenario === 'cross-process-race' ? 2 : 1 }, (_, index) => {
        // Different HOME values deliberately share one ledger: authority is ledger-scoped.
        const worker = child({
          ...process.env,
          CYPHER_BRAIN_HOME: join(home, `worker-${index}`),
          CB_BUDGET_SCENARIO: scenario === 'cross-process-race' ? 'race-worker' : 'crash-worker',
        });
        worker.ready = new Promise((resolve) =>
          worker.proc.on('message', (msg) => {
            if (msg.ready) resolve();
          }),
        );
        worker.result = new Promise((resolve) =>
          worker.proc.on('message', (msg) => {
            if ('admitted' in msg) resolve(msg);
          }),
        );
        return worker;
      });
      if (scenario === 'cross-process-race') {
        await Promise.all(workers.map((w) => w.ready));
        for (const worker of workers) worker.proc.send('go');
      }
      const results = await Promise.all(workers.map((w) => w.result));
      for (const worker of workers) assert.equal((await worker.done).code, 0);
      if (scenario === 'cross-process-race') {
        assert.equal(results.filter((r) => r.admitted).length, 1, 'two concurrent reservations MUST NOT both succeed');
        assert.match(results.find((r) => !r.admitted).error, /exceeds CYPHER_BRAIN_MAX_SPEND_DAILY=100/);
      } else {
        assert.equal(results[0].admitted, true);
        // Simulate the earlier process dying after durable intent, with no final line.
        // Move its timestamp to last month: unresolved spend must NEVER age out.
        const [record] = await openReservations();
        await writeFile(budget.SPEND_BUDGET_LOG, `${JSON.stringify({ ...record, timestamp: old })}\n`, { flag: 'a' });
        await assert.rejects(pushOnce, /exceeds CYPHER_BRAIN_MAX_SPEND_DAILY=100/);
        assert.equal(puts, 0);
      }
      assert.equal((await openReservations()).length, 1);
    } else if (scenario === 'uncertain') {
      await assert.rejects(pushOnce, PushUncertainSpendError);
      assert.equal((await openReservations()).length, 1);
      await assert.rejects(pushOnce, /exceeds CYPHER_BRAIN_MAX_SPEND_DAILY=100/);
      assert.equal(puts, 1);
    } else if (scenario === 'preflight-failure') {
      await assert.rejects(pushOnce, /fixture preflight refusal/);
      assert.equal((await openReservations()).length, 0);
      assert.equal((await budget.readBudgetReservations()).reservations[0].state, 'abandoned');
    } else if (scenario === 'receipt-failure') {
      assert.equal(await pushOnce(), true, 'a receipt write failure must not undo a paid success');
      assert.equal((await openReservations()).length, 1);
    } else {
      assert.equal(await pushOnce(), true);
      assert.equal(puts, scenario === 'sidecar' ? 2 : 1);
      assert.equal((await openReservations()).length, 0);
      if (scenario === 'under-cap' || scenario === 'sidecar') {
        const log = await budget.readBudgetReservations();
        assert.equal(log.reservations.length, puts);
        assert.ok(log.reservations.every((r) => r.state === 'settled'));
        assert.equal(log.reservations[0].amount, '60');
        if (scenario === 'sidecar') assert.equal(log.reservations[1].amount, '40');
        // A second push fits only if the old 60-unit reservation was reconciled
        // down to the actual 20-unit receipt, rather than remaining charged.
        if (scenario === 'under-cap') assert.equal(await pushOnce(), true);
        assert.ok((await readReceipts()).receipts.some((r) => r.cost === '20'));
      }
      if (['zero-caps', 'unset-caps'].includes(scenario)) {
        assert.equal(await readFile(budget.SPEND_BUDGET_LOG).catch(() => null), null);
      }
    }
    mock.restoreAll();
  }
}
