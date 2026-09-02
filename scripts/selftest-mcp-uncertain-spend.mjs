#!/usr/bin/env node
// Issue #818 (+ #809, #810) at the MCP level: what a paid snapshot_now does when the
// push's outcome is UNCERTAIN — the payment MAY have happened and nothing readable can
// say whether it did.
//
// Driven against the BUNDLED build (`node dist/mcp.mjs`) over stdio, exactly like
// scripts/mcp-smoke.mjs, with a mock Arweave gateway in this process. Nothing here
// touches a real network or spends anything: the gateway answers `/price`, `/tx_anchor`
// and `/wallet/<addr>/balance` so the backend gets far enough to SIGN a transaction, then
// refuses the `POST /tx` and answers every `tx/<id>/status` probe 404 — which is the
// backend's definition of inconclusive (a just-posted transaction is not immediately
// indexed, so "not found" is never proof of absence).
//
// What it pins, in order:
//   1. the first call returns isError with code ERR_PUSH_OUTCOME_UNCERTAIN, the backend,
//      check_kind/check_identifier (the signed tx id), and NO pushed/locator;
//   2. a retry with the SAME idempotency_key is STILL an error, marked
//      idempotent_replay:true — and the gateway's submission counter has not moved, i.e.
//      no second transaction was signed and posted (on main it is 2 by this point);
//   3. after the TTL has passed AND a compaction rewrite has run, the key is STILL
//      blocked: the tombstone is `retention: permanent`, so expiry cannot be what lets a
//      retry pay a second time;
//   4. #809: when the result record cannot be WRITTEN after such an outcome, the claim is
//      RETAINED rather than released — a second server process carrying that key is
//      refused (ERR_IDEMPOTENCY_IN_FLIGHT) instead of running the paid path again;
//   5. a NEW key still executes — the guard blocks the key, not the tool.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = join(ROOT, 'dist', 'mcp.mjs');
const CLI_PATH = join(ROOT, 'dist', 'cli.mjs');
const TIMEOUT_MS = 120_000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

function parseFrames(buf) {
  const out = [];
  for (const line of buf.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* incomplete JSON line — ignore */
    }
  }
  return out;
}

function makeRpcClient(child) {
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString('utf8');
  });
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString('utf8');
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  async function waitFor(id) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const frame = parseFrames(stdoutBuf).find((f) => f.id === id);
      if (frame) return frame;
      await wait(100);
    }
    throw new Error(
      `no response for id=${id} within ${TIMEOUT_MS}ms; stdout=${stdoutBuf.slice(0, 800)} stderr=${stderrBuf.slice(-800)}`,
    );
  }
  return { send, waitFor, stderr: () => stderrBuf };
}

// The mock gateway. `submissions` is the counter the double-spend assertions read: it
// counts POST /tx, i.e. every transaction this process actually signed and sent.
function startMockGateway() {
  const state = { submissions: 0 };
  const server = createServer((req, res) => {
    const url = req.url || '';
    if (req.method === 'POST' && /^\/tx\/?$/.test(url)) {
      state.submissions++;
      req.resume();
      req.on('end', () => {
        // A refused POST, not a dropped socket: same ambiguity (the gateway may have
        // persisted the transaction anyway — a 5xx from a proxy in front of one routinely
        // follows a write that landed) and no timeout to wait out.
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('mock gateway: upload refused (issue #818 fixture)');
      });
      return;
    }
    // Every status probe is 404 — INCONCLUSIVE by the backend's own rule, never "absent".
    if (/^\/tx\/[A-Za-z0-9_-]{43}\/status$/.test(url)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    if (/^\/price\/\d+/.test(url)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('1000'); // winston; no CYPHER_BRAIN_MAX_SPEND is set, so this only has to parse
      return;
    }
    if (url === '/tx_anchor') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(randomBytes(32).toString('base64url'));
      return;
    }
    if (/^\/wallet\/[A-Za-z0-9_-]+\/balance$/.test(url)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('1000000000000'); // comfortably above the 1000-winston price above
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

const sc = (frame) => frame?.result?.structuredContent;

async function initialize(client) {
  client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-uncertain', version: '0.0.0' } },
  });
  await client.waitFor(1);
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await wait(100);
}

async function main() {
  if (!existsSync(SERVER_PATH)) throw new Error(`build first: ${SERVER_PATH} is missing`);
  const tmp = await mkdtemp(join(tmpdir(), 'cb-mcp-uncertain-'));
  const gateway = await startMockGateway();
  const home = join(tmp, 'home');
  const data = join(tmp, 'data');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'hello.txt'), 'cypher-brain #818 uncertain-spend payload\n');

  const keygen = spawnSync(process.execPath, [CLI_PATH, 'keygen'], {
    env: { ...process.env, CYPHER_BRAIN_HOME: home },
    encoding: 'utf8',
  });
  if (keygen.status !== 0) throw new Error(`keygen failed (${keygen.status}): ${keygen.stderr || keygen.stdout}`);
  const recipientPath = join(home, 'recipient.txt');

  // A real Arweave JWK, generated locally through the same SDK the backend uses — the
  // gateway is a mock but the SIGNING is genuine, which is what makes the tx id in the
  // error a real, deterministic function of the signed transaction.
  const { default: Arweave } = await import('arweave');
  const arweave = Arweave.init({ host: '127.0.0.1', port: gateway.port, protocol: 'http' });
  const walletPath = join(tmp, 'wallet.json');
  await writeFile(walletPath, JSON.stringify(await arweave.wallets.generate()), { mode: 0o600 });

  const logPath = join(home, 'idempotency-log.jsonl');
  const baseEnv = {
    ...process.env,
    CYPHER_BRAIN_HOME: home,
    CYPHER_BRAIN_AR_HOST: '127.0.0.1',
    CYPHER_BRAIN_AR_PORT: String(gateway.port),
    CYPHER_BRAIN_AR_PROTOCOL: 'http',
    CYPHER_BRAIN_AR_WALLET: walletPath,
    // The USD-rate lookup is advisory and swallows every failure; point it at the mock's
    // 404 anyway so this test makes no outbound request at all.
    CYPHER_BRAIN_AR_USD_RATE_URL: `http://127.0.0.1:${gateway.port}/rates`,
    CYPHER_BRAIN_RECEIPT_LEDGER: join(tmp, 'receipts.jsonl'),
  };
  const snapshotArgs = (out, key) => ({
    dirs: [data],
    recipients: [recipientPath],
    out,
    backend: 'arweave',
    confirm_paid: true,
    idempotency_key: key,
  });

  const children = [];
  const startServer = (env) => {
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env });
    children.push(child);
    return makeRpcClient(child);
  };

  try {
    // ---------- 1. the first call: uncertain, typed, with the tx id ----------
    const key1 = 'uncertain-key-1';
    const out1 = join(tmp, 'snap1.age');
    const client = startServer(baseEnv);
    await initialize(client);
    client.send({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'snapshot_now', arguments: snapshotArgs(out1, key1) },
    });
    const first = await client.waitFor(10);
    const firstSc = sc(first);
    check(
      'the first call reports ERR_PUSH_OUTCOME_UNCERTAIN as an ERROR result',
      first.result?.isError === true && firstSc?.code === 'ERR_PUSH_OUTCOME_UNCERTAIN',
      JSON.stringify(first.result).slice(0, 500),
    );
    check(
      'it carries spend_outcome/backend/check_kind and a 43-char Arweave tx id to verify',
      firstSc?.spend_outcome === 'uncertain' &&
        firstSc?.backend === 'arweave' &&
        firstSc?.check_kind === 'arweave_tx_id' &&
        /^[A-Za-z0-9_-]{43}$/.test(firstSc?.check_identifier ?? ''),
      JSON.stringify(firstSc).slice(0, 500),
    );
    check(
      'it claims NO upload: neither `pushed` nor `locator` is present',
      firstSc !== undefined && !('pushed' in firstSc) && !('locator' in firstSc),
      JSON.stringify(firstSc).slice(0, 300),
    );
    check(
      'the message names the [CB-E027] code and the identifier to check',
      typeof firstSc?.message === 'string' &&
        firstSc.message.includes('[CB-E027]') &&
        firstSc.message.includes(firstSc.check_identifier),
      String(firstSc?.message).slice(0, 400),
    );
    check(
      'exactly ONE transaction was submitted to the gateway',
      gateway.state.submissions === 1,
      `submissions=${gateway.state.submissions}`,
    );

    // ---------- 2. the same key again: still an error, and NOTHING is re-submitted ----------
    // This is the double-spend the issue is about. On main the uncertain outcome is an
    // ordinary Error, so nothing is recorded, the claim is released, and this call runs
    // the whole paid path again (submissions becomes 2).
    client.send({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'snapshot_now', arguments: snapshotArgs(out1, key1) },
    });
    const replay = await client.waitFor(11);
    const replaySc = sc(replay);
    check(
      'a retry with the SAME key replays the tombstone as an ERROR (isError, idempotent_replay)',
      replay.result?.isError === true &&
        replaySc?.idempotent_replay === true &&
        replaySc?.code === 'ERR_PUSH_OUTCOME_UNCERTAIN' &&
        replaySc?.check_identifier === firstSc?.check_identifier,
      JSON.stringify(replay.result).slice(0, 500),
    );
    check(
      'the retry replayed `pushed`/`locator`-free, so it cannot read as a successful push',
      replaySc !== undefined && !('pushed' in replaySc) && !('locator' in replaySc),
      JSON.stringify(replaySc).slice(0, 300),
    );
    check(
      'the retry submitted NOTHING — the gateway counter is still 1 (no double-spend)',
      gateway.state.submissions === 1,
      `submissions=${gateway.state.submissions}`,
    );

    // ---------- 3. past the TTL, and past a compaction: still blocked ----------
    // A fresh server with a 1-second TTL, a wait, and then a record write for ANOTHER key
    // (which is what rewrites the log and drops expired records). A `retention: ttl`
    // record would be gone by now; the tombstone must not be.
    const ttlClient = startServer({ ...baseEnv, CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS: '1' });
    await initialize(ttlClient);
    await wait(1500);
    ttlClient.send({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        // No backend: a free, local-only call whose only job here is to write a record and
        // thereby trigger the compaction rewrite.
        arguments: {
          dirs: [data],
          recipients: [recipientPath],
          out: join(tmp, 'compact.age'),
          idempotency_key: 'ttl-compaction-key',
        },
      },
    });
    const compaction = await ttlClient.waitFor(20);
    check(
      'setup: an unrelated call under a 1s TTL succeeds and rewrites (compacts) the log',
      compaction.result?.isError !== true,
      JSON.stringify(compaction.result).slice(0, 300),
    );
    const logAfterCompaction = await readFile(logPath, 'utf8');
    check(
      'setup control: that rewrite really happened and the log still holds the permanent record',
      logAfterCompaction.includes('"retention":"permanent"') && logAfterCompaction.includes('ttl-compaction-key'),
      logAfterCompaction.slice(0, 400),
    );
    ttlClient.send({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'snapshot_now', arguments: snapshotArgs(out1, key1) },
    });
    const afterTtl = await ttlClient.waitFor(21);
    const afterTtlSc = sc(afterTtl);
    check(
      'past the TTL and past a compaction, the key STILL replays the tombstone as an error',
      afterTtl.result?.isError === true &&
        afterTtlSc?.code === 'ERR_PUSH_OUTCOME_UNCERTAIN' &&
        afterTtlSc?.idempotent_replay === true,
      JSON.stringify(afterTtl.result).slice(0, 500),
    );
    check(
      'and it still submitted nothing (counter unchanged at 1)',
      gateway.state.submissions === 1,
      `submissions=${gateway.state.submissions}`,
    );

    // ---------- 4. #809: a record write that fails leaves the claim HELD ----------
    // The log's write lock is taken by hand and kept fresh, so recordIdempotencyResult
    // times out waiting for it — a deterministic stand-in for the disk-full/read-only log
    // the issue describes, and one that leaves the claim path untouched (the claim is a
    // different file). Refreshing the mtime matters: the lock has a staleness threshold,
    // and an untouched lock would simply be stolen instead of timing out.
    const key2 = 'uncertain-key-2';
    const out2 = join(tmp, 'snap2.age');
    await writeFile(`${logPath}.lock`, 'held by the #809 fixture', { flag: 'w' });
    const keepLockFresh = setInterval(() => {
      writeFile(`${logPath}.lock`, `held by the #809 fixture ${Date.now()}`, { flag: 'w' }).catch(() => {});
    }, 1000);
    let blocked;
    try {
      client.send({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'snapshot_now', arguments: snapshotArgs(out2, key2) },
      });
      blocked = await client.waitFor(12);
    } finally {
      clearInterval(keepLockFresh);
      await rm(`${logPath}.lock`, { force: true });
    }
    const blockedSc = sc(blocked);
    check(
      'a second uncertain call whose record cannot be written still reports the uncertain outcome',
      blocked.result?.isError === true && blockedSc?.code === 'ERR_PUSH_OUTCOME_UNCERTAIN',
      JSON.stringify(blocked.result).slice(0, 400),
    );
    check(
      'setup control: the record write really did fail (the result says the claim is RETAINED)',
      (blockedSc?.warnings ?? []).some(
        (w) => /RETAINED/.test(w) && /recording its idempotency-key result failed/.test(w),
      ),
      JSON.stringify(blockedSc?.warnings ?? []).slice(0, 600),
    );
    check(
      'the log holds no record for that key (nothing to replay — the claim is the only guard left)',
      !(await readFile(logPath, 'utf8')).includes(key2),
      (await readFile(logPath, 'utf8')).slice(0, 400),
    );
    // A SECOND process is what the retained claim has to stop: the in-process Set only
    // covers retries against this same server.
    const otherProcess = startServer(baseEnv);
    await initialize(otherProcess);
    otherProcess.send({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'snapshot_now', arguments: snapshotArgs(join(tmp, 'snap2b.age'), key2) },
    });
    const secondProcess = await otherProcess.waitFor(30);
    const secondSc = sc(secondProcess);
    check(
      'a SECOND server process carrying that key is refused (ERR_IDEMPOTENCY_IN_FLIGHT), not run again',
      secondProcess.result?.isError === true && secondSc?.code === 'ERR_IDEMPOTENCY_IN_FLIGHT',
      JSON.stringify(secondProcess.result).slice(0, 400),
    );
    check(
      'no third transaction was submitted while that key stayed claimed',
      gateway.state.submissions === 2,
      `submissions=${gateway.state.submissions}`,
    );
    // The claim lock file the warning tells an operator to remove really is on disk.
    const claimLocks = (await readdir(home)).filter((n) => n.startsWith('idempotency-log.jsonl.claim.'));
    check(
      'the retained claim exists on disk as the lock file the warning names',
      claimLocks.length >= 1,
      JSON.stringify(claimLocks),
    );

    // The SAME process must be refused too — dropping the in-process Set entry (so the
    // documented "remove the lock file" recovery actually works, see below) must not open
    // a hole: the file claim is what refuses both.
    client.send({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'snapshot_now', arguments: snapshotArgs(out2, key2) },
    });
    const sameProcess = await client.waitFor(13);
    check(
      'the SAME server process is refused for that key too, by the retained file claim',
      sameProcess.result?.isError === true && sc(sameProcess)?.code === 'ERR_IDEMPOTENCY_IN_FLIGHT',
      JSON.stringify(sameProcess.result).slice(0, 400),
    );

    // The operator's documented recovery: verify what happened, then remove the named lock
    // file. That must genuinely unblock the key WITHOUT restarting the server.
    for (const name of claimLocks) await rm(join(home, name), { force: true });
    // The whole prior snapshot, sidecars included: snapshot() no-clobbers `.digest` and
    // `.recipients-fingerprint` as well as the ciphertext itself.
    for (const suffix of ['', '.digest', '.recipients-fingerprint', '.minisig']) {
      await rm(`${out2}${suffix}`, { force: true });
    }
    client.send({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'snapshot_now', arguments: snapshotArgs(out2, key2) },
    });
    const recovered = await client.waitFor(14);
    const recoveredSc = sc(recovered);
    check(
      'removing the lock file unblocks that key on the ALREADY-RUNNING server (no restart needed)',
      recovered.result?.isError === true &&
        recoveredSc?.code === 'ERR_PUSH_OUTCOME_UNCERTAIN' &&
        recoveredSc?.idempotent_replay === false,
      JSON.stringify(recovered.result).slice(0, 400),
    );
    check(
      'that recovered call really re-executed (the gateway counter moved to 3)',
      gateway.state.submissions === 3,
      `submissions=${gateway.state.submissions}`,
    );

    // ---------- 5. a NEW key still executes ----------
    // The guard blocks a key whose outcome is unresolved, not the tool: an operator who
    // has checked the chain and wants to try again with a new key must be able to.
    const freshClient = startServer(baseEnv);
    await initialize(freshClient);
    freshClient.send({
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: { name: 'snapshot_now', arguments: snapshotArgs(join(tmp, 'snap3.age'), 'uncertain-key-3') },
    });
    const fresh = await freshClient.waitFor(40);
    const freshSc = sc(fresh);
    check(
      'a NEW key executes again (and hits the same mock, so it is uncertain too)',
      fresh.result?.isError === true &&
        freshSc?.code === 'ERR_PUSH_OUTCOME_UNCERTAIN' &&
        freshSc?.idempotent_replay === false &&
        freshSc?.check_identifier !== firstSc?.check_identifier,
      JSON.stringify(fresh.result).slice(0, 400),
    );
    check(
      'that new key DID submit a transaction (counter moved) — the guard is per-key, not global',
      gateway.state.submissions === 4,
      `submissions=${gateway.state.submissions}`,
    );
  } finally {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    gateway.server.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

await main();
if (failed > 0) {
  console.log(`\nMCP UNCERTAIN-SPEND SELFTEST FAIL (${failed})`);
  process.exit(1);
}
console.log('\nMCP UNCERTAIN-SPEND SELFTEST PASS');
