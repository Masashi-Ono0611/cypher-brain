// tonutils-storage HTTP API client + ephemeral local daemon lifecycle, for the `ton`
// backend (ton.ts). Ported (trimmed to what this backend needs) from ton-mesh-harness's
// src/daemon/tonutils-process.ts — the sibling project whose bag-creation and daemon
// management code this project inherits; credit where this is borrowed from.
//
// Two distinct daemons are talked to through the same tiny API surface:
//   - the REMOTE seeder daemon (an operator-run tonutils-storage on an always-on box),
//     reached by ton.ts over SSH — never directly from here;
//   - a LOCAL, EPHEMERAL daemon this file spawns for a P2P download (get()'s primary
//     path), against a throwaway db dir, killed and deleted when the fetch ends.
//
// The API contract (verified against xssnick/tonutils-storage api/api.go):
//   POST /api/v1/create  {path, description}            -> BagDetailed (bag_id assigned)
//   POST /api/v1/add     {bag_id, path, download_all}   -> Ok (starts a P2P download)
//   GET  /api/v1/details?bag_id=<hex>                   -> BagDetailed (progress/files)
//   GET  /api/v1/list                                   -> {bags: [...]} (used as a ready probe)
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists, sleep } from '../util.js';
import { ACTIVE_CHILDREN } from '../proc.js';
import { TON_HTTP_TIMEOUT_MS } from '../config.js';

// The fields this backend actually reads. tonutils-storage returns more; extra keys
// pass through the JSON parse untyped and unread rather than being modeled here.
export interface TonBagDetails {
  bag_id: string;
  description: string;
  downloaded: number;
  size: number;
  files_count: number;
  dir_name: string;
  completed: boolean;
  header_loaded: boolean;
  info_loaded: boolean;
  active: boolean;
  seeding: boolean;
  path: string;
  files: Array<{ index: number; name: string; size: number }> | null;
}

export async function tonApi<T>(apiUrl: string, path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${apiUrl}${path}`, {
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(TON_HTTP_TIMEOUT_MS),
    ...init,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`tonutils-storage ${path} -> HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

export const tonDetails = (apiUrl: string, bagId: string): Promise<TonBagDetails> =>
  tonApi(apiUrl, `/api/v1/details?bag_id=${encodeURIComponent(bagId)}`);

export const tonAdd = (apiUrl: string, args: { bag_id: string; path: string }): Promise<unknown> =>
  tonApi(apiUrl, '/api/v1/add', {
    method: 'POST',
    body: JSON.stringify({ ...args, download_all: true }),
  });

// ---------- free-port helpers ----------
// The ephemeral daemon needs a loopback TCP port for its HTTP API and a UDP port for
// ADNL. Ask the kernel for a free one by binding port 0 and reading back what it chose.
// Racy by nature (freed before the daemon binds it), which is fine here: a lost race
// surfaces as the daemon failing its ready probe, not as silent corruption.
const freeTcpPort = (): Promise<number> =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => (port ? res(port) : rej(new Error('could not allocate a free TCP port'))));
    });
  });

const freeUdpPort = (): Promise<number> =>
  new Promise((res, rej) => {
    const sock = createSocket('udp4');
    sock.once('error', rej);
    sock.bind(0, '0.0.0.0', () => {
      const port = sock.address().port;
      sock.close(() => (port ? res(port) : rej(new Error('could not allocate a free UDP port'))));
    });
  });

export interface LocalTonDaemon {
  apiUrl: string;
  /** SIGKILL the daemon and WAIT for it to actually exit — callers delete its db dir next, and a still-dying process writing into a directory being removed is a race (multi-model review W1). */
  stop: () => Promise<void>;
}

// SIGKILL + await the close event (bounded): kill() only QUEUES the signal — reading
// or rewriting files the child owns before it has actually exited is a race.
function killAndWait(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((res) => {
    if (child.exitCode !== null || child.signalCode !== null) return res();
    const t = setTimeout(res, 5_000); // a child SIGKILL cannot reap (wedged in the kernel) must not hang us
    child.once('close', () => {
      clearTimeout(t);
      res();
    });
    try {
      child.kill('SIGKILL');
    } catch {
      clearTimeout(t);
      res();
    }
  });
}

// How long the two startup phases may take before this is reported as a daemon problem
// rather than waited out: config generation is a local disk write (seconds), and the
// ready probe only needs the HTTP listener up — neither involves the network.
const CONFIG_GEN_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 30_000;

const installAdvice = (bin: string): string =>
  `'${bin}' not found — install tonutils-storage (a single Go binary: ` +
  `https://github.com/xssnick/tonutils-storage/releases, or 'go install github.com/xssnick/tonutils-storage/cli@latest'), ` +
  `or set CYPHER_BRAIN_TON_BIN to its path`;

// Spawn one tonutils-storage. `--daemon` is REQUIRED, not stylistic: without it the
// binary runs an interactive REPL that, detached from a TTY, redraws its prompt in a
// hot loop — measured at 87% CPU and 47 GB of log in 6 hours on a real incident
// (sovereign-deploy-kit #37). stdio is 'ignore' on top of that: this daemon's output
// is progress noise, and the API is the interface.
function spawnDaemon(bin: string, args: string[]): ReturnType<typeof spawn> {
  const p = spawn(bin, ['--daemon', ...args], { stdio: 'ignore' });
  ACTIVE_CHILDREN.add(p);
  p.on('close', () => ACTIVE_CHILDREN.delete(p));
  return p;
}

/**
 * Start an ephemeral local tonutils-storage against `dbDir` (a throwaway directory the
 * CALLER owns and deletes) and wait until its HTTP API answers. Returns a handle whose
 * kill() the caller must invoke in a finally.
 *
 * First-run dance (inherited from ton-mesh-harness, which learned it the hard way): the
 * daemon's very first start generates <db>/config.json — including its ADNL key — and
 * then binds the FIXED default UDP port 17555, panicking if something else (another
 * cypher-brain, TON Browser's bundled daemon) already holds it. So: let it generate the
 * file, kill it, rewrite ListenAddr to a kernel-chosen free port, then start for real.
 */
export async function startLocalTonDaemon(
  bin: string,
  dbDir: string,
  networkConfigPath?: string,
): Promise<LocalTonDaemon> {
  const netArgs = networkConfigPath ? ['--network-config', networkConfigPath] : [];
  const configPath = join(dbDir, 'config.json');
  const enoent = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

  if (!(await exists(configPath))) {
    const genChild = spawnDaemon(bin, ['--db', dbDir, ...netArgs]);
    let spawnErr: unknown = null;
    genChild.on('error', (e) => (spawnErr = e));
    // Existence alone does not prove the write finished (Codex review): upstream writes
    // this file directly, and this loop's own SIGKILL below (via killAndWait, in finally)
    // fires the instant the condition below flips — killing a generator still mid-write
    // would leave a truncated file for the JSON.parse right after this try/finally.
    // Requiring a successful parse, not just existence, before breaking out is a cheap
    // completion barrier: a partially-written file fails to parse and is treated the same
    // as "not there yet", not as a fatal error.
    const configReady = async (): Promise<boolean> => {
      if (!(await exists(configPath))) return false;
      try {
        JSON.parse(await readFile(configPath, 'utf8'));
        return true;
      } catch {
        return false; // exists but still being written — keep polling
      }
    };
    try {
      const deadline = Date.now() + CONFIG_GEN_TIMEOUT_MS;
      while (!(await configReady())) {
        if (spawnErr !== null) {
          throw enoent(spawnErr) ? new Error(`ton backend: ${installAdvice(bin)}`) : (spawnErr as Error);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `ton backend: tonutils-storage did not generate ${configPath} within ${CONFIG_GEN_TIMEOUT_MS}ms`,
          );
        }
        await sleep(200);
      }
    } finally {
      // Await the exit, not just the signal: the config file is read and rewritten
      // right below, and a generator still mid-write would race that (review W1).
      await killAndWait(genChild);
    }
    // Rewrite ListenAddr to a free UDP port. Parsed-and-reserialized rather than
    // regex-patched so a malformed config fails loudly here instead of confusing the
    // daemon later.
    const cfg = JSON.parse(await readFile(configPath, 'utf8')) as { ListenAddr?: string };
    cfg.ListenAddr = `0.0.0.0:${await freeUdpPort()}`;
    await writeFile(configPath, JSON.stringify(cfg, null, 2));
  }

  const apiPort = await freeTcpPort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const child = spawnDaemon(bin, ['--api', `127.0.0.1:${apiPort}`, '--db', dbDir, ...netArgs]);
  let spawnErr: unknown = null;
  child.on('error', (e) => (spawnErr = e));
  const stop = (): Promise<void> => killAndWait(child);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (spawnErr !== null) {
      await stop();
      throw enoent(spawnErr) ? new Error(`ton backend: ${installAdvice(bin)}`) : (spawnErr as Error);
    }
    // Early-exit on a daemon that already died (lost the UDP-port race and panicked, a
    // corrupt db, ...) instead of burning the full timeout probing a dead process.
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`ton backend: tonutils-storage exited with code ${child.exitCode} during startup`);
    }
    try {
      // A bare per-probe timeout, shorter than TON_HTTP_TIMEOUT_MS: the daemon is on
      // loopback, so a slow answer here just means "not listening yet".
      const r = await fetch(`${apiUrl}/api/v1/list`, { signal: AbortSignal.timeout(1500) });
      // `r.ok` alone only proves SOMETHING answered on this loopback port (Codex review):
      // freeTcpPort()'s allocation is inherently racy by its own doc comment, so another
      // process could win the freed port before this daemon binds it. Requiring the
      // documented `/api/v1/list` shape (`{bags: [...]}`, per this file's own API-contract
      // comment above) before trusting the probe is a cheap way to confirm it is actually
      // tonutils-storage answering, not just any HTTP 200.
      const body: unknown = r.ok ? await r.json().catch(() => null) : null;
      if (body !== null && typeof body === 'object' && Array.isArray((body as { bags?: unknown }).bags)) {
        return { apiUrl, stop };
      }
    } catch {
      /* not ready yet */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`ton backend: tonutils-storage did not accept HTTP on ${apiUrl} within ${READY_TIMEOUT_MS}ms`);
    }
    await sleep(300);
  }
}
