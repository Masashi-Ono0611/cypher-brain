#!/usr/bin/env node
// Positive control for the elevated-caution regression review on PR #871's fsync
// durability hardening (src/lib/idempotency.ts), across its final (round 3) design.
//
//   ROUND 1, Finding 2: a failure in the durability check for a claim/lock file's own
//   exclusive create must not leave that file behind. No rival holder exists in that case
//   and no real work has started under the claim — so leaving it in place would
//   permanently refuse every future retry of (tool, key) with IdempotencyClaimHeldError
//   (claimIdempotencyKey), or time out every future write to that log forever
//   (withLogLock, once combined with round 1's own live-pid fix — a confirmed-alive pid
//   is never stolen by staleness alone), even once the underlying transient I/O fault
//   clears, because neither lock ever auto-steals.
//
//   ROUND 2 (bounded Codex re-review of round 1's fix) tried an fstat-identity-based
//   cleanup (capture (dev, ino) the instant the exclusive create succeeds; on a later
//   failure, `stat()` the path again and `rm()` it only if the identity still matches) —
//   and a re-review of THAT found it still had two gaps: the stat()-then-rm() was itself
//   a TOCTOU (a replacement claim landing between those two calls got deleted anyway),
//   and the `fh.stat()` identity capture was itself a new failure point (if it failed,
//   cleanup was skipped and an EMPTY claim leaked forever). Round 2 also tried moving
//   claimIdempotencyKey's ancestor-directory sync EARLIER (before the claim's own
//   exclusive step), which turned out to be a WORSE regression: it removed mutual
//   exclusion for whatever ran before it, letting two same-key callers both pass the
//   unguarded early sync and race to claim.
//
//   ROUND 3 (this file) is the actual shipped design: write-then-link, the SAME pattern
//   push-lock.ts's own publishLock() already uses (see idempotency.ts's own comments at
//   claimIdempotencyKey/withLogLock for the full rationale). A private, uniquely-named
//   staging file is written and fsync'd FIRST; only THEN is it atomically PUBLISHED to
//   the shared lock/claim path via `link`. This eliminates rounds 1-2's whole failure
//   class structurally rather than mitigating it: a failure before `link()` succeeds
//   needs no path-based cleanup logic at all (staging's name is unique to that attempt,
//   so nothing else could ever be racing for it), and there is no separate identity-
//   capture step to fail. The ancestor-directory sync stays AFTER the claim is published
//   (round 2's reorder is reverted), preserving mutual exclusion.
//
// THIS LIVES IN ITS OWN PROCESS, not scripts/selftest-idempotency-lib.mjs, because of how
// the fault injection below has to work, and it is fussier than it looks — spelled out here
// because getting this wrong produces a test that silently never exercises the fault at all
// (verified against multiple failure modes while writing this file):
//
//   1. There is no way to pass a fake `fs` implementation into src/lib/idempotency.ts (it
//      imports `node:fs/promises` directly, and this codebase's own header comment rules
//      out a new runtime dependency for a test double), so the only lever is reassigning
//      the SAME shared `node:fs/promises` module object idempotency.ts's own `import {
//      open, link } from 'node:fs/promises'` resolves against. The ESM named-import form
//      is read-only (`fsp.open = ...` on a namespace object throws), so this obtains a
//      mutable reference via `createRequire` instead (Node's CJS/ESM interop for a
//      builtin shares one underlying exports object between the two forms).
//   2. That reassignment only reaches an ES module whose OWN `open`/`link` bindings are
//      linked to it AFTER the reassignment runs, so idempotency.ts must be imported
//      dynamically, second.
//   3. Empirically (Node 24.13, this codebase's --experimental-strip-types dev loader): the
//      FIRST time anything in a process imports ANY named export of `node:fs/promises` via
//      ESM — a static top-level `import { mkdtemp } from 'node:fs/promises'` in THIS file
//      included, even though `open`/`link` are not among the names it imports — that first
//      touch fixes the bindings every later ESM consumer of that module sees for EVERY
//      export, including ones a later `require('node:fs/promises')`-based reassignment can
//      no longer reach — even a freshly re-imported (cache-busted) copy of idempotency.ts
//      itself. So this file deliberately avoids importing `node:fs/promises` via ESM at
//      all (no `mkdtemp`/`rm`/`readFile`/`readdir` from it at the top): every fs call
//      below, ours and idempotency.ts's, goes through the ONE `require('node:fs/promises')`
//      result so the mock is guaranteed to be the first and only binding anything in this
//      process ever sees for it.
//   4. The exclusive-create ('wx') open() call this file needs to fault-inject is now on
//      the STAGING path (`<lock>.staging.<random>`), not the shared lock/claim path
//      itself — claimIdempotencyKey's own ancestor-directory sync ALSO opens `dir` with
//      flag 'r' (via util.ts's fsyncPath) at various points, so the mock below is scoped
//      to flag === 'wx' specifically (an unfiltered "next open() call of any kind" mock
//      was verified, while writing this file, to silently fault that read-mode
//      directory-sync open instead, making every assertion pass trivially without ever
//      exercising the intended failure).
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// Mirrors idempotency.ts's own (private) claimLockPath — needed here only to name the
// exact claim-lock path a test expects to see (or not see) real content published at.
const claimLockPathFor = (logPath, tool, key) =>
  `${logPath}.claim.${createHash('sha256')
    .update(JSON.stringify([tool, key]))
    .digest('hex')}.lock`;

// The FIRST touch of `node:fs/promises` anywhere in this process — see point 3 above for
// why every other fs call in this file goes through `fsp`, not a separate ESM import.
const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const origOpen = fsp.open;
const origLink = fsp.link;

// Every `open(path, 'r')` call this process makes — this is how util.ts's fsyncPath()
// syncs a directory, so this is the ground truth for "was this directory actually synced,
// by anyone" that the ancestor-sync-ownership test below checks against.
const dirSyncOpens = [];

// One-shot: makes the very NEXT EXCLUSIVE-CREATE ('wx') open()'d handle's own `sync()`
// throw — this is now always the STAGING file's own create (see point 4 above) —
// simulating a durability check that fails right after that exclusive create already
// succeeded (fsync is otherwise essentially never observed to fail on a healthy local
// filesystem, so there is no portable way to provoke this without a fault-injected mock).
let failNextOpenSync = false;
// One-shot, mutually exclusive with the above: makes the NEXT EXCLUSIVE-CREATE ('wx')
// opened handle's own `sync()` PAUSE (an unresolved promise this test controls) before
// eventually SUCCEEDING (not failing) — simulating a genuinely SLOW-but-legitimate fsync
// (this file's whole reason to exist per PR #871, no fault at all), so a test can
// deterministically interleave a concurrent SAME-key caller into the gap between "staging
// content is durable" and "this attempt has published its claim".
let pauseNextOpenSync = null; // set to a function to call once paused; null = inactive
let resumePausedOpenSync = null;
// Same shape as the above, but for the very NEXT DIRECTORY sync (flag 'r', how util.ts's
// fsyncPath() syncs a directory — see the ancestor-sync-timing test below) rather than a
// staging file's own exclusive-create ('wx') — used to prove the round-4 fix actually
// makes a WINNING caller WAIT for a slow ancestor sync, not merely discharge it eventually.
let pauseNextDirSync = null;
let resumePausedDirSync = null;
// One-shot: makes the very NEXT directory sync (flag 'r') throw IMMEDIATELY (not paused)
// — used for the round-5 "same caller must not miss its own registered failure" test:
// an immediate failure settles (and the map's cleanup removes it) almost instantly,
// well before this SAME caller's own staging+link work (real, slower I/O) finishes and
// comes back to check on it — the exact timing round 5 found a caller could exploit to
// silently swallow its own failure via a map-lookup-only check.
let failNextDirSync = false;
fsp.open = async (...args) => {
  const fh = await origOpen(...args);
  if (args[1] === 'r') {
    dirSyncOpens.push(args[0]);
    if (failNextDirSync) {
      failNextDirSync = false;
      fh.sync = async () => {
        throw new Error('SIMULATED_ANCESTOR_SYNC_FAILURE');
      };
    } else if (pauseNextDirSync) {
      const announce = pauseNextDirSync;
      pauseNextDirSync = null;
      const originalSync = fh.sync.bind(fh);
      fh.sync = async () => {
        announce();
        await new Promise((r) => {
          resumePausedDirSync = r;
        });
        return originalSync();
      };
    }
  }
  if (failNextOpenSync && args[1] === 'wx') {
    failNextOpenSync = false;
    fh.sync = async () => {
      throw new Error('SIMULATED_FSYNC_FAILURE');
    };
  } else if (pauseNextOpenSync && args[1] === 'wx') {
    const announce = pauseNextOpenSync;
    pauseNextOpenSync = null;
    const originalSync = fh.sync.bind(fh);
    fh.sync = async () => {
      announce();
      await new Promise((r) => {
        resumePausedOpenSync = r;
      });
      return originalSync();
    };
  }
  return fh;
};

// One-shot: makes the NEXT `link()` call fail with a NON-EEXIST error, simulating a
// filesystem fault at the actual publish step (distinct from an ordinary "someone already
// holds it" EEXIST, which every existing lookup/claim test already exercises via natural
// contention).
let failNextLink = null;
// One-shot, mutually exclusive with the above: makes the NEXT `link()` call ACTUALLY
// SUCCEED (the real filesystem operation runs, so the shared path really is published)
// but still REPORT a non-EEXIST error to the caller — simulating an ambiguous RPC/network
// filesystem failure mode (ESTALE/ETIMEDOUT-style on NFS) where the server completed the
// operation but the client never received confirmation of it.
let ambiguousNextLink = null;
fsp.link = async (...args) => {
  if (failNextLink) {
    const code = failNextLink;
    failNextLink = null;
    throw Object.assign(new Error(code), { code });
  }
  if (ambiguousNextLink) {
    const code = ambiguousNextLink;
    ambiguousNextLink = null;
    await origLink(...args);
    throw Object.assign(new Error(code), { code });
  }
  return origLink(...args);
};

// Every entry in `dir` whose name contains `.staging.` — used to prove a failed attempt
// leaves NO stray staging file behind, whatever else it does or does not do.
const strayStagingFiles = async (dir) => {
  const names = await fsp.readdir(dir).catch(() => []);
  return names.filter((n) => n.includes('.staging.'));
};

// Dynamically imported AFTER the mocks above are installed, and the ONLY import of this
// module anywhere in this process — see the header comment for why that ordering matters.
const idemPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'idempotency.ts');
const { claimIdempotencyKey, IdempotencyClaimHeldError, recordIdempotencyResult, IdempotencyStoreError } = await import(
  idemPath
);

const tmp = await fsp.mkdtemp(join(tmpdir(), 'cb-idempotency-claim-durability-'));
try {
  // ================= claimIdempotencyKey =================
  {
    const logPath = join(tmp, 'log.jsonl');
    const dir = dirname(logPath);
    const lockPath = claimLockPathFor(logPath, 'snapshot_now', 'durability-fail-key');

    // ---------- a staging-file durability-check failure propagates, cleanly ----------
    failNextOpenSync = true;
    let threw;
    try {
      await claimIdempotencyKey(logPath, 'snapshot_now', 'durability-fail-key');
    } catch (e) {
      threw = e;
    }
    check(
      'a durability-check failure on the staging file propagates to the caller',
      threw instanceof Error && threw.message === 'SIMULATED_FSYNC_FAILURE',
      threw ? `${threw.constructor.name}: ${threw.message}` : 'no throw (BUG — the injected fault never fired)',
    );

    // ---------- no stray staging file, and the shared claim path was never touched ----------
    const strays = await strayStagingFiles(dir);
    check(
      'the failed attempt leaves no stray staging file behind',
      strays.length === 0,
      strays.length > 0 ? `stray file(s): ${strays.join(', ')}` : undefined,
    );
    const neverPublished = await fsp.readFile(lockPath, 'utf8').catch(() => null);
    check(
      'the shared claim path was never published to (write-then-link never reached `link`)',
      neverPublished === null,
      neverPublished === null ? undefined : `claim path unexpectedly holds content: ${JSON.stringify(neverPublished)}`,
    );

    // ---------- a subsequent retry must not be permanently blocked ----------
    let retryThrew;
    let release;
    try {
      release = await claimIdempotencyKey(logPath, 'snapshot_now', 'durability-fail-key');
    } catch (e) {
      retryThrew = e;
    }
    check(
      'a subsequent retry for the SAME key succeeds once the transient fault clears (not permanently blocked)',
      retryThrew === undefined,
      retryThrew instanceof IdempotencyClaimHeldError
        ? `${retryThrew.constructor.name}: ${retryThrew.message} (BUG — the failed attempt is still blocking retries)`
        : retryThrew
          ? `${retryThrew.constructor.name}: ${retryThrew.message}`
          : undefined,
    );
    if (release) await release();

    // ---------- a NON-EEXIST failure at the actual `link()` publish step is also clean ----------
    failNextLink = 'EIO';
    let linkThrew;
    try {
      await claimIdempotencyKey(logPath, 'snapshot_now', 'link-fail-key');
    } catch (e) {
      linkThrew = e;
    }
    check(
      'a non-EEXIST failure AT the link() publish step propagates to the caller',
      linkThrew instanceof Error && linkThrew.code === 'EIO',
      linkThrew ? `${linkThrew.constructor.name}: ${linkThrew.message} (code=${linkThrew.code})` : 'no throw (BUG)',
    );
    const straysAfterLinkFail = await strayStagingFiles(dir);
    check(
      'a failed link() also leaves no stray staging file behind',
      straysAfterLinkFail.length === 0,
      straysAfterLinkFail.length > 0 ? `stray file(s): ${straysAfterLinkFail.join(', ')}` : undefined,
    );
    const linkFailClaimPath = claimLockPathFor(logPath, 'snapshot_now', 'link-fail-key');
    const claimNeverPublished = await fsp.readFile(linkFailClaimPath, 'utf8').catch(() => null);
    check(
      'a failed link() never leaves partial content at the shared claim path',
      claimNeverPublished === null,
      claimNeverPublished === null
        ? undefined
        : `claim path unexpectedly holds content: ${JSON.stringify(claimNeverPublished)}`,
    );
    let retryAfterLinkFailThrew;
    let releaseAfterLinkFail;
    try {
      releaseAfterLinkFail = await claimIdempotencyKey(logPath, 'snapshot_now', 'link-fail-key');
    } catch (e) {
      retryAfterLinkFailThrew = e;
    }
    check(
      'a retry after a failed link() also succeeds (not permanently blocked)',
      retryAfterLinkFailThrew === undefined,
      retryAfterLinkFailThrew
        ? `${retryAfterLinkFailThrew.constructor.name}: ${retryAfterLinkFailThrew.message}`
        : undefined,
    );
    if (releaseAfterLinkFail) await releaseAfterLinkFail();

    // ---------- control: a GENUINELY held claim (no durability failure) is still refused ----------
    const liveRelease = await claimIdempotencyKey(logPath, 'snapshot_now', 'live-rival-key');
    let rivalThrew;
    try {
      await claimIdempotencyKey(logPath, 'snapshot_now', 'live-rival-key');
    } catch (e) {
      rivalThrew = e;
    }
    check(
      'control: a genuinely held claim (no durability failure involved) is still refused as before',
      rivalThrew instanceof IdempotencyClaimHeldError,
      rivalThrew ? `${rivalThrew.constructor.name}: ${rivalThrew.message}` : 'no throw (BUG)',
    );
    await liveRelease();

    // ---------- a failed attempt for ONE key can never affect a DIFFERENT key's live claim ----------
    // (the structural guarantee that made rounds 1-2's whole "delayed cleanup deletes a
    // replacement" failure class impossible by construction, not merely unlikely: staging
    // paths are unique per attempt, so a failing attempt's own cleanup has nothing in
    // common with any other attempt's — same key or not — to ever collide with.)
    const bRelease = await claimIdempotencyKey(logPath, 'snapshot_now', 'unaffected-key');
    const bOwnerText = await fsp.readFile(claimLockPathFor(logPath, 'snapshot_now', 'unaffected-key'), 'utf8');
    failNextOpenSync = true;
    await claimIdempotencyKey(logPath, 'snapshot_now', 'yet-another-failing-key').catch(() => {});
    const bOwnerTextAfter = await fsp.readFile(claimLockPathFor(logPath, 'snapshot_now', 'unaffected-key'), 'utf8');
    check(
      "an unrelated key's failing attempt never touches a DIFFERENT key's live claim",
      bOwnerTextAfter === bOwnerText,
      JSON.stringify({ before: bOwnerText, after: bOwnerTextAfter }),
    );
    await bRelease();
  }

  // ================= withLogLock (via recordIdempotencyResult) =================
  {
    const lockLog = join(tmp, 'withloglock-log.jsonl');
    const dir = dirname(lockLog);
    const lockPath = `${lockLog}.lock`;

    failNextOpenSync = true;
    let threw;
    try {
      await recordIdempotencyResult(lockLog, 'snapshot_now', 'wll-key', 'fp', { pushed: true }, 86400);
    } catch (e) {
      threw = e;
    }
    check(
      "a durability-check failure on withLogLock's OWN staging file propagates to the caller",
      threw instanceof Error && threw.message === 'SIMULATED_FSYNC_FAILURE',
      threw ? `${threw.constructor.name}: ${threw.message}` : 'no throw (BUG — the injected fault never fired)',
    );

    const strays = await strayStagingFiles(dir);
    check(
      'the failed lock-acquisition attempt leaves no stray staging file behind',
      strays.length === 0,
      strays.length > 0 ? `stray file(s): ${strays.join(', ')}` : undefined,
    );
    const neverPublished = await fsp.readFile(lockPath, 'utf8').catch(() => null);
    check(
      'the shared lock path was never published to',
      neverPublished === null,
      neverPublished === null ? undefined : `lock path unexpectedly holds content: ${JSON.stringify(neverPublished)}`,
    );

    // The regression Codex reproduced against round 2's own fix: without correct cleanup,
    // this process (this test file's own pid, still alive) would leave the lock
    // UNSTEALABLE by round 1's own live-pid fix, for as long as this process lives — every
    // later write to this SAME log times out forever, never recovering even after the
    // underlying fault clears. Prove it does not: a normal write for a DIFFERENT key,
    // right after, must succeed quickly (well under the lock's own multi-second timeout).
    const start = Date.now();
    let laterThrew;
    try {
      await recordIdempotencyResult(lockLog, 'snapshot_now', 'wll-key-2', 'fp2', { pushed: true }, 86400);
    } catch (e) {
      laterThrew = e;
    }
    const elapsedMs = Date.now() - start;
    check(
      'a later write to the SAME log path succeeds quickly, not permanently blocked by the earlier acquisition failure',
      laterThrew === undefined && elapsedMs < 2_000,
      laterThrew instanceof IdempotencyStoreError
        ? `${laterThrew.constructor.name}: ${laterThrew.message} (BUG — the leaked lock is still blocking writes, waited ${elapsedMs}ms)`
        : laterThrew
          ? `${laterThrew.constructor.name}: ${laterThrew.message}`
          : `succeeded in ${elapsedMs}ms`,
    );

    // ---------- a NON-EEXIST failure at withLogLock's OWN link() publish step is also clean ----------
    failNextLink = 'EIO';
    let linkThrew;
    try {
      await recordIdempotencyResult(lockLog, 'snapshot_now', 'wll-key-3', 'fp3', { pushed: true }, 86400);
    } catch (e) {
      linkThrew = e;
    }
    check(
      "a non-EEXIST failure AT withLogLock's link() publish step propagates to the caller",
      linkThrew instanceof Error && linkThrew.code === 'EIO',
      linkThrew ? `${linkThrew.constructor.name}: ${linkThrew.message} (code=${linkThrew.code})` : 'no throw (BUG)',
    );
    const straysAfterLinkFail = await strayStagingFiles(dir);
    check(
      "a failed link() during withLogLock's own acquisition also leaves no stray staging file behind",
      straysAfterLinkFail.length === 0,
      straysAfterLinkFail.length > 0 ? `stray file(s): ${straysAfterLinkFail.join(', ')}` : undefined,
    );
    const startAfterLinkFail = Date.now();
    let laterAfterLinkFailThrew;
    try {
      await recordIdempotencyResult(lockLog, 'snapshot_now', 'wll-key-4', 'fp4', { pushed: true }, 86400);
    } catch (e) {
      laterAfterLinkFailThrew = e;
    }
    const elapsedAfterLinkFailMs = Date.now() - startAfterLinkFail;
    check(
      'a write right after a failed link() also succeeds quickly (not permanently blocked)',
      laterAfterLinkFailThrew === undefined && elapsedAfterLinkFailMs < 2_000,
      laterAfterLinkFailThrew
        ? `${laterAfterLinkFailThrew.constructor.name}: ${laterAfterLinkFailThrew.message} (waited ${elapsedAfterLinkFailMs}ms)`
        : `succeeded in ${elapsedAfterLinkFailMs}ms`,
    );
  }

  // ================= round 3 (bounded Codex re-review of round 3's own fix) =================
  {
    // ---------- Critical: ancestor-sync ownership must not depend on winning the claim ----------
    // No fault involved at all — pure, ordinary contention. Caller A creates a fresh,
    // multi-level directory tree via its own `mkdir` and pauses (slow, not broken) in its
    // staging fsync; caller B, for the SAME key, finds `dir` already existing (A got
    // there first), so B's own `firstCreated` reads back undefined — but B's link()
    // succeeds BEFORE A's does, since A is still paused. A must still discharge ITS OWN
    // ancestor-sync responsibility once it loses (EEXIST), even though it holds no claim.
    const freshRoot = join(tmp, 'ancestor-race', 'nested', 'deep');
    const freshLog = join(freshRoot, 'log.jsonl');
    const freshAncestor1 = join(tmp, 'ancestor-race');
    const freshAncestor2 = join(tmp, 'ancestor-race', 'nested');

    let announceAEntered;
    const aEntered = new Promise((r) => {
      announceAEntered = r;
    });
    pauseNextOpenSync = announceAEntered;

    const aPromise = claimIdempotencyKey(freshLog, 'snapshot_now', 'ancestor-race-key').then(
      (release) => ({ release }),
      (error) => ({ error }),
    );
    await aEntered; // A's mkdir has run (creating the fresh tree) and A is now paused mid-staging-fsync.

    // B, for the SAME key, races ahead while A is still paused — B's own mkdir sees the
    // tree A already created, so B's own firstCreated is undefined.
    const releaseB = await claimIdempotencyKey(freshLog, 'snapshot_now', 'ancestor-race-key');
    check(
      "B (racing the same key while A is paused) wins the claim, unaffected by A's pause",
      typeof releaseB === 'function',
    );

    // Resume A: its staging fsync completes normally (no fault — A was only ever slow),
    // A then tries to publish and gets EEXIST (B already holds it).
    resumePausedOpenSync();
    const aResult = await aPromise;
    check(
      "A loses to B's already-published claim (IdempotencyClaimHeldError), as expected",
      aResult.error instanceof IdempotencyClaimHeldError,
      aResult.error
        ? `${aResult.error.constructor.name}: ${aResult.error.message}`
        : 'A reported success (BUG — both A and B hold the same claim)',
    );

    // The actual regression: even though A LOST, A's own mkdir is the one that created
    // `freshAncestor1`/`freshAncestor2` — nothing else will ever sync them if A does not.
    check(
      'A still syncs the ancestor directories its OWN mkdir created, despite losing the claim',
      dirSyncOpens.includes(freshAncestor1) && dirSyncOpens.includes(freshAncestor2),
      `synced: ${JSON.stringify(dirSyncOpens.filter((p) => p.startsWith(join(tmp, 'ancestor-race'))))}`,
    );

    await releaseB();
  }

  {
    // ---------- Critical (round 4): the WINNER must WAIT for a slow ancestor sync, not
    // merely discharge it eventually — the exact gap Codex found in round 3's own fix ----------
    const freshRoot = join(tmp, 'ancestor-wait', 'nested', 'deep');
    const freshLog = join(freshRoot, 'log.jsonl');

    // A's own `registerAncestorSync` does not block A's OWN progress to staging/link (it
    // fires off the sync and moves on) — so to force B (not A) to win the exclusion race
    // AND keep A's registered ancestor-sync promise unsettled at that moment, BOTH of
    // A's own slow points must be paused independently: its directory (ancestor) sync AND
    // its staging write, released in that order once the assertions below need them to.
    let announceDirPaused;
    const dirPaused = new Promise((r) => {
      announceDirPaused = r;
    });
    pauseNextDirSync = announceDirPaused;
    let announceStagingPaused;
    const stagingPaused = new Promise((r) => {
      announceStagingPaused = r;
    });
    pauseNextOpenSync = announceStagingPaused;

    // A: mkdir creates the fresh tree, registers (and pauses inside) its own ancestor
    // sync, then reaches (and pauses inside) its own staging write.
    const aPromise = claimIdempotencyKey(freshLog, 'snapshot_now', 'ancestor-wait-key').then(
      (release) => ({ release }),
      (error) => ({ error }),
    );
    await dirPaused;
    await stagingPaused;

    // B: for the SAME key, wins the exclusion race (A is stuck in both of its own slow
    // points, so B's own mkdir+staging+link — nothing paused for B — completes first).
    // B's own claimIdempotencyKey call must now BLOCK on awaitPendingAncestorSync(dir) —
    // the fix under test — rather than returning immediately having synced nothing.
    const bPromise = claimIdempotencyKey(freshLog, 'snapshot_now', 'ancestor-wait-key').then(
      (release) => ({ release }),
      (error) => ({ error }),
    );

    // Race B's own promise against a short timer: if B resolves before A's ancestor sync
    // is even resumed, the fix is not actually enforcing the wait (the bug round 4 found).
    const NOT_YET = Symbol('not yet');
    const stillPending = await Promise.race([bPromise, new Promise((r) => setTimeout(() => r(NOT_YET), 300))]);
    check(
      "B's own claim call BLOCKS while A's (concurrent) ancestor sync is still in flight, instead of returning immediately",
      stillPending === NOT_YET,
      stillPending === NOT_YET
        ? undefined
        : "B resolved before A's ancestor sync completed (BUG — the wait is not enforced)",
    );

    // Resume A's ancestor sync — only NOW should B's own call be allowed to resolve.
    resumePausedDirSync();
    const bResult = await bPromise;
    check(
      "B's claim call resolves successfully once A's ancestor sync actually completes",
      bResult.release !== undefined && typeof bResult.release === 'function',
      bResult.error ? `${bResult.error.constructor.name}: ${bResult.error.message}` : undefined,
    );

    // Resume A's still-paused staging write — A can now finish and discover B already
    // published the claim.
    resumePausedOpenSync();
    const aResult = await aPromise;
    check(
      'A (having lost the exclusion race while it was busy syncing ancestors) reports IdempotencyClaimHeldError',
      aResult.error instanceof IdempotencyClaimHeldError,
      aResult.error ? `${aResult.error.constructor.name}: ${aResult.error.message}` : 'A reported success (BUG)',
    );

    if (bResult.release) await bResult.release();
  }

  {
    // ---------- Warning: an ambiguous (NFS-style) link() failure must reconcile, not leak ----------
    const ambiguousLog = join(tmp, 'ambiguous-log.jsonl');
    ambiguousNextLink = 'ESTALE';
    let release;
    let threw;
    try {
      release = await claimIdempotencyKey(ambiguousLog, 'snapshot_now', 'ambiguous-key');
    } catch (e) {
      threw = e;
    }
    check(
      'a link() that actually succeeded but reported an error is reconciled as a real claim, not a failure',
      threw === undefined && typeof release === 'function',
      threw ? `${threw.constructor.name}: ${threw.message} (BUG — a real claim was reported as a failure)` : undefined,
    );
    let rivalThrew;
    try {
      await claimIdempotencyKey(ambiguousLog, 'snapshot_now', 'ambiguous-key');
    } catch (e) {
      rivalThrew = e;
    }
    check(
      'the reconciled claim genuinely excludes a second caller (it is a real, live claim)',
      rivalThrew instanceof IdempotencyClaimHeldError,
      rivalThrew ? `${rivalThrew.constructor.name}: ${rivalThrew.message}` : 'no throw (BUG)',
    );
    if (release) await release();

    // Control: reconciliation must correctly REJECT a mismatch, not treat every failed
    // link() as automatic success — a genuine holder's real token sits at the shared
    // path, this failing caller's own (different) token does not match it, so its own
    // non-EEXIST failure must propagate rather than be swallowed as a false "success".
    const genuineLog = join(tmp, 'genuine-log.jsonl');
    const holderRelease = await claimIdempotencyKey(genuineLog, 'snapshot_now', 'genuine-key');
    failNextLink = 'EIO';
    let genuineThrew;
    try {
      await claimIdempotencyKey(genuineLog, 'snapshot_now', 'genuine-key');
    } catch (e) {
      genuineThrew = e;
    }
    check(
      "reconciliation correctly rejects a mismatch (the real holder's token, not this failing caller's own) and propagates the genuine failure",
      genuineThrew instanceof Error && genuineThrew.code === 'EIO',
      genuineThrew
        ? `${genuineThrew.constructor.name}: ${genuineThrew.message} (code=${genuineThrew.code})`
        : 'no throw (BUG — the genuine failure was silently swallowed)',
    );
    await holderRelease();
  }

  {
    // ---------- Warning (round 4): reconciliation must ALSO cover EEXIST itself, not just
    // other error codes — an NFS client's transparent RPC retry can surface "my own
    // earlier, lower-level retry of this exact link() already landed" as EEXIST, which a
    // naive "EEXIST always means someone else already holds it" check would misreport as
    // a rival claim instead of recognizing it as this call's own ----------
    const eexistAmbiguousLog = join(tmp, 'eexist-ambiguous-log.jsonl');
    ambiguousNextLink = 'EEXIST';
    let release;
    let threw;
    try {
      release = await claimIdempotencyKey(eexistAmbiguousLog, 'snapshot_now', 'eexist-ambiguous-key');
    } catch (e) {
      threw = e;
    }
    check(
      "claimIdempotencyKey: a link() that actually succeeded but reported EEXIST is reconciled as this call's own claim, not IdempotencyClaimHeldError",
      threw === undefined && typeof release === 'function',
      threw
        ? `${threw.constructor.name}: ${threw.message} (BUG — a real claim was misreported as already held)`
        : undefined,
    );
    if (release) await release();

    const eexistAmbiguousLockLog = join(tmp, 'eexist-ambiguous-withloglock-log.jsonl');
    ambiguousNextLink = 'EEXIST';
    let lockThrew;
    try {
      await recordIdempotencyResult(
        eexistAmbiguousLockLog,
        'snapshot_now',
        'eexist-lock-key',
        'fp',
        { pushed: true },
        86400,
      );
    } catch (e) {
      lockThrew = e;
    }
    check(
      "withLogLock: a link() that actually succeeded but reported EEXIST is reconciled as this call's own lock, not a steal-checking timeout",
      lockThrew === undefined,
      lockThrew ? `${lockThrew.constructor.name}: ${lockThrew.message}` : undefined,
    );
  }

  {
    // ---------- Critical (round 5): `dir` itself must ALWAYS be synced on the winning
    // path, even when NEITHER this call NOR any concurrent one had any ancestors to
    // report (the common case: `dir` already exists durably from a previous session) ----------
    const existingDirLog = join(tmp, 'existing-dir-log.jsonl'); // `tmp` already exists — no ancestors for anyone to create
    const beforeCount = dirSyncOpens.filter((p) => p === tmp).length;
    const release = await claimIdempotencyKey(existingDirLog, 'snapshot_now', 'existing-dir-key');
    const afterCount = dirSyncOpens.filter((p) => p === tmp).length;
    check(
      "claimIdempotencyKey: dir's own directory entry is synced even with zero ancestor-sync activity anywhere",
      afterCount > beforeCount,
      `dir-sync calls for ${tmp}: before=${beforeCount}, after=${afterCount}`,
    );
    await release();

    const existingDirLockLog = join(tmp, 'existing-dir-withloglock-log.jsonl');
    const beforeCount2 = dirSyncOpens.filter((p) => p === tmp).length;
    await recordIdempotencyResult(
      existingDirLockLog,
      'snapshot_now',
      'existing-dir-lock-key',
      'fp',
      { pushed: true },
      86400,
    );
    const afterCount2 = dirSyncOpens.filter((p) => p === tmp).length;
    check(
      "withLogLock: dir's own directory entry is synced even with zero ancestor-sync activity anywhere",
      afterCount2 > beforeCount2,
      `dir-sync calls for ${tmp}: before=${beforeCount2}, after=${afterCount2}`,
    );
  }

  {
    // ---------- Critical (round 5): a caller must never miss its OWN registered
    // ancestor-sync failure, even once the map's cleanup has already removed the
    // (settled) entry by the time this same caller checks on it ----------
    const freshRoot = join(tmp, 'own-failure', 'nested', 'deep');
    const freshLog = join(freshRoot, 'log.jsonl');
    failNextDirSync = true; // fails immediately — settles (and gets cleaned up) fast
    let threw;
    try {
      await claimIdempotencyKey(freshLog, 'snapshot_now', 'own-failure-key');
    } catch (e) {
      threw = e;
    }
    check(
      'claimIdempotencyKey never silently swallows its OWN registered ancestor-sync failure',
      threw instanceof Error && threw.message === 'SIMULATED_ANCESTOR_SYNC_FAILURE',
      threw ? `${threw.constructor.name}: ${threw.message}` : 'no throw (BUG — the failure was silently swallowed)',
    );

    const freshRoot2 = join(tmp, 'own-failure-lock', 'nested', 'deep');
    const freshLog2 = join(freshRoot2, 'log.jsonl');
    failNextDirSync = true;
    let lockThrew2;
    try {
      await recordIdempotencyResult(freshLog2, 'snapshot_now', 'own-failure-lock-key', 'fp', { pushed: true }, 86400);
    } catch (e) {
      lockThrew2 = e;
    }
    check(
      'withLogLock never silently swallows its OWN registered ancestor-sync failure',
      lockThrew2 instanceof Error && lockThrew2.message === 'SIMULATED_ANCESTOR_SYNC_FAILURE',
      lockThrew2
        ? `${lockThrew2.constructor.name}: ${lockThrew2.message}`
        : 'no throw (BUG — the failure was silently swallowed)',
    );
  }
} finally {
  fsp.open = origOpen;
  fsp.link = origLink;
  await fsp.rm(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nIDEMPOTENCY CLAIM DURABILITY SELFTEST FAIL (${failed})`);
  process.exit(1);
}
console.log('\nIDEMPOTENCY CLAIM DURABILITY SELFTEST PASS');
