#!/usr/bin/env node
// Proof for #642: the file backend's get() must not have a check/use (TOCTOU) window
// between hashing the object and copying it — a process with FILE_DIR write access
// swapping the object's bytes AFTER it is hashed but BEFORE it is copied must never
// result in the SWAPPED bytes being served as though they'd passed the locator's own
// content-address check.
//
// Two halves:
//
//   Part 1 (grounding / positive control that the BUG is real): a small, deliberately
//   faithful reimplementation of the PRE-FIX two-step sequence (hash, THEN separately
//   copyFile) — not imported from src/, since that vulnerable code no longer exists —
//   with an explicit swap injected between the two steps. This is not timing-dependent:
//   the test itself sequences "hash -> swap -> copy" directly, so it deterministically
//   reproduces the exact failure mode issue #642 describes (a successful, non-throwing
//   copy whose bytes do NOT match the hash that was actually checked). If this half did
//   NOT reproduce a failure, the rest of this test would be proving nothing.
//
//   Part 2 (the actual fix): the SAME kind of concurrent-overwrite attack, run many
//   times against the REAL, CURRENT fileBackend().get() (src/lib/backends/file.ts) while
//   it is mid-flight, with the object's on-disk bytes overwritten IN PLACE (not renamed
//   — open+truncate+write, the same primitive an attacker with FILE_DIR write access
//   would use) repeatedly for the whole duration of the call. Asserts the invariant that
//   actually matters: get() must NEVER resolve successfully while the bytes it wrote to
//   --out do not match the locator's claimed hash. It also checks (not asserts — see
//   below) whether the hammering actually interfered with at least one attempt, as a
//   sanity signal that this test genuinely raced the real code and isn't vacuously
//   passing because the two operations never actually overlapped.
import { mkdtemp, mkdir, rm, writeFile, readFile, unlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

const tmp = await mkdtemp(join(tmpdir(), 'cb-file-toctou-'));
try {
  const fileDir = join(tmp, 'store');
  const outDir = join(tmp, 'out');
  // Set BEFORE any dynamic import of file.ts/config.ts (import hoisting means a later
  // process.env write would be too late for a STATIC import — see selftest-receipt.mjs's
  // header comment for the exact bug this avoids). fileBackend() itself is the module
  // under test for Part 2; Part 1 deliberately does NOT import it (see header comment).
  process.env.CYPHER_BRAIN_HOME = tmp;
  process.env.CYPHER_BRAIN_FILE_DIR = fileDir;
  const { fileBackend } = await import('../src/lib/backends/file.ts');
  const backend = fileBackend();

  const contentA = randomBytes(24 * 1024 * 1024); // large enough to give a real read some wall-clock duration
  const contentB = randomBytes(4096); // small — a fast overwrite, and a very different length (helps a torn read miss both hashes)
  const claimedHash = sha256hex(contentA); // ground truth, computed independently of any code under test
  const resolved = join(fileDir, `${claimedHash}.age`);
  await mkdir(fileDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  // ---------------------------------------------------------------------------
  // Part 1: the pre-#642-fix sequence, with the swap injected explicitly (not
  // timing-dependent) between the hash step and the copy step.
  // ---------------------------------------------------------------------------
  {
    await writeFile(resolved, contentA);
    const out = join(outDir, 'vulnerable-out.age');
    await rm(out, { force: true });
    // The exact pre-fix shape: hash first, copy second, as two independent reads of
    // `resolved`. The swap sits exactly in the gap #642 reported.
    const gotHashBeforeSwap = sha256hex(await readFile(resolved));
    check('Part 1 setup: pre-swap hash matches the claimed hash', gotHashBeforeSwap === claimedHash);
    await writeFile(resolved, contentB); // the attacker's swap, IN PLACE, same path
    let threw = null;
    try {
      await copyFile(resolved, out); // the vulnerable second, independent read
    } catch (e) {
      threw = e;
    }
    const outHash = threw ? null : sha256hex(await readFile(out));
    check(
      'Part 1 (grounding): the pre-fix hash-then-copy sequence reproduces the reported bug — ' +
        'copyFile succeeds (no throw) yet serves bytes that do NOT match the hash that was checked',
      threw === null && outHash !== claimedHash,
      threw ? `unexpectedly threw: ${threw.message}` : `outHash=${outHash} claimedHash=${claimedHash}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Part 2: the actual fix, raced for real against the current fileBackend().get().
  // ---------------------------------------------------------------------------
  const ITERATIONS = 25;
  let interferenceObserved = 0;
  let neverFalselyVerified = true;
  const unexpectedErrors = [];
  for (let i = 0; i < ITERATIONS; i++) {
    await writeFile(resolved, contentA); // reset to the object matching `claimedHash`
    const out = join(outDir, `race-out-${i}.age`);
    await unlink(out).catch(() => {});

    let hammering = true;
    const hammer = (async () => {
      // Keep overwriting the SAME path in place (open+truncate+write, not a rename) for
      // as long as get() is in flight — this is the FILE_DIR-write-access attacker from
      // #642's threat model, applied continuously rather than as one precisely-timed
      // shot, so at least one overwrite has a real chance of landing mid-read across the
      // 25 iterations without depending on fragile exact-millisecond timing.
      while (hammering) {
        await writeFile(resolved, contentB).catch(() => {});
        await sleep(0);
      }
    })();

    let outcome; // 'resolved' | 'threw'
    let err = null;
    try {
      await backend.get(resolved, out);
      outcome = 'resolved';
    } catch (e) {
      outcome = 'threw';
      err = e;
    } finally {
      hammering = false;
      await hammer;
    }

    if (outcome === 'threw') {
      if (/does not match its own locator hash/.test(err?.message ?? '')) {
        interferenceObserved++;
      } else {
        unexpectedErrors.push(err?.message ?? String(err));
      }
    } else {
      // A successful resolve is fine ONLY if the bytes actually at `out` really do match
      // the claimed hash — this is the invariant the whole fix exists to guarantee.
      const outBuf = await readFile(out);
      const outHash = sha256hex(outBuf);
      if (outHash !== claimedHash) {
        neverFalselyVerified = false;
        console.log(
          `[FAIL] iteration ${i}: get() resolved successfully but out hash ${outHash} != claimed ${claimedHash} — the exact bug #642 reports`,
        );
      }
    }
  }

  check(
    'Part 2: get() never resolves successfully with bytes that do not match the claimed hash, across 25 racing attempts',
    neverFalselyVerified,
  );
  check(
    'Part 2: every thrown error (when the race did interfere) is the expected hash-mismatch refusal, not some other failure',
    unexpectedErrors.length === 0,
    unexpectedErrors.slice(0, 3).join(' | '),
  );
  // Not a hard assertion (environment/disk-speed dependent — a very fast tmpfs COULD
  // legitimately let every one of 25 attempts finish before any hammer write lands),
  // but reported plainly either way per this codebase's "positive control" discipline:
  // the important claim above (no false verification, ever) is asserted unconditionally;
  // this line only tells you whether the race construction actually exercised the
  // concurrent-overwrite path at least once, or whether the invariant held vacuously.
  if (interferenceObserved > 0) {
    console.log(
      `[INFO] the race actually interfered with fileBackend().get() ${interferenceObserved}/${ITERATIONS} times, and every one was correctly refused (hash mismatch) — not vacuous`,
    );
  } else {
    console.log(
      `[INFO] the race never interfered with fileBackend().get() in ${ITERATIONS} attempts on this machine (fast disk/page cache) — ` +
        'the "never falsely verified" assertion above held, but could not be exercised under genuine overlap this run',
    );
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nFILE BACKEND TOCTOU SELFTEST FAIL (${failed})`);
  process.exit(1);
}
console.log('\nFILE BACKEND TOCTOU SELFTEST PASS');
