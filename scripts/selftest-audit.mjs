#!/usr/bin/env node
// Proof for #226 — hash-chain audit trail (structured JSONL logging + tamper evidence,
// merged into one mechanism).
//
// Two halves, mirroring scripts/selftest-receipt.mjs's own Part A/B split:
//   Part A exercises src/lib/audit.ts's pure chain math directly against synthetic
//   entries (fast, no CLI process) — this is where the hash-chain verification logic
//   gets real positive-control coverage (deliberately corrupt an entry, confirm
//   verifyAuditChain() actually detects it — a check that's never been observed to
//   fire is unverified).
//   Part B is a real keygen -> snapshot -> push -> restore -> verify sequence through
//   the actual CLI binary, proving the wrapper wiring in pushpull.ts/restore.ts really
//   does append an entry per run (success AND failure), and that `cypher-brain audit`
//   reports the SAME verdict the library function computes.
import { mkdtemp, mkdir, writeFile, rm, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
// Part A: verifyAuditChain() / readAuditLog() against synthetic data
// ---------------------------------------------------------------------------

const tmpA = await mkdtemp(join(tmpdir(), 'cb-audit-unit-'));
try {
  // Set BEFORE importing audit.ts, and via a DYNAMIC import ordered after the env
  // override — a static top-of-file import would pull in config.ts's own env-derived
  // AUDIT_LOG constant at module-load time, BEFORE this override takes effect,
  // silently writing synthetic test data into the REAL default $CYPHER_BRAIN_HOME
  // (the exact bug selftest-receipt.mjs's own header comment documents hitting and
  // fixing in #232 — avoided here from the start).
  //
  // CYPHER_BRAIN_AUDIT_LOG must ALSO be cleared here (Codex review): config.ts's
  // AUDIT_LOG constant is `readEnv('CYPHER_BRAIN_AUDIT_LOG') || join(HOME, ...)` — an
  // operator running this selftest with that override already set in their shell would
  // otherwise have this test's synthetic entries AND its deliberate tampering appended
  // to their REAL audit log, isolation from CYPHER_BRAIN_HOME notwithstanding.
  process.env.CYPHER_BRAIN_HOME = tmpA;
  delete process.env.CYPHER_BRAIN_AUDIT_LOG;
  const { appendAuditEntry, readAuditLog, verifyAuditChain, computeHash } = await import('../src/lib/audit.ts');

  // ENOENT case FIRST, before anything is ever appended: a pristine tmpA has no
  // audit-log.jsonl yet, so this is the real "no log file exists at all" state, not
  // a re-import trick.
  const emptyResult = await readAuditLog();
  check(
    'readAuditLog: no log file yet returns an empty result, not an error',
    emptyResult.entries.length === 0 && emptyResult.skippedLines === 0,
    JSON.stringify(emptyResult),
  );

  const base = {
    backend: 'file',
    locator: null,
    artifact_sha256: 'a'.repeat(64),
    machine: 'test-host',
    recipients_fingerprint: null,
    duration_ms: 5,
  };

  await appendAuditEntry({ ...base, timestamp: '2026-08-01T00:00:00.000Z', command: 'push', exit_code: 0 });
  await appendAuditEntry({ ...base, timestamp: '2026-08-01T00:01:00.000Z', command: 'restore', exit_code: 0 });
  await appendAuditEntry({ ...base, timestamp: '2026-08-01T00:02:00.000Z', command: 'verify', exit_code: 1 });

  const { entries, skippedLines } = await readAuditLog();
  check('readAuditLog: 3 entries survive', entries.length === 3, `got ${entries.length}`);
  check('readAuditLog: skippedLines is 0 on a clean log', skippedLines === 0, `got ${skippedLines}`);
  check('entry 0 has prev_hash null (the very first entry)', entries[0].prev_hash === null, entries[0].prev_hash);
  check(
    'entry 1 chains to entry 0s hash',
    entries[1].prev_hash === entries[0].hash,
    JSON.stringify(entries.map((e) => e.hash)),
  );
  check(
    'entry 2 chains to entry 1s hash',
    entries[2].prev_hash === entries[1].hash,
    JSON.stringify(entries.map((e) => e.hash)),
  );

  const cleanResult = verifyAuditChain(entries);
  check(
    'verifyAuditChain: a clean chain is ok',
    cleanResult.ok === true && cleanResult.brokenAtIndex === null,
    JSON.stringify(cleanResult),
  );
  check('verifyAuditChain: totalEntries matches', cleanResult.totalEntries === 3, cleanResult.totalEntries);

  // Positive control 1: mutate one entry's OWN content without recomputing its hash —
  // its stored hash no longer matches what it should be. Must be detected.
  const tamperedContent = entries.map((e, i) => (i === 1 ? { ...e, exit_code: 999 } : e));
  const contentResult = verifyAuditChain(tamperedContent);
  check(
    'positive control: an entry with altered content (hash now wrong) IS detected',
    contentResult.ok === false && contentResult.brokenAtIndex === 1,
    JSON.stringify(contentResult),
  );

  // Positive control 2: a DIFFERENT kind of break — the entry's own hash IS internally
  // consistent with its content (recomputed here with the real algorithm, via the
  // exported computeHash — Codex review: an earlier version of this test changed
  // prev_hash WITHOUT recomputing the entry's own hash, so it accidentally exercised
  // the SAME content-mismatch branch positive control 1 already covers, not the
  // distinct link-mismatch branch this control is meant to isolate), but its prev_hash
  // no longer points at its actual predecessor (as if a line were deleted/reordered/
  // spliced in). Must ALSO be detected, and detected as a distinct failure mode from
  // control 1.
  const badPrevHash = 'deadbeef'.repeat(8);
  const relinkedEntry = { ...entries[1], prev_hash: badPrevHash };
  const { hash: _oldHash, ...relinkedWithoutHash } = relinkedEntry;
  const recomputedEntry = { ...relinkedWithoutHash, hash: computeHash(relinkedWithoutHash) };
  const tamperedLink = entries.map((e, i) => (i === 1 ? recomputedEntry : e));
  const linkResult = verifyAuditChain(tamperedLink);
  check(
    'positive control: an entry whose prev_hash points at the wrong predecessor IS detected',
    linkResult.ok === false && linkResult.brokenAtIndex === 1,
    JSON.stringify(linkResult),
  );

  // Negative control (nothing broken) already covered by cleanResult above — confirms
  // the two positive controls above are catching a REAL break, not just always firing.
  check(
    'negative control: the ORIGINAL unmodified entries still verify ok (controls above didnt mutate them)',
    verifyAuditChain(entries).ok === true,
  );

  const { AUDIT_LOG } = await import('../src/lib/config.ts');
  await appendFile(AUDIT_LOG, 'not json at all\n');
  await appendFile(AUDIT_LOG, `${JSON.stringify({ cypher_brain_audit_version: 1, command: 'push' })}\n`); // wrong shape (missing required fields)
  const afterGarbage = await readAuditLog();
  check(
    'readAuditLog: a malformed line and a wrong-shape line are both skipped, not fatal',
    afterGarbage.entries.length === 3 && afterGarbage.skippedLines === 2,
    `${JSON.stringify(afterGarbage.entries.length)} ${afterGarbage.skippedLines}`,
  );

  // Positive control: a nullable field (entries[1] is "restore", whose `backend` is
  // ALWAYS null) tampered to a non-null, non-string value must be REJECTED (the whole
  // line skipped), not silently coerced back to null (Codex review, Critical — the
  // original coercion logic let this exact tamper "launder" through unnoticed, since
  // the reconstructed value matched the original null and the stored hash still
  // verified). Appended as its own extra line so it does not disturb the 3-entry chain
  // already established above.
  const nullFieldTamperedRaw = JSON.stringify({ ...entries[1], backend: {} });
  await appendFile(AUDIT_LOG, `${nullFieldTamperedRaw}\n`);
  const afterNullFieldTamper = await readAuditLog();
  check(
    'readAuditLog: a nullable field tampered from null to a non-string value is rejected, not laundered back to null',
    afterNullFieldTamper.entries.length === 3 && afterNullFieldTamper.skippedLines === 3,
    `entries=${afterNullFieldTamper.entries.length} skipped=${afterNullFieldTamper.skippedLines}`,
  );

  // Positive control (#744): two appendAuditEntry() calls racing the SAME await point
  // must not fork the chain. Before the cross-process lock this fix adds, both could
  // read the SAME tail hash (readAuditLog() awaits real file I/O, so two concurrent
  // calls genuinely interleave) and each append an entry whose prev_hash points at it —
  // the second becoming a sibling rather than a child of the first, which
  // verifyAuditChain() then reports as a broken link (a permanent, false "possible
  // tamper" verdict for what was actually two legitimate concurrent runs). Fired via
  // Promise.all (not sequential awaits) onto the log's existing state (3 valid entries
  // plus the malformed/tampered lines appended above, which readAuditLog() already
  // skips) so the two calls' internal readAuditLog()+append critical sections actually
  // have the same tail to race over.
  const beforeConcurrent = await readAuditLog();
  await Promise.all([
    appendAuditEntry({ ...base, timestamp: '2026-08-01T00:03:00.000Z', command: 'push', exit_code: 0 }),
    appendAuditEntry({ ...base, timestamp: '2026-08-01T00:03:00.000Z', command: 'verify', exit_code: 0 }),
  ]);
  const afterConcurrent = await readAuditLog();
  const concurrentVerify = verifyAuditChain(afterConcurrent.entries);
  check(
    'positive control: two concurrent appendAuditEntry() calls do not fork the hash chain (#744)',
    afterConcurrent.entries.length === beforeConcurrent.entries.length + 2 && concurrentVerify.ok === true,
    `before=${beforeConcurrent.entries.length} after=${afterConcurrent.entries.length} verify=${JSON.stringify(concurrentVerify)}`,
  );
} finally {
  delete process.env.CYPHER_BRAIN_HOME;
  delete process.env.CYPHER_BRAIN_AUDIT_LOG;
  await rm(tmpA, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part B: a real CLI push/restore/verify sequence -> real audit entries -> `audit`
// ---------------------------------------------------------------------------

const tmp = await mkdtemp(join(tmpdir(), 'cb-audit-e2e-'));
try {
  const env = { ...process.env, CYPHER_BRAIN_HOME: join(tmp, 'keys') };
  delete env.CYPHER_BRAIN_AUDIT_LOG; // this Part B block's own env, unrelated to Part A's overrides above
  const cb = (extraEnv, ...args) =>
    spawnSync('node', [...DEV_ARGS, BIN, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const cbOk = (extraEnv, ...args) => {
    const r = cb(extraEnv, ...args);
    if (r.status !== 0) throw new Error(`cb ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  };

  const auditLogPath = join(tmp, 'keys', 'audit-log.jsonl');
  const readLog = async () => {
    try {
      return (await readFile(auditLogPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  const startEmpty = await readLog();
  check('no audit log yet before any command runs', startEmpty.length === 0, `got ${startEmpty.length}`);

  const src = join(tmp, 'brain');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'note.txt'), 'audit selftest\n');
  cbOk({}, 'keygen');
  cbOk({}, 'snapshot', '--dir', src, '--out', join(tmp, 'snap.age'));

  const fileEnv = { CYPHER_BRAIN_FILE_DIR: join(tmp, 'store') };
  const loc = cbOk(fileEnv, 'push', '--in', join(tmp, 'snap.age'), '--backend', 'file');
  let entries = await readLog();
  check('push appends exactly one audit entry', entries.length === 1, `got ${entries.length}`);
  check('the entry command is "push"', entries[0]?.command === 'push', entries[0]?.command);
  check('the entry locator matches what push printed', entries[0]?.locator === loc, `${entries[0]?.locator} vs ${loc}`);
  check('the entry exit_code is 0', entries[0]?.exit_code === 0, entries[0]?.exit_code);
  check('the first entry has prev_hash null', entries[0]?.prev_hash === null, entries[0]?.prev_hash);

  cbOk({}, 'restore', '--in', join(tmp, 'snap.age'), '--out-dir', join(tmp, 'restored'));
  entries = await readLog();
  check(
    'restore appends a second audit entry, chained to the first',
    entries.length === 2 && entries[1]?.prev_hash === entries[0]?.hash,
    JSON.stringify(entries.map((e) => e.command)),
  );
  check('the second entry command is "restore"', entries[1]?.command === 'restore', entries[1]?.command);

  cbOk({}, 'verify', '--in', join(tmp, 'snap.age'));
  entries = await readLog();
  check(
    'verify appends a third audit entry, chained to the second',
    entries.length === 3 && entries[2]?.prev_hash === entries[1]?.hash,
    JSON.stringify(entries.map((e) => e.command)),
  );
  check(
    'the third entry command is "verify" with exit_code 0 (verify --level quick PASSed)',
    entries[2]?.command === 'verify' && entries[2]?.exit_code === 0,
    JSON.stringify(entries[2]),
  );

  const jsonReport = JSON.parse(cbOk({}, 'audit', '--json'));
  check('cypher-brain audit --json reports total_entries=3', jsonReport.total_entries === 3, jsonReport.total_entries);
  check(
    'cypher-brain audit --json reports chain_valid=true on a clean log',
    jsonReport.chain_valid === true,
    JSON.stringify(jsonReport),
  );

  // #458: `entries` must expose the FULL trail (previously only `last_entry`, forcing
  // anyone who wanted entries 0/1 to hand-parse audit-log.jsonl outside the CLI). Check
  // both the count AND field-by-field correctness against the real on-disk log read
  // directly (readLog()) — not just that SOME array showed up.
  check(
    'cypher-brain audit --json "entries" includes all 3 entries, not just the last one',
    Array.isArray(jsonReport.entries) && jsonReport.entries.length === 3,
    JSON.stringify(jsonReport.entries),
  );
  check(
    'audit --json "entries" is in log order (oldest first): push, restore, verify',
    jsonReport.entries?.[0]?.command === 'push' &&
      jsonReport.entries?.[1]?.command === 'restore' &&
      jsonReport.entries?.[2]?.command === 'verify',
    JSON.stringify(jsonReport.entries?.map((e) => e.command)),
  );
  for (let i = 0; i < entries.length; i++) {
    check(
      `audit --json "entries"[${i}] matches the on-disk entry field-by-field (hash/prev_hash/timestamp/exit_code)`,
      jsonReport.entries?.[i]?.hash === entries[i].hash &&
        jsonReport.entries?.[i]?.prev_hash === entries[i].prev_hash &&
        jsonReport.entries?.[i]?.timestamp === entries[i].timestamp &&
        jsonReport.entries?.[i]?.command === entries[i].command &&
        jsonReport.entries?.[i]?.exit_code === entries[i].exit_code &&
        jsonReport.entries?.[i]?.machine === entries[i].machine,
      `${JSON.stringify(jsonReport.entries?.[i])} vs ${JSON.stringify(entries[i])}`,
    );
  }
  check(
    'audit --json "entries"[2] (the last one) equals "last_entry" (same object, not two different reads)',
    JSON.stringify(jsonReport.entries?.[2]) === JSON.stringify(jsonReport.last_entry),
    `${JSON.stringify(jsonReport.entries?.[2])} vs ${JSON.stringify(jsonReport.last_entry)}`,
  );

  const humanReport = cbOk({}, 'audit');
  check('cypher-brain audit (human) reports VERDICT: PASS', /VERDICT: PASS/.test(humanReport), humanReport);

  // Positive control: a DELETED/unreadable TRAILING entry, with the REMAINING entries
  // still forming a perfectly valid chain among themselves — the exact "chain
  // truncation" attack Codex review flagged (Warning): dropping the last entry
  // entirely leaves nothing downstream to notice it is missing, so `verifyAuditChain()`
  // alone reports `ok: true` on the survivors. `audit` must still fail overall, because
  // an unreadable line is exactly what a deleted/corrupted entry looks like. Run on
  // the CURRENT clean 3-entry log (backed up and restored afterward) — not after the
  // later hand-corrupt test below, which leaves line 0's hash broken and would corrupt
  // this test's own premise (an otherwise-VALID chain among the survivors).
  const cleanLogBackup = await readFile(auditLogPath, 'utf8');
  const linesForTruncation = cleanLogBackup.trim().split('\n');
  linesForTruncation[linesForTruncation.length - 1] = 'not json at all — simulates a deleted/corrupted entry';
  await writeFile(auditLogPath, `${linesForTruncation.join('\n')}\n`);
  const truncatedJsonRun = cb({}, 'audit', '--json');
  const truncatedJsonParsed = JSON.parse(truncatedJsonRun.stdout);
  check(
    'a chain-truncation (unreadable trailing line) reports chain_valid=true for the readable survivors...',
    truncatedJsonParsed.chain_valid === true,
    JSON.stringify(truncatedJsonParsed),
  );
  check(
    '...but skipped_lines is 1, and the OVERALL --json exit code is still non-zero (not silently PASS)',
    truncatedJsonParsed.skipped_lines === 1 && truncatedJsonRun.status === 1,
    `status=${truncatedJsonRun.status} ${JSON.stringify(truncatedJsonParsed)}`,
  );
  const truncatedHuman = cb({}, 'audit');
  check(
    'cypher-brain audit (human) reports VERDICT: FAIL on a chain-truncation, not PASS',
    truncatedHuman.status === 1 && /VERDICT: FAIL/.test(truncatedHuman.stdout),
    `status=${truncatedHuman.status} stdout=${truncatedHuman.stdout}`,
  );
  await writeFile(auditLogPath, cleanLogBackup); // restore the clean 3-entry log for the tests below

  // Positive control: force restore to fail (a bad --identity path), confirm the
  // FAILURE path still records an entry, not just the success path.
  const badRestore = cb(
    {},
    'restore',
    '--in',
    join(tmp, 'snap.age'),
    '--out-dir',
    join(tmp, 'restored2'),
    '--identity',
    join(tmp, 'no-such-identity.age'),
  );
  check('a deliberately-failing restore exits non-zero', badRestore.status !== 0, badRestore.status);
  entries = await readLog();
  check(
    'the failing restore STILL appended an audit entry (failure path records too)',
    entries.length === 4,
    `got ${entries.length}`,
  );
  // typeof ... === 'number', not just `!== 0` (Codex review): the prior check above
  // already fails when entries.length !== 4, but `entries[3]?.exit_code !== 0` on its
  // own would ALSO read true (and silently pass) if entries[3] did not exist at all —
  // undefined !== 0 is true. Requiring a number closes that.
  check(
    'the failed entry has a non-zero exit_code',
    typeof entries[3]?.exit_code === 'number' && entries[3].exit_code !== 0,
    entries[3]?.exit_code,
  );
  check(
    'the failed entry is still correctly chained',
    entries[3]?.prev_hash === entries[2]?.hash,
    JSON.stringify(entries.slice(2)),
  );

  // Positive control: an audit-log write failure must not fail the underlying
  // command. Same "not-a-directory" blocker-file trick selftest-receipt.mjs already
  // uses for CYPHER_BRAIN_RECEIPT_LEDGER.
  const blockerFile = join(tmp, 'not-a-directory');
  await writeFile(blockerFile, 'x');
  const blockedEnv = { CYPHER_BRAIN_AUDIT_LOG: join(blockerFile, 'audit-log.jsonl') };
  const blockedPush = cb(blockedEnv, 'push', '--in', join(tmp, 'snap.age'), '--backend', 'file');
  check(
    'push still succeeds (exit 0) when the audit log cannot be written',
    blockedPush.status === 0,
    `status=${blockedPush.status} stderr=${blockedPush.stderr.slice(0, 300)}`,
  );
  check(
    'push warns about the audit-write failure without treating it as a push failure',
    /could not append to the audit log/.test(blockedPush.stderr),
    blockedPush.stderr.slice(0, 300),
  );
  check(
    'the real locator still printed on stdout despite the audit-write failure',
    blockedPush.stdout.trim().length > 0,
    blockedPush.stdout,
  );

  // Positive control: hand-corrupt the real on-disk log, confirm `audit` reports FAIL.
  const raw = await readFile(auditLogPath, 'utf8');
  const lines = raw.trim().split('\n');
  const corrupted = JSON.parse(lines[0]);
  corrupted.exit_code = 999; // content changed, hash NOT recomputed -> chain must break
  lines[0] = JSON.stringify(corrupted);
  await writeFile(auditLogPath, `${lines.join('\n')}\n`);
  const corruptedCheck = cb({}, 'audit');
  check(
    'cypher-brain audit reports VERDICT: FAIL on a hand-corrupted log',
    corruptedCheck.status === 1 && /VERDICT: FAIL/.test(corruptedCheck.stdout),
    `status=${corruptedCheck.status} stdout=${corruptedCheck.stdout}`,
  );
  // audit --json also exits 1 on a broken chain, so read the run via cb() not cbOk()
  // (cbOk() would throw on the non-zero exit). The exit status itself is asserted below
  // (Codex review) — sibling to the chain-truncation check above, which already checks
  // `truncatedJsonRun.status === 1` alongside its parsed fields; without it, a regression
  // that made `audit --json` exit 0 on a broken chain would still pass here.
  const corruptedJsonRun = cb({}, 'audit', '--json');
  const corruptedJsonParsed = JSON.parse(corruptedJsonRun.stdout);
  check(
    'cypher-brain audit --json reports chain_valid=false and broken_at_index=0, and exits non-zero',
    corruptedJsonRun.status === 1 &&
      corruptedJsonParsed.chain_valid === false &&
      corruptedJsonParsed.broken_at_index === 0,
    `status=${corruptedJsonRun.status} ${JSON.stringify(corruptedJsonParsed)}`,
  );

  console.log('== audit selftest: end-to-end checks complete ==');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAUDIT SELFTEST: ALL PASS');
