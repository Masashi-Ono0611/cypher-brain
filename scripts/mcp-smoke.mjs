#!/usr/bin/env node
// MCP smoke test for the bundled build. Spawns `node dist/mcp.mjs` over stdio and:
//   1. initialize + notifications/initialized + tools/list — asserts all ten
//      tool names (snapshot_now, last_snapshot_status, verify_restore,
//      restore_now, estimate_cost, schedule_install, schedule_status, keygen,
//      wallet_create, wallet_address) AND their MCP standard tool annotations
//      (readOnlyHint/destructiveHint/idempotentHint/openWorldHint, issue #219)
//      match the expected hints per tool (e.g. last_snapshot_status/
//      estimate_cost/schedule_status/wallet_address are readOnlyHint:true;
//      keygen/wallet_create are destructiveHint:true since force=true discards
//      existing key material; restore_now/schedule_install are
//      destructiveHint:true — restore_now can clobber pre-existing state via
//      pg_restore --clean --if-exists, schedule_install writes a real system
//      file and replaces any prior configuration).
//   2. a REAL snapshot_now round-trip against the free `file` backend inside a
//      temp CYPHER_BRAIN_HOME/CYPHER_BRAIN_FILE_DIR (keygen via the existing
//      lib first), then last_snapshot_status + verify_restore (by bare locator;
//      by locator_file, asserting its sha256 integrity pin was applied; and a
//      wrong-sha256 negative control that must fail closed with no verdict)
//      + restore_now (refuses without confirm_write, leaving out_dir untouched;
//      then a REAL round-trip — pull by locator, decrypt, extract — with the
//      restored file's content asserted on disk against what was snapshotted)
//      + estimate_cost on the result + schedule_install (refuses without
//      confirm_install; a REAL --no-load install against an isolated
//      CYPHER_BRAIN_LAUNCHD_DIR/CYPHER_BRAIN_SCHEDULE_DIR, never touching the
//      real launchctl/crontab) + schedule_status reading that same state back
//      (same schedule.ts state `cypher-brain schedule status` reads); the
//      unknown-argument refusal (#300): the reproduction that was filed —
//      a misspelled OPTIONAL field on snapshot_now, which used to return
//      isError:false having taken a real snapshot — plus the near-miss
//      suggestion (`restore_now {out}` → "did you mean out_dir?", the MCP
//      arrival of the CLI's own #277 hint), and a GENERIC pass over the
//      shared tool list asserting every advertised tool refuses an
//      undeclared argument, so a tool added later is covered without
//      anyone remembering to add a test for it;
//      the out-of-enum refusal (#308): the reproduction that was filed —
//      verify_restore {file, backend:"nonsense"}, which used to return
//      isError:false with a PASS verdict because its local-file branch never
//      consulted the backend — plus the near-miss suggestion for a value one
//      letter off (backend "fille" → "did you mean file?"), a GENERIC pass
//      over every field that DECLARES an enum in the tools/list response,
//      so a tool added later with a new enum field is covered the same way,
//      and a walk of every advertised schema that FAILS on an enum in a
//      shape the dispatcher's check does not read (nested, or a
//      non-primitive literal) rather than letting it ship unenforced;
//      the spend gate: snapshot_now with
//      backend=turbo and no confirm_paid must be refused with
//      ERR_CONFIRM_REQUIRED — even with CYPHER_BRAIN_YES set in the
//      environment (never silently spend); and a keygen call against this
//      server's ALREADY-KEYED home, which must refuse rather than re-key.
//   3. runKeygenWalletTests(): a SEPARATE server + a fresh, isolated
//      CYPHER_BRAIN_HOME proves the issue #174 first-run path end to end —
//      keygen then wallet_create then wallet_address, each's no-clobber
//      refusal without --force, and keygen --force actually rotating the
//      keypair — with real files asserted on disk, not just tool output.
//   4. idempotency_key (#220): a repeat snapshot_now call with the SAME key
//      replays the first call's result (idempotent_replay:true, identical
//      locator/sha256) instead of hitting the real no-clobber refusal a
//      second identical call would otherwise get; the same key reused for a
//      DIFFERENT call is refused (ERR_IDEMPOTENCY_KEY_REUSED); a DIFFERENT
//      key against the same already-existing `out` is NOT a free pass and
//      still hits the real no-clobber refusal (CB-E009); a replay carrying a
//      NEW locator_file (deliberately excluded from the fingerprint) still
//      writes the recovery pointer to that path instead of silently skipping
//      it; and a partial-success push (a --save-locator write that fails
//      strictly AFTER the ciphertext already uploaded) is still recorded
//      under the key even though the overall call errors — a repeat with the
//      SAME key then replays that recorded partial success instead of
//      re-executing (multi-model review, #335). runIdempotencyTtlTest(): a
//      SEPARATE server with a short CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS
//      proves a cached result stops being replayed once it goes stale.
//      runIdempotencyTtlValidationTest(): CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS
//      set to a NaN/zero/negative/Infinity value refuses to start the server
//      (naming the variable) rather than silently defeating replay; unset
//      still starts normally. runIdempotencyCorruptedLogTest(): the
//      idempotency log corrupted EXTERNALLY between two calls makes a
//      BRAND NEW key refuse fail-closed (ERR_IDEMPOTENCY_STORE_UNREADABLE)
//      rather than silently proceeding as "no prior calls". The signature-
//      sidecar-upload-failure half of the same partial-success scenario
//      (PushSignatureUploadError) is covered at the CLI level instead, in
//      scripts/selftest-push-partial-failure.sh — the file backend's
//      content-addressed locator makes that failure deterministic to force
//      only outside the combined snapshot+push call this file drives.
//
// Exits 0 on success, 1 on any failure with a descriptive message on stderr.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_MCP_TOOLS } from './mcp-expected-tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = join(ROOT, 'dist', 'mcp.mjs');
const TIMEOUT_MS = 30_000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'cb-mcp-smoke-'));
  try {
    await run(tmp);
    await runKeygenWalletTests(tmp);
    await runIdempotencyTtlTest(tmp);
    await runIdempotencyTtlValidationTest(tmp);
    await runIdempotencyCorruptedLogTest(tmp);
    await runSignalCleanupTest(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// #220 P2 (multi-model review): CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS must be validated at
// server startup, not merely Number()'d — a NaN/zero/negative override would silently
// disable idempotency-key replay entirely (isFresh()'s `< ttlSeconds * 1000` comparison
// is always false against NaN or a non-positive value), and an Infinity override would
// never expire a key. Asserts the server refuses to start (nonzero exit, a stderr message
// naming the variable) for each bad shape, and that leaving it unset still starts fine
// (the DEFAULT-TTL regression every other test in this file already depends on).
async function runIdempotencyTtlValidationTest(tmp) {
  const home = join(tmp, 'home-ttl-validation');
  const badValues = ['not-a-number', '0', '-5', 'Infinity', '1.5'];
  for (const bad of badValues) {
    const res = spawnSync(process.execPath, [SERVER_PATH], {
      env: { ...process.env, CYPHER_BRAIN_HOME: home, CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS: bad },
      input: '',
      encoding: 'utf8',
      timeout: 5000,
    });
    if (res.status === 0) {
      throw new Error(
        `idempotency TTL validation: CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS=${bad} started successfully (should refuse)`,
      );
    }
    if (!/CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS/.test(res.stderr ?? '')) {
      throw new Error(
        `idempotency TTL validation: CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS=${bad} did not name the variable in ` +
          `its refusal: ${JSON.stringify(res.stderr).slice(0, 400)}`,
      );
    }
  }
  // Unset (the default): must still start and serve normally — a regression here would
  // mean the validation itself broke the common case every OTHER test in this file
  // depends on.
  const okChild = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CYPHER_BRAIN_HOME: join(tmp, 'home-ttl-validation-ok') },
  });
  const { send, waitFor } = makeRpcClient(okChild);
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '0.0.0' } },
    });
    const initRes = await waitFor(1);
    if (!initRes.result)
      throw new Error(
        `idempotency TTL validation: server with an UNSET TTL failed to initialize: ${JSON.stringify(initRes)}`,
      );
  } finally {
    try {
      okChild.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      okChild.kill();
    } catch {
      /* ignore */
    }
  }
  process.stdout.write(
    `MCP SMOKE (idempotency TTL validation): PASS — refused to start for ${badValues.length} invalid TTL value(s) ` +
      '(naming the variable each time), started normally with the TTL unset\n',
  );
}

// #220 P1 (multi-model review): a corrupted idempotency log must make snapshot_now
// fail-closed for a key it cannot rule out, rather than silently treating the corruption
// as "no prior calls" and letting a paid operation proceed. Corrupts the log file
// EXTERNALLY (a truncated write, a hand edit — not something this server itself would
// produce) between two calls against an already-running server, then proves a BRAND NEW
// idempotency_key is refused (fail-closed) rather than silently executed.
async function runIdempotencyCorruptedLogTest(tmp) {
  const home = join(tmp, 'home-corrupted-log');
  const store = join(tmp, 'store-corrupted-log');
  const data = join(tmp, 'data-corrupted-log');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'hello.txt'), 'cypher-brain mcp corrupted-idempotency-log payload\n');

  const keygenRes = spawnSync(process.execPath, [SERVER_PATH.replace(/mcp\.mjs$/, 'cli.mjs'), 'keygen'], {
    env: { ...process.env, CYPHER_BRAIN_HOME: home },
    encoding: 'utf8',
  });
  if (keygenRes.status !== 0) {
    throw new Error(`corrupted-log test: keygen failed (${keygenRes.status}): ${keygenRes.stderr || keygenRes.stdout}`);
  }
  const recipientPath = join(home, 'recipient.txt');

  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CYPHER_BRAIN_HOME: home, CYPHER_BRAIN_FILE_DIR: store },
  });
  const { send, waitFor } = makeRpcClient(child);
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '0.0.0' } },
    });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await wait(100);

    // A first, ordinary call so the idempotency log actually exists on disk (its path is
    // deterministic — join(HOME, 'idempotency-log.jsonl'), src/lib/config.ts).
    const out1 = join(tmp, 'corrupted-log-1.age');
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [data],
          recipients: [recipientPath],
          out: out1,
          backend: 'file',
          idempotency_key: 'corrupted-log-seed-key',
        },
      },
    });
    const first = await waitFor(2);
    if (first.result?.isError)
      throw new Error(`corrupted-log test: seed snapshot_now failed: ${JSON.stringify(first.result).slice(0, 500)}`);
    // #347: this snapshot encrypts to exactly ONE recipient, so the run records the
    // "single recipient — UNRECOVERABLE" warning — and the tool result must carry it
    // in a dedicated `warnings` array, not just buried in `log`. This is the warning
    // that was measured vanishing into a background log on a real agent-driven push;
    // the field is the structural fix.
    const seedWarnings = first.result?.structuredContent?.warnings;
    if (!Array.isArray(seedWarnings) || !seedWarnings.some((w) => /SINGLE recipient/.test(w)))
      throw new Error(
        `#347: snapshot_now (single recipient) did not surface the warning in a warnings[] field: ` +
          `${JSON.stringify(first.result?.structuredContent?.warnings ?? null)}`,
      );
    console.log(
      'MCP SMOKE (#347 warnings field): PASS — the single-recipient warning rides the tool result as warnings[]',
    );

    // #347, the failure half: a warning recorded BEFORE the call failed must ride the
    // ERROR result too — losing it would re-open the relay hole on exactly the runs
    // that most need a human's eyes. Ordering matters for the probe: source
    // validation runs before the single-recipient warning, so a bad DIR fails too
    // early to have warned (as does the out no-clobber check — both probed and
    // rejected as probes for exactly that reason); pg staging runs AFTER recipient
    // resolution, so an unreachable pg connection fails the call post-warning
    // whether pg_dump connects-and-fails or is not even installed.
    send({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [data],
          pg: 'postgres://nobody@127.0.0.1:1/nope',
          recipients: [recipientPath],
          out: join(tmp, 'never-347.age'),
        },
      },
    });
    const failed347 = await waitFor(20);
    if (!failed347.result?.isError)
      throw new Error(
        `#347 error-path probe: expected the call to fail, got: ${JSON.stringify(failed347.result).slice(0, 300)}`,
      );
    const failWarnings = failed347.result?.structuredContent?.warnings;
    if (!Array.isArray(failWarnings) || !failWarnings.some((w) => /SINGLE recipient/.test(w)))
      throw new Error(
        `#347: a warning recorded before the failure did not ride the error result: ${JSON.stringify(failed347.result?.structuredContent)}`,
      );
    console.log('MCP SMOKE (#347 error-path warnings): PASS — a pre-failure warning rides the error result');

    // Corrupt the log EXTERNALLY — a truncated write, not a well-formed StoredLine.
    const logPath = join(home, 'idempotency-log.jsonl');
    await writeFile(logPath, '{"key": "trunca', { flag: 'w' });

    // A BRAND NEW key (never recorded, so no exact match could ever be found among what
    // DOES parse) must refuse fail-closed rather than proceed as if this were simply
    // unused.
    const out2 = join(tmp, 'corrupted-log-2.age');
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [data],
          recipients: [recipientPath],
          out: out2,
          backend: 'file',
          idempotency_key: 'corrupted-log-new-key',
        },
      },
    });
    const second = await waitFor(3);
    if (!second.result?.isError || second.result?.structuredContent?.code !== 'ERR_IDEMPOTENCY_STORE_UNREADABLE') {
      throw new Error(
        `corrupted-log test: a brand-new idempotency_key against a corrupted log should refuse with ` +
          `ERR_IDEMPOTENCY_STORE_UNREADABLE (fail-closed), not: ${JSON.stringify(second.result).slice(0, 500)}`,
      );
    }
    if (existsSync(out2)) {
      throw new Error('corrupted-log test: snapshot_now refused fail-closed but still produced a snapshot artifact');
    }

    process.stdout.write(
      'MCP SMOKE (idempotency corrupted log): PASS — a brand-new key against a corrupted log refuses fail-closed ' +
        '(ERR_IDEMPOTENCY_STORE_UNREADABLE), doing no work\n',
    );
  } finally {
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

// #220 continued: idempotency-key TTL expiry. A SEPARATE server + a short
// CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS proves a cached result stops being replayed once it
// goes stale — without this, run()'s replay assertions above could not tell "replays
// because the key still matches" apart from "replays forever no matter what". Its own
// server (rather than reusing run()'s) because the TTL is read once from the environment
// at process start (src/lib/config.ts), so a short TTL has to be set before this server's
// very first snapshot_now call.
async function runIdempotencyTtlTest(tmp) {
  const home3 = join(tmp, 'home3');
  const store3 = join(tmp, 'store3');
  const data3 = join(tmp, 'data3');
  await mkdir(data3, { recursive: true });
  await writeFile(join(data3, 'hello.txt'), 'cypher-brain mcp idempotency TTL payload\n');

  const keygenRes = spawnSync(process.execPath, [SERVER_PATH.replace(/mcp\.mjs$/, 'cli.mjs'), 'keygen'], {
    env: { ...process.env, CYPHER_BRAIN_HOME: home3 },
    encoding: 'utf8',
  });
  if (keygenRes.status !== 0) {
    throw new Error(
      `idempotency TTL test: keygen failed (${keygenRes.status}): ${keygenRes.stderr || keygenRes.stdout}`,
    );
  }
  const recipientPath3 = join(home3, 'recipient.txt');

  const child3 = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CYPHER_BRAIN_HOME: home3,
      CYPHER_BRAIN_FILE_DIR: store3,
      CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS: '1', // 1s — short enough to expire within this test
    },
  });
  const { send, waitFor } = makeRpcClient(child3);
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '0.0.0' } },
    });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await wait(100);

    const out3 = join(tmp, 'idem-ttl.age');
    const args3 = {
      dirs: [data3],
      recipients: [recipientPath3],
      out: out3,
      backend: 'file',
      idempotency_key: 'idem-ttl-key',
    };

    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'snapshot_now', arguments: args3 } });
    const first = await waitFor(2);
    if (first.result?.isError) {
      throw new Error(
        `idempotency TTL test: fresh snapshot_now failed: ${JSON.stringify(first.result?.structuredContent).slice(0, 500)}`,
      );
    }

    // Immediately replayed (well within the 1s TTL): must hit the cache, not re-execute.
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'snapshot_now', arguments: args3 } });
    const second = await waitFor(3);
    if (second.result?.isError || second.result?.structuredContent?.idempotent_replay !== true) {
      throw new Error(
        `idempotency TTL test: immediate replay did not hit the cache: ${JSON.stringify(second.result).slice(0, 400)}`,
      );
    }

    // After the TTL elapses, the SAME key is treated as a brand-new call — this must hit
    // the real no-clobber refusal (CB-E009), proving the cache actually expired rather
    // than replaying forever.
    await wait(1300);
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'snapshot_now', arguments: args3 } });
    const third = await waitFor(4);
    if (!third.result?.isError || third.result?.structuredContent?.cb_code !== 'CB-E009') {
      throw new Error(
        `idempotency TTL test: replay after TTL expiry should have re-executed and hit the no-clobber refusal ` +
          `(CB-E009): ${JSON.stringify(third.result).slice(0, 400)}`,
      );
    }

    process.stdout.write(
      'MCP SMOKE (idempotency TTL): PASS — immediate replay hit the cache, replay after TTL expiry re-executed\n',
    );
  } finally {
    try {
      child3.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child3.kill();
    } catch {
      /* ignore */
    }
  }
}

// Wires one spawned MCP server's stdout/stderr into the same send()/waitFor(id)
// JSON-RPC-over-stdio pattern the main flow below uses — pulled out so the isolated
// keygen/wallet_create/wallet_address round-trip (its own server, its own temp
// CYPHER_BRAIN_HOME) doesn't hand-roll a second copy of this plumbing.
function makeRpcClient(child) {
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString('utf8');
  });
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString('utf8');
  });
  child.on('error', (err) => {
    throw err;
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
      `no response for id=${id} within ${TIMEOUT_MS}ms; stdout=${stdoutBuf.slice(0, 500)} stderr=${stderrBuf.slice(-500)}`,
    );
  }
  return { send, waitFor };
}

// 3. keygen / wallet_create / wallet_address round-trip (issue #174): a SEPARATE
// server + a FRESH, isolated CYPHER_BRAIN_HOME (rather than reusing `home` above,
// which already has an identity from the CLI-driven keygen at the top of run())
// so the very first keygen/wallet_create call here exercises the real "nothing
// exists yet" first-run path, not the already-exists refusal.
async function runKeygenWalletTests(tmp) {
  const home2 = join(tmp, 'home2');
  const child2 = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CYPHER_BRAIN_HOME: home2 },
  });
  const { send, waitFor } = makeRpcClient(child2);
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '0.0.0' } },
    });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await wait(100);

    // 3a. keygen on a brand-new home: must succeed and actually write both files.
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'keygen', arguments: {} } });
    const keygen1 = await waitFor(2);
    const keygen1Sc = keygen1.result?.structuredContent;
    if (keygen1.result?.isError) throw new Error(`keygen (fresh) failed: ${JSON.stringify(keygen1Sc).slice(0, 500)}`);
    if (typeof keygen1Sc?.recipient !== 'string' || !keygen1Sc.recipient.startsWith('age1'))
      throw new Error(`keygen (fresh) recipient unexpected: ${JSON.stringify(keygen1Sc?.recipient)}`);
    if (keygen1Sc?.passphrase_wrapped !== false)
      throw new Error(`keygen (fresh) passphrase_wrapped unexpected: ${JSON.stringify(keygen1Sc?.passphrase_wrapped)}`);
    const identityPath = keygen1Sc.identity_path;
    const recipientPath2 = keygen1Sc.recipient_path;
    if (!existsSync(identityPath)) throw new Error(`keygen (fresh) did not write identity_path: ${identityPath}`);
    if (!existsSync(recipientPath2)) throw new Error(`keygen (fresh) did not write recipient_path: ${recipientPath2}`);

    // 3b. keygen again, no force: must refuse (no-clobber) rather than silently re-key.
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'keygen', arguments: {} } });
    const keygen2 = await waitFor(3);
    if (keygen2.result?.isError !== true)
      throw new Error(
        `keygen (no force, already exists) did not refuse: ${JSON.stringify(keygen2.result).slice(0, 300)}`,
      );
    if (!/already exists/.test(keygen2.result?.structuredContent?.message ?? ''))
      throw new Error(
        `keygen (no force) refused for the wrong reason: ${JSON.stringify(keygen2.result?.structuredContent)}`,
      );

    // 3c. keygen with force=true: must succeed and actually rotate the recipient.
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'keygen', arguments: { force: true } } });
    const keygen3 = await waitFor(4);
    const keygen3Sc = keygen3.result?.structuredContent;
    if (keygen3.result?.isError) throw new Error(`keygen (force) failed: ${JSON.stringify(keygen3Sc).slice(0, 500)}`);
    if (keygen3Sc?.recipient === keygen1Sc.recipient)
      throw new Error('keygen (force) did not generate a new keypair (recipient unchanged)');

    // 3d. wallet_create on a brand-new home: must succeed and actually write the JWK.
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'wallet_create', arguments: {} } });
    const wc1 = await waitFor(5);
    const wc1Sc = wc1.result?.structuredContent;
    if (wc1.result?.isError) throw new Error(`wallet_create (fresh) failed: ${JSON.stringify(wc1Sc).slice(0, 500)}`);
    if (typeof wc1Sc?.wallet_path !== 'string' || !existsSync(wc1Sc.wallet_path))
      throw new Error(`wallet_create (fresh) did not write wallet_path: ${JSON.stringify(wc1Sc?.wallet_path)}`);
    if (typeof wc1Sc?.address !== 'string' || wc1Sc.address.length < 10)
      throw new Error(`wallet_create (fresh) address unexpected: ${JSON.stringify(wc1Sc?.address)}`);

    // 3e. wallet_create again, no force: must refuse (no-clobber).
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'wallet_create', arguments: {} } });
    const wc2 = await waitFor(6);
    if (wc2.result?.isError !== true)
      throw new Error(
        `wallet_create (no force, already exists) did not refuse: ${JSON.stringify(wc2.result).slice(0, 300)}`,
      );

    // 3f. wallet_address with no arguments falls back to the SAME default path
    // wallet_create just wrote to, and must report the SAME address.
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wallet_address', arguments: {} } });
    const addr = await waitFor(7);
    const addrSc = addr.result?.structuredContent;
    if (addr.result?.isError)
      throw new Error(`wallet_address (default path) failed: ${JSON.stringify(addrSc).slice(0, 500)}`);
    if (addrSc?.address !== wc1Sc.address)
      throw new Error(
        `wallet_address mismatch: ${JSON.stringify(addrSc?.address)} != ${JSON.stringify(wc1Sc.address)}`,
      );

    process.stdout.write(
      `MCP SMOKE (keygen/wallet): PASS — keygen fresh+no-clobber+force ok, ` +
        `wallet_create fresh+no-clobber ok, wallet_address matches wallet_create\n`,
    );
  } finally {
    try {
      child2.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child2.kill();
    } catch {
      /* ignore */
    }
  }
}

async function run(tmp) {
  const home = join(tmp, 'home');
  const store = join(tmp, 'store');
  const data = join(tmp, 'data');
  const outAge = join(tmp, 'snap.age');
  const locatorFile = join(tmp, 'latest-locator.tsv');
  const launchdDir = join(tmp, 'launchagents'); // install() writes a plist here even with --no-load — must never touch the real ~/Library/LaunchAgents

  // keygen via the bundled CLI (dist/cli.mjs — already built by the time this smoke
  // test runs in `npm run verify`). Previously this dynamic-imported src/lib/keys.mjs
  // in-process; since #63 renamed it to keys.ts (internal imports use the OUTPUT
  // extension, e.g. `./config.js`), a plain in-process `import()` can no longer resolve
  // it without the same dev-only TS resolve hook the bash selftests use (see
  // scripts/dev-ts-resolve-hook.mjs) — spawning the already-built CLI is simpler and
  // exercises the exact artifact this smoke test is otherwise testing against.
  process.env.CYPHER_BRAIN_HOME = home;
  process.env.CYPHER_BRAIN_FILE_DIR = store;
  const keygenRes = spawnSync(process.execPath, [SERVER_PATH.replace(/mcp\.mjs$/, 'cli.mjs'), 'keygen'], {
    env: { ...process.env },
    encoding: 'utf8',
  });
  if (keygenRes.status !== 0) {
    throw new Error(`keygen failed (${keygenRes.status}): ${keygenRes.stderr || keygenRes.stdout}`);
  }
  const recipientPath = join(home, 'recipient.txt');

  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'hello.txt'), 'cypher-brain mcp smoke payload\n');

  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CYPHER_BRAIN_HOME: home,
      CYPHER_BRAIN_FILE_DIR: store,
      CYPHER_BRAIN_LAUNCHD_DIR: launchdDir, // install() writes a plist here even with --no-load
      // The MCP spend gate must hold EVEN when the CLI env escape hatch is set.
      CYPHER_BRAIN_YES: '1',
    },
  });

  const { send, waitFor } = makeRpcClient(child);

  try {
    // 1. handshake + tools/list
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '0.0.0' } },
    });
    const init = await waitFor(1);
    if (init.result?.serverInfo?.name !== 'cypher-brain-mcp') {
      throw new Error(`initialize.serverInfo unexpected: ${JSON.stringify(init.result?.serverInfo)}`);
    }
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await wait(100);

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await waitFor(2);
    const names = (list.result?.tools ?? []).map((t) => t.name).sort();
    // Shared with scripts/tarball-smoke.mjs (#290): this assertion runs on every PR,
    // so keeping the list here is what keeps the release-only gate honest too.
    const expected = EXPECTED_MCP_TOOLS;
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error(`tools/list mismatch: expected ${expected.join(', ')} got ${names.join(', ')}`);
    }

    // 1b. MCP standard tool annotations (issue #219) — every tool must carry
    // readOnlyHint/destructiveHint/idempotentHint/openWorldHint hints
    // matching its actual behavior, alongside the existing confirm_paid logic.
    const expectedAnnotations = {
      snapshot_now: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      last_snapshot_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      verify_restore: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      restore_now: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      estimate_cost: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      schedule_install: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      schedule_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      keygen: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      wallet_create: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      wallet_address: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };
    for (const tool of list.result?.tools ?? []) {
      const expectedAnn = expectedAnnotations[tool.name];
      if (!expectedAnn) continue; // unreachable given the names check above
      const actualAnn = tool.annotations ?? {};
      const mismatched = Object.entries(expectedAnn).filter(([key, value]) => actualAnn[key] !== value);
      if (mismatched.length > 0) {
        throw new Error(
          `${tool.name}.annotations mismatch: expected ${JSON.stringify(expectedAnn)} got ${JSON.stringify(actualAnn)} (field(s) ${mismatched.map(([key]) => key).join(', ')})`,
        );
      }
    }

    // 1c. #307: snapshot_now must ADVERTISE the gitleaks gate, with the same enum the
    // CLI's --scan-secrets accepts. This is the structural half of the bug — the field
    // did not exist at all, so no spelling of it could ever have scanned anything — and
    // it needs no gitleaks binary to assert.
    // Both unattended surfaces, not just the one: snapshot_now takes a snapshot directly,
    // schedule_install bakes one into a nightly. Asserted from the same loop so a future
    // surface cannot be added with a differently-spelled enum.
    // Whether THIS machine can scan at all decides what the #301 default resolves to, so
    // it is probed once rather than assumed. `command -v` is the same check the CLI makes.
    const gitleaksOnPath =
      spawnSync('sh', ['-c', 'command -v "$1"', 'sh', process.env.CYPHER_BRAIN_GITLEAKS_BIN || 'gitleaks'], {
        encoding: 'utf8',
      }).stdout?.trim().length > 0;
    // Ask the built CLI what --scan-secrets accepts, by handing it something it must
    // reject: the refusal quotes every valid mode. A parse that finds none is a hard
    // failure, never an empty expectation that would make the comparison below vacuous.
    const scanProbe = spawnSync(
      'node',
      [
        join(ROOT, 'dist', 'cli.mjs'),
        'snapshot',
        '--dir',
        ROOT,
        '--out',
        join(ROOT, 'never-written.age'),
        '--scan-secrets',
        '__invalid__',
      ],
      { encoding: 'utf8' },
    );
    const scanProbeText = `${scanProbe.stdout ?? ''}${scanProbe.stderr ?? ''}`;
    const cliScanModes = [...(scanProbeText.split('(got')[0].match(/"([a-z]+)"/g) ?? [])].map((q) => q.slice(1, -1));
    if (cliScanModes.length === 0) {
      throw new Error(
        `could not read the accepted --scan-secrets modes out of the CLI refusal: ${scanProbeText.slice(0, 300)}`,
      );
    }
    for (const toolName of ['snapshot_now', 'schedule_install']) {
      const tool = (list.result?.tools ?? []).find((t) => t.name === toolName);
      const scanProp = tool?.inputSchema?.properties?.scan_secrets;
      if (!scanProp) {
        throw new Error(
          `${toolName} does not advertise scan_secrets (#307) — properties: ${Object.keys(tool?.inputSchema?.properties ?? {}).join(', ')}`,
        );
      }
      // The expected list is NOT written out here. It is read back out of the CLI's own
      // refusal, which enumerates exactly what snapshot() accepts — so this asserts the two
      // surfaces agree rather than asserting both against a third hand-written copy that
      // would itself need maintaining (the defect class #276/#290/#300 keep producing).
      // Adding a mode to SCAN_SECRETS_MODES therefore needs no edit here; a mode that
      // reaches only ONE of the two surfaces fails this.
      if (scanProp.type !== 'string' || JSON.stringify(scanProp.enum) !== JSON.stringify(cliScanModes)) {
        throw new Error(
          `${toolName}.scan_secrets schema unexpected: ${JSON.stringify(scanProp).slice(0, 300)} (the CLI accepts ${JSON.stringify(cliScanModes)})`,
        );
      }
    }

    // 2a. spend gate: paid backend without confirm_paid must be refused —
    // BEFORE any snapshot work (outAge must not exist afterwards) — even
    // though CYPHER_BRAIN_YES=1 is set in the server's environment.
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: { dirs: [data], recipients: [recipientPath], out: outAge, backend: 'turbo' },
      },
    });
    const guard = await waitFor(3);
    const guardSc = guard.result?.structuredContent;
    if (!guard.result?.isError || guardSc?.code !== 'ERR_CONFIRM_REQUIRED') {
      throw new Error(
        `paid-backend spend gate is OFF: expected isError + ERR_CONFIRM_REQUIRED, got ${JSON.stringify(guard.result).slice(0, 300)}`,
      );
    }
    // issue #212: the same "spends real funds" consent-gate wording the CLI's own
    // push --yes guard uses (pushpull.ts) is recognized here too, so this MCP-level
    // refusal also carries the stable CB-E007 code.
    if (guardSc?.cb_code !== 'CB-E007') {
      throw new Error(`paid-backend spend gate result lacks cb_code=CB-E007: ${JSON.stringify(guardSc).slice(0, 300)}`);
    }
    const guardLeftArtifact = await stat(outAge).then(
      () => true,
      () => false,
    );
    if (guardLeftArtifact)
      throw new Error('spend gate fired but a snapshot artifact was still produced (gate must run before any work)');

    // 2b. real snapshot_now round-trip on the free file backend
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [data],
          recipients: [recipientPath],
          out: outAge,
          backend: 'file',
          locator_file: locatorFile,
        },
      },
    });
    const snap = await waitFor(4);
    const snapSc = snap.result?.structuredContent;
    if (snap.result?.isError) throw new Error(`snapshot_now failed: ${JSON.stringify(snapSc).slice(0, 500)}`);
    if (snapSc?.pushed !== true || snapSc?.backend !== 'file')
      throw new Error(`snapshot_now result unexpected: ${JSON.stringify(snapSc).slice(0, 300)}`);
    if (typeof snapSc.locator !== 'string' || !snapSc.locator.endsWith('.age'))
      throw new Error(`snapshot_now locator unexpected: ${JSON.stringify(snapSc.locator)}`);
    if (!/^[0-9a-f]{64}$/.test(snapSc.sha256 ?? ''))
      throw new Error(`snapshot_now sha256 unexpected: ${JSON.stringify(snapSc.sha256)}`);
    if (!(Number.isInteger(snapSc.size_bytes) && snapSc.size_bytes > 0))
      throw new Error(`snapshot_now size_bytes unexpected: ${JSON.stringify(snapSc.size_bytes)}`);
    // #307 + #301: the result reports the mode that actually RAN, not the caller's input.
    // Omitting scan_secrets no longer means "nothing scanned" — it means whatever the CLI
    // default resolves to here, which is `warn` when gitleaks is installed and `off` when
    // it is not. Asserting a fixed value would either bake in one machine's toolchain or
    // re-assert the pre-#301 contract; asserting agreement with the CLI's own default is
    // the invariant that actually matters.
    const expectedDefaultScan = gitleaksOnPath ? 'warn' : 'off';
    if (snapSc.scan_secrets !== expectedDefaultScan)
      throw new Error(
        `snapshot_now without scan_secrets should report the effective default (${expectedDefaultScan} — gitleaks ${gitleaksOnPath ? 'is' : 'is not'} resolvable here), got ${JSON.stringify(snapSc.scan_secrets)}`,
      );

    // 2b-2. #307: an invalid mode is REFUSED, and refused BEFORE any work. The generic
    // enum pass (#308, further down) covers the refusal for every enum field including
    // this one; what it does not assert is the no-artifact half, which for a gate whose
    // whole job is to stop a snapshot is the part worth pinning here. No gitleaks needed.
    const badScanOut = join(tmp, 'badscan.age');
    send({
      jsonrpc: '2.0',
      // Ids in the 307xx range so this section stays clear of the sequentially-numbered
      // ones above and the 41-43 / 50+i blocks further down.
      id: 30701,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: { dirs: [data], recipients: [recipientPath], out: badScanOut, scan_secrets: 'bogus' },
      },
    });
    const badScan = await waitFor(30701);
    const badScanSc = badScan.result?.structuredContent;
    if (!badScan.result?.isError || badScanSc?.code !== 'ERR_INVALID_INPUT') {
      throw new Error(
        `snapshot_now accepted scan_secrets:"bogus": ${JSON.stringify(badScan.result).slice(0, 400)} (want isError + ERR_INVALID_INPUT)`,
      );
    }
    if (existsSync(badScanOut))
      throw new Error('snapshot_now rejected a bad scan_secrets but still produced a snapshot artifact');

    // #307 (multi-model review): asking for the gate on a snapshot with no dirs source is
    // refused, not reported. The scan runs per staged directory, so a pg-only call would
    // scan ZERO components while the result said "deny" — a caller believing a snapshot
    // was scanned when it was not is worse off than one told it was not. Needs neither
    // gitleaks nor Postgres: the refusal comes before both.
    const noSrcScanOut = join(tmp, 'nosrcscan.age');
    send({
      jsonrpc: '2.0',
      id: 30708,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          pg: 'postgres://x/y',
          recipients: [recipientPath],
          out: noSrcScanOut,
          scan_secrets: 'deny',
        },
      },
    });
    const noSrcScan = await waitFor(30708);
    if (
      noSrcScan.result?.isError !== true ||
      !/nothing to scan/.test(noSrcScan.result?.structuredContent?.message ?? '')
    )
      throw new Error(
        `snapshot_now accepted scan_secrets with no dirs source: ${JSON.stringify(noSrcScan.result).slice(0, 400)}`,
      );
    if (existsSync(noSrcScanOut))
      throw new Error('snapshot_now refused a source-less scan_secrets but still produced a snapshot artifact');

    // 2b-3. #307: the gate is actually WIRED to snapshot(), not just advertised. Needs
    // the real binary, so it SKIPs without one — same idiom as scripts/selftest.sh's
    // own #215 section. The structural assertions above run either way.
    if (spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).status === 0) {
      const leakDir = join(tmp, 'leaky');
      await mkdir(leakDir, { recursive: true });
      // A gitleaks-detectable dummy credential — same synthetic AWS key selftest.sh's
      // #215 section uses. Not a real secret.
      await writeFile(join(leakDir, 'creds.txt'), 'aws_access_key_id = AKIAABCDEFGHIJKLMNOP\n');
      const denyOut = join(tmp, 'deny.age');
      send({
        jsonrpc: '2.0',
        id: 30702,
        method: 'tools/call',
        params: {
          name: 'snapshot_now',
          arguments: { dirs: [leakDir], recipients: [recipientPath], out: denyOut, scan_secrets: 'deny' },
        },
      });
      const deny = await waitFor(30702);
      if (!deny.result?.isError)
        throw new Error(
          `snapshot_now scan_secrets:"deny" did not refuse a source with a planted secret — the option is threaded but not honored: ${JSON.stringify(deny.result?.structuredContent).slice(0, 400)}`,
        );
      if (JSON.stringify(deny.result).includes('AKIAABCDEFGHIJKLMNOP'))
        throw new Error('the planted secret VALUE leaked into the snapshot_now error payload');
      if (existsSync(denyOut))
        throw new Error('snapshot_now scan_secrets:"deny" refused but still produced a snapshot artifact');

      // warn proceeds on the same source, and the result reports the mode that really ran.
      const warnOut = join(tmp, 'warn.age');
      send({
        jsonrpc: '2.0',
        id: 30703,
        method: 'tools/call',
        params: {
          name: 'snapshot_now',
          arguments: { dirs: [leakDir], recipients: [recipientPath], out: warnOut, scan_secrets: 'warn' },
        },
      });
      const warn = await waitFor(30703);
      const warnSc = warn.result?.structuredContent;
      if (warn.result?.isError)
        throw new Error(`snapshot_now scan_secrets:"warn" failed: ${JSON.stringify(warnSc).slice(0, 400)}`);
      if (warnSc?.scan_secrets !== 'warn')
        throw new Error(
          `snapshot_now warn run should report scan_secrets:"warn", got ${JSON.stringify(warnSc?.scan_secrets)}`,
        );
      if (!(warnSc?.log ?? []).some((l) => /gitleaks found/i.test(l)))
        throw new Error(
          `snapshot_now scan_secrets:"warn" did not report the finding in its log: ${JSON.stringify(warnSc?.log).slice(0, 400)}`,
        );
      if (JSON.stringify(warnSc?.log).includes('AKIAABCDEFGHIJKLMNOP'))
        throw new Error('the planted secret VALUE leaked into the snapshot_now warn log');
    } else {
      process.stdout.write(
        'MCP SMOKE: [SKIP] snapshot_now scan_secrets warn/deny end-to-end — no `gitleaks` on PATH ' +
          '(install it — https://github.com/gitleaks/gitleaks — to exercise this; CI installs it, see #215). ' +
          'The schema/validation assertions above still ran.\n',
      );
    }

    // 2b-4. #220: idempotency_key makes a snapshot_now call RETRY-safe — a repeat call
    // with the SAME key returns the FIRST call's result instead of re-executing. Ids in
    // the 220xx range (the issue number), same convention as the 307xx scan_secrets block
    // above. Uses its own out paths throughout, so it never touches outAge/locatorFile —
    // the sections below (last_snapshot_status, verify_restore, restore_now) still depend
    // on those being exactly what 2b left them as.
    const idemOut1 = join(tmp, 'idem1.age');
    const idemOut2 = join(tmp, 'idem2.age');
    const idemKey1 = 'idem-test-key-1';
    const idemArgs1 = {
      dirs: [data],
      recipients: [recipientPath],
      out: idemOut1,
      backend: 'file',
      idempotency_key: idemKey1,
    };

    // 2b-4a. Fresh call: succeeds and reports idempotent_replay:false (the real work ran).
    send({ jsonrpc: '2.0', id: 22001, method: 'tools/call', params: { name: 'snapshot_now', arguments: idemArgs1 } });
    const idem1 = await waitFor(22001);
    const idem1Sc = idem1.result?.structuredContent;
    if (idem1.result?.isError)
      throw new Error(`snapshot_now (idempotency, fresh) failed: ${JSON.stringify(idem1Sc).slice(0, 500)}`);
    if (idem1Sc?.idempotent_replay !== false || idem1Sc?.idempotency_key !== idemKey1)
      throw new Error(`snapshot_now (idempotency, fresh) result unexpected: ${JSON.stringify(idem1Sc).slice(0, 300)}`);
    if (typeof idem1Sc?.locator !== 'string' || typeof idem1Sc?.sha256 !== 'string')
      throw new Error(
        `snapshot_now (idempotency, fresh) missing locator/sha256: ${JSON.stringify(idem1Sc).slice(0, 300)}`,
      );

    // 2b-4b. Exact same call again, same key: `out` already exists (no --force), so a REAL
    // re-execution would fail closed with "already exists" (CB-E009, no-clobber) — this
    // call instead SUCCEEDING with the identical locator/sha256 and idempotent_replay:true
    // is what proves the cache — not a second snapshot/push — answered it.
    send({ jsonrpc: '2.0', id: 22002, method: 'tools/call', params: { name: 'snapshot_now', arguments: idemArgs1 } });
    const idem2 = await waitFor(22002);
    const idem2Sc = idem2.result?.structuredContent;
    if (idem2.result?.isError)
      throw new Error(
        `snapshot_now (idempotency, replay) should have replayed the cached success, not re-executed: ${JSON.stringify(idem2Sc).slice(0, 500)}`,
      );
    if (idem2Sc?.idempotent_replay !== true)
      throw new Error(
        `snapshot_now (idempotency, replay) did not report idempotent_replay:true: ${JSON.stringify(idem2Sc).slice(0, 300)}`,
      );
    if (idem2Sc?.locator !== idem1Sc.locator || idem2Sc?.sha256 !== idem1Sc.sha256)
      throw new Error(
        `snapshot_now (idempotency, replay) locator/sha256 do not match the original call: ${JSON.stringify({ idem1: idem1Sc, idem2: idem2Sc }).slice(0, 500)}`,
      );

    // 2b-4c. Same key, a DIFFERENT call (a different `out`): refused rather than silently
    // answered with idem1's unrelated result — reusing a key must name the SAME operation.
    send({
      jsonrpc: '2.0',
      id: 22003,
      method: 'tools/call',
      params: { name: 'snapshot_now', arguments: { ...idemArgs1, out: idemOut2 } },
    });
    const idem3 = await waitFor(22003);
    const idem3Sc = idem3.result?.structuredContent;
    if (!idem3.result?.isError || idem3Sc?.code !== 'ERR_IDEMPOTENCY_KEY_REUSED')
      throw new Error(
        `snapshot_now (idempotency, key reused for a different call) did not refuse: ${JSON.stringify(idem3.result).slice(0, 400)}`,
      );
    if (existsSync(idemOut2))
      throw new Error('snapshot_now refused a reused idempotency_key but still produced a snapshot artifact');

    // 2b-4d. A DIFFERENT key against the SAME already-existing `out`: the cache is scoped
    // to the key, not a global "skip no-clobber" switch — this must hit the real
    // no-clobber refusal (CB-E009), not be silently waved through.
    send({
      jsonrpc: '2.0',
      id: 22004,
      method: 'tools/call',
      params: { name: 'snapshot_now', arguments: { ...idemArgs1, idempotency_key: 'idem-test-key-2' } },
    });
    const idem4 = await waitFor(22004);
    if (!idem4.result?.isError || idem4.result?.structuredContent?.cb_code !== 'CB-E009')
      throw new Error(
        `snapshot_now with a DIFFERENT idempotency_key against an already-existing out should hit the real ` +
          `no-clobber refusal (CB-E009): ${JSON.stringify(idem4.result).slice(0, 400)}`,
      );

    // 2b-4e. #220 P2 (multi-model review): locator_file is deliberately excluded from the
    // fingerprint, so a replay with a DIFFERENT locator_file than the original call must
    // still WRITE the recovery pointer to the NEWLY-requested path — nothing is
    // re-uploaded, but the requested side effect must not be silently dropped.
    const idemReplayLocatorFile = join(tmp, 'idem-replay-locator.tsv');
    if (existsSync(idemReplayLocatorFile)) throw new Error('idemReplayLocatorFile unexpectedly pre-exists');
    send({
      jsonrpc: '2.0',
      id: 22005,
      method: 'tools/call',
      params: { name: 'snapshot_now', arguments: { ...idemArgs1, locator_file: idemReplayLocatorFile } },
    });
    const idem5 = await waitFor(22005);
    const idem5Sc = idem5.result?.structuredContent;
    if (idem5.result?.isError || idem5Sc?.idempotent_replay !== true)
      throw new Error(
        `snapshot_now (idempotency, replay with a NEW locator_file) should have replayed: ${JSON.stringify(idem5.result).slice(0, 500)}`,
      );
    if (!existsSync(idemReplayLocatorFile))
      throw new Error(
        'snapshot_now idempotent replay with a locator_file it had never seen before did not write it to disk',
      );
    const idemReplayLocatorLine = (await readFile(idemReplayLocatorFile, 'utf8')).split('\n')[0];
    const [idemReplayLocatorField, idemReplayBackendField, idemReplaySha256Field] = idemReplayLocatorLine.split('\t');
    if (
      idemReplayLocatorField !== idem1Sc.locator ||
      idemReplaySha256Field !== idem1Sc.sha256 ||
      idemReplayBackendField !== 'file'
    )
      throw new Error(
        `replayed locator_file content does not match the ORIGINAL call's locator/backend/sha256: ` +
          `${JSON.stringify({ line: idemReplayLocatorLine, idem1: idem1Sc })}`,
      );

    // 2b-4f. #220 P1 (multi-model review): a partial-success push (ciphertext uploaded,
    // then a LATER stage fails) must still be recorded under the idempotency_key even
    // though the overall snapshot_now call reports an error — otherwise the exact retry
    // this feature exists for would spend a second time for what already durably
    // succeeded. Forced deterministically: locator_file's parent path component is a
    // pre-existing regular FILE (not a directory), so push()'s own --save-locator mkdir
    // fails with ENOTDIR strictly AFTER backend.put() (the real, "paid" step for
    // arweave/turbo — here the free `file` backend stands in for the same code path)
    // already succeeded — this is exactly PushLocatorWriteError's own scenario.
    const idemPartialOut = join(tmp, 'idem-partial.age');
    const idemPartialKey = 'idem-partial-failure-key';
    const idemBadLocatorParent = join(tmp, 'idem-bad-locator-parent-is-a-file');
    await writeFile(idemBadLocatorParent, 'not a directory\n');
    const idemBadLocatorFile = join(idemBadLocatorParent, 'locator.tsv');
    send({
      jsonrpc: '2.0',
      id: 22006,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [data],
          recipients: [recipientPath],
          out: idemPartialOut,
          backend: 'file',
          locator_file: idemBadLocatorFile,
          idempotency_key: idemPartialKey,
        },
      },
    });
    const idem6 = await waitFor(22006);
    const idem6Sc = idem6.result?.structuredContent;
    if (!idem6.result?.isError || !/upload succeeded/.test(idem6Sc?.message ?? ''))
      throw new Error(
        `snapshot_now with a --save-locator write that fails AFTER a successful upload should refuse with a ` +
          `"upload succeeded" PushLocatorWriteError message, not: ${JSON.stringify(idem6.result).slice(0, 500)}`,
      );

    // The SAME key, called again with a WORKING locator_file: if the partial success was
    // correctly recorded above despite the overall call erroring, this replays the cached
    // result (idempotent_replay:true, pushed:true) instead of re-executing — a real
    // re-execution would fail closed on `out` already existing (CB-E009), so hitting THAT
    // instead would prove the record was lost, exactly the bug this fixes.
    const idemPartialGoodLocatorFile = join(tmp, 'idem-partial-good-locator.tsv');
    send({
      jsonrpc: '2.0',
      id: 22007,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [data],
          recipients: [recipientPath],
          out: idemPartialOut,
          backend: 'file',
          locator_file: idemPartialGoodLocatorFile,
          idempotency_key: idemPartialKey,
        },
      },
    });
    const idem7 = await waitFor(22007);
    const idem7Sc = idem7.result?.structuredContent;
    if (idem7.result?.isError || idem7Sc?.idempotent_replay !== true || idem7Sc?.pushed !== true)
      throw new Error(
        `a repeat call with the SAME idempotency_key after a partial-success failure should replay the recorded ` +
          `partial success (idempotent_replay:true, pushed:true), not re-execute or refuse: ` +
          `${JSON.stringify(idem7.result).slice(0, 500)}`,
      );
    if (typeof idem7Sc?.locator !== 'string' || idem7Sc.locator.length === 0)
      throw new Error(`replayed partial-success result is missing its recorded locator: ${JSON.stringify(idem7Sc)}`);
    if (!existsSync(idemPartialGoodLocatorFile))
      throw new Error('the replay of a recorded partial-success result did not write the requested locator_file');

    // 2c. last_snapshot_status reads the save-locator file back
    send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'last_snapshot_status', arguments: { locator_file: locatorFile } },
    });
    const status = await waitFor(5);
    const statusSc = status.result?.structuredContent;
    if (status.result?.isError)
      throw new Error(`last_snapshot_status failed: ${JSON.stringify(statusSc).slice(0, 500)}`);
    const latest = statusSc?.latest;
    if (latest?.locator !== snapSc.locator)
      throw new Error(
        `last_snapshot_status locator mismatch: ${JSON.stringify(latest?.locator)} != ${JSON.stringify(snapSc.locator)}`,
      );
    if (latest?.backend !== 'file')
      throw new Error(`last_snapshot_status backend unexpected: ${JSON.stringify(latest?.backend)}`);
    if (latest?.sha256 !== snapSc.sha256) throw new Error(`last_snapshot_status sha256 mismatch`);
    if (!(typeof latest?.age_seconds === 'number' && latest.age_seconds >= 0 && latest.age_seconds < 600)) {
      throw new Error(`last_snapshot_status age_seconds not sane: ${JSON.stringify(latest?.age_seconds)}`);
    }

    // 2d. verify_restore pulls by locator and must reach a full PASS (the
    // private identity lives in this temp CYPHER_BRAIN_HOME).
    send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'verify_restore', arguments: { locator: snapSc.locator, backend: 'file' } },
    });
    const ver = await waitFor(6);
    const verSc = ver.result?.structuredContent;
    if (ver.result?.isError) throw new Error(`verify_restore failed: ${JSON.stringify(verSc).slice(0, 500)}`);
    if (verSc?.verdict !== 'PASS' || verSc?.exit_code !== 0 || verSc?.restorable_proven !== true) {
      throw new Error(`verify_restore expected a full PASS, got: ${JSON.stringify(verSc).slice(0, 500)}`);
    }
    if (!Array.isArray(verSc.checks) || verSc.checks.length === 0)
      throw new Error('verify_restore checks output missing');

    // 2e. verify_restore via locator_file — the save-locator file supplies the
    // locator, its backend AND the sha256 integrity pin in one (the CLI
    // --from-locator-file recovery path); the response must show the pin was
    // applied (pulled.sha256_pin + the sha256 check line) and carry no warning.
    send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'verify_restore', arguments: { locator_file: locatorFile } },
    });
    const verPinned = await waitFor(7);
    const verPinnedSc = verPinned.result?.structuredContent;
    if (verPinned.result?.isError)
      throw new Error(`verify_restore(locator_file) failed: ${JSON.stringify(verPinnedSc).slice(0, 500)}`);
    if (verPinnedSc?.verdict !== 'PASS' || verPinnedSc?.restorable_proven !== true) {
      throw new Error(
        `verify_restore(locator_file) expected a full PASS, got: ${JSON.stringify(verPinnedSc).slice(0, 500)}`,
      );
    }
    if (verPinnedSc?.pulled?.locator !== snapSc.locator || verPinnedSc?.pulled?.backend !== 'file') {
      throw new Error(`verify_restore(locator_file) pulled the wrong artifact: ${JSON.stringify(verPinnedSc?.pulled)}`);
    }
    if (verPinnedSc?.pulled?.sha256_pin !== snapSc.sha256) {
      throw new Error(
        `verify_restore(locator_file) did not apply the sha256 integrity pin: ${JSON.stringify(verPinnedSc?.pulled)}`,
      );
    }
    if (!(verPinnedSc.checks ?? []).some((l) => /\[PASS\] sha256 matches/.test(l))) {
      throw new Error(
        `verify_restore(locator_file) checks are missing the sha256 pin line: ${JSON.stringify(verPinnedSc.checks)}`,
      );
    }
    if (verPinnedSc?.warning !== undefined)
      throw new Error(`verify_restore(locator_file) unexpected warning: ${JSON.stringify(verPinnedSc.warning)}`);
    // #312: everything pull() said now reaches the caller. It used to be captured and
    // dropped, which is what made the case below invisible rather than merely quiet.
    if (!Array.isArray(verPinnedSc?.pulled?.log) || !verPinnedSc.pulled.log.some((l) => /pulled /.test(l))) {
      throw new Error(
        `verify_restore(locator_file) did not surface its pull output: ${JSON.stringify(verPinnedSc?.pulled?.log)}`,
      );
    }
    // A signature that WAS recorded but could NOT be fetched must not come back looking
    // like an artifact that was never signed. pull()'s sidecar fetch is best-effort by
    // design (#214), so the visible result of a DELETED .minisig is verify() reporting
    // "unsigned (legacy) artifact" and a PASS — true of a pre-#214 backup, false here.
    // Point field 6 (sig_locator) of the save-locator file at something unfetchable and
    // assert the result says so; the ciphertext itself still verifies.
    const sigProbeFile = join(tmp, 'sig-gap-locator.tsv');
    const locFields = (await readFile(locatorFile, 'utf8')).trim().split('\t');
    while (locFields.length < 5) locFields.push('');
    locFields[5] = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.age';
    await writeFile(sigProbeFile, `${locFields.join('\t')}\n`);
    send({
      jsonrpc: '2.0',
      id: 78,
      method: 'tools/call',
      params: { name: 'verify_restore', arguments: { locator_file: sigProbeFile } },
    });
    const sigGap = await waitFor(78);
    const sigGapSc = sigGap.result?.structuredContent;
    if (sigGap.result?.isError)
      throw new Error(
        `verify_restore(unfetchable signature) should still verify the ciphertext: ${JSON.stringify(sigGapSc).slice(0, 400)}`,
      );
    if (sigGapSc?.signature?.fetched !== false || !sigGapSc?.signature?.expected_locator) {
      throw new Error(
        `verify_restore did not report that a RECORDED signature could not be fetched — the caller cannot tell this from an unsigned artifact: ${JSON.stringify(sigGapSc).slice(0, 500)}`,
      );
    }
    if (!(sigGapSc?.pulled?.log ?? []).some((l) => /could not fetch the authenticity signature/.test(l))) {
      throw new Error(
        `the reason the signature could not be fetched is still being dropped: ${JSON.stringify(sigGapSc?.pulled?.log)}`,
      );
    }

    // 2f. negative control: an explicitly WRONG sha256 pin must fail CLOSED —
    // an error result with NO verdict field, never a PASS.
    const wrongSha = (snapSc.sha256[0] === '0' ? '1' : '0') + snapSc.sha256.slice(1);
    send({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'verify_restore', arguments: { locator: snapSc.locator, backend: 'file', sha256: wrongSha } },
    });
    const verWrong = await waitFor(8);
    const verWrongSc = verWrong.result?.structuredContent;
    if (verWrong.result?.isError !== true) {
      throw new Error(`wrong-sha256 pin did NOT fail closed: ${JSON.stringify(verWrong.result).slice(0, 500)}`);
    }
    if (!/sha256 mismatch/.test(verWrongSc?.message ?? '')) {
      throw new Error(`wrong-sha256 pin failed for the wrong reason: ${JSON.stringify(verWrongSc).slice(0, 300)}`);
    }
    if (verWrongSc?.verdict !== undefined) {
      throw new Error(`wrong-sha256 pin still produced a verdict: ${JSON.stringify(verWrongSc).slice(0, 300)}`);
    }
    // issue #212: the structured error carries the stable CB-E001 code both inline in
    // `message` (same "[CB-E0xx] see MANAGEMENT.md#error-codes" suffix the CLI prints)
    // AND as its own machine-readable `cb_code` field.
    if (!/\[CB-E001\]/.test(verWrongSc?.message ?? '')) {
      throw new Error(`wrong-sha256 pin message lacks the CB-E001 code: ${JSON.stringify(verWrongSc).slice(0, 300)}`);
    }
    if (verWrongSc?.cb_code !== 'CB-E001') {
      throw new Error(`wrong-sha256 pin result lacks cb_code=CB-E001: ${JSON.stringify(verWrongSc).slice(0, 300)}`);
    }

    // 2g. restore_now: without confirm_write must refuse BEFORE any work (mirrors
    // the snapshot_now spend gate at 2a) — out_dir must not even be created. Uses a
    // deliberately-bogus locator (not snapSc.locator): if the gate were ever
    // bypassed, pull() would attempt (and fail) against a nonexistent object,
    // surfacing as a DIFFERENT error than ERR_CONFIRM_REQUIRED — proving the gate
    // runs before any pull, not just that out_dir happens to be untouched.
    const restoreOutDir = join(tmp, 'restored');
    send({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'restore_now',
        arguments: { locator: 'does-not-exist-locator', backend: 'file', out_dir: restoreOutDir },
      },
    });
    const restoreGuard = await waitFor(15);
    const restoreGuardSc = restoreGuard.result?.structuredContent;
    if (!restoreGuard.result?.isError || restoreGuardSc?.code !== 'ERR_CONFIRM_REQUIRED') {
      throw new Error(
        `restore_now confirm_write gate is OFF: expected isError + ERR_CONFIRM_REQUIRED (even with a bogus locator), got ${JSON.stringify(restoreGuard.result).slice(0, 300)}`,
      );
    }
    if (existsSync(restoreOutDir)) {
      throw new Error(
        'restore_now confirm_write gate fired but out_dir was still created (gate must run before any work)',
      );
    }

    // 2h. restore_now REAL round-trip (issue #183): pull by locator, decrypt with
    // the identity in this temp CYPHER_BRAIN_HOME, and extract into out_dir — then
    // untar the restored `data.tar.gz` component (restore only extracts the OUTER
    // archive; per-dir components stay tarred, same as the CLI — see MANAGEMENT.md's
    // restore runbook) and assert hello.txt's content on disk matches what was
    // snapshotted, proving an actual disk write, not just a reported verdict.
    send({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: {
        name: 'restore_now',
        arguments: { locator: snapSc.locator, backend: 'file', out_dir: restoreOutDir, confirm_write: true },
      },
    });
    const restoreRes = await waitFor(16);
    const restoreResSc = restoreRes.result?.structuredContent;
    if (restoreRes.result?.isError)
      throw new Error(`restore_now failed: ${JSON.stringify(restoreResSc).slice(0, 500)}`);
    if (restoreResSc?.pulled?.locator !== snapSc.locator || restoreResSc?.pulled?.backend !== 'file') {
      throw new Error(`restore_now pulled the wrong artifact: ${JSON.stringify(restoreResSc?.pulled)}`);
    }
    if (restoreResSc?.out_dir !== restoreOutDir || restoreResSc?.pg_restored !== false) {
      throw new Error(`restore_now result unexpected: ${JSON.stringify(restoreResSc).slice(0, 300)}`);
    }
    const restoredArchive = join(restoreOutDir, 'data.tar.gz');
    if (!existsSync(restoredArchive)) throw new Error(`restore_now did not extract data.tar.gz into ${restoreOutDir}`);
    const restoreExtractDir = join(tmp, 'restored-extract');
    await mkdir(restoreExtractDir, { recursive: true });
    const untarRes = spawnSync('tar', ['-xzf', restoredArchive, '-C', restoreExtractDir], { encoding: 'utf8' });
    if (untarRes.status !== 0) throw new Error(`untarring restore_now's data.tar.gz failed: ${untarRes.stderr}`);
    const restoredContent = await readFile(join(restoreExtractDir, 'data', 'hello.txt'), 'utf8');
    if (restoredContent !== 'cypher-brain mcp smoke payload\n') {
      throw new Error(`restore_now restored content mismatch: ${JSON.stringify(restoredContent)}`);
    }

    // 2h-ii. restore_now file-input mode with a WRONG sha256 pin must fail closed
    // (fails BEFORE any decrypt/extract — restoreOutDir2 must never be created),
    // exercising the copy-then-hash-then-restore integrity check on the directly-
    // given `file` path (distinct from the pulled-artifact pin pull() itself checks).
    const restoreOutDir2 = join(tmp, 'restored-wrongsha');
    send({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'restore_now',
        arguments: {
          file: outAge,
          out_dir: restoreOutDir2,
          confirm_write: true,
          sha256: '0'.repeat(64),
        },
      },
    });
    const restoreWrongSha = await waitFor(17);
    const restoreWrongShaSc = restoreWrongSha.result?.structuredContent;
    if (!restoreWrongSha.result?.isError || restoreWrongShaSc?.code !== 'ERR_INVALID_INPUT') {
      throw new Error(
        `restore_now file-input wrong-sha256 did not fail closed: expected isError + ERR_INVALID_INPUT, got ${JSON.stringify(restoreWrongSha.result).slice(0, 300)}`,
      );
    }
    if (existsSync(restoreOutDir2)) {
      throw new Error('restore_now file-input wrong-sha256 still created out_dir before refusing');
    }

    // 2i. estimate_cost on the free file backend (offline + deterministic —
    // exercises the fourth tool's dispatch without a network dependency).
    send({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'estimate_cost', arguments: { file: outAge, backend: 'file' } },
    });
    const est = await waitFor(9);
    const estSc = est.result?.structuredContent;
    if (est.result?.isError) throw new Error(`estimate_cost failed: ${JSON.stringify(estSc).slice(0, 500)}`);
    if (estSc?.cost !== '0' || estSc?.size_bytes !== snapSc.size_bytes || !estSc?.note) {
      throw new Error(`estimate_cost(file) result unexpected: ${JSON.stringify(estSc).slice(0, 300)}`);
    }

    // 2i-b. #293: a nonexistent caller-supplied `file` is bad INPUT, and every tool
    // that takes one must say so with the same code. verify_restore used to let the
    // miss fall through to the library, whose plain Error structuredErr() can only
    // report as ERR_INTERNAL — telling an agent the server broke, and inviting a
    // retry that can only fail the same way. Asserted across BOTH tools together,
    // since the defect was the disagreement between them, not either one alone.
    const missingPath = join(tmp, 'definitely-not-here.age');
    for (const [id, name, args] of [
      [21, 'verify_restore', { file: missingPath }],
      [22, 'estimate_cost', { file: missingPath, backend: 'file' }],
      // restore_now needs its write consent satisfied first, or the confirm gate answers
      // before the path is ever looked at — and it is one of the two tools this changed,
      // so leaving it out would have made the loop's claim of covering them untrue.
      [23, 'restore_now', { file: missingPath, out_dir: join(tmp, 'missing-restore-out'), confirm_write: true }],
    ]) {
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      const res = await waitFor(id);
      const sc = res.result?.structuredContent;
      if (res.result?.isError !== true || sc?.code !== 'ERR_INVALID_INPUT') {
        throw new Error(
          `${name} on a missing file must report ERR_INVALID_INPUT, got ${JSON.stringify(res.result).slice(0, 300)}`,
        );
      }
      if (!/^no such file: /.test(sc?.message ?? '')) {
        throw new Error(`${name} on a missing file has an unexpected message: ${JSON.stringify(sc).slice(0, 200)}`);
      }
    }

    // 2i-ii. estimate_cost via size_bytes (the CLI `estimate` command's alternative —
    // it always sizes a real --in file, so this argument shape is MCP-only) exercises
    // the same shared estimateCost() (src/lib/estimate.ts) the file-arg call above did,
    // now via the OTHER branch of handleEstimateCost's own file/size_bytes resolution
    // (the part of the tool that did NOT move into the shared function).
    send({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'estimate_cost', arguments: { size_bytes: 12345, backend: 'file' } },
    });
    const estBytes = await waitFor(12);
    const estBytesSc = estBytes.result?.structuredContent;
    if (estBytes.result?.isError)
      throw new Error(`estimate_cost(size_bytes) failed: ${JSON.stringify(estBytesSc).slice(0, 500)}`);
    if (estBytesSc?.cost !== '0' || estBytesSc?.size_bytes !== 12345 || !estBytesSc?.note) {
      throw new Error(`estimate_cost(size_bytes) result unexpected: ${JSON.stringify(estBytesSc).slice(0, 300)}`);
    }

    // 2i-iii. estimate_cost(backend: turbo) — offline, deterministic either way, but
    // the expected shape depends on whether the OPTIONAL @ardrive/turbo-sdk actually
    // resolves in this environment (it is not a devDependency, only an optional
    // peerDependency — package.json — so a frozen-lockfile install normally leaves it
    // absent, but a future lockfile change could add it): branch on its real presence
    // instead of assuming absence (same reasoning as scripts/cli-smoke.sh's estimate
    // --backend turbo case; both exercise the SAME estimateCost() call, #159).
    const turboSdkInstalled = existsSync(join(ROOT, 'node_modules', '@ardrive', 'turbo-sdk'));
    send({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'estimate_cost', arguments: { size_bytes: 12345, backend: 'turbo' } },
    });
    const estTurbo = await waitFor(13);
    const estTurboSc = estTurbo.result?.structuredContent;
    if (estTurbo.result?.isError)
      throw new Error(`estimate_cost(turbo) failed: ${JSON.stringify(estTurboSc).slice(0, 500)}`);
    if (turboSdkInstalled) {
      if (estTurboSc?.backend !== 'turbo' || estTurboSc?.size_bytes !== 12345) {
        throw new Error(
          `estimate_cost(turbo, sdk installed) result unexpected: ${JSON.stringify(estTurboSc).slice(0, 300)}`,
        );
      }
    } else if (estTurboSc?.cost !== null || !/not installed/.test(estTurboSc?.note ?? '')) {
      throw new Error(
        `estimate_cost(turbo, sdk missing) result unexpected: ${JSON.stringify(estTurboSc).slice(0, 300)}`,
      );
    }

    // 2j. schedule_install: without confirm_install must refuse BEFORE any file is
    // written (mirrors the restore_now/snapshot_now gates above).
    send({
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'schedule_install', arguments: { backend: 'file', dirs: [data], no_load: true } },
    });
    const schedInstallGuard = await waitFor(18);
    const schedInstallGuardSc = schedInstallGuard.result?.structuredContent;
    if (!schedInstallGuard.result?.isError || schedInstallGuardSc?.code !== 'ERR_CONFIRM_REQUIRED') {
      throw new Error(
        `schedule_install confirm_install gate is OFF: expected isError + ERR_CONFIRM_REQUIRED, got ${JSON.stringify(schedInstallGuard.result).slice(0, 300)}`,
      );
    }
    if (existsSync(launchdDir)) {
      throw new Error('schedule_install confirm_install gate fired but launchdDir was still created');
    }
    if (existsSync(join(home, 'schedule'))) {
      throw new Error('schedule_install confirm_install gate fired but the runner/config dir was still created');
    }

    // 2j-ii. a paid backend without max_spend must refuse (install()'s own validation,
    // delegated to unchanged — proves the confirm_install gate does not shadow it, and
    // that this refusal fires before max_spend's absence would otherwise matter).
    send({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'schedule_install',
        arguments: { backend: 'turbo', dirs: [data], no_load: true, confirm_install: true },
      },
    });
    const schedInstallNoSpend = await waitFor(20);
    if (
      !schedInstallNoSpend.result?.isError ||
      !/max-spend|max_spend/i.test(schedInstallNoSpend.result?.structuredContent?.message ?? '')
    ) {
      throw new Error(
        `schedule_install (backend=turbo, no max_spend) did not refuse for the expected reason: ${JSON.stringify(schedInstallNoSpend.result).slice(0, 300)}`,
      );
    }
    if (existsSync(join(home, 'schedule'))) {
      throw new Error(
        'schedule_install (backend=turbo, no max_spend) still wrote the runner/config dir before refusing',
      );
    }

    // 2k. schedule_install REAL --no-load install (issue #174 follow-up): registers
    // NOTHING with the real launchctl/crontab (no_load: true — this env's
    // CYPHER_BRAIN_LAUNCHD_DIR is already scoped to a temp dir, so even a real load
    // would be harmless, but no_load also proves the tool's own opt-out path works),
    // then schedule_status (below) reads back the SAME state this call wrote.
    send({
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: {
        name: 'schedule_install',
        arguments: { backend: 'file', dirs: [data], no_load: true, confirm_install: true },
      },
    });
    const schedInstall = await waitFor(19);
    const schedInstallSc = schedInstall.result?.structuredContent;
    if (schedInstall.result?.isError)
      throw new Error(`schedule_install failed: ${JSON.stringify(schedInstallSc).slice(0, 500)}`);
    if (schedInstallSc?.backend !== 'file' || schedInstallSc?.at !== '03:30' || schedInstallSc?.no_load !== true) {
      throw new Error(`schedule_install result unexpected: ${JSON.stringify(schedInstallSc).slice(0, 300)}`);
    }
    // #301: same as snapshot_now above — install resolves and BAKES an effective mode even
    // when none was asked for, so the result reports what the nightly will really do.
    if (schedInstallSc?.scan_secrets !== expectedDefaultScan) {
      throw new Error(
        `schedule_install without scan_secrets should report the effective baked mode (${expectedDefaultScan}), got ${JSON.stringify(schedInstallSc?.scan_secrets)}`,
      );
    }

    // 2l. schedule_status — thin wrapper over the SAME schedule() the CLI's `schedule
    // status` dispatches to; asserts against the schedule_install call just above,
    // the structured report (#285) — the same object the resource and the CLI --json serve
    // "no re-implemented logic" design).
    send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'schedule_status', arguments: {} } });
    const sched = await waitFor(10);
    const schedSc = sched.result?.structuredContent;
    if (sched.result?.isError) throw new Error(`schedule_status failed: ${JSON.stringify(schedSc).slice(0, 500)}`);
    // #285: this returns the STRUCTURED report now, not captured console lines.
    if (schedSc?.configured?.at !== '03:30' || schedSc?.configured?.backend !== 'file') {
      throw new Error(`schedule_status.configured unexpected: ${JSON.stringify(schedSc)}`);
    }
    if (typeof schedSc?.next_run !== 'string' || !schedSc.next_run) {
      throw new Error(`schedule_status.next_run missing: ${JSON.stringify(schedSc)}`);
    }
    if (!schedSc?.trigger?.type || !('loaded' in (schedSc.trigger ?? {}))) {
      throw new Error(`schedule_status.trigger missing: ${JSON.stringify(schedSc)}`);
    }
    // #426: `installed` is on the SHARED ScheduleStatusReport type specifically so the
    // MCP tool/resource and the CLI's --json output can never disagree about it (Codex
    // review — the field must not become a CLI-only bolt-on).
    if (schedSc?.installed !== true) {
      throw new Error(`schedule_status.installed unexpected: ${JSON.stringify(schedSc?.installed)}`);
    }

    // 2l-b. #285: the cypher-brain://schedule/status RESOURCE must serve byte-identical
    // state to the tool. That equality is the whole safety argument for adding a second
    // surface at all — if these can differ, this is a third description of one contract,
    // which is the bug class #276/#280/#290/#293 were.
    send({ jsonrpc: '2.0', id: 30, method: 'resources/list', params: {} });
    const resList = await waitFor(30);
    const uris = (resList.result?.resources ?? []).map((r) => r.uri);
    if (JSON.stringify(uris) !== JSON.stringify(['cypher-brain://schedule/status'])) {
      throw new Error(`resources/list unexpected: ${JSON.stringify(resList)}`);
    }
    send({
      jsonrpc: '2.0',
      id: 31,
      method: 'resources/read',
      params: { uri: 'cypher-brain://schedule/status' },
    });
    const resRead = await waitFor(31);
    const body = resRead.result?.contents?.[0];
    if (body?.mimeType !== 'application/json' || typeof body?.text !== 'string') {
      throw new Error(`resources/read returned no JSON body: ${JSON.stringify(resRead).slice(0, 300)}`);
    }
    // Compare everything EXCEPT next_run, which is derived from the clock at call time:
    // two calls either side of a minute boundary legitimately differ, and asserting
    // strict equality here would be a flaky test rather than a real guarantee
    // (multi-model review finding). Both must still HAVE a well-formed next_run.
    const resObj = JSON.parse(body.text);
    const withoutNextRun = (o) => {
      const { next_run, ...rest } = o ?? {};
      return JSON.stringify(rest);
    };
    if (withoutNextRun(resObj) !== withoutNextRun(schedSc)) {
      throw new Error(
        `the schedule status RESOURCE and TOOL disagree — one contract, two answers:\n  resource=${body.text.slice(0, 300)}\n  tool=${JSON.stringify(schedSc).slice(0, 300)}`,
      );
    }
    for (const [what, v] of [
      ['resource', resObj?.next_run],
      ['tool', schedSc?.next_run],
    ]) {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) {
        throw new Error(`${what} next_run is missing or malformed: ${JSON.stringify(v)}`);
      }
    }

    // 2l-c. #285: the restore-runbook prompt. Its text is MANAGEMENT.md's section,
    // inlined at build time; a build that inlined NOTHING would otherwise look like a
    // working feature while handing an agent no procedure at all.
    send({ jsonrpc: '2.0', id: 32, method: 'prompts/list', params: {} });
    const promptList = await waitFor(32);
    const promptNames = (promptList.result?.prompts ?? []).map((p) => p.name);
    if (JSON.stringify(promptNames) !== JSON.stringify(['restore-runbook'])) {
      throw new Error(`prompts/list unexpected: ${JSON.stringify(promptList)}`);
    }
    send({ jsonrpc: '2.0', id: 33, method: 'prompts/get', params: { name: 'restore-runbook' } });
    const promptGet = await waitFor(33);
    const promptText = promptGet.result?.messages?.[0]?.content?.text;
    if (typeof promptText !== 'string' || promptText.length < 200) {
      throw new Error(`restore-runbook prompt is empty or too short: ${JSON.stringify(promptGet).slice(0, 300)}`);
    }
    if (!promptText.startsWith('## Restore runbook') || !/cypher-brain pull --locator/.test(promptText)) {
      throw new Error(
        `restore-runbook prompt does not look like the MANAGEMENT.md section: ${promptText.slice(0, 200)}`,
      );
    }
    // The runbook has TWO read paths — a shipped build uses the constant scripts/build.ts
    // inlined, while src-direct dev runs read MANAGEMENT.md — and a fallback nobody
    // compares is a fallback that can quietly serve something else. So actually compare
    // them: drive the SRC-DIRECT server too and require the same text. (An earlier
    // version of this comment claimed the comparison happened when it did not —
    // multi-model review finding.)
    const devChild = spawn(process.execPath, [join(ROOT, 'bin', 'cypher-brain-mcp.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CYPHER_BRAIN_HOME: home,
        NODE_OPTIONS: `--experimental-strip-types --import ${join(ROOT, 'scripts', 'dev-cli-loader.mjs')}`,
      },
    });
    try {
      const dev = makeRpcClient(devChild);
      dev.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'ci-smoke-dev', version: '0.0.0' },
        },
      });
      await dev.waitFor(1);
      dev.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await wait(100);
      dev.send({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'restore-runbook' } });
      const devGet = await dev.waitFor(2);
      const devText = devGet.result?.messages?.[0]?.content?.text;
      if (devText !== promptText) {
        throw new Error(
          'the restore-runbook prompt differs between the shipped (inlined) and src-direct (MANAGEMENT.md) read paths — ' +
            `dist=${promptText.length}ch dev=${typeof devText === 'string' ? `${devText.length}ch` : JSON.stringify(devGet)}`,
        );
      }
    } finally {
      devChild.kill();
    }

    // 2m. schedule_status must REJECT unexpected arguments rather than silently
    // ignore them (the tool takes none — a stray field could otherwise mask a
    // client's mistaken attempt to scope the report to a different schedule).
    // #300: this is now the no-arguments case of the dispatcher-wide check, so the
    // message must also SAY the tool takes none rather than list nothing.
    send({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'schedule_status', arguments: { unexpected: true } },
    });
    const schedBad = await waitFor(11);
    const schedBadSc = schedBad.result?.structuredContent;
    if (schedBad.result?.isError !== true || schedBadSc?.code !== 'ERR_INVALID_INPUT') {
      throw new Error(
        `schedule_status did not reject an unexpected argument: ${JSON.stringify(schedBad.result).slice(0, 300)}`,
      );
    }
    if (!/takes no arguments/.test(schedBadSc?.message ?? '')) {
      throw new Error(
        `schedule_status rejection does not say it takes none: ${JSON.stringify(schedBadSc).slice(0, 300)}`,
      );
    }

    // 2m-ii. #300 — the reproduction the issue was filed on. A MISSPELLED OPTIONAL
    // field used to fail OPEN: snapshot_now returned isError:false having taken a real
    // snapshot, so a caller asking for the strictest secret-scanning gate got a
    // snapshot with no scan and nothing in the response saying so. It must now refuse,
    // and refuse BEFORE any work — the .age artifact must not exist afterwards, which
    // is what separates "reported an error" from "did it anyway and complained".
    const unknownArgOut = join(tmp, 'unknown-arg.age');
    send({
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: { dirs: [data], recipients: [recipientPath], out: unknownArgOut, scan_secretz: 'deny' },
      },
    });
    const strayOpt = await waitFor(40);
    const strayOptSc = strayOpt.result?.structuredContent;
    if (strayOpt.result?.isError !== true || strayOptSc?.code !== 'ERR_INVALID_INPUT') {
      throw new Error(
        `snapshot_now silently discarded a misspelled optional field: ${JSON.stringify(strayOpt.result).slice(0, 400)}`,
      );
    }
    if (!/scan_secretz/.test(strayOptSc?.message ?? '')) {
      throw new Error(
        `snapshot_now rejection does not name the stray field: ${JSON.stringify(strayOptSc).slice(0, 300)}`,
      );
    }
    if (existsSync(unknownArgOut)) {
      throw new Error('snapshot_now rejected a stray field but still produced a snapshot (the check must run first)');
    }

    // 2m-iii. The rejection must NAME the near miss, the way the CLI's own
    // `restore --out` hint does (#277) — `restore_now {out}` is that exact mistake
    // arriving over MCP, which used to be answered with a bare "out_dir is required"
    // that never mentioned the `out` it had thrown away. Both surfaces phrase it
    // through the same helper (src/lib/suggest.ts), so they cannot drift apart.
    //
    // All three ways a name goes wrong, since they take different paths through that
    // helper and a test of only the first would leave the other two unexercised
    // (multi-model review finding): a real field of another tool that EXTENDS this
    // one's (out → out_dir, the prefix rule), an ordinary misspelling (forcee → force,
    // edit distance), and a case slip (Wallet → wallet — rejected, because JSON keys
    // are case-sensitive and so is the check, but still explained rather than just
    // refused).
    for (const [id, toolName, strayArgs, expected] of [
      [41, 'restore_now', { file: outAge, out: join(tmp, 'nope'), confirm_write: true }, 'did you mean out_dir?'],
      [42, 'keygen', { forcee: true }, 'did you mean force?'],
      [43, 'wallet_address', { Wallet: '/nope' }, 'did you mean wallet?'],
    ]) {
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: strayArgs } });
      const nearMiss = await waitFor(id);
      const nearMissSc = nearMiss.result?.structuredContent;
      if (nearMiss.result?.isError !== true || nearMissSc?.code !== 'ERR_INVALID_INPUT') {
        throw new Error(
          `${toolName} accepted ${JSON.stringify(strayArgs)}: ${JSON.stringify(nearMiss.result).slice(0, 300)}`,
        );
      }
      if (!(nearMissSc.message ?? '').includes(expected)) {
        throw new Error(
          `${toolName} rejection does not suggest the near miss (${expected}): ` +
            `${JSON.stringify(nearMissSc?.message).slice(0, 300)}`,
        );
      }
    }

    // 2m-iv. The point of #300 is that this must not need remembering: the check is
    // derived from each tool's own advertised schema in the dispatcher, so a tool
    // added later is covered without anyone thinking about it. Assert that GENERICALLY
    // over the shared tool list (#290) rather than by naming tools a third time — a
    // future tool that accepts an argument it never declared fails HERE, in the test
    // that was written before it existed. If a tool ever legitimately needs open-ended
    // arguments, this failing is the deliberate step that says so.
    const probe = 'zz_not_a_declared_property';
    for (const [i, toolName] of EXPECTED_MCP_TOOLS.entries()) {
      const id = 50 + i;
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: { [probe]: 'x' } } });
      const res = await waitFor(id);
      const sc = res.result?.structuredContent;
      // Checked FIRST: a missing branch-relevance declaration answers with ERR_INTERNAL, so
      // the ERR_INVALID_INPUT assertion below would throw before this ever ran and report a
      // puzzling "does not reject an undeclared argument" for a tool that rejects it fine
      // (multi-model review finding). Order it here and the failure says what to add.
      if (sc?.message?.includes('branch-relevance declaration')) {
        throw new Error(
          `${toolName} has no branch-relevance declaration (#308) — add it to BRANCH_IRRELEVANT in src/mcp.ts, ` +
            `with an empty array if no declared field of this tool is branch-dependent: ${sc.message}`,
        );
      }
      if (res.result?.isError !== true || sc?.code !== 'ERR_INVALID_INPUT') {
        throw new Error(
          `${toolName} does not reject an undeclared argument — its handler can still be reached with a field ` +
            `tools/list says is not allowed: ${JSON.stringify(res.result).slice(0, 300)}`,
        );
      }
      if (!sc.message?.includes(probe)) {
        throw new Error(
          `${toolName} rejected an undeclared argument without naming it: ${JSON.stringify(sc).slice(0, 300)}`,
        );
      }
    }

    // 2m-iv-a. #319: require_signature over MCP, and — the point of the issue — that it
    // gates rather than reports. `outAge` is unsigned, which is also the shape an attacker
    // produces by DELETING a sidecar; #214 says that warns and continues, and this flag is
    // what turns it into a refusal. The ordering assertion is the load-bearing one:
    // restore_now must not have created out_dir at all, because restore() checks
    // authenticity before the identity is loaded or pg_restore can drop anything.
    send({
      jsonrpc: '2.0',
      id: 90,
      method: 'tools/call',
      params: { name: 'verify_restore', arguments: { file: outAge } },
    });
    const sigBase = (await waitFor(90)).result?.structuredContent;
    if (sigBase?.verdict !== 'PASS') {
      throw new Error(
        `baseline verify_restore(file) should still PASS without require_signature: ${JSON.stringify(sigBase).slice(0, 300)}`,
      );
    }
    send({
      jsonrpc: '2.0',
      id: 91,
      method: 'tools/call',
      params: { name: 'verify_restore', arguments: { file: outAge, require_signature: true } },
    });
    const sigStrict = (await waitFor(91)).result?.structuredContent;
    if (sigStrict?.verdict === 'PASS' || sigStrict?.restorable_proven === true) {
      throw new Error(
        `verify_restore with require_signature still returned a PASS for an artifact with no signature: ${JSON.stringify(sigStrict).slice(0, 400)}`,
      );
    }
    const sigOutDir = join(tmp, 'require-sig-out');
    send({
      jsonrpc: '2.0',
      id: 92,
      method: 'tools/call',
      params: {
        name: 'restore_now',
        arguments: { file: outAge, out_dir: sigOutDir, confirm_write: true, require_signature: true },
      },
    });
    const sigRestore = await waitFor(92);
    if (sigRestore.result?.isError !== true) {
      throw new Error(
        `restore_now with require_signature restored an unsigned artifact: ${JSON.stringify(sigRestore.result).slice(0, 400)}`,
      );
    }
    if (existsSync(sigOutDir)) {
      throw new Error(
        `restore_now refused AFTER touching out_dir — require_signature must gate the write, not report on it: ${sigOutDir} exists`,
      );
    }

    // 2m-iv-a2. The pinned-copy path must carry the AUTHENTICITY SIDECAR with it. restore()
    // looks for "<in>.minisig" beside whatever it is handed, so copying only the ciphertext
    // into the scratch dir left the artifact looking UNSIGNED to the very next step — and an
    // absent signature warns and continues while an INVALID one refuses (#214). Passing
    // sha256 therefore turned a TAMPERED signature into a silent success: adding an
    // integrity pin, the more careful thing to do, disabled the authenticity check. The CLI
    // refuses the same artifact, which is what makes this a surface disagreement rather than
    // a policy.
    const signedSrc = join(tmp, 'signed-src');
    await mkdir(signedSrc, { recursive: true });
    await writeFile(join(signedSrc, 'note.txt'), 'signed-artifact-probe\n');
    const signedAge = join(tmp, 'signed-probe.age');
    const CLI = SERVER_PATH.replace(/mcp\.mjs$/, 'cli.mjs');
    const cliRun = (args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env }, encoding: 'utf8' });
    const kgSign = cliRun(['keygen', '--sign']);
    if (kgSign.status !== 0) throw new Error(`setup: keygen --sign failed: ${kgSign.stderr || kgSign.stdout}`);
    const snapSign = cliRun(['snapshot', '--dir', signedSrc, '--out', signedAge, '--sign']);
    if (snapSign.status !== 0) throw new Error(`setup: snapshot --sign failed: ${snapSign.stderr || snapSign.stdout}`);
    if (!existsSync(`${signedAge}.minisig`)) {
      throw new Error('setup: snapshot --sign did not write a .minisig, so the sidecar probe cannot run');
    }
    const signedSha = createHash('sha256')
      .update(await readFile(signedAge))
      .digest('hex');
    // Structurally valid, cryptographically wrong — the shape restore() must REFUSE, as
    // distinct from an absent sidecar, which it only warns about.
    const sigLines = (await readFile(`${signedAge}.minisig`, 'utf8')).split('\n');
    const sigBytes = Buffer.from(sigLines[1], 'base64');
    sigBytes[sigBytes.length - 1] ^= 0xff;
    sigLines[1] = sigBytes.toString('base64');
    await writeFile(`${signedAge}.minisig`, sigLines.join('\n'));
    const tamperOut = join(tmp, 'tampered-out');
    send({
      jsonrpc: '2.0',
      id: 93,
      method: 'tools/call',
      params: {
        name: 'restore_now',
        arguments: { file: signedAge, out_dir: tamperOut, confirm_write: true, sha256: signedSha },
      },
    });
    const tampered = await waitFor(93);
    if (tampered.result?.isError !== true || existsSync(tamperOut)) {
      throw new Error(
        `restore_now with a sha256 pin restored an artifact whose signature is INVALID — the pin disabled the authenticity check: ${JSON.stringify(tampered.result).slice(0, 400)}`,
      );
    }

    // 2m-iv-a3. A non-boolean must be refused, not coerced. `require_signature: "true"` read
    // as false would hand the permissive posture to a caller who asked for the strict one.
    send({
      jsonrpc: '2.0',
      id: 94,
      method: 'tools/call',
      params: { name: 'verify_restore', arguments: { file: outAge, require_signature: 'true' } },
    });
    const badBool = await waitFor(94);
    if (badBool.result?.isError !== true || badBool.result?.structuredContent?.code !== 'ERR_INVALID_INPUT') {
      throw new Error(
        `verify_restore accepted a non-boolean require_signature instead of refusing it: ${JSON.stringify(badBool.result).slice(0, 300)}`,
      );
    }

    // 2m-iv-b. #308 direction 2: a DECLARED field, a LEGAL value, and a branch that will
    // never read it. Both reproductions were measured on main before the fix — the first
    // is the one this issue was filed on, the second is worse in consequence because the
    // dropped field is the durable recovery pointer.
    for (const [i, probeCase] of [
      {
        tool: 'verify_restore',
        args: { file: join(tmp, 'never.age'), backend: 'turbo' },
        field: 'backend',
        was: 'returned verdict PASS from the local-file branch, having fetched nothing',
      },
      {
        tool: 'snapshot_now',
        args: {
          dirs: [],
          recipients: ['age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsxxxxxx'],
          out: join(tmp, 'never.age'),
          locator_file: join(tmp, 'never.tsv'),
        },
        field: 'locator_file',
        was: 'exited clean without pushing, and never wrote the locator file it was handed',
      },
    ].entries()) {
      const id = 80 + i;
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: probeCase.tool, arguments: probeCase.args } });
      const res = await waitFor(id);
      const sc = res.result?.structuredContent;
      if (res.result?.isError !== true || sc?.code !== 'ERR_INVALID_INPUT' || !sc.message?.includes(probeCase.field)) {
        throw new Error(
          `${probeCase.tool} did not refuse ${probeCase.field} on a branch that cannot read it (before #308 it ${probeCase.was}): ${JSON.stringify(res.result).slice(0, 400)}`,
        );
      }
    }

    // 2m-v. #308 — the same failure one level in, and the reproduction that issue was
    // filed on. `backend` declares enum: ["file","arweave","turbo"], but whether a value
    // outside it was refused used to depend on which BRANCH the rest of the arguments
    // selected: estimate_cost consults the backend and refused, while verify_restore
    // {file, backend:"nonsense"} took the local-file branch, never needed one, and
    // returned a clean PASS — a verdict its caller reads as "verified through the backend
    // I named". The check is now in the dispatcher, derived from the same schema, so it
    // runs whatever branch the call would have taken.
    send({
      jsonrpc: '2.0',
      id: 60,
      method: 'tools/call',
      params: { name: 'verify_restore', arguments: { file: outAge, backend: 'nonsense' } },
    });
    const badEnum = await waitFor(60);
    const badEnumSc = badEnum.result?.structuredContent;
    if (badEnum.result?.isError !== true || badEnumSc?.code !== 'ERR_INVALID_INPUT') {
      throw new Error(
        'verify_restore accepted a backend outside its declared enum on the file branch: ' +
          JSON.stringify(badEnum.result).slice(0, 400),
      );
    }
    if (!(badEnumSc.message ?? '').includes('backend') || !(badEnumSc.message ?? '').includes('nonsense')) {
      throw new Error(
        `verify_restore rejection names neither the field nor the value it refused: ${JSON.stringify(badEnumSc).slice(0, 300)}`,
      );
    }

    // The refusal reaches for the SAME "did you mean" helper (src/lib/suggest.ts) as the
    // unknown-argument refusal above and the CLI's own #277 hint, so a value one letter
    // off is told which declared one it was near rather than only that it was wrong.
    send({
      jsonrpc: '2.0',
      id: 61,
      method: 'tools/call',
      params: { name: 'verify_restore', arguments: { file: outAge, backend: 'fille' } },
    });
    const nearEnum = await waitFor(61);
    const nearEnumSc = nearEnum.result?.structuredContent;
    if (nearEnum.result?.isError !== true || !(nearEnumSc?.message ?? '').includes('did you mean file?')) {
      throw new Error(
        `verify_restore backend="fille" was not answered with the near miss: ${JSON.stringify(nearEnum.result).slice(0, 300)}`,
      );
    }

    // Generic over every field that DECLARES an enum, read out of the tools/list response
    // rather than named here — same discipline as 2m-iv, so a tool added later with a new
    // enum field is covered by a test written before it existed. The value is refused in
    // the dispatcher before any handler runs, so no other argument is needed to reach it.
    const enumFields = [];
    for (const tool of list.result?.tools ?? []) {
      for (const [field, spec] of Object.entries(tool.inputSchema?.properties ?? {})) {
        if (Array.isArray(spec?.enum) && spec.enum.length > 0) enumFields.push([tool.name, field, spec.enum]);
      }
    }
    // Asserted, not assumed: with no enum anywhere the loop below would pass vacuously
    // and report coverage it never exercised. If a schema legitimately drops its last
    // enum, this failing is the deliberate step that says so.
    if (enumFields.length === 0) {
      throw new Error('no advertised tool declares an enum — the generic enum check below would prove nothing');
    }

    // The dispatcher's check is deliberately not a JSON Schema validator (#308): it reads
    // ONE shape — a top-level property's own `enum`, of primitive literals compared by
    // value. Both loops above see only that same shape, so an enum declared any OTHER way
    // would be unenforced AND untested, which is #308's own failure mode wearing a new
    // hat. Walk every advertised schema and refuse to be green with one: an enum nested
    // under items / a sub-object / allOf|anyOf|oneOf is not read at all, and an object or
    // array literal is compared by reference where JSON Schema compares structurally, so
    // it could refuse a value the schema permits. Either is a deliberate step — extend
    // assertDeclaredEnums first — not something a new tool can slip past.
    const enumsFoundBelowProperty = [];
    const walkForEnums = (node, path) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const [i, child] of node.entries()) walkForEnums(child, `${path}[${i}]`);
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === 'enum') enumsFoundBelowProperty.push(`${path}.enum`);
        else walkForEnums(child, `${path}.${key}`);
      }
    };
    const isPrimitiveLiteral = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
    const unenforceable = [];
    for (const tool of list.result?.tools ?? []) {
      const schema = tool.inputSchema ?? {};
      for (const [key, child] of Object.entries(schema)) {
        if (key !== 'properties') walkForEnums(child, `${tool.name}.${key}`);
      }
      for (const [field, spec] of Object.entries(schema.properties ?? {})) {
        for (const [key, child] of Object.entries(spec ?? {})) {
          if (key !== 'enum') walkForEnums(child, `${tool.name}.${field}.${key}`);
          else if (!Array.isArray(child) || !child.every(isPrimitiveLiteral)) {
            unenforceable.push(
              `${tool.name}.${field}.enum (non-primitive literal — compared by reference, not structurally)`,
            );
          }
        }
      }
    }
    unenforceable.push(...enumsFoundBelowProperty.map((p) => `${p} (not a top-level property's own enum)`));
    if (unenforceable.length > 0) {
      throw new Error(
        `advertised enum(s) the dispatcher does not enforce: ${unenforceable.join(', ')} — assertDeclaredEnums ` +
          "reads a top-level property's own enum of primitive literals and nothing else. Extend it (or drop the " +
          'enum from the schema) rather than publishing a constraint the server ignores.',
      );
    }
    const enumProbe = 'zz_not_a_declared_enum_value';
    for (const [i, [toolName, field, allowed]] of enumFields.entries()) {
      if (allowed.includes(enumProbe)) {
        throw new Error(`${toolName}.${field} actually declares the probe value ${enumProbe} — pick another`);
      }
      const id = 70 + i;
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: { [field]: enumProbe } } });
      const res = await waitFor(id);
      const sc = res.result?.structuredContent;
      if (res.result?.isError !== true || sc?.code !== 'ERR_INVALID_INPUT') {
        throw new Error(
          `${toolName} does not reject a value outside ${field}'s declared enum — its handler can still be reached ` +
            `with a value tools/list says is not allowed: ${JSON.stringify(res.result).slice(0, 300)}`,
        );
      }
      if (!(sc.message ?? '').includes(field) || !(sc.message ?? '').includes(enumProbe)) {
        throw new Error(
          `${toolName} rejected an out-of-enum ${field} without naming the field and the value: ${JSON.stringify(sc).slice(0, 300)}`,
        );
      }
    }

    // 2n. keygen against THIS server's home — which already has a real identity
    // (written by the CLI-driven keygen at the top of this run, not by the tool
    // itself) — must refuse rather than silently re-key a brain snapshots already
    // depend on. Complements the fresh-home keygen coverage in
    // runKeygenWalletTests() below by proving the refusal also holds for an
    // identity that pre-dates the MCP server's own lifetime.
    send({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'keygen', arguments: {} } });
    const keygenGuard = await waitFor(14);
    if (keygenGuard.result?.isError !== true)
      throw new Error(
        `keygen against a pre-existing identity did not refuse: ${JSON.stringify(keygenGuard.result).slice(0, 300)}`,
      );
    if (!/already exists/.test(keygenGuard.result?.structuredContent?.message ?? ''))
      throw new Error(`keygen refused for the wrong reason: ${JSON.stringify(keygenGuard.result?.structuredContent)}`);

    // 2o. #307: schedule_install can enable the gate too — an agent installing a nightly
    // over MCP is exactly the unattended surface this issue is about. Kept LAST because a
    // successful install replaces the schedule 2k/2l wrote and read back.
    //
    // Structural first (no gitleaks needed): a source-less request is refused rather than
    // baking a nightly that reports a scan of zero components, and a bad mode is refused.
    send({
      jsonrpc: '2.0',
      id: 30704,
      method: 'tools/call',
      params: {
        name: 'schedule_install',
        arguments: {
          backend: 'file',
          pg: 'postgres://x/y',
          scan_secrets: 'deny',
          no_load: true,
          confirm_install: true,
        },
      },
    });
    const schedNoSrc = await waitFor(30704);
    if (
      schedNoSrc.result?.isError !== true ||
      !/nothing to scan/.test(schedNoSrc.result?.structuredContent?.message ?? '')
    )
      throw new Error(
        `schedule_install accepted scan_secrets with no dirs source: ${JSON.stringify(schedNoSrc.result).slice(0, 400)}`,
      );
    send({
      jsonrpc: '2.0',
      id: 30705,
      method: 'tools/call',
      params: {
        name: 'schedule_install',
        arguments: { backend: 'file', dirs: [data], scan_secrets: 'bogus', no_load: true, confirm_install: true },
      },
    });
    const schedBadMode = await waitFor(30705);
    if (schedBadMode.result?.isError !== true || schedBadMode.result?.structuredContent?.code !== 'ERR_INVALID_INPUT')
      throw new Error(
        `schedule_install accepted scan_secrets:"bogus": ${JSON.stringify(schedBadMode.result).slice(0, 400)}`,
      );

    // Then the real wiring, when a gitleaks exists for install to resolve and bake in.
    let schedScanSummary = 'skipped (no gitleaks)';
    if (spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).status === 0) {
      send({
        jsonrpc: '2.0',
        id: 30706,
        method: 'tools/call',
        params: {
          name: 'schedule_install',
          arguments: { backend: 'file', dirs: [data], scan_secrets: 'deny', no_load: true, confirm_install: true },
        },
      });
      const schedScan = await waitFor(30706);
      const schedScanSc = schedScan.result?.structuredContent;
      if (schedScan.result?.isError)
        throw new Error(`schedule_install with scan_secrets failed: ${JSON.stringify(schedScanSc).slice(0, 500)}`);
      if (schedScanSc?.scan_secrets !== 'deny')
        throw new Error(
          `schedule_install should report the mode it baked in, got ${JSON.stringify(schedScanSc?.scan_secrets)}`,
        );
      // The claim is only worth anything if the generated runner really carries it.
      const runnerText = await readFile(join(home, 'schedule', 'nightly.sh'), 'utf8');
      if (!/snapshot .*--scan-secrets 'deny'/.test(runnerText))
        throw new Error(
          "schedule_install reported scan_secrets:deny but the generated runner's snapshot line lacks it",
        );
      // And schedule_status — the read-back surface an agent would check — agrees.
      send({ jsonrpc: '2.0', id: 30707, method: 'tools/call', params: { name: 'schedule_status', arguments: {} } });
      const schedScanStatus = await waitFor(30707);
      if (schedScanStatus.result?.structuredContent?.configured?.scan_secrets !== 'deny')
        throw new Error(
          `schedule_status does not report the installed scan mode: ${JSON.stringify(schedScanStatus.result?.structuredContent?.configured)}`,
        );
      schedScanSummary = 'installed+runner+status=deny';
    } else {
      process.stdout.write(
        'MCP SMOKE: [SKIP] schedule_install scan_secrets end-to-end — no `gitleaks` on PATH for install to resolve ' +
          '(CI installs it, see #215). The schema and refusal assertions above still ran.\n',
      );
    }

    process.stdout.write(
      `MCP SMOKE: PASS — tools=[${names.join(', ')}], spend gate=ERR_CONFIRM_REQUIRED, ` +
        `file round-trip locator=${snapSc.locator.split('/').pop()}, status.age=${latest.age_seconds}s, verify=${verSc.verdict}, ` +
        `verify(locator_file pin)=${verPinnedSc.verdict}, wrong-pin=fail-closed, ` +
        `restore_now gate=ERR_CONFIRM_REQUIRED, restore_now round-trip content=ok, estimate(file)=0, ` +
        `estimate(size_bytes)=0, estimate(turbo, sdk ${turboSdkInstalled ? 'installed' : 'missing'})=ok, ` +
        `schedule_install gate=ERR_CONFIRM_REQUIRED, schedule_install no_load=ok, ` +
        `schedule_status.next_run=${schedSc.next_run}, schedule_install scan_secrets=${schedScanSummary}, ` +
        `resource==tool=yes, ` +
        `prompt=restore-runbook(${promptText.length}ch), keygen(pre-existing)=refused, ` +
        `unknown-arg refused by all ${EXPECTED_MCP_TOOLS.length} tools (near miss named), ` +
        `out-of-enum value refused on all ${enumFields.length} declared enum field(s), ` +
        `idempotency_key: replay=ok, key-reused-for-different-call=ERR_IDEMPOTENCY_KEY_REUSED, ` +
        `different-key-not-a-free-pass=CB-E009\n`,
    );
  } finally {
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

// A SIGTERM to this long-lived server must not leave its fetch dirs behind. verify_restore
// and restore_now pull/copy into `cypher-brain-mcp-*` temp dirs and erase them in a
// finally-block — which a signal skips entirely, exactly like the snapshot stage dir
// (scripts/selftest.sh "P1 regression") and the drill scratch dir
// (scripts/selftest-verify-levels.sh). Those two are CLI one-shots where a signal is
// exceptional; here it is the ORDINARY way the process ends (launchd stop, machine
// shutdown, an operator Ctrl-C on a foreground server).
//
// Held open deterministically rather than raced: a stub `tar` on PATH intercepts verify's
// listing pass (`tar -tf -`, the first tar the call makes AFTER the pull has finished
// writing pulled.age), touches a marker and becomes `sleep`. Polling for that marker is
// what proves the SIGTERM lands inside the window instead of before or after it. The stub
// exec's sleep rather than backgrounding it so it IS the registered child process, which
// the guard's own SIGKILL sweep then reaps.
async function runSignalCleanupTest(tmp) {
  const home = join(tmp, 'home-signal');
  const store = join(tmp, 'store-signal');
  const data = join(tmp, 'data-signal');
  const isolatedTmp = join(tmp, 'tmpdir-signal');
  const stubBin = join(tmp, 'stubbin-signal');
  const marker = join(tmp, 'tar-stub-started');
  await mkdir(data, { recursive: true });
  await mkdir(isolatedTmp, { recursive: true });
  await mkdir(stubBin, { recursive: true });
  await writeFile(join(data, 'hello.txt'), 'cypher-brain mcp signal-cleanup payload\n');

  const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
  if (!realTar) throw new Error('signal-cleanup test: no tar on PATH (test setup)');
  await writeFile(
    join(stubBin, 'tar'),
    `#!/usr/bin/env bash\nif [ "$1" = "-tf" ]; then\n  : > ${JSON.stringify(marker)}\n  exec sleep 20\nfi\nexec ${JSON.stringify(realTar)} "$@"\n`,
    { mode: 0o755 },
  );

  const keygenRes = spawnSync(process.execPath, [SERVER_PATH.replace(/mcp\.mjs$/, 'cli.mjs'), 'keygen'], {
    env: { ...process.env, CYPHER_BRAIN_HOME: home },
    encoding: 'utf8',
  });
  if (keygenRes.status !== 0) {
    throw new Error(
      `signal-cleanup test: keygen failed (${keygenRes.status}): ${keygenRes.stderr || keygenRes.stdout}`,
    );
  }

  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CYPHER_BRAIN_HOME: home,
      CYPHER_BRAIN_FILE_DIR: store,
      TMPDIR: isolatedTmp, // os.tmpdir() — so the only cypher-brain-mcp-* dirs here are this server's
      PATH: `${stubBin}:${process.env.PATH}`,
    },
  });
  const { send, waitFor } = makeRpcClient(child);
  const leftovers = async () => (await readdir(isolatedTmp)).filter((n) => n.startsWith('cypher-brain-mcp-'));

  let signalled = false;
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '0.0.0' } },
    });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await wait(100);

    // A real snapshot to have something to verify. The stub only intercepts `-tf`, so
    // snapshot's own `tar -cf -` / `-czf` run for real.
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [data],
          recipients: [join(home, 'recipient.txt')],
          out: join(tmp, 'signal-cleanup.age'),
          backend: 'file',
        },
      },
    });
    const snap = await waitFor(2);
    if (snap.result?.isError)
      throw new Error(`signal-cleanup test: snapshot_now failed: ${JSON.stringify(snap.result).slice(0, 500)}`);
    const locator = snap.result?.structuredContent?.locator;
    if (typeof locator !== 'string') throw new Error('signal-cleanup test: snapshot_now returned no locator');

    // TWO calls, fired and deliberately never awaited — both are meant to be interrupted.
    // Two rather than one because the guard tracks these dirs in a SET: with a single
    // in-flight call, a scalar "last registration wins" implementation would pass this
    // test unchanged. The first call reaches the stub tar and parks there; the second gets
    // as far as creating (and registering) its own dir before queueing behind captureCall's
    // mutex — so both directories are on disk when the signal lands, which is the state the
    // set exists for.
    for (const id of [3, 4]) {
      send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'verify_restore', arguments: { locator, backend: 'file' } },
      });
    }

    let inWindow = false;
    for (let i = 0; i < 300; i++) {
      if (existsSync(marker) && (await leftovers()).length >= 2) {
        inWindow = true;
        break;
      }
      await wait(100);
    }
    if (!inWindow) {
      throw new Error(
        'signal-cleanup test: the two verify_restore calls never reached the held-open window with both fetch ' +
          `dirs on disk (marker=${existsSync(marker)}, dirs=${JSON.stringify(await leftovers())}) — test setup`,
      );
    }

    child.kill('SIGTERM');
    signalled = true;
    // Bounded: a handler that cleans up but never re-raises would otherwise hang the whole
    // smoke suite instead of failing it.
    const exited = await Promise.race([
      new Promise((res) => child.once('exit', (code, signal) => res({ code, signal }))),
      wait(15_000).then(() => null),
    ]);
    if (exited === null) throw new Error('signal-cleanup test: server never exited within 15s of SIGTERM');

    const left = await leftovers();
    if (left.length > 0) {
      throw new Error(
        `signal-cleanup test: SIGTERM left ${left.length} cypher-brain-mcp-* dir(s) behind: ${left.join(', ')}`,
      );
    }
    // The guard removes its own listener and re-raises, so the process must die OF the
    // signal. Exiting 0 (or throwing its way to 1) would still leave the temp dir gone —
    // and would still be a regression: `kill` reporting success while the exit status says
    // "ordinary exit" is how a supervisor mislabels an interrupted run as a clean one.
    if (exited.signal !== 'SIGTERM' || exited.code !== null) {
      throw new Error(
        `signal-cleanup test: server did not die of SIGTERM (code=${exited.code}, signal=${exited.signal}) — ` +
          'the handler must re-raise rather than exit on its own',
      );
    }
  } finally {
    if (!signalled) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }
  process.stdout.write(
    'MCP SMOKE (signal cleanup): PASS — SIGTERM with two verify_restore calls in flight left no ' +
      'cypher-brain-mcp-* fetch dir behind, and the server died of the signal it was sent\n',
  );
}

main().catch((err) => {
  process.stderr.write(`MCP SMOKE: FAIL — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
