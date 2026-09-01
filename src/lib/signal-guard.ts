// snapshot() stages the full *plaintext* brain into a 0700 temp dir and leans on
// its finally-block to erase it, and restore() decrypts straight into --out-dir.
// But a signal (operator Ctrl-C, or launchd/shutdown SIGTERM in service mode) tears
// the process down WITHOUT unwinding the suspended async stack, so the finally never
// runs and either the staged plaintext brain or a partially-extracted --out-dir would
// linger — the exact on-disk exposure the threat model exists to prevent. Track the
// active stage dir / .part / restore out-dir and clean them up synchronously from a
// signal handler (async rm/fs calls can't finish before the process dies), then
// re-raise so the exit code is correct.
//
// verify --level drill (#209) does the SAME decrypt+extract into its own scratch dir
// (src/lib/restore.ts) — see setActiveVerifyScratchDir below — with a wrinkle restore()
// itself does not have: that scratch dir outlives restoreImpl()'s own out-dir tracking
// (component auto-expand still runs after restoreImpl() clears ACTIVE_RESTORE_OUT_DIR),
// so it needs its OWN, longer-lived tracked variable rather than reusing that one.
import { rmSync, readdirSync, chmodSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_CHILDREN } from './proc.js';

let ACTIVE_STAGE: string | null = null;
let ACTIVE_OUT_PART: string | null = null; // the partial ${out}.part being written; erased on signal so no stray ciphertext lingers
let ACTIVE_RESTORE_OUT_DIR: string | null = null; // restore()'s --out-dir while the vetted scratch tree is being promoted into it
let ACTIVE_RESTORE_OUT_DIR_PREEXISTED = false; // whether restore() created out-dir itself (safe to erase) or it was already there (must not be destroyed)
// restore()'s ISOLATED scratch directory (#218) while tar extracts an already-vetted
// archive into it — a SEPARATE slot from ACTIVE_RESTORE_OUT_DIR/preexisted because,
// unlike out-dir, the scratch dir is ALWAYS restore's own freshly-created temp
// directory: always safe to erase outright on signal, no preexisted flag needed (same
// "always ours" guarantee ACTIVE_STAGE already gives snapshot()'s plaintext staging
// dir — kept as its own field rather than reused because mcp.ts's long-lived server
// process can have a snapshot_now and a restore_now call in flight in the same
// process, and two unrelated resources sharing one slot would let one clobber the
// other's cleanup).
let ACTIVE_RESTORE_SCRATCH_DIR: string | null = null;
let ACTIVE_VERIFY_SCRATCH_DIR: string | null = null; // verify --level remote/drill's pulled-ciphertext (+, for drill, decrypted-plaintext) scratch dir, for its ENTIRE lifetime
// The MCP server's own fetch dirs (src/mcp.ts): verify_restore and restore_now each pull
// a locator into a private temp dir (`pulled.age`), and restore_now additionally copies a
// caller-given `file` into one before pinning it (`given.age`). Ciphertext, not plaintext
// — lower stakes than the stage dir above — but the finally-blocks that erase them are
// skipped by a signal exactly the same way, and the process they live in is a LONG-LIVED
// server: an operator Ctrl-C or a launchd/shutdown SIGTERM is the ordinary way it ends,
// not an exceptional one.
//
// A Set rather than a scalar slot, unlike every scalar field above it. Those all belong to
// one-shot CLI invocations that hold at most one such resource at a time; this server can
// have two verify_restore calls (or a verify_restore and a restore_now) in flight at once
// — the request handlers interleave, only captureCall()'s console capture is serialized —
// so a single slot would let the second call's registration silently orphan the first
// call's dir, and the first call's finally then deregister a dir belonging to the second.
// That is the same "two unrelated resources must not share one slot" reasoning that gave
// ACTIVE_RESTORE_SCRATCH_DIR its own field, applied WITHIN one resource kind.
const ACTIVE_MCP_FETCH_DIRS = new Set<string>();
// scanForSecrets()'s gitleaks report temp dir while a scan is in flight — a Set for the
// exact same reason ACTIVE_MCP_FETCH_DIRS above is one: mcp.ts's snapshot_now handler only
// takes an idempotency lock when a caller-supplied idempotency_key is given, so two
// snapshot_now calls (no key, or two different keys) run their scans fully concurrently. A
// scalar slot here (as this used to be, and as scanForSecrets()'s own comment flagged) let
// the second scan's registration evict the first scan's dir, and the first scan's finally
// then clear the slot out from under the second — a signal landing while the second scan
// was still running would find ACTIVE_SCAN_REPORT_DIR already null and leak its gitleaks
// report dir under os.tmpdir() forever instead of being swept by forceRmSync (#696).
const ACTIVE_SCAN_REPORT_DIRS = new Set<string>();
// #644: the ephemeral temp trees src/lib/backends/ton.ts's p2pFetch(),
// src/lib/backends/ton-provider.ts's put(), and src/lib/ton-dns.ts's
// assertBagAvailable() each mkdtemp() to hold a LOCAL tonutils-storage daemon's db
// (ADNL key + piece cache) plus, for ton.ts/ton-provider.ts, a copy of the ciphertext
// itself — potentially multi-gigabyte for a large brain. All three already register
// the daemon CHILD PROCESS they spawn in ACTIVE_CHILDREN (proc.ts, via
// ton-client.ts's spawnDaemon), which the handler below already kills first — but
// until this set existed nothing tracked the DIRECTORY, so a signal left both a
// zombie-adjacent orphaned daemon (its process killed, but its db/output never swept)
// and the temp tree itself sitting under os.tmpdir() forever. A Set for the same
// "two unrelated resources must not share one slot" reason ACTIVE_MCP_FETCH_DIRS is
// one: ton.ts's put()+get() and ton-provider.ts's own put() can each have their own
// tmpRoot in flight in the same process (MCP server, or `schedule install`'s cron
// running push then immediately pull).
const ACTIVE_TON_TMP_DIRS = new Set<string>();
let SIGNAL_GUARD_INSTALLED = false;

// fs.rmSync({force: true}) only swallows ENOENT (already gone) — it does NOT retry past
// an EACCES from a read-only directory somewhere under `dir` (removing an entry needs
// WRITE on its PARENT directory, not on the entry itself). A --dir source captured with
// a restrictive mode, or a component tarball that recorded one, can land exactly that
// under a drill's scratch dir even though the outer extract itself passes
// --no-same-permissions (#209 review). This handler cannot await (the process is
// mid-signal), so unlike util.ts's rmrf (the async, normal-exit equivalent of this same
// idea) this chmods synchronously and swallows whatever is still left afterward — the
// same best-effort posture every other branch in this handler already has.
function forceRmSync(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {}
  try {
    unlockRecursiveSync(dir);
  } catch {}
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function unlockRecursiveSync(dir: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // not a directory, or already gone — nothing to unlock
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) unlockRecursiveSync(p);
    try {
      chmodSync(p, e.isDirectory() ? 0o700 : 0o600);
    } catch {}
  }
  try {
    chmodSync(dir, 0o700);
  } catch {}
}

// ESM live bindings are read-only from the importing side, so the module that owns a
// stage / .part (snapshot) or an out-dir (restore) registers them through these setters.
export const setActiveStage = (v: string | null): void => {
  ACTIVE_STAGE = v;
};
export const setActiveOutPart = (v: string | null): void => {
  ACTIVE_OUT_PART = v;
};
// restore() calls this right after it creates/confirms --out-dir and before the tar
// child starts extracting into it, then clears it (v=null) once the extract settles
// (success, or its own catch-block cleanup already ran) — a LATER signal (e.g. during
// a subsequent pg_restore) must not touch out-dir anymore. `preExisted` mirrors
// restore()'s own non-signal cleanup rule: if restore() created out-dir itself it is
// safe to erase outright on signal; if the caller pointed at a directory that was
// already there, deleting it would destroy content we don't own, so the handler
// instead drops a synchronous sentinel flagging it unsafe to trust.
export const setActiveRestoreOutDir = (v: string | null, preExisted = false): void => {
  ACTIVE_RESTORE_OUT_DIR = v;
  ACTIVE_RESTORE_OUT_DIR_PREEXISTED = preExisted;
};
// restore() calls this right after mkdirSync'ing its isolated scratch directory and
// before the tar child starts extracting the already-vetted archive into it, then
// clears it (v=null) once extraction settles — mirroring ACTIVE_STAGE's own
// create-then-register-then-clear discipline for snapshot()'s plaintext stage.
export const setActiveRestoreScratchDir = (v: string | null): void => {
  ACTIVE_RESTORE_SCRATCH_DIR = v;
};
// verify --level remote/drill (src/lib/restore.ts, #209) registers its scratch dir here
// the instant mkdtempSync creates it, and clears it only once its own cleanup (rmrf, in
// util.ts) has actually finished removing it — covering the ENTIRE call, not just the
// decrypt+extract step restoreImpl() tracks via setActiveRestoreOutDir above. That
// narrower tracking is not enough by itself: restoreImpl() clears it as soon as the tar
// extract settles, which is BEFORE component auto-expand runs (still more plaintext
// written under this same scratch dir) and long before the pulled ciphertext itself is
// removed — a signal landing in either of those windows previously went untracked
// entirely (multi-model review finding on PR #332).
export const setActiveVerifyScratchDir = (v: string | null): void => {
  ACTIVE_VERIFY_SCRATCH_DIR = v;
};
// mcp.ts registers a fetch dir in the SAME tick it is created (mkdtempSync, no await in
// between — an `await mkdtemp()` would leave the directory on disk but untracked for as
// long as the continuation is queued) and deregisters it only AFTER its own `rm` has
// actually finished removing it. Both halves matter: registering late leaves a window
// where a signal finds an untracked dir, and deregistering early leaves one where it
// finds a tracked dir nobody will erase.
export const addActiveMcpFetchDir = (dir: string): void => {
  ACTIVE_MCP_FETCH_DIRS.add(dir);
};
export const removeActiveMcpFetchDir = (dir: string): void => {
  ACTIVE_MCP_FETCH_DIRS.delete(dir);
};
// scanForSecrets()'s own temp dir, holding gitleaks' JSON report while a scan is in
// flight. It leans on a finally-block exactly like the stage dir does, and a signal
// skips it exactly the same way — which stopped being hypothetical when #301 made the
// scan run by default, so the window now exists on an ordinary snapshot rather than only
// when someone asked for the gate. The report is redacted (rule IDs, no match text), so
// this is tidiness rather than plaintext exposure; it is registered here anyway because
// "a temp dir the finally would have removed" is precisely what this module is for.
// Registered/deregistered the SAME way addActiveMcpFetchDir/removeActiveMcpFetchDir are —
// add() in the same tick mkdtempSync creates the dir, delete() only after
// scanForSecrets()'s own `rm` has actually finished removing it — for the same "two
// concurrent calls must not share one slot" reason ACTIVE_SCAN_REPORT_DIRS is a Set (#696).
export const addActiveScanReportDir = (dir: string): void => {
  ACTIVE_SCAN_REPORT_DIRS.add(dir);
};
export const removeActiveScanReportDir = (dir: string): void => {
  ACTIVE_SCAN_REPORT_DIRS.delete(dir);
};
// #644: ton.ts/ton-provider.ts/ton-dns.ts call these the SAME way mcp.ts's
// makeFetchDir/discardFetchDir do — register in the same tick mkdtemp() returns (no
// await in between), deregister only after their own rmrf() has actually finished —
// and, critically, call installStageSignalGuard() themselves at that same point
// (idempotent), since push/pull/publish-latest never install it on their own (unlike
// snapshot()/restore()'s own self-install). Without that self-install here, ACTIVE_CHILDREN
// already held the daemon child (ton-client.ts's spawnDaemon) but no signal HANDLER
// existed to ever look at it.
export const addActiveTonTmpDir = (dir: string): void => {
  ACTIVE_TON_TMP_DIRS.add(dir);
};
export const removeActiveTonTmpDir = (dir: string): void => {
  ACTIVE_TON_TMP_DIRS.delete(dir);
};

export function installStageSignalGuard(): void {
  if (SIGNAL_GUARD_INSTALLED) return;
  SIGNAL_GUARD_INSTALLED = true;
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of signals) {
    const handler = () => {
      // Kill the pipeline children FIRST so a still-writing age/tar can't re-create the
      // stage, .part, or out-dir contents after we remove/flag them (the signal may
      // have hit node alone).
      for (const c of ACTIVE_CHILDREN) {
        try {
          c.kill('SIGKILL');
        } catch {}
      }
      ACTIVE_CHILDREN.clear();
      if (ACTIVE_STAGE) {
        forceRmSync(ACTIVE_STAGE);
        ACTIVE_STAGE = null;
      }
      if (ACTIVE_OUT_PART) {
        try {
          rmSync(ACTIVE_OUT_PART, { force: true });
        } catch {}
        ACTIVE_OUT_PART = null;
      }
      if (ACTIVE_RESTORE_SCRATCH_DIR) {
        // Always safe to erase outright — restore's scratch dir is never anything
        // other than a directory restore just mkdirSync'd itself moments earlier.
        try {
          rmSync(ACTIVE_RESTORE_SCRATCH_DIR, { recursive: true, force: true });
        } catch {}
        ACTIVE_RESTORE_SCRATCH_DIR = null;
      }
      if (ACTIVE_RESTORE_OUT_DIR) {
        if (!ACTIVE_RESTORE_OUT_DIR_PREEXISTED) {
          forceRmSync(ACTIVE_RESTORE_OUT_DIR);
        } else {
          // can't safely delete a directory the caller already owned before restore()
          // touched it — drop a durable sentinel instead (a console.error here could be
          // lost: the process is about to die and stderr writes are not guaranteed to
          // flush before that happens).
          try {
            writeFileSync(
              join(ACTIVE_RESTORE_OUT_DIR, '.cypher-brain-restore-INCOMPLETE'),
              `restore interrupted by ${sig} at ${new Date().toISOString()} — this directory may hold a partially-extracted tree; discard it before trusting the contents\n`,
            );
          } catch {}
        }
        ACTIVE_RESTORE_OUT_DIR = null;
        ACTIVE_RESTORE_OUT_DIR_PREEXISTED = false;
      }
      // Covers verify --level remote/drill's ENTIRE scratch dir (pulled ciphertext, and
      // for drill the decrypted+expanded plaintext under it) — always safe to erase
      // outright, unlike ACTIVE_RESTORE_OUT_DIR above: this scratch dir is always one
      // verify() itself created (mkdtempSync), never a caller-owned directory, so there
      // is no "preexisted" case to protect here.
      if (ACTIVE_VERIFY_SCRATCH_DIR) {
        forceRmSync(ACTIVE_VERIFY_SCRATCH_DIR);
        ACTIVE_VERIFY_SCRATCH_DIR = null;
      }
      // Every MCP fetch dir currently in flight (see ACTIVE_MCP_FETCH_DIRS above) — a set,
      // so concurrent tool calls are each erased rather than only whichever registered
      // last. Always safe to erase outright: each one is a directory mcp.ts mkdtempSync'd
      // itself, never a caller-owned path.
      for (const dir of ACTIVE_MCP_FETCH_DIRS) forceRmSync(dir);
      ACTIVE_MCP_FETCH_DIRS.clear();
      // Every scan report dir currently in flight (see ACTIVE_SCAN_REPORT_DIRS above) — a
      // set, so concurrent snapshot_now scans are each erased rather than only whichever
      // registered last. Always safe to erase outright: each one is a directory
      // scanForSecrets() mkdtempSync'd itself, never a caller-owned path.
      for (const dir of ACTIVE_SCAN_REPORT_DIRS) forceRmSync(dir);
      ACTIVE_SCAN_REPORT_DIRS.clear();
      // #644: same "always ours, always safe to erase outright" reasoning as every set/
      // slot above — each dir here is one ton.ts/ton-provider.ts/ton-dns.ts mkdtemp()'d
      // itself. The daemon CHILD living inside one of these dirs was already SIGKILLed
      // by the ACTIVE_CHILDREN loop at the very top of this handler, before this runs —
      // so there is no still-writing process left to race with removing its directory.
      for (const dir of ACTIVE_TON_TMP_DIRS) forceRmSync(dir);
      ACTIVE_TON_TMP_DIRS.clear();
      // adding a listener suppressed Node's default auto-terminate — remove only our
      // own handler (not any unrelated listener) and re-raise so the process exits
      // with the correct signal code instead of hanging.
      process.off(sig, handler);
      process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
}
