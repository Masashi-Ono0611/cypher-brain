#!/usr/bin/env node
// Operator-run, REAL-NETWORK proof for the `ton` storage backend (src/lib/backends/ton.ts).
//
// scripts/selftest-ton.sh (gated in CI) proves the backend's ORCHESTRATION — the real
// backend code, its real remote command lines, its real HTTP client — against a mock
// seeder (PATH-shimmed ssh/scp + scripts/mock-tonutils.mjs). It deliberately cannot
// prove one thing: that a bag actually travels over the real TON Storage P2P network.
// This script is that missing piece — it talks to a REAL operator-run seeder box
// (CYPHER_BRAIN_TON_SSH_HOST) and does a REAL P2P download by bag id, with
// CYPHER_BRAIN_TON_NO_FALLBACK=1 on the pull so a success actually PROVES P2P
// availability rather than silently sliding through the SSH fallback.
//
//   npm run dogfood:ton               (or: node scripts/ton-dogfood.mjs)
//   node scripts/ton-dogfood.mjs --probe-fallback   (also records which path a normal,
//                                                     non-strict pull takes)
//   node scripts/ton-dogfood.mjs --keep             (skip removing the test bag after)
//
// Everything it creates is disposable: a fresh temp CYPHER_BRAIN_HOME, a fresh keypair,
// a throwaway few-KB source file. It never touches the operator's real ~/.cypher-brain,
// costs nothing (ton push/pull are free — no --yes, no wallet), and by default removes
// the test bag from the seeder afterward so repeated dogfood runs do not accumulate junk.
//
// No host/key is hardcoded here — every CYPHER_BRAIN_TON_* setting comes from the
// environment and is passed straight through to the CLI child process, same as any
// other cypher-brain invocation.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_ARGS } from './dev-node-flags.mjs';
import { API_RE, HEX64_RE, assertSafe, sshRun } from './ton-ssh-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'bin', 'cypher-brain.mjs');

// Generous safety net, not a tuned budget: push can legitimately take up to
// CREATE_READY_TIMEOUT_MS (10 min, ton.ts) waiting for the seeder to finish
// hashing/seeding a large bag, and the overall pipe cap (CYPHER_BRAIN_PIPE_TIMEOUT)
// defaults to 1h. This only exists so a truly wedged run fails loud instead of
// hanging forever unattended.
const CB_TIMEOUT_MS = 90 * 60 * 1000;

const ALL_TON_ENVS = [
  'CYPHER_BRAIN_TON_SSH_HOST',
  'CYPHER_BRAIN_TON_SSH_KEY',
  'CYPHER_BRAIN_TON_REMOTE_DIR',
  'CYPHER_BRAIN_TON_REMOTE_API',
  'CYPHER_BRAIN_TON_BIN',
  'CYPHER_BRAIN_TON_HTTP_TIMEOUT',
  'CYPHER_BRAIN_TON_NO_FALLBACK',
  'CYPHER_BRAIN_TON_NETWORK_CONFIG',
];
const REQUIRED_ENVS = ['CYPHER_BRAIN_TON_SSH_HOST', 'CYPHER_BRAIN_TON_BIN'];

const HELP = `ton-dogfood — operator-run real-network proof for the ton storage backend

Usage: node scripts/ton-dogfood.mjs [--probe-fallback] [--keep] [--help]

  --probe-fallback  also run a normal (non-strict) pull afterward and record whether
                     it was served over P2P or the seeder fallback (best-effort; never
                     fails the run).
  --keep            skip removing the test bag from the seeder when done.
  --help            print this and exit 0.

Required env: CYPHER_BRAIN_TON_SSH_HOST, CYPHER_BRAIN_TON_BIN.
All CYPHER_BRAIN_TON_* env vars are passed straight through to the CLI — see the
README "TON Storage" section / src/lib/backends/ton.ts for what each one does.
`;

function requireEnv() {
  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length === 0) return;
  console.error(`ton-dogfood: missing required env var(s): ${missing.join(', ')}`);
  console.error('');
  console.error('This script drives the REAL ton backend against a REAL operator-run seeder box');
  console.error('(no mocks) — see README.md "TON Storage" and src/lib/backends/ton.ts for the');
  console.error('seeder setup (a machine running tonutils-storage, reached over SSH).');
  console.error('');
  console.error('Env vars this script uses (passed straight through to the CLI child process):');
  for (const k of ALL_TON_ENVS) {
    const req = REQUIRED_ENVS.includes(k);
    console.error(`  ${k}${req ? ' (required)' : ''} = ${process.env[k] ?? '<unset>'}`);
  }
  process.exit(2);
}

// ---------- tiny CLI-driving + hashing helpers ----------

function cb(args, extraEnv) {
  const r = spawnSync(process.execPath, [...DEV_ARGS, BIN, ...args], {
    cwd: ROOT,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    encoding: 'utf8',
    timeout: CB_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`spawn failed for 'cypher-brain ${args.join(' ')}': ${r.error.message}`);
  return r;
}

function cbOk(args, extraEnv) {
  const r = cb(args, extraEnv);
  if (r.status !== 0) {
    throw new Error(
      `'cypher-brain ${args.join(' ')}' exited ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}: ` +
        (r.stderr || '').trim().slice(-4000),
    );
  }
  return r;
}

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function findMarker(dir, marker) {
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    try {
      if (readFileSync(p, 'utf8').includes(marker)) return p;
    } catch {
      /* binary or unreadable — not the marker file */
    }
  }
  return null;
}

// ---------- remote-command safety ----------
// HOST_RE/API_RE/HEX64_RE, assertSafe(), sshBaseArgs(), sshRun() live in
// scripts/ton-ssh-lib.mjs (shared with scripts/ton-provider-experiment.mjs — see
// that file's comment for why, #604). REMOTE_PATH_RE is only used here.

const REMOTE_PATH_RE = /^[A-Za-z0-9._/-]+$/;

// Removes the ONE test bag this run created: the seeder daemon record (via its own
// /api/v1/remove, with_files:true) plus cypher-brain's own inventory bookkeeping (which
// the daemon does not know about). Best-effort — cleanup failures are WARN, never FAIL,
// per this script's own contract (see main()).
function cleanupRemoteBag(sha, bagId) {
  const base = assertSafe(
    process.env.CYPHER_BRAIN_TON_REMOTE_DIR || 'cypher-brain-ton',
    'CYPHER_BRAIN_TON_REMOTE_DIR',
    REMOTE_PATH_RE,
  );
  const api = assertSafe(
    process.env.CYPHER_BRAIN_TON_REMOTE_API || '127.0.0.1:9955',
    'CYPHER_BRAIN_TON_REMOTE_API',
    API_RE,
  );
  const safeSha = assertSafe(sha, 'ciphertext sha256', HEX64_RE);
  const safeBag = assertSafe(bagId, 'bag id', HEX64_RE);

  // C1: never arm deletion off the bagId argument alone — read the seeder's OWN
  // inventory record for this sha and confirm it names this exact bag. Only then is
  // the daemon-side removal provably scoped to the bag THIS run's ciphertext created.
  const recorded = sshRun(`cat -- '${base}/inventory/${safeSha}.locator' 2>/dev/null || true`).trim();
  const expected = `ton:v1:${safeBag}`;
  if (recorded !== expected) {
    throw new Error(
      `refusing to delete — seeder inventory for sha ${safeSha} does not match this run's bag: ` +
        `recorded=${JSON.stringify(recorded)} expected=${JSON.stringify(expected)}`,
    );
  }

  // --fail (W1): a 4xx/5xx from the daemon must surface as a non-zero ssh/curl exit,
  // not a silent "removed" (curl without --fail prints the error body but still exits 0).
  const body = JSON.stringify({ bag_id: safeBag, with_files: true });
  sshRun(
    `curl -sS --fail -m 30 -X POST -H 'Content-Type: application/json' --data '${body}' 'http://${api}/api/v1/remove' >/dev/null`,
    60_000,
  );

  // Positive confirmation the daemon actually forgot it, not just that the call
  // returned 2xx: re-list and assert the bag id no longer appears anywhere in it.
  //
  // The count is done LOCALLY, not via a remote `| grep -c ... || true` (Codex review):
  // piping curl into grep on the remote side makes the remote command's own exit status
  // (what sshRun() checks) grep's, not curl's — and the trailing `|| true` was there only
  // to stop a genuine 0-match grep (bag really gone) from being treated as a failure by
  // sshRun(). That same `|| true` also swallowed a FAILED curl (daemon unreachable, 5xx,
  // timeout): with no stdin, `grep -c` on nothing prints "0", which then read as "bag
  // confirmed gone" — the exact opposite of what a failed query means. A distinct sentinel
  // for "the query itself did not complete" keeps this best-effort (never throws — see
  // this function's own "Best-effort" comment above) while no longer confusing "could not
  // check" with "checked, and it is gone".
  // `.includes()`, not exact equality (Codex review, 2nd pass): a curl that fails
  // mid-transfer (connection reset, timeout after partial body) can still have written
  // some stdout before the `||` fallback's sentinel prints — exact equality would then
  // miss the failure entirely and fall through to treating that partial garbage as a
  // real (and likely bag-id-free) listing, "confirming" removal on a query that never
  // actually completed. This sentinel is unlikely to ever appear inside real seeder
  // JSON (a hex bag id list), so a substring match stays safe against false positives.
  const QUERY_FAILED = 'CLEANUP_LIST_QUERY_FAILED';
  const listOutput = sshRun(
    `curl -sS --fail -m 30 'http://${api}/api/v1/list' || printf '${QUERY_FAILED}\\n'`,
    60_000,
  ).trim();
  if (listOutput.includes(QUERY_FAILED)) {
    console.log(
      `[WARN] cleanup: could not query the seeder's /api/v1/list to confirm bag ${safeBag} was removed after ` +
        `/api/v1/remove — check manually on ${process.env.CYPHER_BRAIN_TON_SSH_HOST} if unsure.`,
    );
  } else {
    const stillListedCount = (listOutput.match(new RegExp(safeBag, 'g')) || []).length;
    if (stillListedCount !== 0) {
      console.log(
        `[WARN] cleanup: bag ${safeBag} still appears in the seeder's /api/v1/list after /api/v1/remove ` +
          `(match count=${stillListedCount}) — it may still be finishing removal; check manually on ` +
          `${process.env.CYPHER_BRAIN_TON_SSH_HOST} if it persists.`,
      );
    }
  }

  sshRun(`rm -rf -- '${base}/bags/${safeSha}' '${base}/inventory/${safeSha}.locator'`);
}

// ---------- main ----------

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const known = new Set(['--probe-fallback', '--keep']);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    console.error(`ton-dogfood: unknown argument(s): ${unknown.join(', ')}\n`);
    process.stdout.write(HELP);
    process.exit(2);
  }
  const probeFallback = args.includes('--probe-fallback');
  const keep = args.includes('--keep');

  requireEnv();

  const tmpRoot = mkdtempSync(join(tmpdir(), 'cypher-brain-ton-dogfood-'));
  process.env.CYPHER_BRAIN_HOME = join(tmpRoot, 'home'); // never the operator's real ~/.cypher-brain
  const srcDir = join(tmpRoot, 'src');
  mkdirSync(srcDir, { recursive: true });
  const snapPath = join(tmpRoot, 'snap.age');
  const gotPath = join(tmpRoot, 'got.age');
  const restoreDir = join(tmpRoot, 'restored');
  const locFile = join(tmpRoot, 'locator.tsv');

  const marker = `ton-dogfood-${randomBytes(8).toString('hex')}`;

  const phases = {};
  const timings = {};
  let origSha = null;
  let sizeBytes = null;
  let locator = null;
  let bagId = null;
  let requiredOk = true;

  // W2: SIGINT (Ctrl-C) must still try to remove a bag this run already created —
  // the handler is a closure over the same bagId/origSha/keep the normal cleanup path
  // uses, so it always sees the current values. Kept deliberately minimal: it attempts
  // cleanup exactly once then exits; a SIGKILL (no JS runs at all) or a second Ctrl-C
  // (something is already stuck) both skip it and leave the bag on the seeder — re-run
  // with --keep to inspect it, or remove it by hand (see cleanupRemoteBag above).
  let sigintHandled = false;
  process.on('SIGINT', () => {
    if (sigintHandled) {
      console.log('\n[WARN] second interrupt — exiting immediately without further cleanup.');
      process.exit(130);
    }
    sigintHandled = true;
    console.log('\n[WARN] interrupted (SIGINT) — attempting cleanup once before exiting.');
    if (!keep && bagId && origSha) {
      try {
        cleanupRemoteBag(origSha, bagId);
        console.log('[INFO] cleanup: removed the test bag from the seeder');
      } catch (e) {
        console.log(
          `[WARN] cleanup failed — remove manually on the seeder (bag ${bagId}, sha ${origSha}): ${e.message}`,
        );
      }
    }
    process.exit(130);
  });

  const REQUIRED_PHASES = ['setup', 'push', 'idempotent', 'p2p_pull', 'verify', 'restore'];

  function runPhase(name, fn) {
    if (!requiredOk) {
      phases[name] = 'BLOCKED';
      timings[name] = 0;
      console.log(`[BLOCKED] ${name}: skipped — an earlier required phase failed`);
      return;
    }
    const t0 = Date.now();
    try {
      fn();
      phases[name] = 'PASS';
      console.log(`[PASS] ${name}`);
    } catch (e) {
      phases[name] = 'FAIL';
      requiredOk = false;
      console.log(`[FAIL] ${name}: ${e.message}`);
    } finally {
      timings[name] = Date.now() - t0;
    }
  }

  try {
    runPhase('setup', () => {
      cbOk(['keygen']);
      // A few-KB text file (well under a "large file" scenario — this dogfood proves
      // P2P retrievability, not throughput) with a random marker, so restore's output
      // can be asserted to actually be THIS run's content, not a stale leftover.
      const filler = randomBytes(2048).toString('hex'); // ~4KB
      writeFileSync(join(srcDir, 'note.txt'), `marker: ${marker}\n${filler}\n`);
      cbOk(['snapshot', '--dir', srcDir, '--out', snapPath]);
      origSha = sha256File(snapPath);
      sizeBytes = statSync(snapPath).size;
    });

    runPhase('push', () => {
      const r = cbOk(['push', '--in', snapPath, '--backend', 'ton', '--save-locator', locFile]);
      locator = r.stdout.trim();
      const m = /^ton:v1:([0-9a-f]{64})$/.exec(locator);
      if (!m) throw new Error(`locator does not match ^ton:v1:[0-9a-f]{64}$: ${JSON.stringify(locator)}`);
      bagId = m[1];
    });

    runPhase('idempotent', () => {
      const r = cbOk(['push', '--in', snapPath, '--backend', 'ton']);
      const loc2 = r.stdout.trim();
      if (loc2 !== locator)
        throw new Error(`re-push returned a different locator: ${JSON.stringify(loc2)} != ${JSON.stringify(locator)}`);
    });

    // The core proof: strict mode means a success can ONLY have come from the real P2P
    // network (CYPHER_BRAIN_TON_NO_FALLBACK=1 forbids the SSH fallback outright) — no
    // silent retry through the seeder if P2P fails.
    runPhase('p2p_pull', () => {
      const r = cb(['pull', '--backend', 'ton', '--locator', locator, '--out', gotPath], {
        CYPHER_BRAIN_TON_NO_FALLBACK: '1',
      });
      if (r.status !== 0) {
        throw new Error(
          `strict P2P pull (CYPHER_BRAIN_TON_NO_FALLBACK=1) failed: ${(r.stderr || '').trim().slice(-4000)}`,
        );
      }
      if (!(r.stderr || '').includes('over the TON Storage P2P network')) {
        throw new Error(
          'pull exited 0 but did not report the P2P path in stderr — cannot confirm what actually served it',
        );
      }
      const gotSha = sha256File(gotPath);
      if (gotSha !== origSha) throw new Error(`pulled bytes differ from pushed bytes: ${gotSha} != ${origSha}`);
    });

    runPhase('verify', () => {
      cbOk(['verify', '--in', gotPath]);
    });

    runPhase('restore', () => {
      cbOk(['restore', '--in', gotPath, '--out-dir', restoreDir]);
      const found = findMarker(restoreDir, marker);
      if (!found) throw new Error(`restored tree under ${restoreDir} does not contain this run's marker (${marker})`);
    });

    // Optional, informational: does a normal pull actually go P2P, or quietly fall
    // back? Never fails the run — see the flag's own --help description. BLOCKED is
    // reserved for "could not run at all" (no locator); an executed-but-failed probe,
    // or one whose stderr doesn't say which path served it, is WARN (W3) — a probe
    // that ran and told us something ambiguous is not the same as one that never ran.
    if (probeFallback) {
      const t0 = Date.now();
      if (!locator) {
        phases.fallback_probe = 'BLOCKED';
        timings.fallback_probe = 0;
        console.log('[BLOCKED] fallback_probe: no locator to probe (push phase never succeeded)');
      } else {
        try {
          const probeOut = join(tmpRoot, 'got-probe.age');
          // S1: reuse cb() (surfaces r.error/timeout/signal) instead of a raw spawnSync.
          // The backend only ever treats the literal string '1' as "no fallback", so an
          // EMPTY override disables strict mode without needing to delete the var.
          const r = cb(['pull', '--backend', 'ton', '--locator', locator, '--out', probeOut, '--force'], {
            CYPHER_BRAIN_TON_NO_FALLBACK: '',
          });
          const stderrText = r.stderr || '';
          const path = stderrText.includes('over the TON Storage P2P network')
            ? 'p2p'
            : stderrText.includes('falling back to a direct copy from the seeder')
              ? 'seeder-fallback'
              : 'unknown';
          if (r.status !== 0) {
            phases.fallback_probe = 'WARN';
            console.log(`[WARN] fallback_probe: probe pull exited ${r.status}: ${stderrText.trim().slice(-2000)}`);
          } else if (path === 'unknown') {
            phases.fallback_probe = 'WARN';
            console.log(
              `[WARN] fallback_probe: pull succeeded but stderr did not say which path served it — cannot ` +
                `confirm p2p vs seeder-fallback. stderr tail: ${stderrText.trim().slice(-2000)}`,
            );
          } else {
            phases.fallback_probe = 'PASS';
            console.log(`[PASS] fallback_probe: served via ${path}`);
          }
        } catch (e) {
          phases.fallback_probe = 'WARN';
          console.log(`[WARN] fallback_probe: ${e.message}`);
        } finally {
          timings.fallback_probe = Date.now() - t0;
        }
      }
    } else {
      phases.fallback_probe = 'SKIP';
    }
  } finally {
    // W2: cleanup runs here — in the outer finally — so it still fires even if
    // something above throws an exception runPhase() did not catch (runPhase itself
    // never rethrows, so this is a belt-and-suspenders backstop, not the primary path).
    if (!keep && bagId && origSha) {
      try {
        cleanupRemoteBag(origSha, bagId);
        console.log('[INFO] cleanup: removed the test bag from the seeder');
      } catch (e) {
        console.log(
          `[WARN] cleanup failed — remove manually on the seeder (bag ${bagId}, sha ${origSha}): ${e.message}`,
        );
      }
    } else if (keep && bagId) {
      console.log(`[INFO] --keep: leaving bag ${bagId} on the seeder`);
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('== ton dogfood summary ==');
  console.log(JSON.stringify({ phases, timings_ms: timings, locator, size_bytes: sizeBytes }));

  const ok = REQUIRED_PHASES.every((p) => phases[p] === 'PASS');
  process.exit(ok ? 0 : 1);
}

main();
