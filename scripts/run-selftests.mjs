#!/usr/bin/env node
// The selftest suite, run by a bounded worker pool instead of one `&&` chain (#607).
//
// THIS FILE IS THE ORDERED SOURCE OF TRUTH FOR WHAT `npm run verify` RUNS.
// A new `selftest:*` script is not in the suite until its name appears in PLAN below —
// package.json's per-test `selftest:*` scripts stay for running one test by hand, but the
// `&&` chain that used to live in `verify:suite` is gone. checkCoverage() below fails the
// run if package.json declares a `selftest*` script this list does not name, so a branch
// that adds a test and forgets this file fails at rebase rather than silently opting out.
//
// Shape, and why:
//   1. coverage guard (above) — cheap, so it runs before anything is built.
//   2. preflight, serially: build, typecheck, lint, check:help-docs. Everything after it
//      reads dist/ and src/, so none of it may overlap the build.
//   3. PARALLEL: a dynamic pool of `--jobs N` workers (default 3). Dynamic, not a static
//      split: the tests differ by more than 10x in length, so any fixed partition idles
//      workers at the end. On the first failure the pool STOPS SCHEDULING but still awaits
//      the children already running — killing them would lose their output, which is the
//      output most likely to explain a parallel-only failure.
//   4. EXCLUSIVE, serially, after the pool has fully drained. See the list for why each
//      one is there.
//
// Isolation: every test gets its own directory under the run's TMPDIR (the sandbox
// scripts/verify.mjs creates) as its own TMPDIR/TMP/TEMP. Empty afterwards -> removed;
// non-empty -> KEPT, and the test fails naming what it left. Keeping it is deliberate:
// verify.mjs's existing end-of-run inspection then reports that directory by name, so a
// leaked identity.age is attributed to the test that leaked it instead of to "the suite".
// (BSD `mktemp -d` without a template ignores TMPDIR, so the macOS bash tests' own dirs
// still land outside this tree — same blind spot verify.mjs already documents, unchanged.)
//
// Output: each test's stdout and stderr are buffered and printed as ONE block when it
// finishes, headed by its name and duration. Interleaved live output from three workers is
// unreadable, and worse, unattributable.
//
// Exit: 2 for a usage error; the failing child's own non-zero code (or 1) for a test or
// hygiene failure; and a signal is re-raised on ourselves rather than flattened to a code,
// the same way scripts/verify.mjs does it, so a Ctrl-C still looks like a Ctrl-C upstream.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmTest = (script) => ({ name: script, cmd: NPM, args: ['run', script] });

// ── the plan ───────────────────────────────────────────────────────────────────
//
// PARALLEL holds every test the shared-state audit for #607 cleared to run alongside
// others. What the audit checked, and what it found (2026-09-02, on the tree at the time):
//
//   - Listening ports: no test binds a fixed port. Both arlocal users pick a free one
//     (`freePort()` in scripts/arweave-roundtrip.mjs — CB_ARLOCAL_PORT only overrides it
//     for a human debugging by hand — and in scripts/selftest-receipt.mjs), the mock TON
//     seeder binds :0 (start_ton_seeder in scripts/selftest-lib.sh), and every other
//     listener in the tree is `listen(0, '127.0.0.1')`. So the two arlocal tests do NOT
//     collide and do not need an exclusive group.
//   - ~/Library/LaunchAgents: every schedule-touching test redirects it through
//     CYPHER_BRAIN_LAUNCHD_DIR into its own temp tree (selftest-schedule.sh,
//     selftest-config-file.sh, mcp-smoke.mjs). Confirmed by grep: there is no write to the
//     real directory anywhere in scripts/.
//   - CYPHER_BRAIN_HOME: every test that runs the CLI sets its own, under its own temp
//     dir. The ones that set none (selftest-ans104-sizing, -cctv-age, -error-codes,
//     -import-quietly, -progress, -turbo-dep) are in-process unit tests that spawn nothing
//     and write nothing.
//   - Writes outside the temp tree: only selftest-help-docs.sh — see EXCLUSIVE.
//   - Tracked files: same one. mcp-smoke.mjs names $ROOT/never-written.age, but as the
//     path a refusal must NOT create; nothing writes it.
//
// cli-smoke.sh and mcp-smoke.mjs were tail commands of the old chain rather than npm
// scripts; they are in the pool because the audit clears them too — both build their own
// temp CYPHER_BRAIN_HOME, cli-smoke.sh's `mktemp -d "${TMPDIR:-/tmp}/cb-smoke-XXXXXX"`
// takes the per-test TMPDIR, mcp-smoke.mjs sets an isolated TMPDIR for the server it
// spawns, and both only READ dist/ and src/. mcp-smoke.mjs is also the longest single test
// in the suite, so leaving it serialized at the end would have capped the whole win.
//
// Anything doubtful goes in EXCLUSIVE, not here. The bar for this list is a positive
// finding that a test is self-contained, not the absence of a reason to suspect it.
const PARALLEL = [
  // LONGEST FIRST. A dynamic pool cannot recover from starting its longest test last, and
  // this suite is dominated by one test: `selftest:arweave` alone was 138s of a 174s run
  // measured locally at --jobs 3, so it sets the floor and everything else has to fit
  // around it. The order is a scheduling hint only — correctness does not depend on it, and
  // a new test can go anywhere (near its own weight, ideally).
  npmTest('selftest:arweave'), // ~138s
  npmTest('selftest:ton-provider'), // ~56s
  { name: 'mcp-smoke', cmd: 'node', args: ['scripts/mcp-smoke.mjs'] }, // ~34s
  // #800. Parallel-safe on the same finding as mcp-smoke: it mkdtemp's its whole world
  // under the per-test TMPDIR, and every MCP server it spawns gets that tree's own
  // CYPHER_BRAIN_HOME/CYPHER_BRAIN_FILE_DIR. It binds no port, writes no LaunchAgent, and
  // only READS dist/. Its cost is ~30 short-lived server processes, one per policy case,
  // because the policy inputs are env vars a server reads once at start.
  npmTest('selftest:mcp-snapshot-policy'), // ~33s
  npmTest('selftest'), // ~32s
  npmTest('selftest:schedule'),
  npmTest('selftest:ton-dns'),
  npmTest('selftest:arweave-gateway-cap'),
  npmTest('selftest:init'),
  npmTest('selftest:plan'),
  npmTest('selftest:recovery'),
  npmTest('selftest:runner'),
  npmTest('selftest:storage'),
  npmTest('selftest:minisign'),
  { name: 'cli-smoke', cmd: 'bash', args: ['scripts/cli-smoke.sh'] },
  npmTest('selftest:verify-levels'),
  npmTest('selftest:gbrain-pglite'),
  npmTest('selftest:otel'),
  npmTest('selftest:ton'),
  npmTest('selftest:profiles'),
  npmTest('selftest:receipt'),
  npmTest('selftest:doctor'),
  npmTest('selftest:recovery-kit'),
  npmTest('selftest:rclone'),
  npmTest('selftest:interop'),
  npmTest('selftest:cypherbrainignore'),
  npmTest('selftest:pq'),
  npmTest('selftest:keygen-force'),
  npmTest('selftest:restore-security'),
  // ~7s measured in the pool. Parallel-safe under this list's own bar (a positive
  // finding, not the absence of a reason to suspect it): everything it creates lives
  // under one mkdtemp beneath the per-test TMPDIR — its CYPHER_BRAIN_HOME, its fixtures,
  // and the stub `tar` it puts on PATH. That PATH override is scoped to the env of the
  // `restore` children it spawns itself and is never exported, so no other test can pick
  // it up; it binds no port and writes nothing outside that tree.
  npmTest('selftest:restore-toctou'),
  npmTest('selftest:config-file'),
  npmTest('selftest:wallet-balance'),
  npmTest('selftest:audit'),
  npmTest('selftest:properties'),
  npmTest('selftest:ledger'),
  npmTest('selftest:idempotency-lib'),
  // #818. Parallel-safe by the same findings as mcp-smoke: its own temp
  // CYPHER_BRAIN_HOME, its mock Arweave gateway on `listen(0, '127.0.0.1')`, and it
  // only READS dist/.
  npmTest('selftest:mcp-uncertain-spend'),
  npmTest('selftest:turbo-dep'),
  npmTest('selftest:ans104-sizing'),
  npmTest('selftest:push-partial-failure'),
  npmTest('selftest:push-balance-report'),
  npmTest('selftest:arweave-nodeps'),
  npmTest('selftest:sdk-advice'),
  npmTest('selftest:usd-rate'),
  npmTest('selftest:progress'),
  npmTest('selftest:cctv-age'),
  npmTest('selftest:file-toctou'),
  npmTest('selftest:error-codes'),
  npmTest('selftest:import-quietly'),
];

// EXCLUSIVE runs alone, after the pool has drained.
//   selftest:help-docs rewrites README.md AND src/cli.ts in place and restores them from a
//   backup on exit. Every dev-mode test in the pool runs the CLI straight off src/*.ts, so
//   anything overlapping this would read a deliberately corrupted CLI and fail for a
//   reason that has nothing to do with it.
const EXCLUSIVE = [npmTest('selftest:help-docs')];

const PREFLIGHT = ['build', 'typecheck', 'lint', 'check:help-docs'];

const DEFAULT_PLAN = { preflight: PREFLIGHT.map(npmTest), parallel: PARALLEL, exclusive: EXCLUSIVE };

// ── arguments ──────────────────────────────────────────────────────────────────
const die = (msg) => {
  console.error(`run-selftests: ${msg}`);
  console.error(
    'usage: node scripts/run-selftests.mjs [--jobs N] [--check-list] [--plan FILE]\n' +
      '  --jobs N      workers over the parallel-safe tests (default 3; 1 = serial, for diagnosis)\n' +
      '  --check-list  run only the package.json-vs-this-file coverage guard, then exit\n' +
      '  --plan FILE   replace the suite with a JSON plan — for scripts/selftest-runner.sh only',
  );
  process.exit(2);
};

let jobs = 3;
let planPath = null;
let checkListOnly = false;
{
  const argv = process.argv.slice(2);
  const takeValue = (argv, i, arg) => {
    if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
    if (i + 1 >= argv.length) die(`${arg} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check-list') {
      checkListOnly = true;
    } else if (arg === '--jobs' || arg === '-j' || arg.startsWith('--jobs=')) {
      const value = takeValue(argv, i, arg);
      if (!arg.includes('=')) i++;
      // Digits only: Number('3x') is NaN but Number(' 3 ') is 3, and `--jobs 3x` is a typo
      // that must not quietly become 3.
      if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 64) {
        die(`--jobs needs an integer between 1 and 64, got ${JSON.stringify(value)}`);
      }
      jobs = Number(value);
    } else if (arg === '--plan' || arg.startsWith('--plan=')) {
      planPath = takeValue(argv, i, arg);
      if (!arg.includes('=')) i++;
      if (!planPath) die('--plan needs a file');
    } else {
      die(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
}

// ── plan loading ───────────────────────────────────────────────────────────────
// --plan replaces the suite with fake tests read from a JSON file. It exists for
// scripts/selftest-runner.sh, which has to make this runner fail on purpose — a pool nobody
// has watched stop scheduling, reap its children, or die on a signal is an unproven guard.
//
// It is a FLAG and not an environment variable on purpose (multi-model review): `npm run
// verify` passes its whole environment down, so a stray exported variable would have been
// able to replace the entire suite with nothing and still print "every selftest passed".
// argv is not inherited, so nothing can turn this on by accident — and when it IS on, the
// banner below and the final line both say the real suite did not run.
let plan = DEFAULT_PLAN;
let packageJsonPath = join(ROOT, 'package.json');
if (planPath) {
  const raw = JSON.parse(readFileSync(planPath, 'utf8'));
  plan = {
    preflight: (raw.preflight ?? []).map(normalizeEntry),
    parallel: (raw.parallel ?? []).map(normalizeEntry),
    exclusive: (raw.exclusive ?? []).map(normalizeEntry),
  };
  packageJsonPath = raw.packageJson ?? null; // null = no package.json to check against
  console.log(`[note] --plan ${planPath} is in effect: this is NOT the cypher-brain selftest suite`);
}

function normalizeEntry(e) {
  if (typeof e === 'string') return npmTest(e);
  if (!e || typeof e.name !== 'string' || typeof e.cmd !== 'string' || !Array.isArray(e.args)) {
    throw new Error(`bad plan entry: ${JSON.stringify(e)}`);
  }
  return { name: e.name, cmd: e.cmd, args: e.args };
}

// ── the coverage guard ─────────────────────────────────────────────────────────
// A `selftest*` script in package.json that this file does not run is a test that has
// stopped being run without anyone deciding that. Two branches adding a selftest at once
// is exactly how that happens, so this fires at rebase.
function checkCoverage() {
  if (!packageJsonPath) return true;
  const scripts = JSON.parse(readFileSync(packageJsonPath, 'utf8')).scripts ?? {};
  const isSelftest = (s) => s === 'selftest' || s.startsWith('selftest:');
  const declared = Object.keys(scripts).filter(isSelftest);
  const entries = [...plan.parallel, ...plan.exclusive];
  const planned = new Map(entries.map((t) => [t.name, t]));
  const missing = declared.filter((s) => !planned.has(s));
  // The other direction too: a plan entry naming an npm script that no longer exists would
  // otherwise fail late, as an opaque "Missing script" from npm inside a worker.
  const stale = [...planned.keys()].filter((n) => isSelftest(n) && !(n in scripts));
  // And matching NAMES is not the same as running the test (multi-model review): an entry
  // named after a selftest but pointing somewhere else would satisfy the check above while
  // the actual npm script never runs. Nothing but `npm run <that same name>` counts.
  const mislabeled = [...planned.values()].filter(
    (t) => isSelftest(t.name) && !(t.cmd === NPM && t.args.length === 2 && t.args[0] === 'run' && t.args[1] === t.name),
  );
  if (missing.length === 0 && stale.length === 0 && mislabeled.length === 0) return true;
  console.error('\n[FAIL] the suite list in scripts/run-selftests.mjs is out of sync with package.json');
  for (const s of missing) console.error(`  package.json declares "${s}" but scripts/run-selftests.mjs never runs it`);
  for (const s of stale)
    console.error(`  scripts/run-selftests.mjs runs "${s}" but package.json no longer declares it`);
  for (const t of mislabeled)
    console.error(
      `  scripts/run-selftests.mjs lists "${t.name}" but runs ${[t.cmd, ...t.args].join(' ')}, not ${NPM} run ${t.name}`,
    );
  console.error(
    '\nAdd the test to PARALLEL (or EXCLUSIVE, if it is not safe to run alongside others) in\n' +
      'scripts/run-selftests.mjs. That list — not verify:suite — is what `npm run verify` runs.',
  );
  return false;
}

// ── per-test sandboxes ─────────────────────────────────────────────────────────
// Under the run's TMPDIR, which is the sandbox scripts/verify.mjs made when it is the
// caller. Directly under it, one level deep, because that is the level verify.mjs's
// readdir() reports by name.
const sandboxRoot = process.env.TMPDIR || tmpdir();
const dirNames = new Map();
for (const t of [...plan.preflight, ...plan.parallel, ...plan.exclusive]) {
  const base = t.name.replace(/[^A-Za-z0-9_.-]+/g, '-');
  if ([...dirNames.values()].includes(base)) throw new Error(`two tests map to the sandbox dir ${base}`);
  dirNames.set(t.name, base);
}

// ── running one test ───────────────────────────────────────────────────────────
const live = new Set(); // children still running, for signal forwarding
let shuttingDown = null; // the signal name, once one arrives

// Negative pid = the whole process group. `detached` below is what makes the child a group
// leader, so this reaches the npm -> sh -> node chain and any daemon a test backgrounded
// (arlocal, the mock TON seeder) rather than only the direct child.
//
// KNOWN LIMIT, stated rather than papered over (multi-model review): this reaches the
// group, and a descendant that calls setsid() leaves the group and so survives. Confirming
// the group is actually empty afterwards needs a process jail (cgroups, or polling pgids
// the runner does not know), which is more than the old `&&` chain did — that chain did not
// track descendants at all — so this is a gain, not a guarantee. Nothing in scripts/ calls
// setsid today; a test that starts to would need its own cleanup regardless.
const killGroup = (child, sig) => {
  try {
    process.kill(-child.pid, sig);
  } catch {
    /* already gone */
  }
};

function runTest(t) {
  const dir = join(sandboxRoot, dirNames.get(t.name));
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const chunks = [];
  const child = spawn(t.cmd, t.args, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
  });
  live.add(child);
  child.stdout.on('data', (c) => chunks.push(c));
  child.stderr.on('data', (c) => chunks.push(c));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code, signal, extra) => {
      if (settled) return;
      settled = true;
      live.delete(child);
      killGroup(child, 'SIGKILL'); // anything the test backgrounded and did not reap
      const seconds = (Date.now() - started) / 1000;
      const output = Buffer.concat(chunks).toString('utf8') + (extra ?? '');

      // Hygiene, per test: whatever is still in this test's TMPDIR is this test's. Empty
      // -> take the directory away so verify.mjs's sandbox ends up empty; non-empty ->
      // leave it exactly where it is, so verify.mjs names it.
      let leaked = [];
      try {
        leaked = readdirSync(dir);
      } catch {
        leaked = [];
      }
      if (leaked.length === 0) {
        try {
          rmdirSync(dir);
        } catch {
          /* raced or busy — verify.mjs will say so */
        }
      }
      let status = code === 0 && !signal ? 'PASS' : 'FAIL';
      let note = '';
      if (signal) note = `\n[killed by ${signal}]`;
      if (leaked.length > 0 && status === 'PASS') {
        status = 'LEAK';
        note =
          `\n[FAIL] temp hygiene: this test left ${leaked.length} entry(ies) in its own TMPDIR (#328/#607):\n` +
          leaked.map((n) => `  ${n}`).join('\n') +
          `\n  kept at ${dir} — whatever created these must remove them in a finally/trap`;
      } else if (leaked.length > 0) {
        note += `\n[note] it also left ${leaked.length} entry(ies) in ${dir}`;
      }
      // A worker killed by a signal exits with 128+n rather than a flat 1, so an OOM kill
      // (SIGKILL) or a crash (SIGSEGV) stays distinguishable from a test that simply failed
      // by the time the code reaches CI (multi-model review).
      const signalCode = signal ? 128 + (constants.signals[signal] ?? 0) : 0;
      resolve({
        name: t.name,
        status,
        seconds,
        code: status === 'PASS' ? 0 : code || signalCode || 1,
        output: output + note,
      });
    };

    child.on('error', (e) => finish(1, null, `\n[FAIL] could not spawn ${t.cmd}: ${e.message}`));
    // 'close' waits for the pipes, which a grandchild holding stdout can keep open after
    // the child itself is gone. Bound that wait rather than letting one stray daemon hang
    // the whole harness: on 'exit' we have the status already, so kill the group to drop
    // the pipes and settle a moment later regardless.
    child.on('exit', (code, signal) => {
      killGroup(child, 'SIGKILL');
      setTimeout(
        () => finish(code, signal, settled ? '' : '\n[note] output was cut off: a child held stdout open'),
        2000,
      ).unref();
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// ── reporting ──────────────────────────────────────────────────────────────────
const results = [];
const bar = '─'.repeat(78);
function report(r) {
  results.push(r);
  const head = `${r.name} — ${r.status} (${r.seconds.toFixed(1)}s)`;
  process.stdout.write(`\n${bar}\n${head}\n${bar}\n`);
  process.stdout.write(r.output.endsWith('\n') || r.output === '' ? r.output : `${r.output}\n`);
}

function summary() {
  const width = Math.max(4, ...results.map((r) => r.name.length));
  console.log(`\n${bar}\nsummary (--jobs ${jobs})\n${bar}`);
  for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.status.padEnd(6)}  ${r.seconds.toFixed(1)}s`);
  const skipped = [...plan.parallel, ...plan.exclusive].filter((t) => !results.some((r) => r.name === t.name));
  for (const t of skipped) console.log(`${t.name.padEnd(width)}  ${'SKIP'.padEnd(6)}  -`);
  console.log(bar);
}

// ── signals ────────────────────────────────────────────────────────────────────
// Forward to every live child's group, stop scheduling, let the reaping below run, and
// re-raise on ourselves at the end so the caller sees a signal death (verify.mjs does the
// same, and relies on this one doing it: a suite flattened to exit 1 would make an
// interrupted run indistinguishable from a failed one).
// SIGQUIT is in the list because the workers are DETACHED: a signal the runner does not
// handle kills it and leaves every worker group running, which for this suite means stray
// arlocal and mock-seeder daemons (multi-model review).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, () => {
    shuttingDown ??= sig;
    for (const child of live) killGroup(child, sig);
    // Whatever ignores the first signal gets SIGKILL shortly after, so shutdown is bounded.
    setTimeout(() => {
      for (const child of live) killGroup(child, 'SIGKILL');
    }, 5000).unref();
  });
}

// Same reason, for the other way out: a bug in this file must not leave the workers behind.
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => {
    console.error(`\n[FAIL] run-selftests crashed (${ev}): ${err?.stack ?? err}`);
    for (const child of live) killGroup(child, 'SIGKILL');
    process.exit(1);
  });
}

const exit = (fallbackCode) => {
  summary();
  if (shuttingDown) {
    const num = constants.signals[shuttingDown];
    if (num) {
      process.removeAllListeners(shuttingDown);
      process.kill(process.pid, shuttingDown);
      process.exit(128 + num); // only reached if the signal is ignored
    }
    process.exit(1);
  }
  process.exit(fallbackCode);
};

// ── the run ────────────────────────────────────────────────────────────────────
if (!checkCoverage()) {
  if (!checkListOnly) summary();
  process.exit(1);
}
if (checkListOnly) {
  console.log('[PASS] every selftest:* script in package.json is in the suite list, and runs the script it names');
  process.exit(0);
}

let failed = null; // the first result that was not a PASS

for (const t of plan.preflight) {
  const r = await runTest(t);
  report(r);
  if (r.status !== 'PASS') {
    failed = r;
    break;
  }
  if (shuttingDown) break;
}

if (!failed && !shuttingDown) {
  const queue = [...plan.parallel];
  const inflight = new Set();
  const start = (t) => {
    const p = runTest(t).then((r) => {
      inflight.delete(p);
      report(r);
      if (r.status !== 'PASS') failed ??= r;
    });
    inflight.add(p);
  };
  while (queue.length > 0 && !failed && !shuttingDown) {
    start(queue.shift());
    if (inflight.size >= jobs) await Promise.race([...inflight]);
  }
  // Stop SCHEDULING on a failure, but never stop waiting: a child killed here would lose
  // the output that explains why a parallel run failed where a serial one did not.
  if (inflight.size > 0) await Promise.all([...inflight]);
}

if (!failed && !shuttingDown) {
  for (const t of plan.exclusive) {
    const r = await runTest(t);
    report(r);
    if (r.status !== 'PASS') {
      failed = r;
      break;
    }
    if (shuttingDown) break;
  }
}

if (failed) {
  console.error(`\n[FAIL] ${failed.name} (${failed.status}) — its output is in the block above`);
  exit(failed.code || 1);
}
console.log(
  planPath ? `\n[PASS] every test in ${planPath} passed (NOT the real suite)` : '\n[PASS] every selftest passed',
);
exit(0);
