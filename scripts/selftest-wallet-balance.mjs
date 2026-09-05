#!/usr/bin/env node
// Proof for #345: `wallet balance` reports what an address can actually SPEND — its own
// Turbo Credit balance plus the Credit Share Approvals delegated to it — by querying
// CYPHER_BRAIN_AR_BALANCE_URL over plain HTTP, with NO @ardrive/turbo-sdk involved.
//
// Same isolation trick as selftest-usd-rate.mjs (#170) and selftest-arweave-nodeps.mjs
// (#31): run a COPY of the bundled dist/cli.mjs from a directory with no node_modules,
// so `import('@ardrive/turbo-sdk')` is genuinely unresolvable there. That is the whole
// point of the command — the address whose balance you most need to check during a
// top-up is the browser wallet this machine has no key for, and per #344 the SDK may not
// even be installable in a dependency-heavy checkout. Reading a balance must not depend
// on either. `--address` also means the `arweave` package is not needed to derive one.
//
// The negative cases matter as much as the happy path: a malformed address must be
// refused BEFORE any request goes out (asserted by counting requests the mock received),
// a hard failure (non-200, malformed winc) must FAIL rather than silently read as "no
// funds" — the opposite of arUsdRate()'s deliberate degrade-to-null — and the
// CYPHER_BRAIN_AR_PAID_BY warning must stay quiet when the approval IS reachable.
//
// Spawned ASYNC (spawn, not spawnSync) so this script's in-process http mocks keep
// answering while the CLI runs — spawnSync would block the event loop and starve them.
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
let failed = false;
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => {
  console.log(`[FAIL] ${m}`);
  failed = true;
};

const tmp = await mkdtemp(join(tmpdir(), 'cb-walletbal-'));

const ADDR = 'h1h8Z2iwzUAjydHhYaJAD3KgS2K1qshFIZmXtPIK830';
const PAYER = '0x1b2c2Fda8d1fA0c734E9F0EadEaddEaa7C14c865';
const RATE = 2.0;

try {
  // Isolated copy of the bundled CLI — a dir with NO node_modules.
  const isoDir = join(tmp, 'iso');
  await mkdir(isoDir, { recursive: true });
  const isoBin = join(isoDir, 'cli.mjs');
  await copyFile(join(ROOT, 'dist', 'cli.mjs'), isoBin).catch(() => {
    throw new Error('dist/cli.mjs not found — run `npm run build` first');
  });

  // control: without this, a leaked node_modules would make "works with no SDK" vacuous.
  const probe = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      "import('@ardrive/turbo-sdk').then(()=>process.exit(9)).catch(e=>process.exit(e&&e.code==='ERR_MODULE_NOT_FOUND'?0:9))",
    ],
    { cwd: isoDir, encoding: 'utf8' },
  );
  probe.status === 0
    ? pass('control: @ardrive/turbo-sdk is genuinely unresolvable from the isolated dir')
    : fail('control: @ardrive/turbo-sdk WAS resolvable — test is not isolating the dependency');

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
  const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;

  // rateHits proves the malformed-address case sends NOTHING anywhere — not just that it
  // skipped the balance service (Codex review round 2).
  let rateHits = 0;
  const rateServer = await startServer((_req, res) => {
    rateHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rate: RATE }));
  });

  // Turbo's credit price sheet (#343): USD is priced from THIS by preference (credits
  // are valued at what replacing them costs, not at AR spot). The mock's winc/usd pair
  // is chosen to derive rate 4.0 USD per 1e12 winc — deliberately DIFFERENT from the
  // AR-spot mock's 2.0, so which endpoint fed the USD line is visible in the amount
  // (on the 1e12-winc happy-path fixture: $4.00 = credit rate won, $2.00 = spot won).
  let turboRateHits = 0;
  let turboRatesUp = true;
  let turboRatesBody = { winc: '250000000000', fiat: { usd: 1.0 } };
  const turboRatesServer = await startServer((_req, res) => {
    turboRateHits++;
    if (!turboRatesUp) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(turboRatesBody));
  });

  // The balance mock: `body` decides what the next request answers, `hits` proves whether
  // a request happened at all (the malformed-address case asserts it did NOT), and
  // `lastQuery` proves the address actually arrived in the query string — without that,
  // "it returned a balance" would pass even if the CLI queried the wrong address, or
  // dropped it entirely and read someone else's account (Codex review).
  let body = null;
  let status = 200;
  let hits = 0;
  let lastQuery = null;
  const balServer = await startServer((req, res) => {
    hits++;
    lastQuery = new URL(req.url, 'http://127.0.0.1').searchParams;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });

  const run = (args, extraEnv = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn('node', [isoBin, 'wallet', 'balance', ...args], {
        env: {
          ...process.env,
          CYPHER_BRAIN_AR_BALANCE_URL: urlOf(balServer),
          CYPHER_BRAIN_AR_USD_RATE_URL: urlOf(rateServer),
          CYPHER_BRAIN_AR_TURBO_RATES_URL: urlOf(turboRatesServer),
          // Inherited values would otherwise leak into the PAID_BY assertions below.
          CYPHER_BRAIN_AR_PAID_BY: '',
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
        reject(new Error('wallet balance timed out'));
      }, 15000);
      child.on('close', (code) => {
        clearTimeout(to);
        resolve({ code, stdout, stderr });
      });
      child.on('error', reject);
    });

  // Deliberately ABOVE Number.MAX_SAFE_INTEGER (9007199254740991) and not round, so the
  // approved-minus-used arithmetic cannot survive being rewritten with Number: a float
  // would round these and the expected REMAINING string below would not match. Real winc
  // figures sit below 2^53 today, which is exactly why an accidental Number would go
  // unnoticed without a fixture that refuses to (Codex review).
  const BIG_APPROVED = '90071992547409910007';
  const BIG_USED = '90071992547409900003';
  const BIG_REMAINING = '10004'; // exact bigint difference
  const approval = (over = {}) => ({
    payingAddress: PAYER,
    approvedAddress: ADDR,
    approvedWincAmount: BIG_APPROVED,
    usedWincAmount: BIG_USED,
    expirationDate: new Date(Date.now() + 6 * 86400000).toISOString(),
    ...over,
  });
  const funded = (over = {}) => ({
    winc: '0',
    effectiveBalance: '1000000000000',
    receivedApprovals: [approval()],
    givenApprovals: [],
    ...over,
  });

  // 1. happy path — own vs spendable are DIFFERENT numbers, which is the entire point:
  // the signer holds nothing, yet a push can spend an approval's remaining winc.
  body = funded();
  status = 200;
  let r = await run(['--address', ADDR]);
  if (r.code !== 0) fail(`happy path exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (lastQuery?.get('address') !== ADDR)
    fail(`the queried address was not the one asked for: ${lastQuery?.get('address')}`);
  else if (!r.stdout.includes('own balance       : 0 winc')) fail(`own balance not reported: ${r.stdout}`);
  else if (!r.stdout.includes('spendable balance : 1000000000000 winc')) fail(`spendable not reported: ${r.stdout}`);
  else if (!r.stdout.includes('~$4.00 USD') || !r.stdout.includes('(Turbo credit rate)'))
    fail(`USD line not priced+labeled at Turbo's credit rate: ${r.stdout}`);
  else if (!r.stdout.includes(`from ${PAYER}`)) fail(`received approval not listed: ${r.stdout}`);
  else if (!r.stdout.includes(`remaining ${BIG_REMAINING} winc (of ${BIG_APPROVED} approved, ${BIG_USED} used)`))
    fail(`approval arithmetic not rendered exactly (bigint precision lost?): ${r.stdout}`);
  else pass('wallet balance: own vs spendable, USD, and the received approval all reported without the SDK (#345)');

  // 1b. the credit price sheet going down must DEGRADE to AR spot, visibly: same body,
  // same command, but the USD amount now derives from the spot mock (2.0), not the
  // credit mock (4.0). Proves the preference order in both directions with one pair.
  turboRatesUp = false;
  r = await run(['--address', ADDR]);
  turboRatesUp = true;
  if (r.code !== 0) fail(`spot-fallback run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (!r.stdout.includes('~$2.00 USD') || !r.stdout.includes('AR spot — credit price sheet unavailable'))
    fail(`with the credit price sheet down, USD did not fall back to LABELED AR spot: ${r.stdout}`);
  else
    pass('wallet balance: prices USD at the credit rate, falling back to labeled AR spot only when the sheet is down');

  // 1c. turboUsdRate() itself must refuse garbage rather than derive a misleading rate
  // (Codex review): malformed/zero winc, and winc past Number's integer precision, all
  // yield null (spot fallback); the well-formed sheet yields exactly the mocked rate.
  {
    const probe = (envUrl) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          'node',
          [
            '--experimental-strip-types',
            '--import',
            './scripts/dev-cli-loader.mjs',
            '-e',
            "import('./src/lib/estimate.ts').then(async (m) => console.log(JSON.stringify(await m.turboUsdRate())))",
          ],
          {
            cwd: ROOT,
            env: { ...process.env, CYPHER_BRAIN_AR_TURBO_RATES_URL: envUrl },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        const to = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('rate probe timed out'));
        }, 15000);
        child.on('close', () => {
          clearTimeout(to);
          resolve(out.trim().split('\n').pop());
        });
        child.on('error', reject);
      });
    const url = urlOf(turboRatesServer);
    const good = JSON.parse(await probe(url));
    if (good?.ratePer1e12Winc === 4 && good?.usdPerGiB === 1)
      pass('turboUsdRate: a well-formed sheet derives exactly the mocked rate (4.0 per 1e12 winc)');
    else fail(`turboUsdRate mis-derived the mocked sheet: ${JSON.stringify(good)}`);
    for (const [label, bodyCase] of [
      ['a malformed winc string', { winc: 'abc', fiat: { usd: 1.0 } }],
      ['a zero winc', { winc: '0', fiat: { usd: 1.0 } }],
      ['a winc past Number precision', { winc: '9007199254740993000', fiat: { usd: 1.0 } }],
      ['a missing fiat.usd', { winc: '250000000000', fiat: {} }],
      ['a non-number fiat.usd (boolean true)', { winc: '250000000000', fiat: { usd: true } }],
      ['a sheet whose derived rate overflows to Infinity', { winc: '1', fiat: { usd: 1e308 } }],
      ['a sheet whose derived rate underflows to 0', { winc: '9007199254740991', fiat: { usd: 5e-324 } }],
    ]) {
      turboRatesBody = bodyCase;
      const got = await probe(url);
      if (got === 'null') pass(`turboUsdRate: ${label} yields null, not a derived guess`);
      else fail(`turboUsdRate accepted ${label}: ${got}`);
    }
    turboRatesBody = { winc: '250000000000', fiat: { usd: 1.0 } };
  }

  // 2. the reachability warning — an approval a push cannot draw on because
  // CYPHER_BRAIN_AR_PAID_BY does not name its payer.
  if (!r.stderr.includes('CYPHER_BRAIN_AR_PAID_BY=<payer address>'))
    fail(`no warning when PAID_BY is unset despite a live approval: ${r.stdout}\n${r.stderr}`);
  else if (!r.stderr.includes('run summary — 1 warning(s)'))
    fail(`the end-of-run warning summary block (#347) is missing: ${r.stderr}`);
  else pass('wallet balance: warns (on stderr) about the unreachable approval AND repeats it in the run summary');

  // 2b. NEGATIVE control for the same warning: correctly configured must stay quiet.
  // Without this, a warning hard-coded to always fire would pass the check above.
  r = await run(['--address', ADDR], { CYPHER_BRAIN_AR_PAID_BY: PAYER });
  if (r.code !== 0) fail(`PAID_BY-set run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (r.stdout.includes('⚠') || r.stderr.includes('⚠'))
    fail(`warned even though PAID_BY names the payer: ${r.stdout}\n${r.stderr}`);
  else if (r.stderr.includes('run summary'))
    fail(`a warning-free run still printed the summary block (#347 negative control): ${r.stderr}`);
  else pass('wallet balance: no warning and NO summary block once PAID_BY names the payer (negative control)');

  // 2c. PAID_BY set to an address that shared nothing — a push would silently fall back
  // to the (empty) own balance, so this must be called out.
  r = await run(['--address', ADDR], { CYPHER_BRAIN_AR_PAID_BY: ADDR });
  if (r.code !== 0) fail(`PAID_BY-mismatch run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (!r.stderr.includes('matches no live approval'))
    fail(`no warning for a PAID_BY that shared nothing: ${r.stdout}\n${r.stderr}`);
  else pass('wallet balance: warns when PAID_BY matches no live approval');

  // 3. an EXPIRED approval must be labelled, not quietly counted as usable. The fixture
  // zeroes effectiveBalance too: an expired approval that still reported spendable credit
  // would be an incoherent state to assert against (Codex review).
  body = funded({
    effectiveBalance: '0',
    receivedApprovals: [approval({ expirationDate: new Date(Date.now() - 1000).toISOString() })],
  });
  r = await run(['--address', ADDR]);
  if (r.code !== 0) fail(`expired-approval run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (!r.stdout.includes('EXPIRED')) fail(`an expired approval was not flagged: ${r.stdout}`);
  else if (!r.stdout.includes('spendable balance : 0 winc'))
    fail(`expired credit was still reported as spendable: ${r.stdout}`);
  else if (r.stderr.includes('CYPHER_BRAIN_AR_PAID_BY=<payer address>'))
    fail(`nagged to set PAID_BY for an approval that has already expired: ${r.stderr}`);
  else pass('wallet balance: an expired approval is labelled EXPIRED, not counted as spendable, and skips the nudge');

  // 3b. an EXHAUSTED approval (live, but nothing left) must not be advertised either —
  // pointing at a drained approval and saying "set PAID_BY to spend this" is the same
  // false green light in a different disguise (Codex review).
  body = funded({
    effectiveBalance: '0',
    receivedApprovals: [approval({ usedWincAmount: BIG_APPROVED })],
  });
  r = await run(['--address', ADDR]);
  if (r.code !== 0) fail(`exhausted-approval run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (!r.stdout.includes('remaining 0 winc')) fail(`exhausted approval not shown as drained: ${r.stdout}`);
  else if (r.stderr.includes('CYPHER_BRAIN_AR_PAID_BY=<payer address>'))
    fail(`nudged to set PAID_BY for a fully consumed approval: ${r.stderr}`);
  else pass('wallet balance: a fully consumed approval is not advertised as reachable credit');

  // 3c. ...and it must not silence the mismatch warning either: PAID_BY naming a drained
  // approval still means the push falls back to the own balance.
  r = await run(['--address', ADDR], { CYPHER_BRAIN_AR_PAID_BY: PAYER });
  if (r.code !== 0) fail(`drained-approval mismatch run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (!r.stderr.includes('matches no live approval'))
    fail(`a drained approval silenced the PAID_BY mismatch warning: ${r.stdout}\n${r.stderr}`);
  else pass('wallet balance: a drained approval does not satisfy the PAID_BY reachability check');

  // 3d. an expiry we cannot READ must not be reported as good. "expired: false" alone
  // would let a garbage expirationDate read as "still valid" and get recommended
  // (Codex review round 2) — neither expired nor live is an honest answer for it.
  body = funded({ receivedApprovals: [approval({ expirationDate: 12345 })] });
  r = await run(['--address', ADDR]);
  if (r.code !== 0) fail(`unreadable-expiry run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (!r.stdout.includes('expiry UNKNOWN')) fail(`an unreadable expiry was not surfaced: ${r.stdout}`);
  else if (r.stderr.includes('CYPHER_BRAIN_AR_PAID_BY=<payer address>'))
    fail(`recommended an approval whose expiry could not be read: ${r.stderr}`);
  else pass('wallet balance: an unreadable expiry is shown as UNKNOWN and never recommended');

  // 3e. an ETH payer written in the other case is the SAME account — warning here would
  // be actively misleading, since the push would in fact work (Codex review round 2).
  body = funded();
  r = await run(['--address', ADDR], { CYPHER_BRAIN_AR_PAID_BY: PAYER.toLowerCase() });
  if (r.code !== 0) fail(`lowercase-payer run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (r.stderr.includes('matches no live approval'))
    fail(`a lowercase ETH payer was treated as a different account: ${r.stderr}`);
  else pass('wallet balance: an ETH payer matches case-insensitively (checksummed vs lowercase)');

  // 3f. NEGATIVE control for 3e: case folding must NOT leak to case-SENSITIVE chains, or
  // it would invent a match between two genuinely different Arweave accounts. This must
  // be a GENUINE case flip of ADDR (same address, different letter-casing) — flipping the
  // trailing character blindly is not that: ADDR ends in the digit '0', which the
  // 'O'-or-'o' ternary below turns into the letter 'O', producing an address that differs
  // from ADDR at the byte level regardless of case, so even unconditional lowercasing
  // would still (correctly, but for the wrong reason) call it a mismatch.
  const lastAlphaIndex = [...ADDR].map((_c, i) => i).findLast((i) => /[A-Za-z]/.test(ADDR[i]));
  if (lastAlphaIndex === undefined) throw new Error('ADDR fixture has no alphabetic character to case-flip');
  const flipped = ADDR[lastAlphaIndex] === ADDR[lastAlphaIndex].toUpperCase() ? 'toLowerCase' : 'toUpperCase';
  const arCaseVariant =
    ADDR.slice(0, lastAlphaIndex) + ADDR[lastAlphaIndex][flipped]() + ADDR.slice(lastAlphaIndex + 1);
  body = funded({ receivedApprovals: [approval({ payingAddress: arCaseVariant })] });
  r = await run(['--address', ADDR], { CYPHER_BRAIN_AR_PAID_BY: ADDR });
  if (r.code !== 0) fail(`arweave case-variant run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (!r.stderr.includes('matches no live approval'))
    fail(`two Arweave addresses differing only in case were treated as the same account: ${r.stdout}\n${r.stderr}`);
  else pass('wallet balance: case folding does not leak to case-sensitive (Arweave) addresses');

  // 3g. an INVALID CALENDAR DATE must not pass as a known expiry. Date.parse accepts
  // "2026-02-30" and silently rolls it to March 2 (measured) — a two-day drift in a
  // deadline the operator is deciding on, so the round-trip check must reject it.
  body = funded({ receivedApprovals: [approval({ expirationDate: '2026-02-30T00:00:00.000Z' })] });
  r = await run(['--address', ADDR]);
  if (r.code !== 0) fail(`invalid-calendar-date run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (!r.stdout.includes('expiry UNKNOWN'))
    fail(`an invalid calendar date silently passed as a real deadline: ${r.stdout}`);
  else pass('wallet balance: a rolled-over calendar date (2026-02-30) is UNKNOWN, not a silently shifted deadline');

  // 3h. NEGATIVE control for 3g: a genuinely valid ISO-8601 UTC timestamp must still be
  // accepted, or the round-trip check would have made every expiry UNKNOWN.
  body = funded();
  r = await run(['--address', ADDR]);
  if (r.stdout.includes('expiry UNKNOWN')) fail(`a valid ISO-8601 UTC expiry was rejected as unknown: ${r.stdout}`);
  else if (!r.stdout.includes('day(s)')) fail(`a valid expiry did not render its relative deadline: ${r.stdout}`);
  else pass('wallet balance: a valid ISO-8601 UTC expiry is still accepted (negative control)');

  // 4. --json: the full documented shape, with no key silently absent (#268's contract).
  body = funded();
  r = await run(['--address', ADDR, '--json']);
  if (r.code !== 0) fail(`--json run exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    /* reported below */
  }
  const KEYS = [
    'address',
    'own',
    'effective',
    'unit',
    'approx_ar',
    'usd_estimate',
    'usd_rate_source',
    'received_approvals',
    'given_approvals',
  ];
  if (!parsed) fail(`--json did not produce parseable JSON on stdout: ${r.stdout.slice(0, 200)}`);
  else {
    const missing = KEYS.filter((k) => !Object.hasOwn(parsed, k));
    if (missing.length) fail(`--json omitted documented key(s): ${missing.join(', ')}`);
    else if (parsed.effective !== '1000000000000') fail(`--json effective wrong: ${parsed.effective}`);
    else if (parsed.received_approvals[0]?.remaining !== BIG_REMAINING)
      fail(`--json approval remaining wrong (bigint precision lost?): ${JSON.stringify(parsed.received_approvals[0])}`);
    else if (parsed.received_approvals[0]?.expiry_known !== true)
      fail(`--json approval omitted/miscomputed expiry_known: ${JSON.stringify(parsed.received_approvals[0])}`);
    else if (parsed.usd_rate_source !== 'turbo-credit')
      fail(`--json did not carry the rate provenance (expected 'turbo-credit'): ${parsed.usd_rate_source}`);
    else pass('wallet balance --json: all nine documented keys present, winc strings intact, rate provenance carried');
  }

  // 5. a malformed address must be refused BEFORE any request leaves the process —
  // otherwise the shape check is decoration, not a guard against query injection. Both
  // outbound destinations are checked: the balance service AND the rate endpoint.
  const before = hits;
  const rateBefore = rateHits;
  const turboRateBefore = turboRateHits;
  r = await run(['--address', 'evil?&injected=1']);
  if (r.code === 0) fail('a malformed address exited 0');
  else if (hits !== before) fail(`a malformed address still hit the payment service (${hits - before} request(s))`);
  else if (rateHits !== rateBefore || turboRateHits !== turboRateBefore)
    fail(
      `a malformed address still hit a rate endpoint (spot +${rateHits - rateBefore}, credit +${turboRateHits - turboRateBefore})`,
    );
  else if (!r.stderr.includes('not a wallet address')) fail(`unexpected error for a malformed address: ${r.stderr}`);
  else pass('wallet balance: a malformed address is refused locally — nothing is sent to either endpoint');

  // 6. an address the service has never seen is a real answer — a fresh wallet — and
  // reads as zero, NOT as an error. Measured against the live service: that reply is
  // 404 with the body "User Not Found".
  status = 404;
  body = 'User Not Found';
  r = await run(['--address', ADDR]);
  if (r.code !== 0) fail(`a never-funded address exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (!r.stdout.includes('spendable balance : 0 winc')) fail(`"User Not Found" did not read as zero: ${r.stdout}`);
  else pass('wallet balance: a never-funded address ("User Not Found") reports zero and exits 0');

  // 6b. ...but a DIFFERENT 404 must not. The live service answers a mistyped/moved
  // endpoint with a bare 404 "Not Found" — the same status as above. Reading that as zero
  // would turn a wrong CYPHER_BRAIN_AR_BALANCE_URL into a confident "you have no funds"
  // on a spend-adjacent path, so only the recognized body gets the zero reading.
  body = 'Not Found';
  r = await run(['--address', ADDR]);
  if (r.code === 0) fail('a bare 404 (wrong endpoint) exited 0 — a missing endpoint must not read as a zero balance');
  else if (!r.stderr.includes('CYPHER_BRAIN_AR_BALANCE_URL'))
    fail(`the wrong-endpoint 404 did not point at the URL setting: ${r.stderr}`);
  else pass('wallet balance: a bare 404 (wrong endpoint) fails and names the URL setting, unlike "User Not Found"');

  // 7. a genuine service failure must FAIL. This is the deliberate difference from
  // arUsdRate()'s degrade-to-null: a silent null here would read as "no funds" (or, at a
  // spend gate, as "fine, proceed") — both wrong answers to "how much can I spend?".
  status = 500;
  body = 'boom';
  r = await run(['--address', ADDR]);
  if (r.code === 0) fail('a 500 from the payment service exited 0 — an unknown balance must not read as zero');
  else if (!r.stderr.includes('could not read')) fail(`unexpected error for a 500: ${r.stderr}`);
  else pass('wallet balance: a 500 fails loudly rather than degrading to a zero balance');

  // 8. a malformed winc field is the same class of hazard — refuse rather than guess.
  status = 200;
  body = { winc: 12345, effectiveBalance: '1' };
  r = await run(['--address', ADDR]);
  if (r.code === 0) fail('a non-string winc exited 0');
  else if (!r.stderr.includes('not a non-negative integer string')) fail(`unexpected error for bad winc: ${r.stderr}`);
  else pass('wallet balance: a malformed winc field is rejected, not coerced');

  // 9. approvals present in a shape we do not understand must fail rather than flatten to
  // "you have no approvals" — the same fail-open the winc check above refuses.
  body = { winc: '0', effectiveBalance: '0', receivedApprovals: { oops: true } };
  r = await run(['--address', ADDR]);
  if (r.code === 0) fail('a non-array receivedApprovals exited 0 — it would read as "no approvals"');
  else if (!r.stderr.includes('present but not an array')) fail(`unexpected error for bad approvals: ${r.stderr}`);
  else pass('wallet balance: a non-array approvals field is rejected, not silently emptied');

  // 9b. ...while an ABSENT approvals field is a legitimate lean response, not an error.
  body = { winc: '5', effectiveBalance: '5' };
  r = await run(['--address', ADDR]);
  if (r.code !== 0) fail(`a response with no approvals arrays exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (!r.stdout.includes('spendable balance : 5 winc')) fail(`lean response not rendered: ${r.stdout}`);
  else pass('wallet balance: an absent approvals field is treated as "none", not as an error (negative control)');

  // 10. a BALANCE_URL that already carries a query keeps it, and still gets ?address —
  // string concatenation would have produced a second "?" and a broken request.
  body = funded();
  const withQuery = `${urlOf(balServer)}/v1/balance?tenant=x`;
  r = await run(['--address', ADDR], { CYPHER_BRAIN_AR_BALANCE_URL: withQuery });
  if (r.code !== 0) fail(`a BALANCE_URL with an existing query exited ${r.code}: ${r.stderr.slice(0, 200)}`);
  else if (lastQuery?.get('tenant') !== 'x' || lastQuery?.get('address') !== ADDR)
    fail(`query params were mangled: tenant=${lastQuery?.get('tenant')} address=${lastQuery?.get('address')}`);
  else pass('wallet balance: an override URL with an existing query string is extended, not corrupted');

  for (const s of openedServers) s.close();
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(failed ? 'WALLET BALANCE SELFTEST: FAIL' : 'WALLET BALANCE SELFTEST: PASS');
process.exit(failed ? 1 : 0);
