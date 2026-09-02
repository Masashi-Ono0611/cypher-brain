// A same-machine advisory lock for push's two check-then-act sequences (#806, #807).
//
// Both bugs have the identical shape — read a destination's current state, act on what
// was read, and write the result, with nothing serializing the three steps across
// PROCESSES (a `schedule`d run overlapping a manual one, or an MCP agent call overlapping
// either):
//
//   #806  push --skip-unchanged: resolveSkipUnchanged() reads the --save-locator file,
//         backend.put() pays, and the save-locator rewrite records where it went. Two
//         pushes sharing one --save-locator both read "nothing recorded", both pay for
//         the same content, and the second rewrite discards the first one's locator —
//         a duplicate irreversible spend AND a lost recovery pointer.
//   #807  the rclone backend: rcloneObjectExists() probes, `rclone copyto` uploads. Two
//         pushes to one absent --remote both see "nothing there" and the later silently
//         replaces the earlier — and an rclone --remote is the one locator in this tool
//         that is NOT content-addressed (NON_CONTENT_ADDRESSED_BACKENDS, config.ts), so
//         that overwrite destroys a distinct snapshot rather than rewriting equal bytes.
//
// The primitive is idempotency.ts's existing claim/release lock file, deliberately reused
// rather than reinvented: an exclusive create of a file holding a `newLockToken()` owner
// token, released through `releaseLockFileIfOwned()`, which removes the file only while
// it still holds this owner's exact bytes. Same "no new persistence mechanism, no lock
// server, no new runtime dependency" constraint #220 set for the idempotency store.
//
// What that primitive is and is NOT, stated up front because the difference decides how
// much this can promise. Exclusive creation IS atomic, so of N processes racing for a
// free lock exactly one wins — that is the guarantee the two races above needed. Every
// path that reads a lock and then acts on what it read (recovering an abandoned one;
// removing one's own on release) is a check-then-act built out of separate syscalls, and
// no path-based lock can make those atomic; the code below narrows each such window to
// adjacent syscalls, prefers the fail-safe branch when a check is inconclusive, and says
// so where it cannot. The bound that makes that acceptable: losing one of those races
// degrades to the UNLOCKED behaviour that shipped before this file existed — the race
// #806/#807 describe — never to something worse. A guarantee stronger than that needs an
// OS-level lock (flock/fcntl) or a backend-native conditional create, which is a
// different change from this one.
//
// TWO deliberate differences from claimIdempotencyKey, both forced by the caller:
//
//   1. It WAITS (bounded) instead of refusing immediately. An MCP idempotency key names
//      one logical call, so a concurrent duplicate is always a mistake worth refusing.
//      Two pushes to one locator file are not: the loser only has to run AFTER the
//      winner, and once it does, its own --skip-unchanged lookup observes the pointer
//      the winner just wrote and prints the ordinary SKIPPED line. Waiting is what turns
//      the race into the sequence the operator meant. Only a holder that is still
//      running when the wait runs out gets the refusal (PushLockHeldError, CB-E028) —
//      which is still strictly better than the bug it replaces, because refusing to push
//      costs nothing and paying twice does not.
//   2. It RECOVERS from an abandoned lock automatically. claimIdempotencyKey deliberately
//      does not (its own doc comment explains why: an operator removes a wedged claim by
//      hand, after confirming the holder is gone). That posture cannot be copied here.
//      push is the verb `cypher-brain schedule` runs UNATTENDED every night; a lock left
//      behind by one crash would silently stop every subsequent backup with nobody
//      reading the error, which is a worse failure than the race this closes. So a lock
//      whose recorded pid is no longer running is stolen rather than waited on — see
//      isAbandoned() for the exact test and its residual risk.
//
// SCOPE, stated rather than assumed. Two pushes exclude each other only when they share
// a CYPHER_BRAIN_HOME (the lock files live under it) AND resolve to the same key string.
// That covers the realistic concurrency both issues describe — one operator, one
// scheduler, one agent, one box, one config — and nothing beyond it: two DIFFERENT
// machines writing one cloud remote are not serialized (that needs a backend-native
// conditional create, which rclone.ts's own comment records as the residual risk it could
// not close), and neither are two spellings of one destination that this cannot see
// through — see saveLocatorLockKey() for what IS canonicalized, and note that an rclone
// remote string cannot be canonicalized at all (`r:/a/../b` and `r:/b` are two keys).
import { writeFile, readFile, rm, rename, link, mkdir, stat, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { HOME } from './config.js';
import { newLockToken, lockTokenPid, releaseLockFileIfOwned } from './idempotency.js';
import { sleep } from './util.js';
import { warn } from './warn.js';

/** What a lock is keyed by — the wording of every message below branches on it. */
export type PushLockKind = 'save-locator' | 'rclone-remote';

/**
 * Thrown when the lock is still held by a LIVE process after the bounded wait — the one
 * outcome in which a push refuses rather than running. Never thrown for an abandoned
 * lock (that is recovered automatically), so seeing this really does mean another push
 * is running right now, or that a live process is holding a lock it should have released.
 */
export class PushLockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushLockHeldError';
  }
}

// How long to wait for a LIVE holder before refusing. A few seconds: long enough to
// serialize the overlapping-start case both issues describe (two runs kicked off within
// moments of each other, where the loser only has to queue behind the winner), short
// enough that an operator staring at a terminal is not left wondering. A holder that is
// mid-upload to a paid backend can easily outlast it — that is the case that gets
// CB-E028, and refusing there is the correct answer: the alternative is paying twice.
const WAIT_MS = 5_000;
const POLL_MS = 50;
// A lock file whose contents do not parse as an owner record is treated as abandoned —
// but only after this grace period. Generous on purpose: a lock this code publishes is
// complete the instant it appears (see publishLock), so the only way to observe a
// half-written one is the fallback path on a filesystem without hard links, and a minute
// is far longer than a stalled 100-byte write can plausibly take.
const UNPARSEABLE_GRACE_MS = 60_000;
// Bounded so a pathological loop (steal, lose the re-create, find another abandoned
// lock, steal again) cannot spin: after this many steals the lock is treated as held.
const MAX_STEALS = 3;
// The LAST-RESORT backstop, and a deliberate trade rather than an oversight.
//
// Every other abandonment test below asks "is the holder still running", which a pid
// answers accurately only until that pid is reused — by an unrelated long-lived process,
// or by anything at all after a reboot. In those cases a lock nobody holds looks held
// FOREVER, and this is the verb `cypher-brain schedule` runs unattended every night: a
// permanent, silent stop to every future backup is a worse outcome than the race this
// file closes. So a lock this old is taken regardless of what its pid says.
//
// The cost, stated plainly: a push still running after a full day can have its lock
// stolen, which re-opens the double-pay/overwrite window for that one run. That is
// remote (no upload in this tool takes a day) and, when it happens, degrades to exactly
// the behaviour that shipped before this file existed — whereas the wedge it prevents is
// strictly worse than that. A day is chosen so it bounds every wedge at one missed
// nightly run.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The lock file for a (kind, key) pair, under CYPHER_BRAIN_HOME — the same directory the
 * idempotency log and its claim locks already live in, so nothing new appears next to an
 * operator's save-locator file or inside their rclone remote.
 *
 * Hashed, and hashed the same way idempotency.ts's claimLockPath does it (a
 * JSON.stringify of the tuple, so the two components can never be confused with each
 * other): a save-locator path or an rclone remote string can contain path separators and
 * other filesystem-unsafe characters. Exported so a test can name the exact file to
 * pre-create when it needs a held lock without a real second push.
 */
export function pushLockPath(kind: PushLockKind, key: string): string {
  const id = createHash('sha256')
    .update(JSON.stringify([kind, key]))
    .digest('hex');
  return join(HOME, 'push-locks', `${id}.lock`);
}

/**
 * The lock key for a `--save-locator` path: absolute, with its DIRECTORY resolved through
 * symlinks. Two invocations naming one file by different routes — `/tmp/x/ptr.tsv` and
 * `/private/tmp/x/ptr.tsv` on macOS, a symlinked backup directory, `./ptr.tsv` from
 * another cwd — must land on the same lock, or the lock silently guards nothing.
 *
 * Only the directory is resolved: the locator file itself often does not exist yet on a
 * first push, and `realpath` on a missing path fails. What that leaves — say so rather
 * than let the guarantee sound wider than it is: two pushes are serialized only when this
 * returns the SAME string for both, so a locator file that is itself a symlink or a hard
 * link to another name, two spellings that differ only in case on a case-insensitive
 * filesystem, and a path under a directory that does not exist yet (where realpath falls
 * back to the unresolved form) each still yield two independent locks.
 */
export async function saveLocatorLockKey(path: string): Promise<string> {
  const full = resolve(path);
  const dir = await realpath(dirname(full)).catch(() => dirname(full));
  return join(dir, basename(full));
}

interface Holder {
  text: string;
  pid: number | null;
  mtimeMs: number;
}

// Read and stat SEQUENTIALLY, not in parallel: a lock that is replaced in between would
// otherwise pair one generation's bytes with another generation's mtime.
//
// null means GONE (ENOENT — released or stolen between our failed create and this read),
// which is a normal, retryable state. Every OTHER failure — EACCES on a lock directory
// whose permissions changed, an I/O error — throws instead of being flattened into null:
// treating "cannot read" as "nothing there" would make an unattended schedule poll for
// the full wait and then report CB-E028 ("another push is in flight") forever, for a
// problem that is neither another push nor fixable by waiting.
async function readHolder(lockPath: string): Promise<Holder | null> {
  let text: string;
  let mtimeMs: number;
  try {
    text = await readFile(lockPath, 'utf8');
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new Error(
      `cannot read the push lock at ${lockPath} (${(e as NodeJS.ErrnoException)?.code ?? 'unknown error'}) — ` +
        'refusing to push without knowing whether another push holds it',
      { cause: e },
    );
  }
  return { text, pid: lockTokenPid(text), mtimeMs };
}

/**
 * Is this process still running? `kill(pid, 0)` sends no signal and only reports
 * reachability: ESRCH means gone, EPERM means it exists but belongs to another user
 * (alive — never steal from it).
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Whether a lock may be taken from its recorded holder — the ONLY three ways a lock is
 * ever taken from someone else, all of them meaning "that holder cannot still be running":
 * its pid is gone, its boot is gone, or the file does not parse as a lock at all. A lock
 * is deliberately NEVER stolen for being old: a push holds this for as long as its upload
 * takes, there is no bound on that, and stealing from a live holder is precisely the
 * double-spend/overwrite this exists to prevent. The cost of that choice is that a lock
 * LEAKED by a still-running process (a release that failed) blocks pushes until that
 * process exits — which is why the release path warns when it cannot clean up, and why
 * CB-E028's message names the file.
 *
 * TWO limits worth stating plainly rather than implying:
 *
 *   - Clearing an abandoned lock says nothing about what the crashed run had already
 *     DONE. A push killed between `backend.put()` and the save-locator commit has
 *     already paid, and no lock file can undo or discover that; the next run sees no
 *     recorded locator and pushes again — exactly as it did before this lock existed
 *     (receipt-ledger.jsonl is where that spend is recorded, and MCP callers have
 *     idempotency keys). This lock closes the CONCURRENT double-pay, not the
 *     crash-between-steps one.
 *   - A killed parent does not necessarily take its `rclone copyto` child with it, so a
 *     recovering push can in principle overlap an orphaned transfer. Narrow, and
 *     unchanged from before this lock existed.
 */
function isAbandoned(holder: Holder): boolean {
  if (holder.pid === null) return Date.now() - holder.mtimeMs > UNPARSEABLE_GRACE_MS;
  if (!pidAlive(holder.pid)) return true;
  return Date.now() - holder.mtimeMs > MAX_AGE_MS; // last resort — see MAX_AGE_MS
}

/**
 * Take an abandoned lock away from its dead holder.
 *
 * Via rename, not a plain unlink: the rename is itself the mutual exclusion for the
 * steal, so of two waiters that both judged the same lock abandoned, exactly one moves
 * it aside and the other's rename fails with ENOENT — where two unlinks could each
 * remove the OTHER's freshly created lock and leave both believing they hold it.
 *
 * The moved file's contents are then compared with what was judged abandoned, because
 * the window between that judgement and this rename is not closed: if a different
 * (newer, live) lock was moved, it is put back rather than discarded, and this steal
 * reports failure so the caller re-evaluates from scratch.
 */
async function stealLock(lockPath: string, abandoned: Holder): Promise<void> {
  // Re-read IMMEDIATELY before the rename and re-judge, so the window between deciding
  // "abandoned" and acting on it is two syscalls rather than a whole poll cycle. This is
  // narrowing, not closing: a path-based lock cannot make read-and-rename one atomic
  // step (idempotency.ts's claim lock documents the same limit). What bounds the damage
  // is that losing this race degrades to the UNLOCKED behaviour that shipped before —
  // the race in #806/#807 — never to something worse.
  const fresh = await readHolder(lockPath);
  if (!fresh || fresh.text !== abandoned.text || !isAbandoned(fresh)) return;
  const side = `${lockPath}.stale.${randomBytes(8).toString('hex')}`;
  try {
    await rename(lockPath, side);
  } catch (e) {
    // ENOENT is the benign race this is built to lose: another waiter got there first, or
    // the holder released it — re-evaluate. Anything else (EACCES on the lock directory,
    // EROFS, EIO) is a real, unchanging problem: swallowing it would burn the steal
    // budget and then report CB-E028, sending an operator to look for a concurrent push
    // that does not exist while a genuinely abandoned lock stays put on every future run.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw new Error(
      `cannot clear the abandoned push lock at ${lockPath} ` +
        `(${(e as NodeJS.ErrnoException)?.code ?? 'unknown error'}) — its owner is gone but it cannot be removed`,
      { cause: e },
    );
  }
  // A read failure here is NOT "it matched": treating it as one deletes whatever was
  // moved aside, which — if it was in fact a newer holder's lock — leaves that holder
  // running with nothing recording that it holds anything. Unknown goes down the restore
  // path, same as a known mismatch.
  const moved = await readFile(side, 'utf8').catch(() => null);
  if (moved === null || moved !== fresh.text) {
    // Not (provably) the lock that was judged abandoned — a new holder can have claimed
    // it in between. Put it back and take nothing. `link` rather than a re-write: it
    // restores the ORIGINAL file even when its contents could not be read, and it fails
    // with EEXIST rather than clobbering if a third party has since created its own lock
    // at that path. If it fails, the side file is deliberately KEPT rather than removed —
    // a holder whose lock is missing is a holder nobody can see, so leaving the evidence
    // (and saying so) beats deleting it silently.
    try {
      await link(side, lockPath);
      await rm(side, { force: true });
    } catch {
      warn(
        `could not restore a push lock that was moved aside while recovering a stale one — ${side} holds its ` +
          'contents; remove that file once no push is running',
      );
    }
    return;
  }
  warn(
    `cleared an abandoned push lock at ${lockPath}` +
      (fresh.pid === null ? ' (unreadable owner)' : ` (owner pid ${fresh.pid} is no longer running)`) +
      ' — a previous push was killed or crashed before it could release it. This does NOT mean that push did ' +
      'nothing: if it was killed after a paid upload, check receipt-ledger.jsonl before assuming this run is the first',
  );
  await rm(side, { force: true });
}

/**
 * Release, and SAY SO if the lock survived. releaseLockFileIfOwned never throws (a
 * release must not turn a completed push into a failure), which used to make a failed
 * cleanup completely silent — and since a lock is never stolen for being old, a leaked
 * one blocks every later push for as long as this process lives. That is tolerable only
 * if it is visible, so an operator gets the file's name at the moment it leaks rather
 * than as a mysterious CB-E028 hours later.
 *
 * The ownership comparison inside releaseLockFileIfOwned is itself a read followed by a
 * remove (see this module's header): if the lock were replaced between those two
 * syscalls, the remove would take the successor's. Reaching that requires this holder's
 * lock to have been taken away first, which only happens when this process looks dead —
 * so it is the same window the module header bounds, not an independent one.
 */
async function releasePushLock(lockPath: string, body: string): Promise<void> {
  await releaseLockFileIfOwned(lockPath, body);
  try {
    if ((await readFile(lockPath, 'utf8')) === body) {
      warn(
        `could not remove this push's own lock file ${lockPath} — later pushes for the same destination will be ` +
          'refused until it is deleted',
      );
    }
  } catch {
    // Gone (the normal case) or unreadable — nothing useful to say either way.
  }
}

/**
 * Try to become the holder: true if this process now owns `lockPath`, false if someone
 * else already does.
 *
 * Write-then-`link`, not a plain exclusive `writeFile`: `link` publishes a file that is
 * ALREADY COMPLETE, whereas `writeFile(…, 'wx')` makes the path exist before its contents
 * are there. That gap is small but it is the one window in which another process can read
 * a live lock as an empty, unparseable file — and an unparseable lock becomes stealable
 * after UNPARSEABLE_GRACE_MS, so a stalled writer could have its lock taken while it went
 * on to push. `link` fails with EEXIST exactly like `wx` when a holder exists, so the
 * exclusion property is unchanged.
 *
 * `link` is unsupported on a few filesystems (exFAT/FAT, some network mounts) — the same
 * ones pushpull.ts's promoteNoClobber already falls back for, with the same trade: an
 * exclusive create is still a correct no-clobber gate, it just re-opens the (much
 * narrower, grace-period-bounded) partial-publication window there.
 */
async function publishLock(lockPath: string, body: string): Promise<boolean> {
  const staging = `${lockPath}.new.${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(staging, body, { flag: 'wx' });
  } catch {
    // Cannot stage (an unwritable lock directory, say) — fall back to the direct create,
    // whose own failure is the one that gets reported.
    return directPublish(lockPath, body);
  }
  let published: boolean;
  try {
    await link(staging, lockPath);
    published = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') published = false;
    else if (code && ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(code)) {
      published = await directPublish(lockPath, body);
    } else {
      await rm(staging, { force: true }).catch(() => {});
      throw e;
    }
  }
  // Best-effort, and deliberately NOT in a `finally`: once the link above has succeeded
  // this process HOLDS the lock, so letting a failure to tidy up the staging file throw
  // would lose the release function for a lock that is now live — the exact shape of a
  // permanently wedged schedule.
  await rm(staging, { force: true }).catch(() => {});
  return published;
}

async function directPublish(lockPath: string, body: string): Promise<boolean> {
  try {
    await writeFile(lockPath, body, { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw e;
  }
}

function subjectFor(kind: PushLockKind, key: string): string {
  return kind === 'save-locator' ? `locator file ${key}` : `rclone remote ${key}`;
}

function riskFor(kind: PushLockKind): string {
  return kind === 'save-locator'
    ? 'paying twice for the same content and recording only one of the two locators'
    : 'silently overwriting the object the other push is uploading';
}

/**
 * Acquire the advisory lock for (kind, key), waiting up to WAIT_MS for a live holder and
 * recovering an abandoned one. Returns the release function the caller MUST call exactly
 * once, in a `finally` — the whole point is that the lock spans the caller's entire
 * check-then-act sequence, so releasing early re-opens the race it closes.
 *
 * @throws PushLockHeldError when a LIVE holder outlasts the wait.
 */
export async function acquirePushLock(kind: PushLockKind, key: string): Promise<() => Promise<void>> {
  const lockPath = pushLockPath(kind, key);
  await mkdir(join(HOME, 'push-locks'), { recursive: true });
  const token = newLockToken();
  // Line 1 is the owner token (whose pid readHolder parses); line 2 names the guarded
  // resource for an operator who finds the file — JSON-encoded, so a key containing a
  // newline (a locator path legally may) cannot forge a line of its own. Only whole-file
  // byte equality is ever compared for ownership.
  const body = `${token}\n${kind}\t${JSON.stringify(key)}\n`;
  const deadline = Date.now() + WAIT_MS;
  let steals = 0;
  let announcedWait = false;
  for (;;) {
    if (await publishLock(lockPath, body)) return () => releasePushLock(lockPath, body);
    const holder = await readHolder(lockPath);
    if (holder && isAbandoned(holder) && steals < MAX_STEALS) {
      steals++;
      await stealLock(lockPath, holder);
      continue;
    }
    if (Date.now() >= deadline) {
      const heldBy = holder?.pid === null || holder === null ? '' : ` (held by pid ${holder.pid})`;
      throw new PushLockHeldError(
        `another push is in flight for ${subjectFor(kind, key)}${heldBy} — refusing to run both at once rather than ` +
          `risk ${riskFor(kind)}. Wait for it to finish and re-run. The lock is ${lockPath}; a holder that has ` +
          'crashed is cleared automatically on the next run, so remove that file by hand only if a live process is ' +
          'holding it and you know it is not pushing.',
      );
    }
    if (!announcedWait) {
      announcedWait = true;
      warn(
        `another push holds the lock for ${subjectFor(kind, key)} — waiting up to ${Math.round(WAIT_MS / 1000)}s for ` +
          'it to finish before deciding what to do',
      );
    }
    await sleep(POLL_MS);
  }
}
