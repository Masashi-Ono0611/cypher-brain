#!/usr/bin/env node
// issue #654 (MCP-level): a ton-provider snapshot_now call whose funding is confirmed
// on-chain but whose provider-notify handshake times out must be recorded under its
// idempotency_key with funding_confirmed:true / provider_download_confirmed:false /
// partial_stage:'provider_notify' — NOT the locator_file_write_failed fallback the
// pre-existing PushSignatureUploadError/PushLocatorWriteError branch would have
// misclassified it as (Codex design review, agmsg 2026-08-29: "MCP idempotencyは必ず
// 新errorを個別扱いしてください"). Deliberately reuses this run's ALREADY-RUNNING
// tonapi/mytonprovider/notify mocks — invoked from scripts/selftest-ton-provider.sh
// via `node` with those mocks' env vars already inherited — rather than duplicating a
// second copy of that infrastructure just for the MCP path.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = join(ROOT, 'dist', 'mcp.mjs');
const TIMEOUT_MS = 30_000;

const TMP = process.env.MCP_PARTIAL_TEST_TMP;
const TON_WALLET_PATH = process.env.MCP_PARTIAL_TEST_TON_WALLET;
if (!TMP || !TON_WALLET_PATH) {
  throw new Error('MCP_PARTIAL_TEST_TMP and MCP_PARTIAL_TEST_TON_WALLET must be set (see selftest-ton-provider.sh)');
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function parseFrames(buf) {
  const frames = [];
  for (const line of buf.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      frames.push(JSON.parse(trimmed));
    } catch {
      /* not a JSON-RPC frame line (e.g. a stray console.error leak) — ignore */
    }
  }
  return frames;
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
  return { send, waitFor };
}

async function main() {
  const srcDir = join(TMP, 'mcp-partial-src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, 'note.txt'), 'issue #654 MCP-level partial-success payload\n');
  const out = join(TMP, 'mcp-partial.age');
  const idempotencyKey = 'issue-654-mcp-partial-key';

  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CYPHER_BRAIN_TON_WALLET: TON_WALLET_PATH,
      CYPHER_BRAIN_TON_PROVIDER_OWNER: '',
      // Short retry window so the mocked provider's partial download (forced below)
      // reliably times out well inside this script's own 30s waitFor() budget.
      CYPHER_BRAIN_TON_PROVIDER_NOTIFY_RETRY_MS: '1500',
      CYPHER_BRAIN_TON_PROVIDER_NOTIFY_INTERVAL_MS: '300',
    },
  });
  const { send, waitFor } = makeRpcClient(child);
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } },
    });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // The mock notify shim reads this file for how many bytes to claim as
    // "downloaded" — see selftest-ton-provider.sh's own mock-notify.mjs. "1" is far
    // short of the real artifact size, so the retry loop above times out.
    await writeFile(process.env.MCP_PARTIAL_TEST_NOTIFY_DOWNLOADED, '1');

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [srcDir],
          recipients: [process.env.MCP_PARTIAL_TEST_RECIPIENT],
          out,
          backend: 'ton-provider',
          confirm_paid: true,
          idempotency_key: idempotencyKey,
        },
      },
    });
    const r1 = await waitFor(2);
    if (!r1.result?.isError) {
      throw new Error(
        `expected an error result (notify never confirms within the retry window), got: ${JSON.stringify(r1.result).slice(0, 500)}`,
      );
    }
    if (!/funding is CONFIRMED on-chain/.test(r1.result?.structuredContent?.message ?? '')) {
      throw new Error(
        `the immediate error result should still name the confirmed funding, got: ${JSON.stringify(r1.result).slice(0, 500)}`,
      );
    }
    console.log(
      '[PASS] MCP snapshot_now(ton-provider): notify timeout after confirmed funding reports an error naming the confirmed funding',
    );

    // Same idempotency_key, called again: replays the RECORDED PARTIAL SUCCESS
    // (idempotent_replay:true) rather than attempting a second real broadcast — #220's
    // idempotency-key feature applied to this new error shape. This replayed result,
    // not the original call's own immediate error above, is where funding_confirmed/
    // provider_download_confirmed/partial_stage actually live (recordIdempotencyResult
    // stores the classified partialResult; the original call itself still `throw`s).
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [srcDir],
          recipients: [process.env.MCP_PARTIAL_TEST_RECIPIENT],
          out,
          backend: 'ton-provider',
          confirm_paid: true,
          idempotency_key: idempotencyKey,
        },
      },
    });
    const r2 = await waitFor(3);
    const sc2 = r2.result?.structuredContent;
    // issue #810: the replay is an ERROR result, not a success one. This assertion used to
    // require `isError` to be ABSENT — which was the bug: the first call reported this
    // outcome as an error and the replay reported the identical state as a clean success,
    // so an agent retrying after a transport hiccup concluded a push whose provider never
    // confirmed the download had fully succeeded. Both calls must agree.
    if (r2.result?.isError !== true || sc2?.idempotent_replay !== true) {
      throw new Error(
        `a repeat call with the SAME idempotency_key after a confirmed-funding notify failure should replay the ` +
          `recorded partial success as an ERROR (isError:true, idempotent_replay:true), not re-execute, refuse, or ` +
          `report a clean success (#810): ${JSON.stringify(r2.result).slice(0, 500)}`,
      );
    }
    if (sc2?.funding_confirmed !== true) {
      throw new Error(`replayed result missing funding_confirmed:true: ${JSON.stringify(sc2).slice(0, 500)}`);
    }
    if (sc2?.provider_download_confirmed !== false) {
      throw new Error(
        `replayed result missing provider_download_confirmed:false: ${JSON.stringify(sc2).slice(0, 500)}`,
      );
    }
    if (sc2?.partial_stage !== 'provider_notify') {
      throw new Error(`replayed result missing partial_stage:'provider_notify': ${JSON.stringify(sc2).slice(0, 500)}`);
    }
    // issue #654 (Codex design review): this is exactly the misclassification this
    // fix's own dedicated branch in mcp.ts exists to avoid — without it, this error
    // shape fell into the generic `else` and reported locator_file_write_failed:true,
    // which is simply false (nothing about --save-locator bookkeeping happened here).
    if (sc2?.locator_file_write_failed || sc2?.signature_upload_failed) {
      throw new Error(
        `must NOT fall into the locator_file_write_failed/signature_upload_failed branches: ${JSON.stringify(sc2).slice(0, 500)}`,
      );
    }
    if (typeof sc2?.locator !== 'string' || !sc2.locator.startsWith('ton-provider:v1:')) {
      throw new Error(`replayed result is missing a real ton-provider locator: ${JSON.stringify(sc2).slice(0, 500)}`);
    }
    console.log(
      '[PASS] MCP snapshot_now(ton-provider): the replayed partial-success result classifies as funding_confirmed/provider_download_confirmed:false/partial_stage:provider_notify, not the generic locator_file_write_failed bucket',
    );
  } finally {
    child.kill();
  }
}

await main();
console.log('MCP TON-PROVIDER PARTIAL-SUCCESS SELFTEST PASS');
