#!/usr/bin/env node
// A mock tonutils-storage for scripts/selftest-ton.sh — stands in for BOTH daemons the
// ton backend talks to (the seeder's and the ephemeral local one), speaking just the
// four /api/v1 endpoints src/lib/backends/ton-client.ts documents. Same testing idea as
// arweave-roundtrip.mjs's arlocal: exercise the REAL backend code end-to-end with no
// real network — except here the protocol peer is this stub, not a protocol
// implementation, so what the selftest proves is cypher-brain's own orchestration
// (transfer, create, poll, locate, fallback), never TON Storage itself (that is
// scripts/ton-dogfood.mjs's job, operator-run).
//
// "The network" is a shared registry file (MOCK_TON_STORE env): create() records
// bag_id -> source path there; add() on another instance "downloads" by copying from
// that path. Delete a registry entry and the bag is "gone from the network" — which is
// how the selftest forces the P2P path to fail and proves the fallback fires.
//
// Argv contract mirrored from the real binary (cli/main.go): --daemon (ignored),
// --api <addr>, --db <dir>, --network-config <path> (ignored). First run with no
// existing <db>/config.json writes one and idles — that is the real binary's
// generate-then-get-killed startup dance ton-client.ts drives.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const apiAddr = opt('--api');
const dbDir = opt('--db');
if (!dbDir) {
  console.error('mock-tonutils: --db required');
  process.exit(2);
}
const store = process.env.MOCK_TON_STORE;
if (!store) {
  console.error('mock-tonutils: MOCK_TON_STORE env required');
  process.exit(2);
}
const registryPath = join(store, 'registry.json');
const readRegistry = () => (existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : {});
const writeRegistry = (r) => writeFileSync(registryPath, JSON.stringify(r, null, 2));

mkdirSync(dbDir, { recursive: true });
const configPath = join(dbDir, 'config.json');
if (!existsSync(configPath)) {
  writeFileSync(configPath, JSON.stringify({ ListenAddr: '0.0.0.0:17555', Key: 'mock' }, null, 2));
}
// No --api: this is the config-generation run; idle until killed, like the real binary.
if (!apiAddr) {
  setInterval(() => {}, 1_000_000);
} else {
  const [host, port] = apiAddr.split(':');
  // Bags this instance holds (created here, or "downloaded" via add).
  const local = new Map(); // bag_id -> {path, entry, size}
  // issue #643 positive control (scripts/selftest-ton.sh): if MOCK_TONUTILS_INACTIVE_FLAG
  // is set AND the file it names exists, its CONTENTS ("<bag_id> <remaining_count>") name
  // a bag_id to report `completed: true, active: false` for the next `remaining_count`
  // details() calls that match it — a bag the seeder still fully retains (all bytes
  // present, nothing missing) but has stopped ACTIVELY seeding (daemon restarted, disk
  // pressure evicted the piece cache, ...). A COUNTER, not a plain sticky flag: the
  // idempotency check this simulates (ton.ts's put()) makes exactly ONE details() call
  // before falling through to re-create the bag, but re-creation's OWN "wait until
  // completed && active" poll loop (the SAME check the initial-create path always uses)
  // would starve for the full 10-minute CREATE_READY_TIMEOUT_MS if the SAME flag kept
  // reporting inactive forever — self-clearing after `remaining_count` matches lets a test
  // force exactly the idempotency check's own read without also wedging the re-create it
  // triggers. Read/rewritten fresh on every request (not cached at startup), matching
  // scripts/selftest-ton-provider.sh's own mock-tonapi.mjs flag-file convention. Unset/
  // absent is a no-op — selftest-ton-provider.sh's ephemeral local daemons never set this.
  const inactiveFlagPath = process.env.MOCK_TONUTILS_INACTIVE_FLAG;
  const consumeForcedInactive = (id) => {
    if (!inactiveFlagPath || !existsSync(inactiveFlagPath)) return false;
    const [flagId, countRaw] = readFileSync(inactiveFlagPath, 'utf8').trim().split(/\s+/);
    const count = Number(countRaw);
    if (flagId !== id || !Number.isInteger(count) || count <= 0) return false;
    const remaining = count - 1;
    writeFileSync(inactiveFlagPath, remaining > 0 ? `${flagId} ${remaining}` : '');
    return true;
  };

  const details = (id) => {
    const b = local.get(id);
    if (!b) return null;
    const forcedInactive = consumeForcedInactive(id);
    return {
      bag_id: id,
      description: b.description ?? 'mock',
      downloaded: b.size,
      size: b.size,
      files_count: 1,
      dir_name: basename(b.path),
      completed: true,
      header_loaded: true,
      info_loaded: true,
      active: !forcedInactive,
      seeding: !forcedInactive,
      path: b.path,
      files: [{ index: 0, name: b.entry, size: b.size }],
      // Additive fields for scripts/selftest-ton-provider.sh (src/lib/backends/
      // ton-provider.ts's createLocalBag()) — NOT exercised by selftest-ton.sh, which
      // reads none of these. `bag_size` is a second alias of `size` (both present: the
      // real tonutils-storage API's own struct comment in
      // scripts/go/storage-v1-client/seeder.go names it `bag_size`, but ton.ts's
      // production-tested TonBagDetails reads `size` — this mock does not know which
      // is the wire truth, so it emits both). piece_size/merkle_hash are NOT a real
      // merkle computation (this mock tracks raw file bytes, not TON Storage's actual
      // piece/merkle-tree protocol — see the file header) — just plausible-shaped fake
      // values so ton-provider.ts's field presence/shape checks have something to read.
      bag_size: b.size,
      piece_size: 131072,
      merkle_hash: id,
    };
  };

  const srv = createServer((req, res) => {
    const url = new URL(req.url, `http://${apiAddr}`);
    const reply = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      try {
        if (url.pathname === '/api/v1/list') return reply(200, { bags: [...local.keys()].map((id) => details(id)) });
        if (url.pathname === '/api/v1/details') {
          const d = details(url.searchParams.get('bag_id')?.toLowerCase());
          return d ? reply(200, d) : reply(500, { error: 'bag not found' });
        }
        if (url.pathname === '/api/v1/create') {
          const { path, description } = JSON.parse(body);
          // One entry per cypher-brain bag by construction; find it.
          const entries = ['snapshot.age', 'snapshot.minisig'].filter((n) => existsSync(join(path, n)));
          if (entries.length !== 1)
            return reply(500, { error: `mock: expected exactly one snapshot entry in ${path}` });
          const entry = entries[0];
          const file = join(path, entry);
          const id = createHash('sha256').update(readFileSync(file)).digest('hex');
          // Copy into a STABLE location under the shared store, rather than remembering
          // `path` itself: a real tonutils-storage daemon ingests and internally retains
          // piece data at create() time, so a bag stays fetchable over "P2P" even after
          // the caller's own source directory is gone (selftest-ton-provider.sh's put()
          // uses a torn-down-on-return local ephemeral directory — see ton-provider.ts's
          // header comment on why). Registering the original `path` here reproduced that
          // exact class of bug: a later /api/v1/add from a DIFFERENT mock instance failed
          // with ENOENT once the first instance's temp dir was cleaned up.
          const blobsDir = join(store, 'blobs');
          mkdirSync(blobsDir, { recursive: true });
          const stableFile = join(blobsDir, `${id}-${entry}`);
          copyFileSync(file, stableFile);
          const reg = readRegistry();
          reg[id] = { source: stableFile, entry };
          writeRegistry(reg);
          local.set(id, { path, entry, size: statSync(file).size, description });
          return reply(200, details(id));
        }
        if (url.pathname === '/api/v1/add') {
          const { bag_id, path } = JSON.parse(body);
          const id = String(bag_id).toLowerCase();
          const reg = readRegistry();
          if (!reg[id]) return reply(500, { error: 'mock: bag not on the network' });
          // #644 positive control (scripts/selftest-ton.sh's SIGTERM-mid-P2P-pull test):
          // if MOCK_TONUTILS_PARK_ON_ADD names a sentinel path, announce that this
          // request was reached and then never reply — pins ton.ts's p2pFetchInto() at
          // its `await tonAdd(...)` call so a test can SIGTERM the CLI process with the
          // ephemeral local daemon (this process) and its temp db dir both deterministically
          // still alive, instead of racing real (sub-millisecond, on this trivial mock)
          // download completion. Read fresh per-request, same convention as the
          // MOCK_TONUTILS_INACTIVE_FLAG counter above; unset is a no-op for every other
          // caller of this mock.
          if (process.env.MOCK_TONUTILS_PARK_ON_ADD) {
            writeFileSync(process.env.MOCK_TONUTILS_PARK_ON_ADD, 'reached\n');
            return; // never reply — this request just hangs until the process is killed
          }
          const dir = join(path, id, 'bag');
          mkdirSync(dir, { recursive: true });
          copyFileSync(reg[id].source, join(dir, reg[id].entry));
          local.set(id, { path: dir, entry: reg[id].entry, size: statSync(reg[id].source).size });
          return reply(200, { ok: true });
        }
        return reply(404, { error: `mock: no such endpoint ${url.pathname}` });
      } catch (e) {
        return reply(500, { error: `mock: ${e?.message ?? e}` });
      }
    });
  });
  srv.listen(Number(port), host);
}
