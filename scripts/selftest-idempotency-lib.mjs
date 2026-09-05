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
//     claim through; a manually-removed claim (the supported recovery path for a
//     confirmed-crashed holder — see claimIdempotencyKey's own doc comment for why there
//     is deliberately no AUTOMATIC steal) can be re-claimed; and releasing a claim after
//     it was manually removed and re-claimed by someone else must NOT delete that new
//     holder's live claim.
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
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

// Mirrors idempotency.ts's own (private) claimLockPath — needed here only to simulate an
// operator manually removing a confirmed-crashed holder's lock file directly, something
// the public claimIdempotencyKey/release API has no legitimate reason to expose.
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
    const wrong = keys.filter(
      (_key, i) =>
        results[i] !== undefined && (results[i].fingerprint !== `fp-${i}` || results[i].result?.locator !== `loc-${i}`),
    );
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

  // ---------- #636 claimIdempotencyKey: held claim's error names the lock file + gives an age hint ----------
  {
    const logPath = join(tmp, 'claim-message-log.jsonl');
    const release = await claimIdempotencyKey(logPath, 'snapshot_now', 'message-key');
    const lockPath = claimLockPathFor(logPath, 'snapshot_now', 'message-key');
    let threw;
    try {
      await claimIdempotencyKey(logPath, 'snapshot_now', 'message-key');
    } catch (e) {
      threw = e;
    }
    check(
      "a held claim's error names the lock file path (an operator's recovery entry point) and gives an age hint",
      threw instanceof IdempotencyClaimHeldError &&
        threw.message.includes(lockPath) &&
        /\d+ minute/.test(threw.message),
      threw ? threw.message : 'did not throw (BUG)',
    );
    await release();
  }

  // ---------- #636 claimIdempotencyKey: manual removal (the supported recovery path) unblocks a new claim ----------
  {
    // There is deliberately NO automatic staleness-based steal (see claimIdempotencyKey's
    // own doc comment) — recovering from a confirmed-crashed holder is an operator action:
    // remove the named lock file by hand. Simulated here the same way an operator would,
    // by deleting the file directly rather than calling the crashed holder's own release
    // (which, by definition, a crashed process never gets to call).
    const logPath = join(tmp, 'claim-manual-recovery-log.jsonl');
    await claimIdempotencyKey(logPath, 'snapshot_now', 'crashed-key'); // deliberately never released — simulates a crashed holder
    const lockPath = claimLockPathFor(logPath, 'snapshot_now', 'crashed-key');
    await rm(lockPath, { force: true }); // the operator's manual intervention

    let reclaimThrew;
    let releaseRecovered;
    try {
      releaseRecovered = await claimIdempotencyKey(logPath, 'snapshot_now', 'crashed-key');
    } catch (e) {
      reclaimThrew = e;
    }
    check(
      'a manually-removed claim can be re-claimed (the supported recovery path for a confirmed-crashed holder)',
      reclaimThrew === undefined,
      reclaimThrew ? `${reclaimThrew.constructor.name}: ${reclaimThrew.message}` : undefined,
    );
    if (releaseRecovered) await releaseRecovered();
  }

  // ---------- #636 claimIdempotencyKey: releasing after manual removal + re-claim must not delete the new holder's ----------
  {
    const logPath = join(tmp, 'claim-recovered-release-log.jsonl');
    const releaseOriginal = await claimIdempotencyKey(logPath, 'snapshot_now', 'recovered-key');
    const lockPath = claimLockPathFor(logPath, 'snapshot_now', 'recovered-key');
    await rm(lockPath, { force: true }); // an operator, believing the original holder crashed, removes it
    // A second caller claims the now-vacant key — this is the NEW legitimate holder.
    const releaseNew = await claimIdempotencyKey(logPath, 'snapshot_now', 'recovered-key');
    const ownerAfterRecover = await readFile(lockPath, 'utf8');

    // The ORIGINAL caller was not actually gone (the operator's belief was wrong, or it
    // simply finishes late) and finally calls ITS OWN release — this must be a silent
    // no-op, not a deletion of the new holder's live claim (deleting it here would let a
    // THIRD caller in while the second is still working, exactly the bug this claim
    // exists to prevent).
    await releaseOriginal();
    const ownerAfterOriginalRelease = await readFile(lockPath, 'utf8').catch(() => null);
    check(
      "releasing a claim after manual removal + re-claim does not delete the new holder's live claim",
      ownerAfterOriginalRelease === ownerAfterRecover,
      JSON.stringify({ before: ownerAfterRecover, after: ownerAfterOriginalRelease }),
    );
    await releaseNew();
  }

  // ---------- #818: disposition/retention round-trip ----------
  {
    const logPath = join(tmp, 'disposition-log.jsonl');
    await recordIdempotencyResult(logPath, 'snapshot_now', 'plain-key', 'fp-plain', { pushed: true }, 86400);
    await recordIdempotencyResult(
      logPath,
      'snapshot_now',
      'uncertain-key',
      'fp-uncertain',
      { code: 'ERR_PUSH_OUTCOME_UNCERTAIN', check_identifier: 'tx-abc' },
      86400,
      Date.now(),
      { disposition: 'error', retention: 'permanent' },
    );
    const plain = await lookupIdempotencyResult(logPath, 'snapshot_now', 'plain-key', 86400);
    check(
      'a record written with no options reads back as success/ttl (the pre-#818 defaults)',
      plain?.disposition === 'success' && plain?.retention === 'ttl',
      JSON.stringify(plain),
    );
    const tombstone = await lookupIdempotencyResult(logPath, 'snapshot_now', 'uncertain-key', 86400);
    check(
      'an error/permanent record round-trips both fields AND its result payload',
      tombstone?.disposition === 'error' &&
        tombstone?.retention === 'permanent' &&
        tombstone?.result?.check_identifier === 'tx-abc',
      JSON.stringify(tombstone),
    );
  }

  // ---------- #818: the TTL does not govern a permanent record, and compaction keeps it ----------
  {
    // The whole point of the tombstone: expiry must not be what unblocks a key whose
    // payment was never settled. Both halves are asserted — the TTL check on LOOKUP, and
    // the survival of the rewrite that recordIdempotencyResult performs for another key
    // (which is where an expired record is actually dropped from the file).
    const logPath = join(tmp, 'permanent-ttl-log.jsonl');
    const longAgo = Date.now() - 90 * 24 * 3600 * 1000; // 90 days back, against a 1s TTL below
    await recordIdempotencyResult(logPath, 'snapshot_now', 'ttl-key', 'fp-ttl', { pushed: true }, 86400, longAgo);
    await recordIdempotencyResult(
      logPath,
      'snapshot_now',
      'permanent-key',
      'fp-perm',
      { code: 'ERR_PUSH_OUTCOME_UNCERTAIN' },
      86400,
      longAgo,
      { disposition: 'error', retention: 'permanent' },
    );
    const staleTtl = await lookupIdempotencyResult(logPath, 'snapshot_now', 'ttl-key', 1);
    check(
      'a 90-day-old ttl record is expired by a 1s TTL (the control)',
      staleTtl === undefined,
      JSON.stringify(staleTtl),
    );
    const stalePermanent = await lookupIdempotencyResult(logPath, 'snapshot_now', 'permanent-key', 1);
    check(
      'a 90-day-old PERMANENT record is still returned under the same 1s TTL',
      stalePermanent?.disposition === 'error' && stalePermanent?.retention === 'permanent',
      JSON.stringify(stalePermanent),
    );
    // A later write for an UNRELATED key rewrites the whole file — the moment an expired
    // record is dropped. The permanent one must survive that compaction.
    await recordIdempotencyResult(logPath, 'snapshot_now', 'other-key', 'fp-other', { pushed: true }, 1);
    const afterCompaction = await lookupIdempotencyResult(logPath, 'snapshot_now', 'permanent-key', 1);
    check(
      'a PERMANENT record survives the compaction that drops the expired ttl record beside it',
      afterCompaction?.retention === 'permanent',
      await readFile(logPath, 'utf8'),
    );
    const droppedTtl = (await readFile(logPath, 'utf8')).includes('"ttl-key"');
    check('the expired ttl record beside it WAS dropped by that same compaction (the control)', !droppedTtl);
  }

  // ---------- #818: a permanent record cannot be superseded by a ttl one ----------
  {
    // Positive control for the guard, not just its absence: the write is attempted and
    // must be REFUSED, and the tombstone must still be readable afterwards. (No caller
    // reaches this today — mcp.ts replays the tombstone before it could ever record
    // again — which is exactly why the invariant is enforced here rather than argued.)
    const logPath = join(tmp, 'permanent-immutable-log.jsonl');
    await recordIdempotencyResult(
      logPath,
      'snapshot_now',
      'tombstoned-key',
      'fp-tomb',
      { code: 'ERR_PUSH_OUTCOME_UNCERTAIN', check_identifier: 'tx-keep-me' },
      86400,
      Date.now(),
      { disposition: 'error', retention: 'permanent' },
    );
    let overwriteThrew;
    try {
      await recordIdempotencyResult(logPath, 'snapshot_now', 'tombstoned-key', 'fp-tomb', { pushed: true }, 86400);
    } catch (e) {
      overwriteThrew = e;
    }
    check(
      'a ttl-retention write for a key holding a PERMANENT record is refused (fail-closed)',
      overwriteThrew instanceof IdempotencyStoreError,
      overwriteThrew ? `${overwriteThrew.constructor.name}: ${overwriteThrew.message}` : 'the write succeeded (BUG)',
    );
    // ...and so is a PERMANENT one: a permanent write carries the default
    // disposition 'success', so allowing it would let an ordinary success replace the
    // uncertain-spend tombstone and turn its replay back into a clean success.
    let permanentOverwriteThrew;
    try {
      await recordIdempotencyResult(
        logPath,
        'snapshot_now',
        'tombstoned-key',
        'fp-tomb',
        { pushed: true },
        86400,
        Date.now(),
        { retention: 'permanent' },
      );
    } catch (e) {
      permanentOverwriteThrew = e;
    }
    check(
      'a PERMANENT write for that key is refused too (a success must not replace an error tombstone)',
      permanentOverwriteThrew instanceof IdempotencyStoreError,
      permanentOverwriteThrew
        ? `${permanentOverwriteThrew.constructor.name}: ${permanentOverwriteThrew.message}`
        : 'the write succeeded (BUG)',
    );
    const survived = await lookupIdempotencyResult(logPath, 'snapshot_now', 'tombstoned-key', 86400);
    check(
      'the tombstone survived that refused write, unchanged',
      survived?.retention === 'permanent' && survived?.result?.check_identifier === 'tx-keep-me',
      JSON.stringify(survived),
    );
    // The control: another key's ordinary write is unaffected by the guard.
    let unrelatedThrew;
    try {
      await recordIdempotencyResult(logPath, 'snapshot_now', 'unrelated-key', 'fp-unrelated', { pushed: true }, 86400);
    } catch (e) {
      unrelatedThrew = e;
    }
    check(
      'control: an ordinary write for a DIFFERENT key still succeeds alongside the tombstone',
      unrelatedThrew === undefined,
      unrelatedThrew ? `${unrelatedThrew.constructor.name}: ${unrelatedThrew.message}` : undefined,
    );
  }

  // ---------- #818: a corrupted log is never REWRITTEN, only refused ----------
  {
    // recordIdempotencyResult rewrites the whole file from the lines it could parse, so a
    // line it could NOT parse is dropped by the next write. If that line held a permanent
    // tombstone, the rewrite would produce a clean log with nothing left to refuse the
    // retry. Fail closed instead — the same posture lookup already takes for a read.
    const logPath = join(tmp, 'corrupt-rewrite-log.jsonl');
    const tombstone = JSON.stringify({
      key: 'permanent-key',
      tool: 'snapshot_now',
      recordedAt: new Date().toISOString(),
      fingerprint: 'fp-perm',
      result: { code: 'ERR_PUSH_OUTCOME_UNCERTAIN' },
      disposition: 'error',
      retention: 'permanent',
    });
    await writeFile(logPath, `${tombstone}\n{"key": "trunca\n`, { flag: 'w' });
    let writeThrew;
    try {
      await recordIdempotencyResult(logPath, 'snapshot_now', 'some-new-key', 'fp-new', { pushed: true }, 86400);
    } catch (e) {
      writeThrew = e;
    }
    check(
      'a write against a log with an unparseable line is refused, not allowed to rewrite it',
      writeThrew instanceof IdempotencyStoreError,
      writeThrew ? `${writeThrew.constructor.name}: ${writeThrew.message}` : 'the write succeeded (BUG)',
    );
    const onDisk = await readFile(logPath, 'utf8');
    check(
      'the permanent record AND the corrupted line both survive that refusal',
      onDisk.includes('"retention":"permanent"') && onDisk.includes('{"key": "trunca'),
      onDisk.slice(0, 400),
    );
  }

  // ---------- #818: a record written before these fields existed still reads ----------
  {
    // Backward compatibility on disk, exercised against a line written by hand in the
    // EXACT pre-#818 shape (no disposition, no retention, no version field — the format
    // never had one). Every deployed cypher-brain has such lines already.
    const logPath = join(tmp, 'legacy-format-log.jsonl');
    const legacy = JSON.stringify({
      key: 'legacy-key',
      tool: 'snapshot_now',
      recordedAt: new Date().toISOString(),
      fingerprint: 'fp-legacy',
      result: { pushed: true, locator: 'legacy-locator' },
    });
    await writeFile(logPath, `${legacy}\n`, { flag: 'w' });
    const hit = await lookupIdempotencyResult(logPath, 'snapshot_now', 'legacy-key', 86400);
    check(
      'a pre-#818 record (no disposition/retention on disk) still replays, as success/ttl',
      hit?.fingerprint === 'fp-legacy' &&
        hit?.result?.locator === 'legacy-locator' &&
        hit?.disposition === 'success' &&
        hit?.retention === 'ttl',
      JSON.stringify(hit),
    );

    // ...and a line that DOES carry the fields but with a value outside the closed set is
    // not silently reinterpreted: it fails the shape check, which makes the file read as
    // corrupted and a lookup for another key fail closed (the same posture a truncated
    // line already gets). Reading `disposition: "successs"` as a success is how an error
    // tombstone would quietly come back as a clean replay.
    const bogus = JSON.stringify({
      key: 'bogus-key',
      tool: 'snapshot_now',
      recordedAt: new Date().toISOString(),
      fingerprint: 'fp-bogus',
      result: { pushed: true },
      disposition: 'successs',
    });
    const bogusPath = join(tmp, 'bogus-disposition-log.jsonl');
    await writeFile(bogusPath, `${bogus}\n`, { flag: 'w' });
    let bogusThrew;
    try {
      await lookupIdempotencyResult(bogusPath, 'snapshot_now', 'some-other-key', 86400);
    } catch (e) {
      bogusThrew = e;
    }
    check(
      'a record with an out-of-set disposition is treated as corrupt (fail-closed), not read as a success',
      bogusThrew instanceof IdempotencyStoreError,
      bogusThrew ? `${bogusThrew.constructor.name}: ${bogusThrew.message}` : 'lookup returned normally (BUG)',
    );
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nIDEMPOTENCY LIB SELFTEST FAIL (${failed})`);
  process.exit(1);
}
console.log('\nIDEMPOTENCY LIB SELFTEST PASS');
