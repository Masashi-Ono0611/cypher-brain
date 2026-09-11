#!/usr/bin/env node
// issue #949 (scenario 2, MCP-level): a ton-provider snapshot_now call whose funding is
// ALREADY confirmed on-chain (waitForContractActive() returned) but whose
// confirmed-state pending-spend record write then fails (a full disk, a permissions
// change under CYPHER_BRAIN_RECEIPT_LEDGER's own pending-spends sidecar) must be
// recorded under its idempotency_key as a partial success (funding_confirmed:true,
// partial_stage:'confirmed_intent_write') — the SAME retry-safety #654's
// PushFundingConfirmedButIncompleteError already gets for the notify step, one
// checkpoint earlier — NOT a plain error that lets a same-key retry release its claim
// and broadcast a second real transfer.
//
// The failure is induced by a REAL EACCES, not a simulated timeout: this script polls
// the spawned MCP server's own pending-spends log (derived from a DEDICATED, isolated
// CYPHER_BRAIN_RECEIPT_LEDGER this script picks) for its 'pending' line, then chmod's
// that file read-only before the server's own advanceSpendIntent(..., 'confirmed') call
// can append to it. The window between those two writes is opened wide (SLOW_ADDR_FLAG,
// #949 mock hook — delays every tonapi query naming the auto-sign wallet's own address)
// so this script's poll loop reliably wins the race against a normally-instant mocked
// round trip. Reuses this run's ALREADY-RUNNING tonapi/mytonprovider/notify mocks — see
// selftest-ton-provider-mcp-partial.mjs's own header comment for why.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = join(ROOT, 'dist', 'mcp.mjs');
const TIMEOUT_MS = 30_000;

const TMP = process.env.MCP_CONFIRMED_WRITE_TEST_TMP;
const TON_WALLET_PATH = process.env.MCP_CONFIRMED_WRITE_TEST_TON_WALLET;
const LEDGER = process.env.MCP_CONFIRMED_WRITE_TEST_LEDGER;
const SLOW_ADDR_FLAG = process.env.MCP_CONFIRMED_WRITE_TEST_SLOW_ADDR_FLAG;
const WALLET_ADDR_RAW = process.env.MCP_CONFIRMED_WRITE_TEST_WALLET_ADDR_RAW;
if (!TMP || !TON_WALLET_PATH || !LEDGER || !SLOW_ADDR_FLAG || !WALLET_ADDR_RAW) {
  throw new Error(
    'MCP_CONFIRMED_WRITE_TEST_TMP/TON_WALLET/LEDGER/SLOW_ADDR_FLAG/WALLET_ADDR_RAW must all be set (see selftest-ton-provider.sh)',
  );
}
// Derived the same way pending-spend.ts derives it — see that module's own comment.
const PENDING_LOG = `${LEDGER}.pending-spends.jsonl`;
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

// Races the tool-call response against the pending-spend log reaching 'pending' — chmod's
// it read-only the moment it does, then clears SLOW_ADDR_FLAG (no longer needed once the
// window is used, and leaving it would needlessly delay this same wallet's later queries
// too). Returns once either the file is chmod'd or the deadline passes.
async function chmodPendingLogOncePending() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(PENDING_LOG)) {
      const text = await readFile(PENDING_LOG, 'utf8').catch(() => '');
      if (text.includes('"state":"pending"')) {
        await chmod(PENDING_LOG, 0o444);
        await rm(SLOW_ADDR_FLAG, { force: true });
        return true;
      }
    }
    await wait(50);
  }
  return false;
}

async function main() {
  const srcDir = join(TMP, 'mcp-confirmed-write-src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, 'note.txt'), 'issue #949 MCP-level confirmed-intent-write-failure payload\n');
  const out = join(TMP, 'mcp-confirmed-write.age');
  const idempotencyKey = 'issue-949-mcp-confirmed-write-key';

  // Opens the #949 mock hook's window BEFORE spawning — this run's own funds-check
  // (fetchAccountState(owner), owner == this wallet with CYPHER_BRAIN_TON_PROVIDER_OWNER
  // unset) is the first query this delays, giving chmodPendingLogOncePending() below
  // several real seconds to win the race well before waitForContractActive() confirms
  // the contract and the server's own advanceSpendIntent(..., 'confirmed') call fires.
  await writeFile(SLOW_ADDR_FLAG, WALLET_ADDR_RAW);

  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CYPHER_BRAIN_TON_WALLET: TON_WALLET_PATH,
      CYPHER_BRAIN_TON_PROVIDER_OWNER: '',
      CYPHER_BRAIN_RECEIPT_LEDGER: LEDGER,
      CYPHER_BRAIN_PIN_RECIPIENTS: process.env.MCP_CONFIRMED_WRITE_TEST_RECIPIENT,
      CYPHER_BRAIN_MCP_SOURCE_ROOTS: JSON.stringify([TMP]),
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
          recipients: [process.env.MCP_CONFIRMED_WRITE_TEST_RECIPIENT],
          out,
          backend: 'ton-provider',
          confirm_paid: true,
          idempotency_key: idempotencyKey,
        },
      },
    });

    const won = await chmodPendingLogOncePending();
    if (!won) {
      throw new Error(`the pending-spend record at ${PENDING_LOG} never reached 'pending' within the race window`);
    }

    const r1 = await waitFor(2);
    if (!r1.result?.isError) {
      throw new Error(
        `expected an error result (the confirmed-state pending-spend write is now EACCES), got: ${JSON.stringify(r1.result).slice(0, 500)}`,
      );
    }
    const sc1 = r1.result?.structuredContent;
    // issue #654 (Codex design review — see selftest-ton-provider-mcp-partial.mjs's own
    // header comment): the classified funding_confirmed/partial_stage/locator fields are
    // written by mcp.ts's recordIdempotencyResult() call and only ever surface on the
    // REPLAYED result (checked below on sc2) — the FIRST call's own immediate error still
    // just `throw`s `e` as-is, so only its message is asserted here.
    if (!/funding is CONFIRMED on-chain/.test(sc1?.message ?? '')) {
      throw new Error(
        `the immediate error result should name the confirmed funding, got: ${JSON.stringify(sc1).slice(0, 500)}`,
      );
    }
    if (!/recording the confirmed-state pending-spend record failed/.test(sc1?.message ?? '')) {
      throw new Error(
        `the immediate error result should name the confirmed-state pending-spend record as the failure point: ${JSON.stringify(sc1).slice(0, 500)}`,
      );
    }
    console.log(
      '[PASS] MCP snapshot_now(ton-provider): a confirmed-state pending-spend write failure reports an error naming the confirmed funding and the failed record write',
    );

    // Restore write access before the replay call below — a real operator would fix the
    // disk/permissions issue before retrying; this assertion is about the IDEMPOTENCY
    // CLAIM (was it retained?), not about re-inducing the same fs failure a second time.
    await chmod(PENDING_LOG, 0o644);

    // Same idempotency_key, called again: replays the RECORDED PARTIAL SUCCESS
    // (idempotent_replay:true) rather than attempting a second real broadcast — proving
    // the claim was RETAINED, not released, by the failure above.
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'snapshot_now',
        arguments: {
          dirs: [srcDir],
          recipients: [process.env.MCP_CONFIRMED_WRITE_TEST_RECIPIENT],
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
        `a repeat call with the SAME idempotency_key after a confirmed-intent-write failure must replay the ` +
          `recorded partial success as an ERROR (isError:true, idempotent_replay:true) — proving the idempotency ` +
          `claim was RETAINED rather than released — not re-execute (a SECOND real broadcast), refuse, or report a ` +
          `clean success: ${JSON.stringify(r2.result).slice(0, 500)}`,
      );
    }
    if (sc2?.funding_confirmed !== true || sc2?.provider_download_confirmed !== false) {
      throw new Error(
        `replayed result missing funding_confirmed:true/provider_download_confirmed:false (issue #949): ${JSON.stringify(sc2).slice(0, 500)}`,
      );
    }
    if (sc2?.partial_stage !== 'confirmed_intent_write') {
      throw new Error(
        `replayed result missing partial_stage:'confirmed_intent_write' (distinguishing this from #654's own ` +
          `'provider_notify' stage): ${JSON.stringify(sc2?.partial_stage)}`,
      );
    }
    // issue #654 (Codex design review): this is exactly the misclassification this fix's
    // own dedicated branch in mcp.ts exists to avoid.
    if (sc2?.locator_file_write_failed || sc2?.signature_upload_failed) {
      throw new Error(
        `must NOT fall into the locator_file_write_failed/signature_upload_failed branches: ${JSON.stringify(sc2).slice(0, 500)}`,
      );
    }
    // The original call's own message (sc1) embeds the same locator inline rather than as
    // a structured field (see the comment above) — cross-checked against it here so the
    // replay is proven to describe the SAME spend, not merely A valid-looking one.
    const embeddedLocator = /locator: (ton-provider:v1:\S+)\)/.exec(sc1?.message ?? '')?.[1];
    if (typeof sc2?.locator !== 'string' || !sc2.locator.startsWith('ton-provider:v1:')) {
      throw new Error(`replayed result is missing a real ton-provider locator: ${JSON.stringify(sc2).slice(0, 500)}`);
    }
    if (embeddedLocator && sc2.locator !== embeddedLocator) {
      throw new Error(
        `replayed locator does not match the original refusal's own embedded locator: first=${JSON.stringify(embeddedLocator)} replay=${JSON.stringify(sc2.locator)}`,
      );
    }
    console.log(
      '[PASS] MCP snapshot_now(ton-provider): a repeat call with the SAME idempotency_key replays the confirmed-intent-write partial success instead of broadcasting a second transfer — the idempotency claim was retained, not released',
    );
  } finally {
    child.kill();
    await chmod(PENDING_LOG, 0o644).catch(() => {});
    await rm(SLOW_ADDR_FLAG, { force: true }).catch(() => {});
  }
}

await main();
console.log('MCP TON-PROVIDER CONFIRMED-INTENT-WRITE-FAILURE SELFTEST PASS');
