#!/usr/bin/env node
// Proof for #220's multi-model review (P1 findings 2 + 3): src/lib/idempotency.ts's own
// read/write contract, exercised directly (no MCP server, no push()) since these are pure
// properties of the log file's read-modify-write logic. Run straight off src/*.ts (no
// build step), same as scripts/selftest-progress.mjs.
//
//   - fail-closed reads (finding 2): a read failure that is NOT "the file does not exist
//     yet" (a directory sitting where the log should be) must throw IdempotencyStoreError
//     rather than silently answer "no prior calls" — a caller that cannot tell the
//     difference would let a paid operation proceed on an uncertain read. Likewise a file
//     that DOES read but contains an unparseable line: since there is no way to tell
//     "definitely a different key's corrupted record" apart from "possibly OUR key's,
//     now unreadable", a lookup that finds no exact match among what DID parse must still
//     refuse rather than report a miss.
//   - the ENOENT case (missing file) is unaffected: still a plain cache miss, never an
//     error — this is the overwhelmingly common case (nothing has ever been recorded
//     yet) and must not regress into a false refusal.
//   - concurrent writes (finding 3): recordIdempotencyResult's read-modify-rename has no
//     mutual exclusion of its own, so N calls racing on the SAME log file (each for a
//     DIFFERENT key) used to silently clobber one another — the last rename wins. Firing
//     them concurrently IN ONE PROCESS reproduces the exact race an unguarded
//     read-modify-rename has across separate OS processes too: without a lock, both
//     interleave at the same await points either way. This asserts every key's record
//     survives once withLogLock serializes the writes.
//   - #636 claimIdempotencyKey: a POSITIVE CONTROL for the cross-process claim mcp.ts
//     now takes for the ENTIRE snapshot_now call (not just the log write above) — proof
//     the guard actually fires, not just that it exists. A second claim attempt for the
//     SAME (tool, key) while the first is still held must be rejected outright
//     (IdempotencyClaimHeldError) — this is the exact mechanism that makes the #636 race
//     (a second process reading a stale cache-miss while the first is still mid-upload)
//     impossible: the second process can never even START its own lookup-then-work
//     sequence while the claim is held, regardless of how long either process's own log
//     read takes. Also asserts: two DIFFERENT keys never contend; release lets a new
//     claim through; a claim older than the staleness threshold is stolen (a crashed
//     holder must not wedge the key forever); and — the one non-obvious failure mode a
//     naive stale-steal design invites — releasing a claim that was ALREADY stolen by a
//     later holder must NOT delete that later holder's live claim.
import { mkdtemp, mkdir, rm, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  lookupIdempotencyResult,
  recordIdempotencyResult,
  IdempotencyStoreError,
  claimIdempotencyKey,
  IdempotencyClaimHeldError,
} from '../src/lib/idempotency.ts';

// Must match src/lib/idempotency.ts's own (private) CLAIM_STALE_MS — there is no test
// hook to read it back, so this is kept in sync by hand; a drift here would only make
// the staleness test below wait longer or shorter than necessary, never silently pass.
const CLAIM_STALE_MS = 2 * 60 * 60 * 1000;

// Mirrors idempotency.ts's own (private) claimLockPath — needed here only to backdate a
// claim's mtime directly on disk to simulate a crashed holder, something the public
// claimIdempotencyKey/release API has no legitimate reason to expose.
const claimLockPathFor = (logPath, tool, key) =>
  `${logPath}.claim.${createHash('sha256')
    .update(JSON.stringify([tool, key]))
    .digest('hex')}.lock`;

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const tmp = await mkdtemp(join(tmpdir(), 'cb-idempotency-lib-'));
try {
  // ---------- ENOENT (missing file) is still a plain, error-free cache miss ----------
  {
    const logPath = join(tmp, 'enoent', 'idempotency-log.jsonl');
    const result = await lookupIdempotencyResult(logPath, 'snapshot_now', 'never-seen-key', 86400);
    check('a missing log file is a plain cache miss (no throw)', result === undefined);
  }

  // ---------- fail-closed: a directory sitting where the log file should be ----------
  {
    const logPath = join(tmp, 'blocked-log.jsonl');
    await mkdir(logPath, { recursive: true }); // EISDIR on readFile — not ENOENT
    let threw;
    try {
      await lookupIdempotencyResult(logPath, 'snapshot_now', 'some-key', 86400);
    } catch (e) {
      threw = e;
    }
    check(
      'a non-ENOENT read failure (EISDIR) throws IdempotencyStoreError, not a silent miss',
      threw instanceof IdempotencyStoreError,
      threw ? `${threw.constructor.name}: ${threw.message}` : 'lookup returned normally (no throw)',
    );
  }

  // ---------- fail-closed: a genuinely corrupted line, queried with a DIFFERENT key ----------
  {
    const logPath = join(tmp, 'corrupted-log.jsonl');
    await mkdir(join(tmp), { recursive: true });
    // One well-formed record for "other-key", plus a truncated/garbled line (a crash
    // mid-write, or a hand edit) that fails to parse at all.
    const goodLine = JSON.stringify({
      key: 'other-key',
      tool: 'snapshot_now',
      recordedAt: new Date().toISOString(),
      fingerprint: 'abc',
      result: { pushed: true },
    });
    await writeFile(logPath, `${goodLine}\n{"key": "trunca\n`, { flag: 'w' });

    let threw;
    try {
      await lookupIdempotencyResult(logPath, 'snapshot_now', 'brand-new-key', 86400);
    } catch (e) {
      threw = e;
    }
    check(
      'a corrupted line + no match for the queried key throws IdempotencyStoreError (fail-closed)',
      threw instanceof IdempotencyStoreError,
      threw ? `${threw.constructor.name}: ${threw.message}` : 'lookup returned normally (no throw)',
    );

    // The corruption must not swallow a REAL hit for a key that DOES appear well-formed
    // in the same file — "some other line is corrupt" is not itself grounds to refuse a
    // lookup that already found its answer.
    const hit = await lookupIdempotencyResult(logPath, 'snapshot_now', 'other-key', 86400);
    check(
      'a genuine hit still returns normally even when a DIFFERENT line in the same file is corrupted',
      hit?.fingerprint === 'abc',
      JSON.stringify(hit),
    );
  }

  // ---------- concurrent writes: N racing recordIdempotencyResult calls must not clobber each other ----------
  {
    const logPath = join(tmp, 'concurrent-log.jsonl');
    const N = 12;
    const keys = Array.from({ length: N }, (_, i) => `concurrent-key-${i}`);
    await Promise.all(
      keys.map((key, i) =>
        recordIdempotencyResult(logPath, 'snapshot_now', key, `fp-${i}`, { locator: `loc-${i}` }, 86400),
      ),
    );
    const results = await Promise.all(keys.map((key) => lookupIdempotencyResult(logPath, 'snapshot_now', key, 86400)));
    const lost = keys.filter((_, i) => results[i] === undefined);
    check(
      `all ${N} concurrently-recorded keys survive (none lost to a clobbered rewrite)`,
      lost.length === 0,
      lost.length > 0 ? `lost: ${lost.join(', ')}` : undefined,
    );
    const wrong = keys.filter((_key, i) => results[i] !== undefined && results[i].fingerprint !== `fp-${i}`);
    check(
      'every surviving key kept its OWN fingerprint/result, not a sibling’s',
      wrong.length === 0,
      wrong.length > 0 ? `mismatched: ${wrong.join(', ')}` : undefined,
    );
  }

  // ---------- concurrent writes against a PRE-EXISTING log with an unrelated fresh entry ----------
  {
    // Same race, but this time an existing key (written before the race starts) must
    // ALSO still be there afterward — proving the lock does not just avoid losing the
    // NEW writes to each other, it also protects whatever was already on disk.
    const logPath = join(tmp, 'concurrent-log-2.jsonl');
    await recordIdempotencyResult(logPath, 'snapshot_now', 'pre-existing-key', 'fp-pre', { locator: 'loc-pre' }, 86400);
    const N = 8;
    const keys = Array.from({ length: N }, (_, i) => `race-key-${i}`);
    await Promise.all(
      keys.map((key, i) =>
        recordIdempotencyResult(logPath, 'snapshot_now', key, `fp-${i}`, { locator: `loc-${i}` }, 86400),
      ),
    );
    const preHit = await lookupIdempotencyResult(logPath, 'snapshot_now', 'pre-existing-key', 86400);
    check(
      'a pre-existing entry survives a burst of concurrent writes for OTHER keys',
      preHit?.fingerprint === 'fp-pre',
      JSON.stringify(preHit),
    );
    const results = await Promise.all(keys.map((key) => lookupIdempotencyResult(logPath, 'snapshot_now', key, 86400)));
    const lost = keys.filter((_, i) => results[i] === undefined);
    check(
      `all ${N} new concurrent keys ALSO survive alongside the pre-existing one`,
      lost.length === 0,
      lost.join(', '),
    );
  }

  // ---------- #636 claimIdempotencyKey: positive control — the guard actually fires ----------
  {
    const logPath = join(tmp, 'claim-log.jsonl');

    // A second claim for the SAME key while the first is still held must be rejected —
    // this IS the mechanism that closes #636 (a second caller can never start its own
    // lookup-then-work sequence while the first still holds the claim, no matter how
    // long either caller's own log read takes).
    const releaseA = await claimIdempotencyKey(logPath, 'snapshot_now', 'claim-key-1');
    let secondThrew;
    try {
      await claimIdempotencyKey(logPath, 'snapshot_now', 'claim-key-1');
    } catch (e) {
      secondThrew = e;
    }
    check(
      'a second claim for the SAME (tool, key) while the first is held is rejected (IdempotencyClaimHeldError)',
      secondThrew instanceof IdempotencyClaimHeldError,
      secondThrew ? `${secondThrew.constructor.name}: ${secondThrew.message}` : 'second claim succeeded (BUG)',
    );

    // A DIFFERENT key must never contend with claim-key-1's still-held claim.
    const releaseB = await claimIdempotencyKey(logPath, 'snapshot_now', 'claim-key-2');
    check('a claim for a DIFFERENT key is unaffected by another key’s held claim', true);
    await releaseB();

    // Release must actually free the key for a new claim.
    await releaseA();
    let reclaimThrew;
    let releaseA2;
    try {
      releaseA2 = await claimIdempotencyKey(logPath, 'snapshot_now', 'claim-key-1');
    } catch (e) {
      reclaimThrew = e;
    }
    check(
      'releasing a claim lets a subsequent claim for the SAME key succeed',
      reclaimThrew === undefined,
      reclaimThrew ? `${reclaimThrew.constructor.name}: ${reclaimThrew.message}` : undefined,
    );
    if (releaseA2) await releaseA2();
  }

  // ---------- #636 claimIdempotencyKey: a stale (presumed-crashed) claim is stolen ----------
  {
    const logPath = join(tmp, 'claim-stale-log.jsonl');
    await claimIdempotencyKey(logPath, 'snapshot_now', 'stale-key'); // deliberately never released — simulates a crashed holder
    const lockPath = claimLockPathFor(logPath, 'snapshot_now', 'stale-key');
    const old = new Date(Date.now() - CLAIM_STALE_MS - 1000);
    await utimes(lockPath, old, old);

    let staleThrew;
    let releaseStolen;
    try {
      releaseStolen = await claimIdempotencyKey(logPath, 'snapshot_now', 'stale-key');
    } catch (e) {
      staleThrew = e;
    }
    check(
      'a claim older than the staleness threshold is stolen rather than wedging the key forever',
      staleThrew === undefined,
      staleThrew ? `${staleThrew.constructor.name}: ${staleThrew.message}` : undefined,
    );
    if (releaseStolen) await releaseStolen();
  }

  // ---------- #636 claimIdempotencyKey: releasing a STOLEN claim must not delete the new holder's ----------
  {
    const logPath = join(tmp, 'claim-stolen-release-log.jsonl');
    const releaseOriginal = await claimIdempotencyKey(logPath, 'snapshot_now', 'stolen-key');
    const lockPath = claimLockPathFor(logPath, 'snapshot_now', 'stolen-key');
    const old = new Date(Date.now() - CLAIM_STALE_MS - 1000);
    await utimes(lockPath, old, old);
    // A second caller observes the claim as stale and steals it — this is the NEW
    // legitimate holder from here on.
    const releaseNew = await claimIdempotencyKey(logPath, 'snapshot_now', 'stolen-key');
    const ownerAfterSteal = await readFile(lockPath, 'utf8');

    // The ORIGINAL (unlucky, overran-its-budget) holder finally finishes and calls ITS
    // OWN release — this must be a silent no-op, not a deletion of the new holder's live
    // claim (deleting it here would let a THIRD caller in while the second is still
    // working, exactly the bug this claim exists to prevent).
    await releaseOriginal();
    const ownerAfterOriginalRelease = await readFile(lockPath, 'utf8').catch(() => null);
    check(
      "releasing a stolen claim does not delete the new holder's live claim",
      ownerAfterOriginalRelease === ownerAfterSteal,
      JSON.stringify({ before: ownerAfterSteal, after: ownerAfterOriginalRelease }),
    );
    await releaseNew();
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nIDEMPOTENCY LIB SELFTEST FAIL (${failed})`);
  process.exit(1);
}
console.log('\nIDEMPOTENCY LIB SELFTEST PASS');
