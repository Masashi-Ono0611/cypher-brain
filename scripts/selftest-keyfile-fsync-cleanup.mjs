#!/usr/bin/env node
// Regression proof — a post-merge Codex regression review of this session's accumulated
// diff, run against #871's fsync discipline, found that src/lib/keys.ts's writeKeyFile()
// --force branch cleaned up its sibling `<path>.<pid>.<hex>.tmp` scratch file ONLY around
// the rename() step: if fh.sync() (or, in principle, fh.close()) rejected AFTER the
// secret payload was already written to `tmp`, the handle still closed (its own try/
// finally), but execution never reached the rename step's catch block — leaving `tmp`
// (a COMPLETE, unencrypted secret: an age identity, a minisign signing key, or an
// Arweave JWK — writeKeyFile() is the ONE shared write path keys.ts/minisign.ts/
// wallet.ts all use) sitting on disk forever, unreported, and untracked by
// signal-guard.ts's cleanup-on-signal mechanism (which never knew the file existed).
//
// Four parts:
//
//   Part 1 (grounding / positive control that the BUG is real): a small, deliberately
//   faithful reimplementation of the PRE-FIX shape — cleanup scoped ONLY around
//   rename() — since that vulnerable code no longer exists in src/. The injected
//   failure is an INSTANCE-level override of the open FileHandle's own sync() method
//   (the "mock the fs-handle" fault injection this fix's own review asked for): simple,
//   and scoped to exactly the one call under test. If this half did not reproduce a
//   leftover secret-bearing tmp file, the rest of this test would be proving nothing.
//
//   Part 2 (the actual fix): the SAME kind of fh.sync() failure, injected into the REAL,
//   CURRENT writeKeyFile() (src/lib/keys.ts) instead of a reimplementation. Since
//   writeKeyFile() opens its own FileHandle internally, the instance-level trick from
//   Part 1 isn't reachable from outside — instead this patches node:fs/promises's own
//   open() at the process level, via the underlying CJS require('fs').promises object.
//   THIS WORKS ONLY IF 'node:fs/promises' has not already been instantiated as its OWN
//   ESM module record anywhere in this process by the time the patch runs (verified
//   during this fix's own development, the hard way): Node's ESM named exports for a
//   builtin CJS module are a snapshot taken the FIRST time that module specifier is
//   linked in this realm, not a live getter re-read on every access — so a static
//   top-level `import { open } from 'node:fs/promises'` ANYWHERE (including in this very
//   script, evaluated before this script's own body runs) freezes the binding every
//   later importer of that same specifier (including a dynamically-imported keys.ts)
//   will see, no matter how the underlying object is mutated afterward. That is why this
//   script has NO static top-level import of 'node:fs/promises' at all — see the dynamic
//   `await import('node:fs/promises')` right after the patch below, and keys.ts's own
//   dynamic import after that. Asserts: the tmp file is gone, nothing was left at the
//   final path either, and the injected error still propagates (the fix must not turn a
//   real fh.sync() failure into a silent, incomplete success).
//
//   Part 3 (signal-guard registration, per this fix's own review request): the same
//   fh.sync() failure, but this time as a HANG instead of a throw, observed via an
//   actual SIGTERM landing mid-write rather than via writeKeyFile()'s own catch block —
//   a signal handler runs OUTSIDE the suspended async call stack entirely (see
//   signal-guard.ts's own header comment), so writeKeyFile()'s local try/catch/finally
//   NEVER gets a chance to run here; the ONLY thing that can still be cleaning up the
//   tmp file is signal-guard.ts's own SIGTERM handler, driven by the
//   addActiveKeyScratchFile()/removeActiveKeyScratchFile() pair this fix added. Spawns a
//   real child process (scripts/selftest-keyfile-fsync-cleanup-child.mjs) running
//   writeKeyFile() for real, waits for a sentinel proving the tmp file is on disk with
//   the secret payload BEFORE sending SIGTERM (so the assertion after killing it means
//   something), then asserts the tmp file is gone once the child has actually died by
//   that signal. The SIGKILL fallback (so a broken handler can never hang this suite) is
//   an emergency escape hatch ONLY — needing it counts as a FAILURE of the check that
//   the signal itself worked, not a silently-accepted alternate success path (a second
//   Codex review pass of this fix flagged an earlier draft that accepted either).
//
//   Part 4 (a Critical finding from that same second review pass): if the catch block's
//   own `rm(tmp, {force:true})` cleanup ITSELF throws (a transient EACCES/EIO actually
//   unlinking a file that exists, as opposed to the ENOENT `force` already swallows),
//   the fix must NOT deregister the tmp file — doing so unconditionally (the first-cut
//   shape of this fix) would silently drop the only remaining safety net for the secret
//   still on disk. Spawns a child (scripts/selftest-keyfile-fsync-cleanup-child-
//   rmfail.mjs) where BOTH fh.sync() and the async rm() are mocked to fail —
//   writeKeyFile() throws having failed to clean up its own tmp file — then confirms a
//   REAL SIGTERM afterward still sweeps it via signal-guard's own, SEPARATE, unmocked
//   `rmSync` (node:fs, not node:fs/promises), proving the file stayed correctly tracked
//   despite the earlier failed rm().
// Deliberately NO static top-level `import ... from 'node:fs/promises'` in this file —
// see the Part 2 header comment above for why. `existsSync` is 'node:fs' (a DIFFERENT
// module specifier from 'node:fs/promises'), so it is unaffected and safe to import
// statically.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { DEV_ARGS } from './dev-node-flags.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(HERE, 'selftest-keyfile-fsync-cleanup-child.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// Assigned below, AFTER the node:fs/promises open() patch is installed and that module
// is dynamically imported for the first time in this process — see the Part 2 header
// comment above. preFixWriteKeyFile() only CALLS these (at Part 1's runtime, further
// down), so closing over these outer `let` bindings is fine even though it is declared
// before the assignment.
let open, rename, rm, mkdtemp, readFile, readdir;

// The pre-fix shape of writeKeyFile()'s --force branch, exactly as it existed
// before this fix — see this file's header comment for why it lives here as a
// reimplementation rather than an import. `tmp` is passed in by the caller (rather than
// randomized internally, as the real function does) purely so the caller can assert on
// it directly without needing to scan a directory listing for it.
async function preFixWriteKeyFile(path, tmp, payload, mode) {
  const fh = await open(tmp, 'wx', mode);
  // Instance-level fault injection: overrides ONLY this one FileHandle's sync() method,
  // scoped to exactly this call.
  fh.sync = async () => {
    throw new Error('SIMULATED_EIO: fh.sync() failed after write (Part 1 grounding)');
  };
  try {
    await fh.writeFile(payload);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

// Process-wide open() patch for Part 2 — installed BEFORE 'node:fs/promises' is
// instantiated as an ESM module anywhere in this process (see the Part 2 header comment
// above for why the ordering itself is load-bearing, not just the patch's existence).
// Armed only around the one call it targets (faultArmed stays false the rest of the
// time, so this is a no-op pass-through everywhere else in this script, including
// Part 1's own open() calls, which go through their own separately-imported `open`
// below rather than this wrapper).
const require = createRequire(import.meta.url);
const cjsFsPromises = require('node:fs').promises;
const realOpen = cjsFsPromises.open;
let faultArmed = false;
let faultPrefix = null;
Object.defineProperty(cjsFsPromises, 'open', {
  value: async (...args) => {
    const fh = await realOpen.apply(cjsFsPromises, args);
    const p = args[0];
    if (faultArmed && typeof p === 'string' && faultPrefix && p.startsWith(faultPrefix) && p.endsWith('.tmp')) {
      fh.sync = async () => {
        throw new Error('SIMULATED_EIO: fh.sync() failed after write (Part 2, real writeKeyFile)');
      };
    }
    return fh;
  },
  writable: true,
  configurable: true,
});

// The FIRST import of 'node:fs/promises' anywhere in this process — deliberately after
// the patch above (see the Part 2 header comment). Every later importer of this same
// specifier in this process, including keys.ts's own dynamic import right after, reuses
// this same already-instantiated module record.
({ open, rename, rm, mkdtemp, readFile, readdir } = await import('node:fs/promises'));
const tmp = await mkdtemp(join(tmpdir(), 'cb-keyfile-fsync-cleanup-'));

// Dynamic import, AFTER the patch above — see the comment on the (deliberately absent)
// static import at the top of this file for why.
const { writeKeyFile } = await import('../src/lib/keys.ts');

try {
  // ---------------------------------------------------------------------------
  // Part 1: grounding — reproduce the pre-fix leak in isolation.
  // ---------------------------------------------------------------------------
  {
    const target = join(tmp, 'part1-identity.age');
    const tmpFile = `${target}.tmp`;
    const SECRET = 'AGE-SECRET-KEY-PART1-GROUNDING-MARKER-1a2b3c4d5e6f';
    let threw = null;
    try {
      await preFixWriteKeyFile(target, tmpFile, SECRET, 0o600);
    } catch (e) {
      threw = e;
    }
    check(
      'Part 1 setup: the pre-fix shape actually threw (the injected fh.sync() failure propagated)',
      threw !== null && /SIMULATED_EIO/.test(threw.message),
      threw ? threw.message : '(no throw)',
    );
    const leftover = existsSync(tmpFile);
    check(
      'Part 1 (grounding): the pre-fix shape (cleanup scoped only around rename()) leaves the secret-bearing tmp file behind when fh.sync() fails',
      leftover,
      leftover ? '' : `${tmpFile} does not exist — grounding failed to reproduce the reported bug`,
    );
    if (leftover) {
      const content = await readFile(tmpFile, 'utf8');
      check(
        'Part 1 (grounding): the leftover tmp file holds the FULL, unencrypted secret payload',
        content === SECRET,
        content,
      );
      await rm(tmpFile, { force: true }); // our own grounding artifact — not the fix's job to clean this one up
    }
    check('Part 1 (grounding): the destination path was never created either way', !existsSync(target), '');
  }

  // ---------------------------------------------------------------------------
  // Part 2: the fix — same fault, against the REAL, CURRENT writeKeyFile().
  // ---------------------------------------------------------------------------
  {
    const target = join(tmp, 'part2-identity.age');
    const SECRET = 'AGE-SECRET-KEY-PART2-FIX-MARKER-9z8y7x6w5v4u';
    faultPrefix = `${target}.`;
    faultArmed = true;
    let threw = null;
    try {
      await writeKeyFile(target, SECRET, 0o600, true); // force=true — exercises the tmp-then-rename branch
    } catch (e) {
      threw = e;
    } finally {
      faultArmed = false;
    }
    check(
      'Part 2: writeKeyFile() still propagates the injected fh.sync() failure (the fix must not swallow a real error)',
      threw !== null && /SIMULATED_EIO/.test(threw.message),
      threw ? threw.message : '(no throw)',
    );
    const remaining = (await readdir(tmp)).filter((n) => n.startsWith('part2-identity.age'));
    check(
      'Part 2 (the fix): NO leftover tmp file (or anything else at/under the target name) remains after the injected fh.sync() failure',
      remaining.length === 0,
      `found: ${remaining.join(', ') || '(none)'}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Part 3: signal-guard registration — the same window, closed by an actual SIGTERM
  // instead of writeKeyFile()'s own (in this scenario, unreachable) catch/finally.
  // ---------------------------------------------------------------------------
  {
    const target = join(tmp, 'part3-identity.age');
    const sentinel = join(tmp, 'part3-sentinel');
    const child = spawn('node', [...DEV_ARGS, CHILD_SCRIPT, target, sentinel], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    let exitInfo = null;
    const exited = new Promise((res) => {
      child.on('close', (code, signal) => {
        exitInfo = { code, signal };
        res();
      });
    });

    const barrierDeadline = Date.now() + 15_000;
    while (!existsSync(sentinel) && exitInfo === null && Date.now() < barrierDeadline) await sleep(25);
    const reachedSync = existsSync(sentinel);
    check(
      'Part 3 setup: the child reached fh.sync() with the tmp file already fully written (sentinel appeared)',
      reachedSync,
      reachedSync ? '' : `timed out or exited early — exitInfo=${JSON.stringify(exitInfo)} stdout=${out} stderr=${err}`,
    );

    if (reachedSync) {
      const beforeKill = (await readdir(tmp)).filter((n) => n.startsWith('part3-identity.age.') && n.endsWith('.tmp'));
      check(
        'Part 3 setup: exactly one tmp file exists on disk BEFORE the signal (something real to clean up)',
        beforeKill.length === 1,
        `found ${beforeKill.length}: ${beforeKill.join(', ')}`,
      );
      if (beforeKill.length === 1) {
        const preContent = await readFile(join(tmp, beforeKill[0]), 'utf8');
        check(
          'Part 3 setup: that tmp file already holds the full secret payload before the signal',
          preContent === 'AGE-SECRET-KEY-PART3-MARKER-signal-guard-cleanup',
          preContent,
        );
      }

      child.kill('SIGTERM');
      const killDeadline = Date.now() + 5_000;
      while (exitInfo === null && Date.now() < killDeadline) await sleep(25);
      // SIGKILL here is an emergency escape hatch ONLY (so a broken signal-guard handler
      // can never hang this suite forever) — escalating to it must count as a FAILURE of
      // THIS check, not a silently-accepted alternate success path (Codex review finding):
      // if signal-guard.ts's own SIGTERM handler hung instead of re-raising and
      // terminating, a check that also accepted SIGKILL as "the signal worked" would pass
      // even though the thing actually being tested here (SIGTERM re-raise -> normal
      // termination) never happened.
      const neededSigkillEscalation = exitInfo === null;
      if (neededSigkillEscalation) {
        child.kill('SIGKILL');
        await exited;
      } else {
        await exited;
      }
      check(
        'Part 3: the child process terminated via SIGTERM itself, with no SIGKILL escalation needed',
        !neededSigkillEscalation && exitInfo !== null && exitInfo.signal === 'SIGTERM',
        `neededSigkillEscalation=${neededSigkillEscalation} exitInfo=${JSON.stringify(exitInfo)}`,
      );
      const afterKill = (await readdir(tmp)).filter((n) => n.startsWith('part3-identity.age'));
      check(
        "Part 3 (signal-guard): the tmp file is swept by signal-guard.ts's own SIGTERM handler (registered via addActiveKeyScratchFile) — writeKeyFile()'s own catch/finally never ran, since the process died mid-fh.sync()",
        afterKill.length === 0,
        `found: ${afterKill.join(', ') || '(none)'}`,
      );
    } else {
      if (exitInfo === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Part 4: a Critical finding from a second Codex review pass of this fix — if the
  // catch block's own `rm(tmp, {force:true})` cleanup ITSELF throws, writeKeyFile()
  // must NOT deregister the tmp file from signal-guard.ts's tracked Set (doing so
  // unconditionally would silently drop the only remaining safety net for the secret
  // still on disk). Spawns a child (scripts/selftest-keyfile-fsync-cleanup-child-
  // rmfail.mjs) where BOTH fh.sync() and the async rm() fail — writeKeyFile() throws
  // having failed to clean up its own tmp file — then confirms a REAL SIGTERM
  // afterward still sweeps it via signal-guard's own (separate, unmocked) rmSync,
  // proving the file stayed correctly tracked despite the earlier failed rm().
  // ---------------------------------------------------------------------------
  {
    const target = join(tmp, 'part4-identity.age');
    const sentinel = join(tmp, 'part4-sentinel');
    const childScript = join(HERE, 'selftest-keyfile-fsync-cleanup-child-rmfail.mjs');
    const child = spawn('node', [...DEV_ARGS, childScript, target, sentinel], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    let exitInfo = null;
    const exited = new Promise((res) => {
      child.on('close', (code, signal) => {
        exitInfo = { code, signal };
        res();
      });
    });

    const barrierDeadline = Date.now() + 15_000;
    while (!existsSync(sentinel) && exitInfo === null && Date.now() < barrierDeadline) await sleep(25);
    const reachedSentinel = existsSync(sentinel);
    check(
      'Part 4 setup: the child reached its own sentinel (writeKeyFile() threw, having failed to remove its own tmp file)',
      reachedSentinel,
      reachedSentinel
        ? ''
        : `timed out or exited early — exitInfo=${JSON.stringify(exitInfo)} stdout=${out} stderr=${err}`,
    );

    if (reachedSentinel) {
      const sentinelContent = await readFile(sentinel, 'utf8');
      check(
        'Part 4 setup: writeKeyFile() actually threw (both the injected sync() and rm() failures propagated as expected)',
        /SIMULATED_EIO/.test(sentinelContent) || /SIMULATED_EACCES/.test(sentinelContent),
        sentinelContent,
      );
      const beforeKill = (await readdir(tmp)).filter((n) => n.startsWith('part4-identity.age.') && n.endsWith('.tmp'));
      check(
        "Part 4 setup: the tmp file is STILL on disk (the mocked rm() correctly failed to remove it — this is the state a REAL failed rm() would leave, and it's what makes this test meaningful)",
        beforeKill.length === 1,
        `found ${beforeKill.length}: ${beforeKill.join(', ')}`,
      );

      child.kill('SIGTERM');
      const killDeadline = Date.now() + 5_000;
      while (exitInfo === null && Date.now() < killDeadline) await sleep(25);
      const neededSigkillEscalation = exitInfo === null;
      if (neededSigkillEscalation) {
        child.kill('SIGKILL');
        await exited;
      } else {
        await exited;
      }
      check(
        'Part 4: the child process terminated via SIGTERM itself, with no SIGKILL escalation needed',
        !neededSigkillEscalation && exitInfo !== null && exitInfo.signal === 'SIGTERM',
        `neededSigkillEscalation=${neededSigkillEscalation} exitInfo=${JSON.stringify(exitInfo)}`,
      );
      const afterKill = (await readdir(tmp)).filter((n) => n.startsWith('part4-identity.age'));
      check(
        'Part 4 (the Critical fix): the tmp file IS swept by signal-guard.ts’s real SIGTERM handler even though writeKeyFile()’s own rm() cleanup attempt had failed — proving the file stayed correctly registered rather than being deregistered on a failed cleanup',
        afterKill.length === 0,
        `found: ${afterKill.join(', ') || '(none)'}`,
      );
    } else {
      if (exitInfo === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }
} finally {
  Object.defineProperty(cjsFsPromises, 'open', { value: realOpen, writable: true, configurable: true });
  await rm(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nKEYFILE FSYNC CLEANUP SELFTEST FAIL (${failed})`);
  process.exit(1);
}
console.log('\nKEYFILE FSYNC CLEANUP SELFTEST PASS');
