// ton backend: TON Storage via a self-hosted seeder (an operator-run box with
// tonutils-storage on it — "the seeder" below) plus P2P retrieval.
//
// Same delegate-don't-reimplement posture as rclone.ts, with the split Codex review
// settled: a bag must be BORN on the machine that will retain and seed it, so put()
// transfers the ciphertext to the seeder over SSH/scp and creates the bag THERE
// (remote-side tonutils-storage HTTP API, reached through ssh + curl on loopback —
// the API is never exposed to the network). get()'s primary path is the opposite:
// a fresh, ephemeral local tonutils-storage downloads the bag over the real TON
// Storage P2P network by bag id — no credential, no SSH key, so the "identity +
// locator is all a fresh machine needs" recovery promise (README) holds. The seeder
// is only a FALLBACK read path, and says so loudly when used.
//
// What this backend does NOT promise (docs/durability.md): TON Storage is
// content-addressed P2P, not permanent storage — a bag is retrievable only while at
// least one reachable seeder retains it. One operator box is one failure domain.
//
// Locator: "ton:v1:<64-hex-bag-id>" — schema-versioned, nothing mutable embedded
// (no URLs, no host names: those live in config, not in the recovery artifact).
// The bag's single entry is always named "snapshot<ext>" so the locator needs no
// entry name. The bag id is the torrent's merkle root, and the P2P download path
// verifies every piece against it — but the SSH fallback path does not, which is
// why `ton` sits in NON_CONTENT_ADDRESSED_BACKENDS (config.ts): a pull without a
// --sha256 pin cannot tell which path served it.
import { mkdtempSync } from 'node:fs';
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join, extname, basename } from 'node:path';
import {
  AGE_MAGIC,
  MINISIG_MAGIC,
  PIPE_TIMEOUT_MS,
  TON_SSH_HOST,
  TON_SSH_KEY,
  TON_REMOTE_DIR,
  TON_REMOTE_API,
  TON_BIN,
  TON_NO_FALLBACK,
  TON_NETWORK_CONFIG,
} from '../config.js';
import { run } from '../proc.js';
import { sha256, sleep, readHead, rmrf, errMsg, makeBagLocator } from '../util.js';
import { progressReporter } from '../progress.js';
import { tonAdd, tonDetails, startLocalTonDaemon, type TonBagDetails } from './ton-client.js';
import { installStageSignalGuard, addActiveTonTmpDir, removeActiveTonTmpDir } from '../signal-guard.js';
import type { StorageBackend, PutOpts, FetchShape } from '../types.js';

// Locator shape (see header comment). Anchored + exact-length, same "narrow validated
// shape" defense file.ts/arweave.ts apply: a locator may arrive over an UNTRUSTED
// channel (a tampered --save-locator file feeding pull), and everything below embeds
// it into remote commands and URLs, so nothing but this shape may pass. Built via the
// shared makeBagLocator() factory (util.ts) — ton-provider.ts uses the same factory
// with the 'ton-provider' schema, so the two locator shapes cannot drift apart (#505).
//
// bagIdFrom is exported for src/lib/ton-dns.ts (the `publish-latest` command): the SAME
// locator shape guard used to gate push/pull, so a non-ton or malformed locator in a
// --from-locator-file is refused with one identical, already-tested message instead of
// a second, possibly-diverging regex.
const { locator: tonLocator, bagIdFrom, test: isTonLocator } = makeBagLocator('ton');
export { tonLocator, bagIdFrom };

// Everything interpolated into a REMOTE shell command line must pass one of these
// allowlists first — the remote side is a real shell (that is what ssh executes), so
// this is the entire injection surface. The values are operator-set config, i.e.
// already trusted like RCLONE_BIN, but "trusted" configs still get typos; a strict
// character set turns a would-be quoting bug into a loud refusal.
const HOST_RE = /^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/;
// No `~` anywhere (review W3): a quoted '~/x' in an ssh command line is a LITERAL
// tilde directory while scp may expand the same spelling remotely — the two paths
// silently diverge. Home-relative is spelled as a plain relative path (the ssh
// command and scp both resolve it against the SSH user's home), absolute as /...
const REMOTE_PATH_RE = /^[A-Za-z0-9._/-]+$/;

function assertRemoteSafe(value: string, what: string, re: RegExp): string {
  if (!re.test(value) || value.startsWith('-')) {
    throw new Error(
      `ton backend: ${what} contains characters this backend refuses to place in a remote command: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

const sshBaseArgs = (): string[] => [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  ...(TON_SSH_KEY ? ['-i', TON_SSH_KEY] : []),
];

// Run one command line on the seeder. Array-args spawn via proc.ts's run() locally
// (no local shell), remote side is sshd's shell — hence the allowlists above on every
// interpolated piece. ENOENT on ssh itself gets the same actionable-message treatment
// rclone.ts gives a missing rclone binary.
async function sshRun(cmd: string, timeoutMs = 60_000): Promise<string> {
  const host = assertRemoteSafe(TON_SSH_HOST, 'CYPHER_BRAIN_TON_SSH_HOST', HOST_RE);
  try {
    const { out } = await run('ssh', [...sshBaseArgs(), '--', host, cmd], { timeoutMs });
    return out;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`ton backend: 'ssh' not found on PATH — an OpenSSH client is required to reach the seeder`);
    }
    throw e;
  }
}

async function scpToSeeder(localFile: string, remotePath: string): Promise<void> {
  const host = assertRemoteSafe(TON_SSH_HOST, 'CYPHER_BRAIN_TON_SSH_HOST', HOST_RE);
  assertRemoteSafe(remotePath, 'remote path', REMOTE_PATH_RE);
  await run('scp', [...sshBaseArgs(), '-q', '--', resolve(localFile), `${host}:${remotePath}`], {
    timeoutMs: PIPE_TIMEOUT_MS,
  });
}

async function scpFromSeeder(remotePath: string, localFile: string): Promise<void> {
  const host = assertRemoteSafe(TON_SSH_HOST, 'CYPHER_BRAIN_TON_SSH_HOST', HOST_RE);
  assertRemoteSafe(remotePath, 'remote path', REMOTE_PATH_RE);
  await run('scp', [...sshBaseArgs(), '-q', '--', `${host}:${remotePath}`, resolve(localFile)], {
    timeoutMs: PIPE_TIMEOUT_MS,
  });
}

// The seeder daemon's API, reached as `curl` ON the seeder against loopback — the API
// stays bound to 127.0.0.1 there (its auth story is "loopback only"), and this keeps it
// that way instead of asking operators to tunnel or expose it.
async function seederApi<T>(pathAndQuery: string, postBody?: string, timeoutS = 60): Promise<T> {
  const api = assertRemoteSafe(TON_REMOTE_API, 'CYPHER_BRAIN_TON_REMOTE_API', /^[A-Za-z0-9.:-]+$/);
  // pathAndQuery/postBody are built ONLY from validated hex ids and allowlisted paths
  // by the callers below — never from free-form input.
  const post = postBody === undefined ? '' : ` -X POST -H 'Content-Type: application/json' --data '${postBody}'`;
  const out = await sshRun(
    `curl -sS -m ${Math.trunc(timeoutS)}${post} 'http://${api}${pathAndQuery}'`,
    (Math.trunc(timeoutS) + 30) * 1000,
  );
  let parsed: T & { error?: unknown };
  try {
    parsed = JSON.parse(out) as T & { error?: unknown };
  } catch {
    throw new Error(`ton backend: seeder API returned non-JSON for ${pathAndQuery}: ${out.slice(0, 200)}`);
  }
  // tonutils-storage reports handler failures as {"error": "..."} with HTTP 500 — curl
  // -sS still prints the body, so surface it as the error it is.
  if (parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string') {
    throw new Error(`ton backend: seeder API ${pathAndQuery} failed: ${parsed.error}`);
  }
  return parsed;
}

// The one entry name a cypher-brain bag ever contains (locator carries no entry name
// on purpose — see header). Extension preserved the same way file.ts's put() does, for
// the same #214 reason: the .minisig sidecar pushed through this SAME backend must not
// be misnamed snapshot.age.
// Exported for ton-provider.ts: the SAME "a bag holds exactly one entry, named
// snapshot.<ext>" rule applies there too — the locator carries no entry name for either
// backend (see header), so both must derive the identical name from the pushed file.
export const entryNameFor = (file: string): string => {
  const ext = extname(file) || '.age';
  if (ext !== '.age' && ext !== '.minisig') {
    throw new Error(
      `ton backend: refusing to push an unexpected artifact type (${ext}) — only .age ciphertext and its .minisig sidecar are ever stored`,
    );
  }
  return `snapshot${ext}`;
};

const ENTRY_RE = /(^|\/)snapshot\.(age|minisig)$/;

// Shape gate on fetched bytes (#318, arweave.ts's soft-404 lesson): the P2P path is
// merkle-verified against the bag id, but the bag id itself proves nothing about WHAT
// the bag holds, and the SSH fallback verifies nothing at all. Answer "is this the
// object type the caller asked for" before the bytes are handed anywhere.
async function assertShape(file: string, expect: FetchShape): Promise<void> {
  const head = await readHead(file, 64);
  const ok = expect === 'minisig' ? head.startsWith(MINISIG_MAGIC) : head.startsWith(AGE_MAGIC);
  if (!ok) {
    throw new Error(
      `ton backend: fetched object is not the expected ${expect === 'minisig' ? 'minisign signature' : 'age ciphertext'} (header mismatch)`,
    );
  }
}

const requireHost = (): void => {
  if (!TON_SSH_HOST) {
    throw new Error(
      'ton backend: CYPHER_BRAIN_TON_SSH_HOST (user@host of the seeder box running tonutils-storage) is required to push — ' +
        'see the README ton section for the seeder setup',
    );
  }
};

// Remote layout under CYPHER_BRAIN_TON_REMOTE_DIR (relative paths land in the SSH
// user's home, which is where a bare `ssh host cmd` runs):
//   staging/<sha>.part        upload in flight (unique name; atomically moved away)
//   bags/<sha>/snapshot<ext>  the bag's content dir (what /api/v1/create is pointed at)
//   inventory/<sha>.locator   sha->locator record, written LAST — its existence means
//                             "this bag was fully created and seeding was confirmed",
//                             which is what makes re-pushing the same ciphertext
//                             idempotent, and what the GC of old bags keys off.
interface RemotePaths {
  base: string;
  staging: string;
  bagDir: string;
  inventory: string;
}

function remotePathsFor(sha: string): RemotePaths {
  const base = assertRemoteSafe(TON_REMOTE_DIR, 'CYPHER_BRAIN_TON_REMOTE_DIR', REMOTE_PATH_RE);
  return {
    base,
    staging: `${base}/staging/${sha}.part`,
    bagDir: `${base}/bags/${sha}`,
    inventory: `${base}/inventory/${sha}.locator`,
  };
}

async function seederDetails(bagId: string): Promise<TonBagDetails> {
  return seederApi<TonBagDetails>(`/api/v1/details?bag_id=${bagId}`);
}

// Recovery oracle for a create whose RESPONSE was lost (remote curl timeout on a huge
// bag, an interrupted earlier push that died between create and the inventory write, a
// daemon that refuses a re-create of a dir it already holds): the bag directory is
// named by the ciphertext sha, and the daemon reports each bag's dir_name — so the
// bag id can be re-derived from the daemon's own list without ever guessing.
async function findSeederBagByDirName(dirName: string): Promise<string | null> {
  const r = await seederApi<{ bags?: Array<{ bag_id?: string; dir_name?: string }> | null }>('/api/v1/list');
  const hit = (r.bags ?? []).find((b) => b.dir_name === dirName);
  const id = hit?.bag_id?.toLowerCase?.();
  return id && /^[0-9a-f]{64}$/.test(id) ? id : null;
}

// How long put() waits for the seeder to finish hashing the new bag, and how long the
// create CALL itself may run: /api/v1/create can block while the daemon piece-hashes
// the file, which for a multi-GB brain is real work — 60s (the default API timeout)
// would cut the response off mid-create and lose the bag id. The recovery oracle
// above exists for exactly that loss, but not needing it is better.
const CREATE_READY_TIMEOUT_MS = 600_000;
const CREATE_CALL_TIMEOUT_S = 600;

// get()'s P2P phase gives up early in two situations that both read as "nobody
// reachable is seeding this bag": the bag's metadata (torrent info) never arrives, or
// the byte count stops moving. Both bounds are deliberately much shorter than
// PIPE_TIMEOUT_MS (the overall cap) so an unavailable bag falls through to the seeder
// fallback in minutes, not after an hour of silence.
const P2P_INFO_TIMEOUT_MS = 180_000;
const P2P_STALL_TIMEOUT_MS = 300_000;

// Exported for ton-provider.ts (issue #396): the P2P download path is protocol-level
// content-addressed retrieval, identical regardless of WHO is seeding the bag (our own
// seeder box vs a paid mytonprovider.org provider) — ton-provider.ts has no seeder-SSH
// fallback of its own (it never operates a seeder), so it reuses this P2P-only phase and
// surfaces a failure directly rather than duplicating this logic.
export async function p2pFetch(bagId: string, expect: FetchShape, out: string): Promise<void> {
  // #644: push/pull never install the signal guard themselves (unlike snapshot()/
  // restore()'s own self-install) — installStageSignalGuard() is idempotent, so calling
  // it here, before the tmp dir even exists, is what makes a SIGINT/SIGTERM/SIGHUP mid-
  // P2P-fetch actually kill the ephemeral daemon (ACTIVE_CHILDREN, already registered by
  // ton-client.ts's spawnDaemon) and sweep this directory, instead of the signal falling
  // through to Node's default "terminate with nothing cleaned up" behavior.
  installStageSignalGuard();
  // The WHOLE body sits inside the tmpRoot try/finally — a daemon that fails to start
  // must not leak the temp tree it was about to use (review W2). What is downloaded
  // here is ciphertext, so the leak class is disk garbage, not secrets — but garbage
  // that accumulates one directory per failed pull is still a leak.
  //
  // mkdtempSync (not the async mkdtemp), then register, with NO await in between —
  // multi-model review: an `await mkdtemp()` creates the directory on disk but leaves
  // the JS continuation that registers it queued, so a signal landing in that window
  // finds an untracked directory (the exact same reasoning mcp.ts's makeFetchDir()
  // documents for its own mkdtempSync usage).
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cypher-brain-ton-'));
  addActiveTonTmpDir(tmpRoot);
  try {
    await p2pFetchInto(tmpRoot, bagId, expect, out);
  } finally {
    // Deregister only AFTER rmrf() actually removed it (multi-model review) — if
    // cleanup itself fails (EACCES under the dir, say), the entry deliberately STAYS
    // registered so a LATER signal's forceRmSync (chmod+retry) is the one path left
    // that can still clear it. The failure is still swallowed here (advisory-only
    // cleanup, same as before this review comment): a leftover temp dir must never
    // fail an otherwise-successful pull.
    try {
      await rmrf(tmpRoot);
      removeActiveTonTmpDir(tmpRoot);
    } catch {
      /* left registered on purpose — see comment above */
    }
  }
}

async function p2pFetchInto(tmpRoot: string, bagId: string, expect: FetchShape, out: string): Promise<void> {
  const dbDir = join(tmpRoot, 'db');
  const dlDir = join(tmpRoot, 'dl');
  await mkdir(dbDir, { recursive: true });
  await mkdir(dlDir, { recursive: true });
  const daemon = await startLocalTonDaemon(TON_BIN, dbDir, TON_NETWORK_CONFIG || undefined);
  try {
    await tonAdd(daemon.apiUrl, { bag_id: bagId, path: dlDir });
    const progress = progressReporter('ton p2p pull');
    const started = Date.now();
    let infoBy = started + P2P_INFO_TIMEOUT_MS;
    let lastDownloaded = -1;
    let stallBy = started + P2P_STALL_TIMEOUT_MS;
    for (;;) {
      const d = await tonDetails(daemon.apiUrl, bagId);
      if (d.completed) break;
      const now = Date.now();
      if (!d.info_loaded && now > infoBy) {
        throw new Error(
          `ton backend: bag metadata not found on the P2P network within ${P2P_INFO_TIMEOUT_MS}ms — no reachable seeder appears to hold ${bagId}`,
        );
      }
      if (d.info_loaded) {
        infoBy = Number.POSITIVE_INFINITY;
        progress.report(d.downloaded, d.size);
        if (d.downloaded > lastDownloaded) {
          lastDownloaded = d.downloaded;
          stallBy = now + P2P_STALL_TIMEOUT_MS;
        } else if (now > stallBy) {
          throw new Error(
            `ton backend: P2P download stalled (no bytes for ${P2P_STALL_TIMEOUT_MS}ms) at ${d.downloaded}/${d.size}`,
          );
        }
      }
      if (now - started > PIPE_TIMEOUT_MS) {
        throw new Error(`ton backend: P2P download did not complete within ${PIPE_TIMEOUT_MS}ms`);
      }
      await sleep(1000);
    }
    // The daemon lays the bag out under its own directory naming (download root /
    // bag-id / <bag's internal dir name> / entry) — resolved by listing rather than
    // reconstructed, so a layout difference between versions cannot silently miss.
    const found = (await readdir(dlDir, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .find((p) => ENTRY_RE.test(p) && extname(p) === (expect === 'minisig' ? '.minisig' : '.age'));
    if (!found) {
      throw new Error(
        `ton backend: downloaded bag ${bagId} does not contain the expected snapshot entry — not a cypher-brain bag?`,
      );
    }
    await assertShape(found, expect);
    await mkdir(dirname(resolve(out)), { recursive: true });
    await copyFile(found, out);
  } finally {
    // Await the exit before the caller removes tmpRoot — a still-dying daemon writing
    // into a directory mid-removal is a race (review W1).
    await daemon.stop();
  }
}

// Fallback read path: fetch the object file straight off the seeder's disk over scp,
// via the inventory (sha -> locator) written at push time — deliberately NOT via the
// seeder's daemon API, so this path still works when that daemon is down, which is
// exactly the situation a disaster-recovery fallback exists for.
async function seederFetch(bagId: string, expect: FetchShape, out: string): Promise<void> {
  requireHost();
  const base = assertRemoteSafe(TON_REMOTE_DIR, 'CYPHER_BRAIN_TON_REMOTE_DIR', REMOTE_PATH_RE);
  const locator = tonLocator(bagId);
  // -r would be wrong here (directories); -l prints matching FILE names, one per line.
  const shaFile = (await sshRun(`grep -l -- '${locator}' ${base}/inventory/*.locator 2>/dev/null || true`))
    .trim()
    .split('\n')[0];
  if (!shaFile) throw new Error(`ton backend: seeder inventory has no record of ${locator}`);
  const sha = basename(shaFile, '.locator');
  assertRemoteSafe(sha, 'inventory sha', /^[0-9a-f]{64}$/);
  const ext = expect === 'minisig' ? '.minisig' : '.age';
  const remoteFile = `${base}/bags/${sha}/snapshot${ext}`;
  const tmpLocal = `${resolve(out)}.ton-fallback.part`;
  await scpFromSeeder(remoteFile, tmpLocal);
  try {
    await assertShape(tmpLocal, expect);
    await mkdir(dirname(resolve(out)), { recursive: true });
    await copyFile(tmpLocal, out);
  } finally {
    await rmrf(tmpLocal).catch(() => undefined);
  }
}

export function tonBackend(): StorageBackend {
  return {
    async put(file: string, _opts: PutOpts = {}): Promise<string> {
      requireHost();
      const entry = entryNameFor(file);
      const sha = await sha256(file);
      const p = remotePathsFor(sha);

      // Idempotency (the sha IS the key): a re-push of the same ciphertext returns the
      // recorded locator — after confirming the seeder still actually holds AND is
      // actively seeding the bag (the SAME completed && active gate the initial-create
      // path below waits for), because an inventory line whose bag is gone, or merely
      // retained-but-inactive (seeder daemon restarted, disk pressure evicted the piece
      // cache, ...), would otherwise hand back a locator nothing can currently serve
      // (#643: `completed` alone was true for a bag that had gone inactive, so a
      // re-push reported "already seeded" without actually restoring availability).
      const recorded = (await sshRun(`cat -- '${p.inventory}' 2>/dev/null || true`)).trim();
      if (isTonLocator(recorded)) {
        try {
          const d = await seederDetails(bagIdFrom(recorded));
          if (d.completed && d.active) {
            console.error(`ton: unchanged ciphertext already seeded as ${recorded} (idempotent re-push)`);
            return recorded;
          }
        } catch {
          /* stale inventory — fall through and re-create the bag */
        }
      }

      await sshRun(`mkdir -p -- '${p.base}/staging' '${p.bagDir}' '${p.base}/inventory'`);
      await scpToSeeder(file, p.staging);
      // Integrity of the transfer, checked before anything durable happens: scp already
      // checksums per-packet, but "the file scp wrote is the file we hashed locally" is
      // cheap to prove and ends any doubt a partial/interrupted earlier upload left.
      // sha256sum on Linux seeders, shasum -a 256 on macOS ones — same output shape.
      const remoteSha = (
        await sshRun(
          `if command -v sha256sum >/dev/null 2>&1; then sha256sum -- '${p.staging}'; else shasum -a 256 -- '${p.staging}'; fi`,
          PIPE_TIMEOUT_MS,
        )
      )
        .trim()
        .split(/\s+/)[0];
      if (remoteSha !== sha) {
        // Remove the bad staging copy before failing (review W4) — a deterministic
        // name means the next attempt overwrites it anyway, but a known-corrupt file
        // has no business surviving on the seeder.
        await sshRun(`rm -f -- '${p.staging}'`).catch(() => undefined);
        throw new Error(`ton backend: transfer corrupted — local sha256 ${sha}, seeder-side ${remoteSha}`);
      }
      await sshRun(`mv -f -- '${p.staging}' '${p.bagDir}/${entry}'`);

      // /api/v1/create needs an ABSOLUTE path on the seeder; resolve the (possibly
      // home-relative) bag dir there rather than guessing at $HOME from here.
      const absBagDir = (await sshRun(`cd -- '${p.bagDir}' && pwd`)).trim();
      assertRemoteSafe(absBagDir, 'resolved seeder bag directory', REMOTE_PATH_RE);
      let bagId: string | null = null;
      try {
        const created = await seederApi<TonBagDetails>(
          '/api/v1/create',
          JSON.stringify({ path: absBagDir, description: `cypher-brain ${sha.slice(0, 12)}` }),
          CREATE_CALL_TIMEOUT_S,
        );
        const id = created.bag_id?.toLowerCase?.();
        if (id && /^[0-9a-f]{64}$/.test(id)) bagId = id;
      } catch (createErr) {
        // The create RESPONSE is lost, not necessarily the create: a timeout on a huge
        // bag, or a daemon refusing a dir it already holds (an interrupted earlier push
        // that died before recording its inventory line). The bag dir is named by the
        // sha, so ask the daemon what it holds before declaring failure.
        bagId = await findSeederBagByDirName(sha).catch(() => null);
        if (bagId === null) throw createErr;
        console.error(`ton: create response lost (${errMsg(createErr)}) — recovered bag id from the seeder bag list`);
      }
      if (bagId === null) {
        throw new Error('ton backend: seeder returned an invalid bag id from /api/v1/create');
      }

      // "Created" is not "seeding": wait until the seeder reports the bag complete and
      // actively seeded before recording anything or handing the locator back — a
      // locator for a half-hashed bag would be a recovery artifact pointing at nothing.
      const deadline = Date.now() + CREATE_READY_TIMEOUT_MS;
      for (;;) {
        const d = await seederDetails(bagId);
        if (d.completed && d.active) break;
        if (Date.now() > deadline) {
          throw new Error(
            `ton backend: seeder did not finish creating/seeding bag ${bagId} within ${CREATE_READY_TIMEOUT_MS}ms`,
          );
        }
        await sleep(2000);
      }

      const locator = tonLocator(bagId);
      // Written last, atomically (tmp + mv): see the RemotePaths comment — existence
      // of this file is the "fully created" signal the idempotency check above trusts.
      await sshRun(`printf '%s' '${locator}' > '${p.inventory}.tmp' && mv -f -- '${p.inventory}.tmp' '${p.inventory}'`);
      console.error(`ton: bag ${bagId} created and seeding on ${TON_SSH_HOST}`);
      return locator;
    },

    async get(locator: string, out: string, expect: FetchShape = 'age'): Promise<void> {
      const bagId = bagIdFrom(locator);
      try {
        await p2pFetch(bagId, expect, out);
        console.error(`ton: fetched ${bagId} over the TON Storage P2P network (availability proven)`);
        return;
      } catch (p2pErr) {
        if (TON_NO_FALLBACK) {
          throw new Error(
            `ton backend: P2P fetch failed and CYPHER_BRAIN_TON_NO_FALLBACK=1 forbids the seeder fallback — ${errMsg(p2pErr)}`,
          );
        }
        if (!TON_SSH_HOST) {
          throw new Error(
            `ton backend: P2P fetch failed (${errMsg(p2pErr)}) and no CYPHER_BRAIN_TON_SSH_HOST is configured for the seeder fallback`,
          );
        }
        console.error(
          `ton: WARNING — P2P fetch failed (${errMsg(p2pErr)}); falling back to a direct copy from the seeder. ` +
            'P2P availability of this bag is NOT proven by this pull.',
        );
        await seederFetch(bagId, expect, out);
      }
    },
  };
}
