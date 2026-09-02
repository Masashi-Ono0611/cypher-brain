#!/usr/bin/env node
// Proof for #232 — persist provider receipts + a cumulative cost ledger.
//
// Two halves, deliberately split by what they need:
//   Part A exercises src/lib/receipt.ts / src/lib/ledger.ts's pure aggregation math
//   directly against synthetic receipts (fast, no network, no wallet) — this is where
//   the day/month/backend grouping and unpriced-entry handling get real coverage.
//   Part B is a REAL arlocal push (no real AR, no network — same harness
//   scripts/arweave-roundtrip.mjs already established) proving the actual wiring: a
//   paid backend's put() really does call onReceipt with the real signed tx.reward,
//   pushpull.ts really does append it, and `cypher-brain ledger` really does read it
//   back correctly through the CLI, not just the library function.
import { mkdtemp, mkdir, writeFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { DEV_ARGS } from './dev-node-flags.mjs';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`[PASS] ${name}`);
  else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'bin', 'cypher-brain.mjs');

// ---------------------------------------------------------------------------
// Part A: summarizeLedger() / readReceipts() against synthetic data
// ---------------------------------------------------------------------------

const tmpA = await mkdtemp(join(tmpdir(), 'cb-receipt-unit-'));
try {
  // Set BEFORE importing receipt.ts/ledger.ts, and via a DYNAMIC import, not a static
  // one: config.ts computes HOME/RECEIPT_LEDGER as module-level consts at first import,
  // so setting process.env.CYPHER_BRAIN_HOME AFTER a static top-of-file `import` has
  // already pulled those modules in (import hoisting runs before any of the script's
  // own statements, regardless of source order) has NO effect — the real bug this
  // comment replaces: an earlier version of this script set the env var here but had
  // already statically imported these modules, so every appendReceipt() call silently
  // wrote into the REAL default $CYPHER_BRAIN_HOME (e.g. ~/.cypher-brain), not this
  // sandbox — caught only by noticing a real file appear outside any test tmp dir.
  process.env.CYPHER_BRAIN_HOME = tmpA;
  const { appendReceipt, readReceipts } = await import('../src/lib/receipt.ts');
  const { summarizeLedger } = await import('../src/lib/ledger.ts');
  const base = {
    cypher_brain_receipt_version: 1,
    artifact_sha256: 'a'.repeat(64),
    size_bytes: 1000,
    payer_address: 'payer1',
    raw: { ok: true },
  };

  await appendReceipt({
    ...base,
    timestamp: '2026-08-01T00:00:00.000Z',
    backend: 'arweave',
    locator: 'tx1',
    cost: '100',
    unit: 'winston',
  });
  await appendReceipt({
    ...base,
    timestamp: '2026-08-15T00:00:00.000Z',
    backend: 'arweave',
    locator: 'tx2',
    cost: '250',
    unit: 'winston',
  });
  await appendReceipt({
    ...base,
    timestamp: '2026-09-01T00:00:00.000Z',
    backend: 'turbo',
    locator: 'di1',
    cost: '999999999999',
    unit: 'winc',
  });
  // unpriced: cost/unit both null — must be counted but excluded from every sum
  await appendReceipt({
    ...base,
    timestamp: '2026-09-02T00:00:00.000Z',
    backend: 'turbo',
    locator: 'di2',
    cost: null,
    unit: null,
  });
  // undated: a REAL priced cost, but a timestamp that isn't the canonical
  // toISOString() shape appendReceipt() always produces (a hand-edited/foreign line) —
  // must be counted in by_backend (it has a real cost), excluded from by_day/by_month
  // (it cannot be safely bucketed), and counted as `undated_receipts`, NOT
  // `unpriced_receipts` (Codex review — the two were conflated before this fix).
  await appendReceipt({
    ...base,
    timestamp: '2026-08-20', // missing time-of-day — not ISO_UTC_PATTERN
    backend: 'arweave',
    locator: 'tx3',
    cost: '500',
    unit: 'winston',
  });
  // a raw malformed JSON line — must be skipped, not fatal
  const { RECEIPT_LEDGER } = await import('../src/lib/config.ts');
  await appendFile(RECEIPT_LEDGER, 'not json at all\n');
  // a well-formed-JSON but wrong-shape line (missing required fields) — also skipped
  await appendFile(RECEIPT_LEDGER, `${JSON.stringify({ cypher_brain_receipt_version: 1, backend: 'turbo' })}\n`);

  const { receipts, skippedLines } = await readReceipts();
  check(
    'readReceipts: 5 real entries survive, 2 malformed/wrong-shape lines are skipped',
    receipts.length === 5,
    `got ${receipts.length}`,
  );
  check('readReceipts: skippedLines counts exactly the 2 unreadable lines', skippedLines === 2, `got ${skippedLines}`);

  const summary = summarizeLedger(receipts);
  check(
    'summarizeLedger: total_receipts counts every survived line',
    summary.total_receipts === 5,
    JSON.stringify(summary),
  );
  check(
    'summarizeLedger: unpriced_receipts counts ONLY the null-cost entry (not the undated one)',
    summary.unpriced_receipts === 1,
    JSON.stringify(summary),
  );
  check(
    'summarizeLedger: undated_receipts counts the bad-timestamp entry, separate from unpriced_receipts',
    summary.undated_receipts === 1,
    JSON.stringify(summary),
  );
  check(
    'summarizeLedger: by_backend sums per unit, arweave = 100+250+500 winston (undated tx3 IS included — it has a real cost)',
    summary.by_backend.arweave?.count === 3 && summary.by_backend.arweave?.cost.winston === '850',
    JSON.stringify(summary.by_backend.arweave),
  );
  check(
    'summarizeLedger: by_backend turbo count includes the unpriced entry but its cost sum excludes it',
    summary.by_backend.turbo?.count === 2 && summary.by_backend.turbo?.cost.winc === '999999999999',
    JSON.stringify(summary.by_backend.turbo),
  );
  check(
    'summarizeLedger: by_month groups 2026-08 (two DATED arweave entries only, tx3 excluded) separately from 2026-09',
    summary.by_month['2026-08']?.winston === '350' && summary.by_month['2026-09']?.winc === '999999999999',
    JSON.stringify(summary.by_month),
  );
  check(
    'summarizeLedger: by_day keeps 2026-08-01 and 2026-08-15 as separate buckets, not merged into the month',
    summary.by_day['2026-08-01']?.winston === '100' && summary.by_day['2026-08-15']?.winston === '250',
    JSON.stringify(summary.by_day),
  );
  check(
    'summarizeLedger: the undated entry (tx3, cost 500) does not silently land in ANY by_day bucket',
    !Object.values(summary.by_day).some((d) => d.winston === '500' || d.winston === '850'),
    JSON.stringify(summary.by_day),
  );
  check(
    'summarizeLedger: winston and winc are never summed together',
    summary.by_backend.arweave?.cost.winc === undefined,
    JSON.stringify(summary.by_backend.arweave),
  );
} finally {
  delete process.env.CYPHER_BRAIN_HOME;
  await rm(tmpA, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part B: a REAL arlocal push -> a real receipt -> `cypher-brain ledger`
// ---------------------------------------------------------------------------

const Arweave = (await import('arweave')).default;
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
const PORT = await freePort();
const arlocal = spawn('node', [join(ROOT, 'scripts', 'arlocal-server.mjs'), String(PORT)], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
arlocal.stderr.setEncoding('utf8');
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('arlocal did not become ready in time')), 20000);
    arlocal.stderr.on('data', (d) => {
      if (String(d).includes(`arlocal listening on ${PORT}`)) {
        clearTimeout(t);
        resolve();
      }
    });
  });

  const tmp = await mkdtemp(join(tmpdir(), 'cb-receipt-e2e-'));
  try {
    const ar = Arweave.init({ host: 'localhost', port: PORT, protocol: 'http' });
    const jwk = await ar.wallets.generate();
    const addr = await ar.wallets.jwkToAddress(jwk);
    const walletPath = join(tmp, 'wallet.json');
    await writeFile(walletPath, JSON.stringify(jwk), { mode: 0o600 });
    await fetch(`http://localhost:${PORT}/mint/${addr}/100000000000000`);

    const env = {
      ...process.env,
      CYPHER_BRAIN_HOME: join(tmp, 'keys'),
      CYPHER_BRAIN_AR_HOST: 'localhost',
      CYPHER_BRAIN_AR_PORT: String(PORT),
      CYPHER_BRAIN_AR_PROTOCOL: 'http',
      CYPHER_BRAIN_AR_WALLET: walletPath,
      CYPHER_BRAIN_YES: '1',
    };
    const cb = (extraEnv, ...args) => {
      const r = spawnSync('node', [...DEV_ARGS, BIN, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
      return r;
    };
    const cbOk = (extraEnv, ...args) => {
      const r = cb(extraEnv, ...args);
      if (r.status !== 0) throw new Error(`cb ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
      return r.stdout.trim();
    };

    const src = join(tmp, 'brain');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'note.txt'), 'receipt selftest\n');
    cbOk({}, 'keygen');
    cbOk({}, 'snapshot', '--dir', src, '--out', join(tmp, 'snap.age'));

    // free backend: push, then confirm no receipt was written (nothing to persist)
    const fileEnv = { CYPHER_BRAIN_FILE_DIR: join(tmp, 'store') };
    const freePushLoc = cbOk(fileEnv, 'push', '--in', join(tmp, 'snap.age'), '--backend', 'file');
    check('file backend push succeeds', /^\S+$/.test(freePushLoc), freePushLoc);
    let ledgerEmptyAfterFreePush;
    try {
      ledgerEmptyAfterFreePush = (await readReceiptsAt(join(tmp, 'keys', 'receipt-ledger.jsonl'))).length === 0;
    } catch {
      ledgerEmptyAfterFreePush = true; // ledger file not created at all — also correct
    }
    check('file backend (free) push does NOT write a receipt', ledgerEmptyAfterFreePush);

    console.error('push --backend arweave...');
    const loc = cbOk({}, 'push', '--in', join(tmp, 'snap.age'), '--backend', 'arweave');

    const ledgerPath = join(tmp, 'keys', 'receipt-ledger.jsonl');
    const entries = await readReceiptsAt(ledgerPath);
    check('arweave push writes exactly one receipt', entries.length === 1, `got ${entries.length}`);
    const entry = entries[0];
    check('receipt backend field is arweave', entry.backend === 'arweave', entry.backend);
    check('receipt locator matches the tx id push printed', entry.locator === loc, `${entry.locator} vs ${loc}`);
    check('receipt unit is winston', entry.unit === 'winston', entry.unit);
    check('receipt cost is a plain non-negative integer string', /^\d+$/.test(entry.cost ?? ''), entry.cost);
    check(
      'receipt raw.tx_id matches the locator (raw response persisted, not reshaped away)',
      entry.raw?.tx_id === loc,
      JSON.stringify(entry.raw),
    );
    check(
      'receipt raw.reward equals the recorded cost (same authoritative tx.reward)',
      entry.raw?.reward === entry.cost,
      JSON.stringify(entry.raw),
    );
    check(
      'receipt payer_address matches the funded signer wallet',
      entry.payer_address === addr,
      `${entry.payer_address} vs ${addr}`,
    );

    const humanReport = cbOk({}, 'ledger');
    check(
      'ledger human report mentions the backend and cost',
      humanReport.includes('arweave') && humanReport.includes(entry.cost),
      humanReport,
    );

    const jsonReport = JSON.parse(cbOk({}, 'ledger', '--json'));
    check(
      'ledger --json total_receipts is 1',
      jsonReport.total_receipts === 1,
      JSON.stringify(jsonReport.total_receipts),
    );
    check(
      'ledger --json by_backend.arweave.cost.winston matches the receipt',
      jsonReport.by_backend?.arweave?.cost?.winston === entry.cost,
      JSON.stringify(jsonReport.by_backend),
    );

    const csvReport = cbOk({}, 'ledger', '--csv');
    check('ledger --csv includes the locator', csvReport.includes(loc), csvReport);

    // A SIGNED push to a paid backend is TWO separate uploads (ciphertext + .minisig
    // sidecar) — each its own charge, so the ledger must record TWO receipts, not one
    // (Codex review — the sidecar upload's cost was invisible to the ledger before this
    // fix, understating the true total for every signed arweave/turbo push).
    cbOk({}, 'keygen', '--sign');
    const signedSnap = join(tmp, 'signed-snap.age');
    // #832: NOT `--sign` (keygen's flag, never read by snapshot) — the keygen above is
    // what makes this snapshot a signed one.
    cbOk({}, 'snapshot', '--dir', src, '--out', signedSnap);
    console.error('push --backend arweave (signed)...');
    const signedLoc = cbOk({}, 'push', '--in', signedSnap, '--backend', 'arweave');
    const entriesAfterSignedPush = await readReceiptsAt(ledgerPath);
    check(
      'a signed push appends TWO receipts (ciphertext + .minisig sidecar), not one',
      entriesAfterSignedPush.length === entries.length + 2,
      `had ${entries.length}, now ${entriesAfterSignedPush.length}`,
    );
    const newEntries = entriesAfterSignedPush.slice(entries.length);
    const primaryReceipt = newEntries.find((e) => e.locator === signedLoc);
    const sidecarReceipt = newEntries.find((e) => e.locator !== signedLoc);
    check(
      'the primary artifact receipt locator matches what push printed',
      !!primaryReceipt,
      JSON.stringify(newEntries),
    );
    check(
      'the sidecar receipt has its OWN distinct locator and a real winston cost',
      !!sidecarReceipt && sidecarReceipt.locator !== signedLoc && /^\d+$/.test(sidecarReceipt.cost ?? ''),
      JSON.stringify(sidecarReceipt),
    );
    check(
      "the sidecar receipt raw.tx_id matches its own locator, not the primary artifact's",
      sidecarReceipt?.raw?.tx_id === sidecarReceipt?.locator,
      JSON.stringify(sidecarReceipt),
    );

    // receipt-write failure must not fail an already-successful (already-paid!) push:
    // point CYPHER_BRAIN_RECEIPT_LEDGER's directory AT an existing plain FILE, so
    // mkdir(dirname(...), {recursive:true}) fails with ENOTDIR — a portable way to
    // force a write failure without relying on chmod/permission semantics that differ
    // across CI runners (and can be a no-op when running as root).
    const blockerFile = join(tmp, 'not-a-directory');
    await writeFile(blockerFile, 'x');
    const blockedEnv = { CYPHER_BRAIN_RECEIPT_LEDGER: join(blockerFile, 'receipt-ledger.jsonl') };
    const blocked = cb(blockedEnv, 'push', '--in', join(tmp, 'snap.age'), '--backend', 'arweave');
    check(
      'push still succeeds (exit 0) when the receipt ledger cannot be written',
      blocked.status === 0,
      `status=${blocked.status} stderr=${blocked.stderr.slice(0, 300)}`,
    );
    check(
      'push warns about the receipt failure without treating it as a push failure',
      /could not persist the upload receipt/.test(blocked.stderr),
      blocked.stderr.slice(0, 300),
    );
    check(
      'the money-was-actually-spent locator still printed on stdout despite the receipt failure',
      /^[A-Za-z0-9_-]{43}$/.test(blocked.stdout.trim()),
      blocked.stdout,
    );

    console.log('== receipt/ledger selftest: end-to-end checks complete ==');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
} finally {
  arlocal.kill();
}

// ---------------------------------------------------------------------------
// Part C: #457 — `ledger`'s plain-text empty-state message must distinguish a
// GENUINELY empty ledger (no file / zero lines) from a ledger where every line
// exists but is unreadable (0 receipts survived readReceipts(), skippedLines > 0).
// Before this fix, both cases printed the IDENTICAL "no receipts yet" sentence —
// audit.ts already avoided this exact confusion for the equivalent scenario
// (total entries: 0 / unreadable lines skipped: N / VERDICT: FAIL vs a true-empty
// PASS with no skipped-lines line at all), so this proves ledger.ts now matches
// that precedent instead of reusing wording that undercuts the "never silently
// treated as no receipts" guarantee this CLI's own --help text documents.
// ---------------------------------------------------------------------------
const tmpC = await mkdtemp(join(tmpdir(), 'fix457458-ledger-emptystate-'));
try {
  const envC = { ...process.env, CYPHER_BRAIN_HOME: tmpC };
  delete envC.CYPHER_BRAIN_RECEIPT_LEDGER;
  const cbC = (...args) => spawnSync('node', [...DEV_ARGS, BIN, ...args], { env: envC, encoding: 'utf8' });

  // (a) truly empty: no ledger file exists at all yet — must print the ORIGINAL "no
  // receipts yet" sentence, unchanged (no regression from this fix).
  const trulyEmpty = cbC('ledger');
  check(
    '#457 no-regression: a genuinely empty ledger (no file) still prints the original "no receipts yet" message',
    trulyEmpty.status === 0 && trulyEmpty.stdout.includes('no receipts yet'),
    `status=${trulyEmpty.status} stdout=${trulyEmpty.stdout}`,
  );
  check(
    '#457 no-regression: a genuinely empty ledger warns nothing on stderr (no lines to skip)',
    trulyEmpty.stderr.trim() === '',
    trulyEmpty.stderr,
  );

  // (b) all-unreadable: the ledger FILE exists and has lines, but every single one is
  // garbage (malformed JSON or wrong-shape) — 0 receipts survive readReceipts(), but
  // skippedLines > 0. Must print a message VISIBLY DIFFERENT from (a)'s, naming the
  // skipped count, per the issue repro (a receipt-shaped line missing
  // cypher_brain_receipt_version, plus literal garbage, as the ONLY ledger content).
  const ledgerPathC = join(tmpC, 'receipt-ledger.jsonl');
  const garbageLines = [
    'not json at all — literal garbage',
    JSON.stringify({ cypher_brain_receipt_version: 2, backend: 'arweave' }), // wrong/future version
  ];
  await writeFile(ledgerPathC, `${garbageLines.join('\n')}\n`);
  const allGarbage = cbC('ledger');
  check(
    '#457 fix: an all-unreadable ledger (0 readable, 2 skipped) does NOT print the true-empty "no receipts yet" sentence',
    !allGarbage.stdout.includes('no receipts yet'),
    allGarbage.stdout,
  );
  check(
    '#457 fix: the all-unreadable message instead names the skipped count and says this is not necessarily empty',
    /\b2\b/.test(allGarbage.stdout) && /not necessarily an empty ledger/.test(allGarbage.stdout),
    allGarbage.stdout,
  );
  check(
    '#457: the all-unreadable case still warns on stderr with the skipped-line count (unchanged warn() behavior)',
    /2 line\(s\)/.test(allGarbage.stderr) && /could not be read/.test(allGarbage.stderr),
    allGarbage.stderr,
  );
  check(
    '#457: the two messages ((a) truly empty vs (b) all-unreadable) are genuinely DIFFERENT strings, not just different in the warning',
    trulyEmpty.stdout.trim() !== allGarbage.stdout.trim(),
    `(a)=${JSON.stringify(trulyEmpty.stdout)} (b)=${JSON.stringify(allGarbage.stdout)}`,
  );

  // --json must still be correct in this scenario (already was — this is a
  // no-regression check on the pre-existing, technically-correct --json data the
  // issue itself called out as fine).
  const allGarbageJson = JSON.parse(cbC('ledger', '--json').stdout);
  check(
    '#457: --json in the all-unreadable case reports total_receipts=0 and skipped_lines=2 (this part was already correct)',
    allGarbageJson.total_receipts === 0 && allGarbageJson.skipped_lines === 2,
    JSON.stringify(allGarbageJson),
  );
} finally {
  await rm(tmpC, { recursive: true, force: true });
}

async function readReceiptsAt(path) {
  const { readFile } = await import('node:fs/promises');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nRECEIPT/LEDGER SELFTEST: ALL PASS');
