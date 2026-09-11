#!/usr/bin/env node
// issue #949 (scenario 1, MCP-level): a ton-provider snapshot_now call whose funding
// broadcast is accepted (HTTP 200) but whose subsequent on-chain confirmation poll
// (waitForContractActive()) times out — a TonAPI outage, not proof the transfer failed —
// must be recorded under its idempotency_key as an UNCERTAIN spend (ERR_PUSH_OUTCOME_
// UNCERTAIN / spend_outcome:'uncertain' / check_kind:'ton_contract_address'), the SAME
// classification #818's arweave.ts case already gets, NOT a plain error that lets a
// same-key retry release its claim and broadcast a second real transfer. Deliberately
// reuses this run's ALREADY-RUNNING tonapi/mytonprovider/notify mocks (env vars inherited
// from selftest-ton-provider.sh) — see selftest-ton-provider-mcp-partial.mjs's own header
// comment for why that is the right posture here too.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = join(ROOT, 'dist', 'mcp.mjs');
const TIMEOUT_MS = 30_000;

const TMP = process.env.MCP_UNCERTAIN_TEST_TMP;
const TON_WALLET_PATH = process.env.MCP_UNCERTAIN_TEST_TON_WALLET;
if (!TMP || !TON_WALLET_PATH) {
  throw new Error(
    'MCP_UNCERTAIN_TEST_TMP and MCP_UNCERTAIN_TEST_TON_WALLET must be set (see selftest-ton-provider.sh)',
  );
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
  const srcDir = join(TMP, 'mcp-uncertain-src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, 'note.txt'), 'issue #949 MCP-level uncertain-spend payload\n');
  const out = join(TMP, 'mcp-uncertain.age');
  const idempotencyKey = 'issue-949-mcp-uncertain-key';

  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CYPHER_BRAIN_TON_WALLET: TON_WALLET_PATH,
      CYPHER_BRAIN_TON_PROVIDER_OWNER: '',
      CYPHER_BRAIN_PIN_RECIPIENTS: process.env.MCP_UNCERTAIN_TEST_RECIPIENT,
      CYPHER_BRAIN_MCP_SOURCE_ROOTS: JSON.stringify([TMP]),
      // Short and bounded so the mock tonapi's never-active contract (forced by the
      // caller having already `touch`ed NEVER_ACTIVE_FLAG before spawning this script)
      // reliably times out well inside this script's own 30s waitFor() budget.
      CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS: '1500',
      CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_POLL_MS: '200',
      CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS: '10000',
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

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [srcDir],
          recipients: [process.env.MCP_UNCERTAIN_TEST_RECIPIENT],
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
        `expected an error result (the deploy confirm-poll times out against the never-active mock), got: ${JSON.stringify(r1.result).slice(0, 500)}`,
      );
    }
    const sc1 = r1.result?.structuredContent;
    if (sc1?.code !== 'ERR_PUSH_OUTCOME_UNCERTAIN' || sc1?.spend_outcome !== 'uncertain') {
      throw new Error(
        `the immediate error result must classify as ERR_PUSH_OUTCOME_UNCERTAIN/uncertain (issue #949), not a plain ` +
          `error indistinguishable from "nothing was spent": ${JSON.stringify(r1.result).slice(0, 500)}`,
      );
    }
    if (
      sc1?.backend !== 'ton-provider' ||
      sc1?.check_kind !== 'ton_contract_address' ||
      typeof sc1?.check_identifier !== 'string' ||
      !sc1.check_identifier
    ) {
      throw new Error(
        `the immediate error result is missing the ton_contract_address check an operator/agent needs to settle the ` +
          `ambiguity: ${JSON.stringify(r1.result).slice(0, 500)}`,
      );
    }
    console.log(
      '[PASS] MCP snapshot_now(ton-provider): a confirm-timeout right after a successful broadcast classifies as ERR_PUSH_OUTCOME_UNCERTAIN/ton_contract_address',
    );

    // Same idempotency_key, called again: #818's own posture for an uncertain outcome —
    // the claim is a PERMANENT tombstone (never auto-cleared by a later call), so a
    // same-key retry must replay the SAME uncertain refusal rather than attempting a
    // second real broadcast.
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [srcDir],
          recipients: [process.env.MCP_UNCERTAIN_TEST_RECIPIENT],
          out,
          backend: 'ton-provider',
          confirm_paid: true,
          idempotency_key: idempotencyKey,
        },
      },
    });
    const r2 = await waitFor(3);
    const sc2 = r2.result?.structuredContent;
    if (r2.result?.isError !== true || sc2?.idempotent_replay !== true) {
      throw new Error(
        `a repeat call with the SAME idempotency_key after an uncertain-spend refusal must replay the recorded ` +
          `refusal (isError:true, idempotent_replay:true), not re-execute (a SECOND real broadcast) or report a ` +
          `clean success: ${JSON.stringify(r2.result).slice(0, 500)}`,
      );
    }
    if (sc2?.code !== 'ERR_PUSH_OUTCOME_UNCERTAIN' || sc2?.spend_outcome !== 'uncertain') {
      throw new Error(`replayed result lost its uncertain-spend classification: ${JSON.stringify(sc2).slice(0, 500)}`);
    }
    if (sc2?.check_identifier !== sc1.check_identifier) {
      throw new Error(
        `replayed check_identifier does not match the original refusal's (the operator's check target must not ` +
          `drift): first=${JSON.stringify(sc1.check_identifier)} replay=${JSON.stringify(sc2?.check_identifier)}`,
      );
    }
    console.log(
      '[PASS] MCP snapshot_now(ton-provider): a repeat call with the SAME idempotency_key replays the uncertain-spend refusal instead of broadcasting a second transfer',
    );
  } finally {
    child.kill();
  }
}

await main();
console.log('MCP TON-PROVIDER UNCERTAIN-SPEND SELFTEST PASS');
