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
import { mkdtemp, mkdir, writeFile, rm, appendFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { DEV_ARGS } from './dev-node-flags.mjs';
import { sha256 } from '../src/lib/util.ts';

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

  // Positive control (#744), SAME-PROCESS interleaving: two appendAuditEntry() calls
  // racing the SAME await point, both fired from THIS process via Promise.all, must
  // not fork the chain. Before the lock this fix adds, both could read the SAME tail
  // hash (readAuditLog() awaits real file I/O, so two concurrent calls genuinely
  // interleave within a single event loop) and each append an entry whose prev_hash
  // points at it — the second becoming a sibling rather than a child of the first,
  // which verifyAuditChain() then reports as a broken link (a permanent, false
  // "possible tamper" verdict for what was actually two legitimate concurrent runs).
  //
  // This exercises the SAME lock code path (withAuditLogLock's `wx`-flag exclusive
  // create) a genuine second OS PROCESS would, but it does not itself prove the lock
  // works ACROSS a process boundary — an in-process mutex would pass this exact check
  // too. That distinct claim (the whole point of a filesystem-based lock over an
  // in-process one: this log is written by separate push/restore/verify CLI/MCP
  // invocations, not concurrent calls within one process) gets its own, separate
  // positive control below ("cross-process lock proof"), using two real child
  // processes — do not read this check alone as cross-process coverage.
  const beforeConcurrent = await readAuditLog();
  await Promise.all([
    appendAuditEntry({ ...base, timestamp: '2026-08-01T00:03:00.000Z', command: 'push', exit_code: 0 }),
    appendAuditEntry({ ...base, timestamp: '2026-08-01T00:03:00.000Z', command: 'verify', exit_code: 0 }),
  ]);
  const afterConcurrent = await readAuditLog();
  const concurrentVerify = verifyAuditChain(afterConcurrent.entries);
  check(
    'positive control: two SAME-PROCESS concurrent appendAuditEntry() calls do not fork the hash chain (#744)',
    afterConcurrent.entries.length === beforeConcurrent.entries.length + 2 && concurrentVerify.ok === true,
    `before=${beforeConcurrent.entries.length} after=${afterConcurrent.entries.length} verify=${JSON.stringify(concurrentVerify)}`,
  );
} finally {
  delete process.env.CYPHER_BRAIN_HOME;
  delete process.env.CYPHER_BRAIN_AUDIT_LOG;
  await rm(tmpA, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part A2: cross-process lock proof (real OS processes, not just same-process
// interleaving) — closes the gap the check above deliberately does NOT cover.
// ---------------------------------------------------------------------------
//
// Spawns two REAL, separate `node` child processes (spawn(), run concurrently — never
// spawnSync(), which would serialize them and prove nothing about concurrent access),
// each making many appendAuditEntry() calls against the SAME on-disk audit log via the
// SAME withAuditLogLock() the CLI itself uses. A start barrier (both children poll for
// a "go" file that this script only creates once BOTH have signaled ready) synchronizes
// their first call as closely as two independent OS processes can be synchronized, and
// each child records its own loop's [start, end] wall-clock window so this script can
// verify AFTERWARD that the two processes' windows actually overlapped — i.e. that this
// was genuine concurrent execution across a process boundary, not one process finishing
// before the other started (which would prove nothing about the lock). Only once that
// overlap is confirmed does the resulting merged chain's integrity mean anything for
// the cross-process claim specifically.
const tmpCross = await mkdtemp(join(tmpdir(), 'cb-audit-crossproc-'));
try {
  const crossHome = join(tmpCross, 'home');
  await mkdir(crossHome, { recursive: true });
  const barrierFile = join(tmpCross, 'go');
  const auditUrl = pathToFileURL(join(ROOT, 'src', 'lib', 'audit.ts')).href;
  const CALLS_PER_PROCESS = 30;

  // The worker is a plain .mjs file (not embedded via `node -e`) so it goes through
  // the SAME --experimental-strip-types + dev-ts-resolve-hook.mjs pipeline every other
  // dev-mode script in this repo already relies on to import audit.ts's `.js`-suffixed
  // relative imports (config.js et al. actually resolve to .ts source — see
  // dev-cli-loader.mjs) — `node -e`'s eval script does not reliably inherit the same
  // resolution behavior for its OWN relative imports the way a real file on disk does.
  const workerPath = join(tmpCross, 'cross-proc-worker.mjs');
  await writeFile(
    workerPath,
    [
      `import { writeFile, stat } from 'node:fs/promises';`,
      `const [, , label, countStr, barrierFile, readyDir, auditUrl] = process.argv;`,
      `const count = Number(countStr);`,
      // Import BEFORE signaling ready / polling the barrier (Codex review after a
      // measured flake): dynamic-importing audit.ts (parsing + type-stripping the
      // module graph) takes an amount of wall time that varies process-to-process for
      // reasons that have nothing to do with the lock (module cache warmth, OS
      // scheduling of whichever process happens to start first) — measured directly:
      // moving this import to AFTER the barrier let one process's import finish, run,
      // and complete its ENTIRE loop before the other process's own import had even
      // resolved, so their [start, end] windows never overlapped despite both crossing
      // the barrier close together — a false "not concurrent" flake with nothing to do
      // with the lock (reproduced once in 3 runs). Importing first means both
      // processes are equally ready to call appendAuditEntry() the instant the barrier
      // appears, so the measured loop window starts from the same footing for both.
      `const { appendAuditEntry } = await import(auditUrl);`,
      `await writeFile(\`\${readyDir}/\${label}.ready\`, '1');`,
      `const deadline = Date.now() + 10_000;`,
      `for (;;) {`,
      `  try { await stat(barrierFile); break; } catch {}`,
      `  if (Date.now() > deadline) { console.error(\`\${label}: barrier timeout\`); process.exit(2); }`,
      `  await new Promise((r) => setTimeout(r, 2));`,
      `}`,
      // AuditEntry.command is a closed union ('push' | 'restore' | 'verify' — see
      // audit.ts's own type and its validateAndParse() shape check) — an arbitrary
      // per-process label there (this file's earlier draft used the literal worker
      // label, e.g. 'cross-a') gets SILENTLY skipped as a wrong-shape line by
      // readAuditLog() rather than throwing, so every entry from either process would
      // read back as if it had never been written (a false "readAuditLog always sees
      // 0 entries" symptom this file's own author hit and root-caused while writing
      // this check — see the isolated single-process, zero-concurrency repro this
      // comment is next to in the PR). The per-process identity that actually matters
      // for THIS check (which process wrote which entry, for the interleaving/overlap
      // check below) rides on `machine` instead, which is a free-form string.
      `const validCommands = ['push', 'restore', 'verify'];`,
      `const startNs = process.hrtime.bigint();`,
      `for (let i = 0; i < count; i++) {`,
      `  await appendAuditEntry({`,
      `    backend: 'file', locator: null, artifact_sha256: 'a'.repeat(64), machine: label,`,
      `    recipients_fingerprint: null, duration_ms: 1, timestamp: new Date().toISOString(),`,
      `    command: validCommands[i % validCommands.length], exit_code: 0,`,
      `  });`,
      `}`,
      `const endNs = process.hrtime.bigint();`,
      `await writeFile(\`\${readyDir}/\${label}.window.json\`, JSON.stringify({ startNs: startNs.toString(), endNs: endNs.toString() }));`,
      '',
    ].join('\n'),
  );

  // Dropped, not set to `undefined` (spawn's env option requires string values —
  // Codex review): an operator running this selftest with CYPHER_BRAIN_AUDIT_LOG
  // already exported would otherwise leak this synthetic cross-process data into
  // their REAL audit log, isolation from CYPHER_BRAIN_HOME notwithstanding — the same
  // guard Part A takes above.
  const { CYPHER_BRAIN_AUDIT_LOG: _unusedCrossAuditLog, ...crossBaseEnv } = process.env;
  const spawnWorker = (label) => {
    const child = spawn(
      'node',
      [...DEV_ARGS, workerPath, label, String(CALLS_PER_PROCESS), barrierFile, tmpCross, auditUrl],
      {
        cwd: ROOT,
        env: { ...crossBaseEnv, CYPHER_BRAIN_HOME: crossHome },
      },
    );
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    return new Promise((resolve) => {
      const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.on('close', (code) => {
        clearTimeout(killer);
        resolve({ code, stderr });
      });
      child.on('error', (err) => {
        clearTimeout(killer);
        resolve({ code: 'SPAWN_ERROR', stderr: String(err) });
      });
    });
  };

  const childA = spawnWorker('cross-a');
  const childB = spawnWorker('cross-b');

  // Wait for both children's ready markers (bounded), THEN drop the barrier file — this
  // is what makes their first appendAuditEntry() call start as close to simultaneously
  // as two independent processes can, rather than one racing ahead while the other is
  // still being spawned/loading modules.
  const readyDeadline = Date.now() + 10_000;
  for (;;) {
    const [aReady, bReady] = await Promise.all([
      stat(join(tmpCross, 'cross-a.ready')).then(
        () => true,
        () => false,
      ),
      stat(join(tmpCross, 'cross-b.ready')).then(
        () => true,
        () => false,
      ),
    ]);
    if (aReady && bReady) break;
    if (Date.now() > readyDeadline) {
      check('cross-process lock proof: both workers signaled ready before the barrier timeout', false, 'timed out');
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await writeFile(barrierFile, '1');

  const [resultA, resultB] = await Promise.all([childA, childB]);
  check(
    'cross-process lock proof: both real child processes exited 0',
    resultA.code === 0 && resultB.code === 0,
    `a=${resultA.code} (${resultA.stderr.slice(0, 300)}) b=${resultB.code} (${resultB.stderr.slice(0, 300)})`,
  );

  const readWindow = async (label) => JSON.parse(await readFile(join(tmpCross, `${label}.window.json`), 'utf8'));
  const [windowA, windowB] = await Promise.all([readWindow('cross-a'), readWindow('cross-b')]);
  const aStart = BigInt(windowA.startNs);
  const aEnd = BigInt(windowA.endNs);
  const bStart = BigInt(windowB.startNs);
  const bEnd = BigInt(windowB.endNs);
  // The actual "this was really concurrent, not two serialized processes" proof: each
  // process's own [start, end] wall-clock window (from ITS OWN process.hrtime.bigint(),
  // recorded only after crossing the shared barrier) must overlap the other's. Two
  // processes that happened to run one fully after the other (no genuine OS-level
  // concurrency) would fail this — and would make the "no fork" check below prove
  // nothing about cross-process safety specifically (an in-process mutex, or even no
  // lock at all serialized by luck, would also pass a chain that was never actually
  // raced).
  const windowsOverlap = aStart < bEnd && bStart < aEnd;
  check(
    "cross-process lock proof: the two child processes' append loops actually overlapped in wall-clock time (genuine concurrency, not accidental serialization)",
    windowsOverlap,
    `a=[${aStart},${aEnd}] b=[${bStart},${bEnd}]`,
  );

  const rawCross = await readFile(join(crossHome, 'audit-log.jsonl'), 'utf8');
  const crossEntries = rawCross
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const { verifyAuditChain: verifyAuditChainCross } = await import(auditUrl);
  const crossVerify = verifyAuditChainCross(crossEntries);
  check(
    `cross-process lock proof: ${CALLS_PER_PROCESS * 2} entries from two genuinely-concurrent OS processes survive without forking the hash chain (#744)`,
    crossEntries.length === CALLS_PER_PROCESS * 2 && crossVerify.ok === true,
    `entries=${crossEntries.length} expected=${CALLS_PER_PROCESS * 2} verify=${JSON.stringify(crossVerify)}`,
  );
} finally {
  await rm(tmpCross, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part A3: direct cross-process lock CONTENTION proof (Codex review) — closes a gap
// Part A2 above deliberately does not: two processes racing a REALISTIC workload not
// forking the chain is consistent with the lock working, but is ALSO consistent with
// the two processes simply never actually colliding (e.g. one gets fully descheduled
// while the other runs its entire loop, then resumes — their recorded whole-loop
// [start,end] windows can still "overlap" on paper without a single individual
// operation ever truly racing). That is not a hypothetical: it is exactly the failure
// mode Codex's review named for Part A2's own overlap check. This test instead proves
// the lock's mutual exclusion DIRECTLY, the classic way — one process holds it for a
// known duration, a second process's OWN attempt to acquire it is timed, and that
// timing must show it was genuinely BLOCKED, not that it happened to run when the
// resource was free.
// ---------------------------------------------------------------------------

const tmpA3 = await mkdtemp(join(tmpdir(), 'cb-audit-lockproof-'));
try {
  const homeA3 = join(tmpA3, 'home');
  await mkdir(homeA3, { recursive: true });
  const auditUrl = pathToFileURL(join(ROOT, 'src', 'lib', 'audit.ts')).href;
  const HOLD_MS = 1500;

  // HOLDER: acquires the lock, signals "acquired" (via a marker file, BEFORE sleeping —
  // this is what lets the waiter below know it is safe to start timing its own attempt,
  // rather than possibly racing the holder to create the lock file first), holds it for
  // exactly HOLD_MS, THEN — still fully inside the critical section, before returning —
  // writes a SECOND marker ("holder-critical-section-done"). That second marker, not
  // elapsed wall-clock time, is what the waiter below checks for (Codex review — see
  // its own comment): a purely timing-based threshold cannot distinguish genuine mutual
  // exclusion from the waiter "winning" this lock's own stale-lock-steal path (a real,
  // by-design feature for crash recovery — AUDIT_LOCK_STALE_MS) part-way through the
  // hold; a deterministic ordering marker can. import() happens up FRONT (Codex review),
  // not after any wait, so module load time is never a hidden component of a measured
  // window.
  const holderWorkerPath = join(tmpA3, 'holder-worker.mjs');
  await writeFile(
    holderWorkerPath,
    [
      `import { writeFile } from 'node:fs/promises';`,
      `const [, , holdMsStr, readyDir, auditUrl] = process.argv;`,
      `const holdMs = Number(holdMsStr);`,
      `const { withAuditLogLock } = await import(auditUrl);`,
      `const result = {};`,
      `await withAuditLogLock(async () => {`,
      `  result.acquiredNs = process.hrtime.bigint().toString();`,
      `  await writeFile(\`\${readyDir}/holder-acquired\`, '1');`,
      `  await new Promise((r) => setTimeout(r, holdMs));`,
      `  await writeFile(\`\${readyDir}/holder-critical-section-done\`, '1');`,
      `  result.releasedNs = process.hrtime.bigint().toString();`,
      `});`,
      `await writeFile(\`\${readyDir}/holder-result.json\`, JSON.stringify(result));`,
      '',
    ].join('\n'),
  );

  // WAITER: imports FIRST (Codex review — module load time is never consumed from the
  // measured hold window), then polls for the holder-acquired marker (proof the lock is
  // genuinely held before this process's OWN timed attempt begins), then calls
  // withAuditLogLock() itself. The DETERMINISTIC check happens INSIDE that call's own
  // callback: it checks whether holder-critical-section-done already exists — if this
  // waiter's callback is running at all, it holds the SAME lock the holder just held, so
  // that marker's presence or absence at exactly this moment is a direct, ordering-based
  // (not timing-based) answer to "did I enter only after the holder's critical section
  // truly finished". Wall-clock elapsed time is still recorded too, but only as a
  // secondary diagnostic — never the pass/fail condition.
  const waiterWorkerPath = join(tmpA3, 'waiter-worker.mjs');
  await writeFile(
    waiterWorkerPath,
    [
      `import { writeFile, stat } from 'node:fs/promises';`,
      `const [, , readyDir, auditUrl] = process.argv;`,
      `const { withAuditLogLock } = await import(auditUrl);`,
      `const deadline = Date.now() + 10_000;`,
      `for (;;) {`,
      `  try { await stat(\`\${readyDir}/holder-acquired\`); break; } catch {}`,
      `  if (Date.now() > deadline) { console.error('waiter: holder-acquired marker timeout'); process.exit(2); }`,
      `  await new Promise((r) => setTimeout(r, 5));`,
      `}`,
      `const callStartNs = process.hrtime.bigint();`,
      `let enteredAfterHolderFinished = null;`,
      `await withAuditLogLock(async () => {`,
      `  enteredAfterHolderFinished = await stat(\`\${readyDir}/holder-critical-section-done\`).then(`,
      `    () => true,`,
      `    () => false,`,
      `  );`,
      `});`,
      `const acquiredNs = process.hrtime.bigint();`,
      `await writeFile(`,
      `  \`\${readyDir}/waiter-result.json\`,`,
      `  JSON.stringify({ callStartNs: callStartNs.toString(), acquiredNs: acquiredNs.toString(), enteredAfterHolderFinished }),`,
      `);`,
      '',
    ].join('\n'),
  );

  const { CYPHER_BRAIN_AUDIT_LOG: _unusedLockProofAuditLog, ...lockProofBaseEnv } = process.env;
  const spawnLockProofWorker = (scriptPath, args) => {
    const child = spawn('node', [...DEV_ARGS, scriptPath, ...args], {
      cwd: ROOT,
      env: { ...lockProofBaseEnv, CYPHER_BRAIN_HOME: homeA3 },
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    return new Promise((resolve) => {
      const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.on('close', (code) => {
        clearTimeout(killer);
        resolve({ code, stderr });
      });
      child.on('error', (err) => {
        clearTimeout(killer);
        resolve({ code: 'SPAWN_ERROR', stderr: String(err) });
      });
    });
  };

  const [holderResult, waiterResult] = await Promise.all([
    spawnLockProofWorker(holderWorkerPath, [String(HOLD_MS), tmpA3, auditUrl]),
    spawnLockProofWorker(waiterWorkerPath, [tmpA3, auditUrl]),
  ]);
  check(
    'lock contention proof: both the holder and waiter processes exited 0',
    holderResult.code === 0 && waiterResult.code === 0,
    `holder=${holderResult.code} (${holderResult.stderr.slice(0, 300)}) waiter=${waiterResult.code} (${waiterResult.stderr.slice(0, 300)})`,
  );

  const holderData = JSON.parse(await readFile(join(tmpA3, 'holder-result.json'), 'utf8'));
  const waiterData = JSON.parse(await readFile(join(tmpA3, 'waiter-result.json'), 'utf8'));
  const waitedMs = Number(BigInt(waiterData.acquiredNs) - BigInt(waiterData.callStartNs)) / 1e6;
  // PRIMARY assertion: deterministic ordering, not a timing threshold (Codex review,
  // 2nd pass — a pure "waited >= 750ms" check cannot distinguish genuine mutual
  // exclusion from the waiter entering PART-WAY through the holder's hold via this
  // lock's own by-design stale-lock-steal path, confirmed reachable with a mutated
  // stale threshold in review). `enteredAfterHolderFinished` is read by the WAITER's
  // OWN callback, at the exact moment it holds the lock, checking whether the holder
  // had already written its "critical section done" marker — this can only be true if
  // the waiter's entry happened strictly after the holder's own work finished,
  // regardless of how long that took or by what path the waiter eventually got in.
  check(
    `lock contention proof: the waiter's OWN callback observes the holder's critical section had already finished before it entered (deterministic ordering, not a timing threshold) — direct proof of cross-process mutual exclusion (#744, Codex review)`,
    waiterData.enteredAfterHolderFinished === true,
    `enteredAfterHolderFinished=${waiterData.enteredAfterHolderFinished} waited=${waitedMs.toFixed(1)}ms (diagnostic only) holder=${JSON.stringify(holderData)} waiter=${JSON.stringify(waiterData)}`,
  );
  // SECONDARY, diagnostic-only — logged, NOT asserted via check() (Codex review: an
  // earlier version of this used check() here too, which DOES fail the whole suite on
  // false, directly contradicting this comment's own "not asserted as pass/fail"). The
  // primary assertion above is the deterministic ordering check; this is only useful
  // context in the PASS case, and a merely-slow-but-still-correctly-serialized waiter
  // (scheduling jitter, slow module load) must never fail the suite over it.
  console.log(
    `       (diagnostic) waiter waited ${waitedMs.toFixed(0)}ms of a ${HOLD_MS}ms hold — not itself pass/fail`,
  );
} finally {
  await rm(tmpA3, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part B: a real CLI push/restore/verify sequence -> real audit entries -> `audit`
// ---------------------------------------------------------------------------

const tmp = await mkdtemp(join(tmpdir(), 'cb-audit-e2e-'));
try {
  const env = { ...process.env, CYPHER_BRAIN_HOME: join(tmp, 'keys') };
  delete env.CYPHER_BRAIN_AUDIT_LOG; // this Part B block's own env, unrelated to Part A's overrides above
  // Bounded, matching the convention this codebase's OTHER real-CLI-subprocess selftests
  // already use for spawnSync (mcp-smoke.mjs's own runCli(): "a hung setup call must fail
  // loudly, not wedge the whole suite" — 30s there too; ton-dogfood.mjs uses the same
  // `timeout` option, just with a far larger bound because IT genuinely waits on a real
  // remote network seeder). Every command in this Part B sequence (keygen/snapshot/push/
  // restore/verify/audit against the file backend) is local-only with no network call, so
  // 30s is generous headroom, not a tuned budget. Before this, `cb()` had NO timeout at
  // all — unlike this file's own Part A2 cross-process workers above (which bound their
  // OWN child processes) and unlike selftest-otel.mjs's runDoctor() (spawn()+watchdog) —
  // so a genuinely wedged CLI invocation here would hang this selftest indefinitely with
  // no internal diagnostic, relying entirely on CI's outer 30-MINUTE job timeout (and
  // giving no clue which specific command inside this file actually stalled) instead of
  // failing loudly and immediately.
  const CB_TIMEOUT_MS = 30_000;
  const cb = (extraEnv, ...args) =>
    spawnSync('node', [...DEV_ARGS, BIN, ...args], {
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: CB_TIMEOUT_MS,
      // killSignal: 'SIGKILL', not spawnSync's own 'SIGTERM' default (Codex review): a
      // child that installs its OWN signal handling (this codebase's CLI has exactly
      // that — see restore.ts's signal-guard work) can catch/defer SIGTERM and keep
      // running past this "bound", since spawnSync sends the kill signal once and then
      // simply keeps waiting for the child to actually exit rather than escalating.
      // SIGKILL cannot be caught, ignored, or deferred by any process, so it is the only
      // choice here that makes this an actual HARD bound rather than a polite request a
      // wedged/handler-catching child could outlive.
      killSignal: 'SIGKILL',
    });
  const cbOk = (extraEnv, ...args) => {
    const r = cb(extraEnv, ...args);
    // `r.error` (Codex review, matching ton-dogfood.mjs's own cb()): spawnSync sets this
    // on a failure to spawn AT ALL (e.g. PATH corruption) OR when `timeout` fires — in the
    // timeout case `status` is null and `signal` is 'SIGKILL' (this file's own killSignal
    // override above), which the OLD `r.status !== 0` check alone already treats as a
    // failure, but silently: `r.stderr || r.stdout` for a killed-mid-run process is easy
    // to misread as "the command printed nothing", not "the command was killed after 30s
    // and never got the chance to". Naming the signal and `r.error`'s own message closes
    // that ambiguity.
    if (r.error || r.status !== 0)
      throw new Error(
        `cb ${args.join(' ')} failed (status=${r.status}${r.signal ? ` signal=${r.signal}` : ''}): ` +
          `${r.error ? r.error.message : r.stderr || r.stdout}`,
      );
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

  // Ground truth for the TOCTOU-fix positive controls below: the real sha256 of the
  // pushed/restored/verified artifact, computed independently of anything push()/
  // restore()/verify() themselves do.
  const snapDigest = await sha256(join(tmp, 'snap.age'));

  const fileEnv = { CYPHER_BRAIN_FILE_DIR: join(tmp, 'store') };
  const loc = cbOk(fileEnv, 'push', '--in', join(tmp, 'snap.age'), '--backend', 'file');
  let entries = await readLog();
  check('push appends exactly one audit entry', entries.length === 1, `got ${entries.length}`);
  check('the entry command is "push"', entries[0]?.command === 'push', entries[0]?.command);
  check('the entry locator matches what push printed', entries[0]?.locator === loc, `${entries[0]?.locator} vs ${loc}`);
  check('the entry exit_code is 0', entries[0]?.exit_code === 0, entries[0]?.exit_code);
  check('the first entry has prev_hash null', entries[0]?.prev_hash === null, entries[0]?.prev_hash);
  // Multi-model review, TOCTOU fix: push() now reads this digest itself, once, before
  // pushCore() starts — recordAudit() no longer reopens --in by path after the fact.
  // Confirms the threaded-through value actually lands in the recorded entry (and is
  // correct), not just that SOME value shows up.
  check(
    'the push entry records the artifact digest it actually pushed (TOCTOU fix, not a reopen-by-path)',
    entries[0]?.artifact_sha256 === snapDigest,
    `${entries[0]?.artifact_sha256} vs ${snapDigest}`,
  );

  cbOk({}, 'restore', '--in', join(tmp, 'snap.age'), '--out-dir', join(tmp, 'restored'));
  entries = await readLog();
  check(
    'restore appends a second audit entry, chained to the first',
    entries.length === 2 && entries[1]?.prev_hash === entries[0]?.hash,
    JSON.stringify(entries.map((e) => e.command)),
  );
  check('the second entry command is "restore"', entries[1]?.command === 'restore', entries[1]?.command);
  // Same TOCTOU-fix control as push above: restore() now threads through the SAME
  // #785 pinned-descriptor baseline digest restoreImpl() already computes for its own
  // in-place-overwrite check, instead of recordAudit() reopening --in afterward.
  check(
    'the restore entry records the artifact digest it actually restored (TOCTOU fix, not a reopen-by-path)',
    entries[1]?.artifact_sha256 === snapDigest,
    `${entries[1]?.artifact_sha256} vs ${snapDigest}`,
  );

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
  // TOCTOU fix: --level quick WITHOUT --sha256 never computes a full-file digest at all
  // (forcing one unconditionally would cost verify --level quick an extra full read on
  // every artifact, however large) — recordAudit() must record `null` here, not a value
  // reopened by path from whatever happens to be at --in right now.
  check(
    'a --level quick verify WITHOUT --sha256 records no artifact digest (avoids an unconditional extra full-file read)',
    entries[2]?.artifact_sha256 === null,
    entries[2]?.artifact_sha256,
  );

  // A --level quick verify WITH --sha256 DOES already compute the full digest (to
  // compare against the pin) — that SAME value must be the one recordAudit() gets,
  // still without any reopen-by-path. Run against an isolated audit log so this extra
  // invocation does not perturb the `entries` index arithmetic the rest of Part B below
  // relies on.
  const pinnedAuditLogPath = join(tmp, 'pinned-audit-log.jsonl');
  cbOk({ CYPHER_BRAIN_AUDIT_LOG: pinnedAuditLogPath }, 'verify', '--in', join(tmp, 'snap.age'), '--sha256', snapDigest);
  const pinnedEntries = (await readFile(pinnedAuditLogPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  check(
    'a --level quick verify WITH --sha256 records the digest it just checked against the pin',
    pinnedEntries.length === 1 &&
      pinnedEntries[0]?.command === 'verify' &&
      pinnedEntries[0]?.artifact_sha256 === snapDigest,
    JSON.stringify(pinnedEntries),
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
